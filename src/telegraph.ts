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
  readonly kind: "fixture" | "engine" | "anjoman";
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
  waitMs = 120_000,
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
      const res = await http(`${base}/agent/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message, stream: false, maxSpendUsd: request.maxCostUsd }),
        signal: AbortSignal.timeout(100_000),
      });
      if (res.status !== 200 && res.status !== 202) throw new TransportError(`Anjoman answered ${res.status}`, res.status);
      let reply = (await res.json()) as ChatReply;
      const started = now();
      while (reply.jobId && (res.status === 202 || reply.status === "running") && now() - started < waitMs) {
        await new Promise((r) => setTimeout(r, 2_000));
        const poll = await http(`${base}/agent/jobs/${encodeURIComponent(reply.jobId)}`, { headers, signal: AbortSignal.timeout(30_000) });
        if (!poll.ok) throw new TransportError(`job poll answered ${poll.status}`, poll.status);
        reply = (await poll.json()) as ChatReply;
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
      return {
        minerId: reply.sources?.[0]?.miner?.id ?? request.minerId,
        result,
        costUsd: reply.costUsd,
        answeredAt: new Date(now()).toISOString(),
        receipt: { jobId: reply.jobId, receiptHash: reply.sources?.[0]?.receiptHash, rail: "anjoman-account" },
      };
    },
  };
}
