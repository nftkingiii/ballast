// Public routes for the web page. Nothing here reads or returns a secret: the payment credentials live in the PlanDeps factory
// the server passes in, and the plan sent to the browser has its label replaced (the paid label names the signer wallet).
//   GET  /                       the page            GET /app.css, /app.js, /favicon.svg
//   GET  /public/status          live availability, runs left today, busy flag
//   GET  /public/sites           preset sites (sites/*.json)
//   GET  /public/recorded        the recorded Mind run (web/data/recorded.json)
//   GET  /public/compare         the with/without comparison, from compare/results.*
//   GET  /public/runs[/:id]      the last 20 live runs since the last restart
//   POST /public/run             { site, mode: "demo" | "live" } -> NDJSON stream of events, ending in a result or an error
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSite } from "./config.ts";
import { DEMO_SITE_ID, listSites, loadComparison, loadSite } from "./public-data.ts";
import { LiveLimiter, WindowLimiter } from "./public-limits.ts";
import { planSite, type PlanDeps } from "./plan.ts";
import type { AskRequest, Transport } from "./telegraph.ts";
import type { Plan } from "./types.ts";

export const LIVE_LABEL = "live · testnet (Sepolia test USDC)";
export const DEMO_REPLAY_NOTE = "Demo replays the recorded West Texas answers; pick Live run for this site's real prices";
export const DEMO_LABEL = "DEMO · recorded stand-in answers, no Telegraph calls, nothing paid";

export interface PublicOptions {
  /** BALLAST_PUBLIC_LIVE=1 and a working payment setup. When false, live runs are refused with a clear message. */
  liveEnabled: boolean;
  liveDeps: (site: ReturnType<typeof parseSite>) => Promise<PlanDeps>;
  demoDeps: () => PlanDeps;
  /** Available escrow balance in USD. Throwing means unknown, which refuses the run. */
  getBalanceUsd: () => Promise<number>;
  minBalanceUsd?: number;
  perRunCapUsd?: number;
  limiter?: LiveLimiter;
  demoLimiter?: WindowLimiter;
  now?: () => Date;
  webDir?: URL;
}

interface RunRecord {
  id: string;
  at: string;
  site: string;
  costUsd: number;
  calls: number;
  actions: Record<string, number>;
  plan: Plan;
}

const CHECK_NAMES: Record<string, string> = {
  GRID_POWER_PRICE_GENERAL: "power price",
  MINING_HASHPRICE_VERIFY_GENERAL: "hashprice",
  WEATHER_FORECAST_VERIFY_GENERAL: "weather verify",
};

export function clientIp(req: IncomingMessage): string {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real) return real.trim();
  // Behind a proxy the last entry is the one the proxy itself appended; earlier ones can be written by the caller.
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return fwd.at(-1) ?? req.socket.remoteAddress ?? "unknown";
}

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};

const CSP = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "media-src https:",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function createPublicApi(options: PublicOptions) {
  const now = options.now ?? (() => new Date());
  const limiter = options.limiter ?? new LiveLimiter({ now });
  const demoLimiter = options.demoLimiter ?? new WindowLimiter(20, 60_000);
  const minBalance = options.minBalanceUsd ?? 1;
  const runCap = options.perRunCapUsd ?? 0.4;
  const webDir = options.webDir ?? new URL("../web/", import.meta.url);
  const recent: RunRecord[] = [];
  let balanceCache: { at: number; usd: number | null } | undefined;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function balance(fresh: boolean): Promise<number | null> {
    if (!fresh && balanceCache && Date.now() - balanceCache.at < 60_000) return balanceCache.usd;
    try {
      balanceCache = { at: Date.now(), usd: await options.getBalanceUsd() };
    } catch {
      balanceCache = { at: Date.now(), usd: null };
    }
    return balanceCache.usd;
  }

  async function status(ip: string) {
    const s = limiter.status(ip);
    let available = options.liveEnabled;
    let reason: string | undefined;
    if (!options.liveEnabled) reason = "Live runs are switched off on this server. The demo run still works.";
    else {
      const usd = await balance(false);
      if (usd === null) [available, reason] = [false, "The escrow balance could not be read, so live runs are paused. The demo run still works."];
      else if (usd < minBalance) [available, reason] = [false, `The escrow balance is below $${minBalance.toFixed(2)}, so live runs are paused until it is topped up.`];
      else if (s.remainingToday === 0) [available, reason] = [false, `All ${s.dailyMax} live runs for today (UTC) are used. They reset at 00:00 UTC.`];
      else if (s.remainingForYou === 0) [available, reason] = [false, `You have used your ${s.perIpMax} live runs for today (UTC).`];
    }
    const escrow = options.liveEnabled ? balanceCache?.usd ?? null : null;
    return { live: { available, reason, escrowAvailableUsd: escrow === null ? null : Math.round(escrow * 100) / 100, label: LIVE_LABEL, ...s, perRunCapUsd: runCap, minBalanceUsd: minBalance }, demo: { label: DEMO_LABEL } };
  }

  function publicPlan(plan: Plan): Plan {
    return { ...plan, label: plan.mode === "paid" ? LIVE_LABEL : DEMO_LABEL };
  }

  function watch(transport: Transport, emit: (e: unknown) => void): Transport {
    let n = 0;
    return {
      kind: transport.kind,
      async ask(request: AskRequest) {
        const call = ++n;
        const check = CHECK_NAMES[request.intent] ?? request.intent;
        const subject = String(request.params.interval_start ?? request.params.date ?? "").slice(0, 16);
        emit({ type: "ask", n: call, check, provider: request.minerId, subject });
        const t0 = Date.now();
        try {
          const a = await transport.ask(request);
          emit({ type: "answer", n: call, check, provider: a.minerId, subject, costUsd: a.costUsd, receipt: a.receipt.receiptHash ?? a.receipt.jobId ?? a.receipt.signalHash ?? null, ms: Date.now() - t0 });
          return a;
        } catch (error) {
          emit({ type: "failed", n: call, check, provider: request.minerId, subject, message: (error as Error).message.slice(0, 200), ms: Date.now() - t0 });
          throw error;
        }
      },
    };
  }

  function stream(res: ServerResponse) {
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
    const emit = (e: unknown) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
    };
    const beat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
    return { emit, end: () => (clearInterval(beat), res.writableEnded || res.end()) };
  }

  async function run(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) {
    const ip = clientIp(req);
    const mode = body.mode === "live" ? "live" : body.mode === "demo" ? "demo" : undefined;
    const siteId = String(body.site ?? "");
    if (!mode) return json(res, 400, { error: "bad_mode", message: 'mode must be "demo" or "live".' });
    const raw = loadSite(siteId);
    if (!raw) return json(res, 400, { error: "unknown_site", message: "Pick one of the preset sites." });

    if (mode === "demo") {
      if (!demoLimiter.allow(ip)) return json(res, 429, { error: "demo_rate_limited", message: "Too many demo runs from this address in the last minute. Wait a moment." });
      const out = stream(res);
      try {
        // The recorded answers are for West Texas (HB_WEST) only. For any other site the demo replays the West Texas
        // site itself, so the plan is named and keyed as West Texas and never carries the picked site's name or node.
        const replay = siteId !== DEMO_SITE_ID;
        const site = parseSite(replay ? loadSite(DEMO_SITE_ID)! : raw);
        const deps = options.demoDeps();
        const note = replay ? DEMO_REPLAY_NOTE : undefined;
        out.emit({ type: "start", mode, label: DEMO_LABEL, site: site.name, ...(note ? { note, requestedSite: siteId } : {}) });
        const plan = await planSite(site, { ...deps, transport: watch(deps.transport, out.emit) });
        out.emit({ type: "result", mode, label: DEMO_LABEL, ...(note ? { note } : {}), plan: publicPlan(plan) });
      } catch (error) {
        out.emit({ type: "error", message: `The demo run failed: ${(error as Error).message}` });
      }
      return out.end();
    }

    if (!options.liveEnabled) return json(res, 503, { error: "live_disabled", message: "Live runs are switched off on this server.", offerDemo: true });
    const slot = limiter.reserve(ip);
    if ("refused" in slot) {
      const s = limiter.status(ip);
      const text = {
        busy: "Another live run is in progress. Only one runs at a time, and each takes a minute or two. Try again shortly.",
        daily: `All ${s.dailyMax} live runs for today (UTC) are used. They reset at 00:00 UTC.`,
        ip: `You have used your ${s.perIpMax} live runs for today (UTC).`,
      }[slot.refused];
      return json(res, slot.refused === "busy" ? 409 : 429, { error: slot.refused, message: text, offerDemo: true });
    }
    const { ticket } = slot;
    let spent = false;
    try {
      const usd = await balance(true);
      if (usd === null) return json(res, 503, { error: "balance_unknown", message: "The escrow balance could not be read, so no live run was started and nothing was paid.", offerDemo: true });
      if (usd < minBalance) return json(res, 503, { error: "low_balance", message: `The escrow balance is below $${minBalance.toFixed(2)}, so no live run was started and nothing was paid.`, offerDemo: true });
      // One cap for the whole run, through the planner's own budget: the site's cap, never above the public ceiling.
      const asked = Number(raw.intelligence?.spendCapUsd);
      raw.intelligence = { ...raw.intelligence, spendCapUsd: Math.min(Number.isFinite(asked) && asked > 0 ? asked : runCap, runCap) };
      const site = parseSite(raw);
      const deps = await options.liveDeps(site);
      ticket.commit();
      spent = true;
      const out = stream(res);
      out.emit({ type: "start", mode, label: LIVE_LABEL, site: site.name, capUsd: site.intelligence.spendCapUsd, remainingToday: limiter.status(ip).remainingToday });
      try {
        const plan = await planSite(site, { ...deps, transport: watch(deps.transport, out.emit) });
        const id = createHash("sha256").update(`${plan.generatedAt}|${Math.random()}`).digest("hex").slice(0, 10);
        const actions: Record<string, number> = {};
        for (const d of plan.decisions) actions[d.action] = (actions[d.action] ?? 0) + 1;
        recent.unshift({ id, at: plan.generatedAt, site: plan.site, costUsd: plan.intelligenceCostUsd, calls: plan.telegraphCalls, actions, plan: publicPlan(plan) });
        recent.length = Math.min(recent.length, 20);
        out.emit({ type: "result", mode, label: LIVE_LABEL, runId: id, plan: publicPlan(plan), remainingToday: limiter.status(ip).remainingToday });
      } catch (error) {
        out.emit({ type: "error", message: `The live run failed part way: ${(error as Error).message.slice(0, 300)}. Anything already bought was paid for; no result is shown.`, offerDemo: true });
      }
      return out.end();
    } catch (error) {
      if (!spent) return json(res, 503, { error: "live_unavailable", message: `Live runs are unavailable right now: ${(error as Error).message.slice(0, 200)}. Nothing was paid.`, offerDemo: true });
      throw error;
    } finally {
      ticket.release();
    }
  }

  /** Returns true when the request was one of ours. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, readBody: () => Promise<unknown>): Promise<boolean> {
    const path = url.pathname;
    const ip = clientIp(req);
    if (req.method === "GET") {
      const file = STATIC[path];
      if (file) {
        try {
          const data = readFileSync(new URL(file[0], webDir));
          res.writeHead(200, { "content-type": file[1], "cache-control": "no-cache", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" });
          res.end(data);
        } catch {
          json(res, 404, { error: "not_found" });
        }
        return true;
      }
      if (path === "/public/status") return json(res, 200, await status(ip)), true;
      if (path === "/public/sites") return json(res, 200, { sites: listSites() }), true;
      if (path === "/public/recorded") return json(res, 200, JSON.parse(readFileSync(new URL("data/recorded.json", webDir), "utf8"))), true;
      if (path === "/public/compare") return json(res, 200, loadComparison()), true;
      if (path === "/public/runs") {
        return json(res, 200, { note: "Kept in memory since the last restart; the host has no volume.", runs: recent.map(({ plan: _p, ...r }) => r) }), true;
      }
      const m = /^\/public\/runs\/([a-f0-9]{10})$/.exec(path);
      if (m) {
        const r = recent.find((x) => x.id === m[1]);
        return r ? json(res, 200, { mode: "live", label: LIVE_LABEL, runId: r.id, plan: r.plan }) : json(res, 404, { error: "gone", message: "That run is no longer kept (only the last 20 since the last restart are)." }), true;
      }
      return false;
    }
    if (req.method === "POST" && path === "/public/run") {
      let body: Record<string, unknown>;
      try {
        body = (await readBody()) as Record<string, unknown>;
      } catch (error) {
        json(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message });
        return true;
      }
      await run(req, res, body ?? {});
      return true;
    }
    return false;
  }

  return { handle, limiter, recent, status };
}

export type PublicApi = ReturnType<typeof createPublicApi>;
