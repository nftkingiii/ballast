import type { Receipt } from "./types.ts";

type Fetch = typeof fetch;

export const DEVNODE = "https://devnode.telegraphprotocol.com";
export const ANJOMAN_API = "https://backend.telegraphprotocol.com";
/** One engine ask costs $0.01 on testnet; used to reserve budget before a call. */
export const ENGINE_ASK_USD = 0.01;

export interface AskRequest {
  intent: string;
  minerId: string;
  params: Record<string, unknown>;
  /** For a miner whose endpoint takes more than the intent's params (Pecos needs `market`). */
  native?: { method: "GET"; endpoint: string; payload: Record<string, unknown> };
  maxCostUsd: number;
}

export interface Answer {
  minerId: string;
  result: Record<string, unknown>;
  costUsd: number;
  answeredAt: string;
  receipt: Receipt;
}

export interface Transport {
  readonly kind: "fixture" | "engine" | "anjoman" | "hybrid";
  ask(request: AskRequest): Promise<Answer>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Stops all further buying once a call would take total spend over the cap. */
export class Budget {
  spentUsd = 0;
  breached = false;
  constructor(readonly capUsd: number) {}

  /** True when a call that could cost `maxUsd` still fits. A refusal is permanent for this plan. */
  reserve(maxUsd: number): boolean {
    if (this.breached || this.spentUsd + maxUsd > this.capUsd + 1e-9) {
      this.breached = true;
      return false;
    }
    return true;
  }

  record(usd: number): void {
    this.spentUsd += usd;
  }
}

/** Signs Telegraph's escrow challenge with EIP-191 personal_sign. Ballast never holds a key itself. */
export interface EscrowSigner {
  address: string;
  personalSign(message: string): Promise<string>;
}

interface Challenge {
  accepts: { scheme: string; network: string; payTo: string; extra?: { message?: string } }[];
}

const fromBase64Json = (text: string): unknown => JSON.parse(Buffer.from(text, "base64").toString("utf8"));

/**
 * Pays per request from the caller's Telegraph escrow balance (scheme "escrow"), which works while the
 * x402 facilitator is timing out (bounty #214). POST, read the 402 challenge, sign its message, retry
 * with X-PAYMENT, read the receipt from X-PAYMENT-RESPONSE.
 */
export function createEngineTransport(
  signer: EscrowSigner,
  http: Fetch = fetch,
  now = () => Date.now(),
  base = DEVNODE,
): Transport {
  return {
    kind: "engine",
    async ask(request) {
      const url = `${base}/engine/v1/ask/${encodeURIComponent(request.minerId)}`;
      const body = JSON.stringify(
        request.native
          ? { method: request.native.method, endpoint: request.native.endpoint, payload: request.native.payload }
          : { intent: request.intent, params: request.params },
      );
      const send = (headers: Record<string, string>) =>
        http(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(65_000) });

      const first = await send({});
      if (first.status !== 402) throw new TransportError(`expected a 402 challenge, got ${first.status}`, first.status);
      const header = first.headers.get("payment-required");
      if (!header) throw new TransportError("402 without a Payment-Required header", 402);
      const challenge = fromBase64Json(header) as Challenge;
      const escrow = challenge.accepts.find((a) => a.scheme === "escrow");
      const template = escrow?.extra?.message;
      if (!escrow || !template) throw new TransportError("the node offered no escrow payment option", 402);

      const value = /Amount:\s*(\d+)\s*uUSDC/.exec(template)?.[1];
      if (!value) throw new TransportError("escrow challenge has no Amount line", 402);
      const costUsd = Number(value) / 1e6;
      if (costUsd > request.maxCostUsd + 1e-9) {
        throw new TransportError(`quote $${costUsd} is above the $${request.maxCostUsd} limit`, 402);
      }

      const validAfter = Math.floor(now() / 1000) - 30;
      const validBefore = validAfter + 90; // the node allows at most a 2 minute window
      const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
      const from = signer.address.toLowerCase();
      const message = template
        .replace("{from}", from)
        .replace("{nonce}", nonce)
        .replace("{validAfter}", String(validAfter))
        .replace("{validBefore}", String(validBefore));
      const signature = await signer.personalSign(message);
      const payload = {
        x402Version: 2,
        scheme: "escrow",
        network: escrow.network,
        // The escrow rail wants value and the validity bounds as strings (anjoman.ai/docs/using/escrow-inference).
        payload: {
          signature,
          authorization: { from, to: escrow.payTo, value, validAfter: String(validAfter), validBefore: String(validBefore), nonce },
        },
      };
      const paid = await send({ "x-payment": Buffer.from(JSON.stringify(payload)).toString("base64") });
      if (paid.status !== 200) {
        // Refusals carry a reason (wrong amount, expired, signer mismatch, insufficient escrow): surface it.
        const reason = await paid
          .json()
          .then((b: { reason?: string; error?: string }) => b.reason ?? b.error ?? "")
          .catch(() => "");
        throw new TransportError(`paid ask answered ${paid.status}${reason ? `: ${reason}` : ""}`, paid.status);
      }
      const json = (await paid.json()) as { result?: Record<string, unknown>; signal_hash?: string; cost_usd?: number };
      const raw = paid.headers.get("x-payment-response");
      const receipt = raw ? (fromBase64Json(raw) as { receipt_hash?: string; rail?: string; amount_uusdc?: number }) : {};
      if (!json.result || !receipt.receipt_hash) throw new TransportError("answer came back without a result or a receipt");
      return {
        minerId: request.minerId,
        result: json.result,
        costUsd: receipt.amount_uusdc !== undefined ? receipt.amount_uusdc / 1e6 : (json.cost_usd ?? costUsd),
        answeredAt: new Date(now()).toISOString(),
        receipt: { receiptHash: receipt.receipt_hash, signalHash: json.signal_hash, rail: receipt.rail },
      };
    },
  };
}

interface ChatReply {
  jobId?: string;
  status?: string;
  answer?: string;
  reply?: string;
  costUsd?: number | null;
  sources?: { receiptHash?: string; miner?: { id?: string } }[];
}

/**
 * Pays from an Anjoman account balance with an API key (no wallet). The key can only call /agent/chat,
 * which takes plain language, so the message names the intent, miner and params and asks for one JSON
 * object back. Anything that does not parse is refused rather than guessed at.
 */
/** Reads a server-sent event stream until the `job` event and returns its jobId (or undefined if none arrives). */
async function firstJobId(res: Response): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return undefined;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as { jobId?: string; job?: { jobId?: string } };
          const id = parsed.jobId ?? parsed.job?.jobId;
          if (id && (event === "job" || event === undefined || event === "conversation")) return id;
        } catch {
          /* not JSON: keep reading */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** The plain-language question each intent answers, built from its canonical parameters. */
const QUESTION: Record<string, (p: Record<string, unknown>) => string> = {
  MINING_HASHPRICE_VERIFY_GENERAL: (p) => `What is the Bitcoin hashprice at block height ${p.block_height}?`,
  GRID_POWER_PRICE_GENERAL: (p) =>
    `What was the ERCOT ${p.market ?? "real-time"} settlement point price for ${p.node_or_zone} for the interval starting ${p.interval_start}?`,
  WEATHER_FORECAST_VERIFY_GENERAL: (p) => `What was the daily maximum and minimum temperature and precipitation in ${p.location} on ${p.date}?`,
};

export function createAnjomanTransport(
  apiKey: string,
  http: Fetch = fetch,
  now = () => Date.now(),
  base = ANJOMAN_API,
  waitMs = 180_000,
): Transport {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" };
  return {
    kind: "anjoman",
    async ask(request) {
      // Canonical params, plus anything only the native payload carries (e.g. the power market).
      const call: Record<string, unknown> = { ...(request.native?.payload ?? {}), ...(request.params ?? {}) };
      // Ask a real question and let Anjoman map it to the miner's own inputs: some miners take a plain-language
      // `question` field, and insisting on "exactly these parameters" made the agent stop with "question not provided".
      const message =
        `${QUESTION[request.intent] ? QUESTION[request.intent]!(call) : `Answer Telegraph intent ${request.intent} for ${JSON.stringify(call)}.`} ` +
        `Use Telegraph intent ${request.intent} and buy the answer from miner ${request.minerId}; these are the intent parameters: ${JSON.stringify(call)}. ` +
        `If the miner needs a plain-language question, ask it this question. ` +
        `Reply with only the miner's answer fields as one JSON object, no commentary.`;
      // Stream mode: Anjoman sends the job id as an early `job` event, so Ballast never holds a long request
      // open. Waiting on one JSON reply (stream: false) hit gateway 504s on slower questions before Anjoman's own
      // ~80 s switch to 202 + jobId, and a dropped request still runs and may still be charged on the server.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100_000);
      let res: Response;
      try {
        res = await http(`${base}/agent/chat`, {
          method: "POST",
          headers: { ...headers, accept: "text/event-stream, application/json" },
          body: JSON.stringify({ message, maxSpendUsd: request.maxCostUsd }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        throw new TransportError(`Anjoman request failed: ${(error as Error).message}`);
      }
      if (res.status !== 200 && res.status !== 202) {
        clearTimeout(timer);
        const hint = res.status >= 500 ? " (the job may still have run on Anjoman's side; check its activity before retrying)" : "";
        throw new TransportError(`Anjoman answered ${res.status}${hint}`, res.status);
      }
      let reply: ChatReply;
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const jobId = await firstJobId(res);
        controller.abort();
        clearTimeout(timer);
        if (!jobId) throw new TransportError("Anjoman stream ended without a job id");
        reply = { jobId, status: "running" };
      } else {
        reply = (await res.json()) as ChatReply;
        clearTimeout(timer);
      }
      const started = now();
      while (reply.jobId && reply.status === "running" && now() - started < waitMs) {
        await new Promise((r) => setTimeout(r, 2_000));
        const jobId = reply.jobId;
        const poll = await http(`${base}/agent/jobs/${encodeURIComponent(jobId)}`, { headers, signal: AbortSignal.timeout(30_000) });
        if (!poll.ok) throw new TransportError(`job ${jobId} poll answered ${poll.status}`, poll.status);
        // The job endpoint may return the job at the top level or under `job`, with or without its id: keep ours.
        const body = (await poll.json()) as ChatReply & { job?: ChatReply };
        reply = { ...(body.job ?? body), jobId };
        if (reply.status !== "running") break;
      }
      if (reply.status === "running") throw new TransportError(`job ${reply.jobId} still running after ${waitMs / 1000}s`);
      const text = reply.answer ?? reply.reply ?? "";
      const match = /\{[\s\S]*\}/.exec(text);
      // Keep Anjoman's own words on failure, so a missing input or empty balance explains itself.
      const said = text.replace(/\s+/g, " ").trim().slice(0, 200);
      if (!match) throw new TransportError(`job ${reply.jobId ?? "?"} returned no JSON answer (${reply.status})${said ? `: "${said}"` : ""}`);
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        throw new TransportError(`job ${reply.jobId ?? "?"} returned unparseable JSON`);
      }
      if (reply.costUsd === null || reply.costUsd === undefined) {
        throw new TransportError(`job ${reply.jobId ?? "?"} reported no cost (${reply.status})${said ? `: "${said}"` : ""}`);
      }
      // A named miner is only a hint on this route: never claim it answered unless Anjoman says so.
      return {
        minerId: reply.sources?.[0]?.miner?.id ?? `${request.minerId} (requested; miner not stated by Anjoman)`,
        result,
        costUsd: reply.costUsd,
        answeredAt: new Date(now()).toISOString(),
        receipt: { jobId: reply.jobId, receiptHash: reply.sources?.[0]?.receiptHash, rail: "anjoman-account" },
      };
    },
  };
}

/**
 * Available escrow balance of a wallet in USD, from the node ledger (keyless GET /v1/ledger/account/{address}).
 * Amounts are micro-USDC strings, e.g. {"available":"4700000","balance":"4700000","charged":"300000","deposited":"5000000"} is $4.70.
 * Anything that is not a non-negative whole number of micro-USDC throws, so a caller that needs a floor refuses rather than guesses.
 */
export async function readLedgerAvailableUsd(address: string, http: Fetch = fetch, base = DEVNODE): Promise<number> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new TransportError("not a wallet address");
  const res = await http(`${base}/v1/ledger/account/${address}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new TransportError(`ledger read failed with ${res.status}`, res.status);
  const available = ((await res.json()) as { available?: unknown }).available;
  if ((typeof available !== "string" && typeof available !== "number") || !/^[0-9]+$/.test(String(available))) throw new TransportError("ledger response has no readable available amount");
  return Number(available) / 1e6;
}
