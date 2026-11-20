// Policy A (web-only Mind, modelled) and Policy B (Ballast's real code on replayed provider answers).
import { decideHour } from "../src/decide.ts";
import { planSite } from "../src/plan.ts";
import { TransportError, type Answer, type AskRequest, type Transport } from "../src/telegraph.ts";
import type { PublicSources } from "../src/sources.ts";
import type { Memory } from "../src/reuse.ts";
import type { Action, Plan, SiteConfig } from "../src/types.ts";
import { createHash } from "node:crypto";
import { HOUR, NODE, QUARTER } from "./model.ts";
import type { World } from "./world.ts";

export const DECISION_OFFSET_MIN = 16;

export interface Decided {
  hour: string;
  action: Action;
  fraction: number;
  /** Price the decision rested on (null for HOLD). */
  priceUsed: number | null;
  basis: "real-time" | "day-ahead" | "none";
  /** The policy raised a named problem with an input (rejected an answer, fell back, or held). */
  flagged: boolean;
  /** Short reasons for the flags, when any. */
  flags: string[];
  /** Evidence fields present for the inputs the decision used: provider, as-of time, receipt, per input (power, hashprice). */
  evidence: { power: [boolean, boolean, boolean]; hashprice: [boolean, boolean, boolean] } | null;
  /** A wrong-market or wrong-interval answer was recovered (asked again, or read from the public archive). */
  recovered: boolean;
  /** The hashprice was an earlier accepted answer standing in for a missing fresh one. */
  carried: boolean;
  /** Decided before any interval of the hour was published: the plan said to decide again later. */
  provisional: boolean;
  telegraphCostUsd: number;
  paidAnswers: number;
  publicCalls: number;
  /** Measured wall time of the policy code for this decision. */
  ms: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Policy A: one unchecked price and one unchecked hashprice, no staleness, interval, node, market or cross-checks, no receipts. */
export function policyA(site: SiteConfig, w: World, hour: string, carried: { hashprice: number }, variant: "latest" | "latest-at-14" | "day-ahead" = "latest"): Decided {
  const t0 = performance.now();
  const prev = iso(Date.parse(hour) - QUARTER);
  const obs =
    variant === "latest" ? w.observation(hour)
    : variant === "latest-at-14" ? { lmp: w.rt.get(prev)!, node: NODE, market: "real-time" as const, intervalStart: prev }
    : { lmp: w.da.get(hour)!, node: NODE, market: "day-ahead" as const, intervalStart: hour };
  // If the hashprice page fails, a web-only Mind keeps the last value it saw and carries on without saying so.
  const hp = w.hashpriceAvailable(hour) ? w.hashprice(hour).usdPerPhDay : carried.hashprice;
  carried.hashprice = hp;
  const d = decideHour(site, {
    hour, hashpriceUsdPerPhDay: hp, hashpriceGaps: [], tempC: undefined, weatherRequired: false, weatherTrusted: true, weatherGaps: [], evidence: [], forward: false,
    power: { basis: obs.market, price: obs.lmp, evidence: [], notes: [] },
  });
  return {
    hour, action: d.action, fraction: d.runFraction, priceUsed: obs.lmp, basis: obs.market, flagged: false, flags: [],
    // Assumption for the modelled Mind: it can cite the page it read (provider), but scraped values carry no interval/as-of time and there is no receipt.
    evidence: { power: [true, false, false], hashprice: [true, false, false] },
    recovered: false, carried: false, provisional: false, telegraphCostUsd: 0, paidAnswers: 0, publicCalls: 2, ms: performance.now() - t0,
  };
}

/** Replay transport: the provider answers come from the world (plus its injected failures). Same shapes the live nodes return. */
function replayTransport(w: World, now: Date): Transport {
  const receipt = (v: unknown) => `fixture:${createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12)}`;
  const answeredAt = iso(now.getTime() - 20_000);
  return {
    kind: "fixture",
    async ask(req: AskRequest): Promise<Answer> {
      if (req.intent === "GRID_POWER_PRICE_GENERAL") {
        const market = String(req.native?.payload.market) as "real-time" | "day-ahead";
        const start = String(req.params.interval_start);
        const hour = iso(Math.floor(Date.parse(start) / HOUR) * HOUR);
        let result: Record<string, unknown>;
        if (market === "real-time") {
          // The injected failure lands on the hour's first quarter-hour; any other interval is served clean.
          const o = start === hour ? w.observation(hour) : { lmp: w.rt.get(start)!, node: NODE, market: "real-time" as const, intervalStart: start };
          result = { lmp_usd_per_mwh: o.lmp, node_or_zone: o.node, market: o.market, interval_start: o.intervalStart, currency: "USD", iso: "ERCOT" };
        } else {
          const lmp = w.da.get(start);
          if (lmp === undefined) throw new TransportError(`no day-ahead price for ${start}`, 404);
          result = { lmp_usd_per_mwh: lmp, node_or_zone: NODE, market: "day-ahead", interval_start: start, currency: "USD", iso: "ERCOT" };
        }
        return { minerId: req.minerId, result, costUsd: 0, answeredAt, receipt: { receiptHash: receipt([req.minerId, result]) } };
      }
      if (req.intent === "MINING_HASHPRICE_VERIFY_GENERAL") {
        const hour = iso(Math.floor(now.getTime() / HOUR) * HOUR);
        if (!w.hashpriceAvailable(hour)) throw new TransportError("HTTP 503 from the hashprice provider", 503);
        const hp = w.hashprice(hour);
        const result = { hashprice_sats_per_ph_day: (hp.usdPerPhDay / hp.btcUsd) * 1e8, hashprice_usd_per_ph_day: null, block_height: hp.avgHeight, hashrate_eh_s: hp.hashrateEhS };
        return { minerId: req.minerId, result, costUsd: 0, answeredAt, receipt: { receiptHash: receipt([req.minerId, result]) } };
      }
      throw new TransportError(`no replay for ${req.intent}`);
    },
  };
}

export function replayPublic(w: World, hourOf: (now?: Date) => string): PublicSources {
  return {
    async ercotPrice(node, market, start) {
      if (node !== NODE) return null;
      const lmp = market === "real-time" ? w.rt.get(start.toISOString()) : w.da.get(start.toISOString());
      return lmp === undefined ? null : { lmp, source: "ERCOT public MIS archive via Assize (saved)" };
    },
    async tipHeight() { return w.hashprice(hourOf()).avgHeight; },
    async hashprice() {
      const hp = w.hashprice(hourOf());
      return { usdPerPhDay: hp.usdPerPhDay, btcUsd: hp.btcUsd, hashrateEhS: hp.hashrateEhS, tipHeight: hp.avgHeight, source: "mempool.space daily reward-stats and hashrate (saved)" };
    },
    async forecast() { throw new Error("not used: the comparison site has no heat limit"); },
    async observedHigh() { return null; },
  };
}

/** Policy B: Ballast's real planSite (evidence gathering, checks, decideHour) on the same world. */
export async function policyB(site: SiteConfig, w: World, hour: string, offsetMin = DECISION_OFFSET_MIN, memory?: { value: Memory }): Promise<{ decided: Decided; plan: Plan }> {
  const now = new Date(Date.parse(hour) + offsetMin * 60_000);
  const t0 = performance.now();
  const plan = await planSite({ ...site, planning: { ...site.planning, hours: 1, startHour: hour } }, {
    transport: replayTransport(w, now), pub: replayPublic(w, () => hour), now, mode: "demo", label: "comparison replay", memory: memory?.value,
  });
  const ms = performance.now() - t0;
  // The next run remembers what this one accepted, as a planner run every hour would.
  if (memory && plan.hashpriceMemory) memory.value = { hashprice: plan.hashpriceMemory };
  const d = plan.decisions[0]!;
  const used = d.evidence.map((id) => plan.evidence.find((e) => e.id === id)!);
  const telegraph = (check: string) => used.find((e) => e.check === check && e.source.kind !== "public" && e.accepted);
  // A price recovered from the public archive has a provider and an as-of time but no receipt.
  const powerEvidence = (check: string) => telegraph(check) ?? used.find((e) => e.check === check && e.accepted && e.recovery?.via === "public-archive");
  const fields = (e?: (typeof used)[number]): [boolean, boolean, boolean] => [Boolean(e?.source.id), Boolean(e?.answeredAt), Boolean(e?.receipt.receiptHash)];
  const flags = plan.missingChecks.map((g) => `${g.check}: ${g.reason}`);
  return {
    plan,
    decided: {
      hour, action: d.action, fraction: d.runFraction, priceUsed: d.powerPriceUsdPerMwh, basis: d.basis, flagged: flags.length > 0, flags,
      evidence: d.action === "HOLD" ? null : { power: fields(powerEvidence(d.basis === "real-time" ? "power-real-time" : "power-day-ahead")), hashprice: fields(telegraph("hashprice")) },
      recovered: used.some((e) => e.recovery !== undefined && e.accepted),
      carried: used.some((e) => e.carried !== undefined),
      provisional: d.revisitAt !== undefined,
      telegraphCostUsd: plan.projectedPaidCostUsd,
      paidAnswers: plan.evidence.filter((e) => e.source.kind !== "public" && !e.carried && e.receipt.receiptHash !== undefined).length,
      publicCalls: plan.evidence.filter((e) => e.source.kind === "public").length + 2,
      ms,
    },
  };
}

export const quarterOf = (ms: number) => Math.floor(ms / QUARTER) * QUARTER;
