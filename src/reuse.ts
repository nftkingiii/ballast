// Rules shared by plan mode and monitor mode for reusing an input Ballast already accepted when a fresh one cannot be had.
// Pure functions and plain data only, so both modes apply the same test and a carried value is described the same way.
import type { AbstainKind } from "./diff.ts";
import type { Gap, Mode, Receipt, Source } from "./types.ts";

const MIN = 60_000;

/** Which kind of problem a gap is. Precedence when several apply: budget, conflict, stale, missing. */
export function classifyGap(g: Gap): AbstainKind {
  if (g.check === "budget" || /spend cap/i.test(g.reason)) return "budget";
  if (/disagree/i.test(g.reason)) return "conflict";
  if (/stale|substituted|older than|answered at/i.test(g.reason)) return "stale";
  return "missing";
}

/** True when every gap is an outage (nothing arrived, or the budget ran out), as opposed to an answer that arrived and was wrong. */
export const outageOnly = (gaps: Gap[]): boolean => gaps.length > 0 && gaps.every((g) => ["missing", "budget"].includes(classifyGap(g)));

/**
 * A slow input (hashprice) may stand in for a fresh one only when the fresh one is missing because of an outage, not because it
 * arrived and disagreed or was stale, and only inside its freshness window. A window of 0 turns carrying off.
 */
export function mayReuse(opts: { gaps: Gap[]; ageMs: number; windowMin: number }): { ok: boolean; ageMin: number; why: string } {
  const ageMin = Math.max(0, Math.round(opts.ageMs / MIN));
  if (!(opts.windowMin > 0)) return { ok: false, ageMin, why: "carrying an earlier answer is switched off for this site" };
  if (!outageOnly(opts.gaps)) return { ok: false, ageMin, why: "the fresh answer did not fail by outage (it arrived and was refused, or the sources disagree), so an earlier one is not a substitute" };
  if (opts.ageMs > opts.windowMin * MIN) return { ok: false, ageMin, why: `the last accepted answer is ${ageMin} min old, past the ${opts.windowMin} min window` };
  return { ok: true, ageMin, why: `inside the ${opts.windowMin} min window` };
}

/** A hashprice answer Ballast accepted, kept (in memory or in a state file) so a later run can reuse it. Plain JSON. */
export interface CarriedHashprice {
  usdPerPhDay: number;
  /** demo values are never carried into paid runs, or the other way round. */
  mode: Mode;
  /** When Ballast accepted it (the original run's clock). */
  acceptedAt: string;
  /** When the provider answered, its identity and its receipt: shown unchanged when the value is carried. */
  answeredAt: string;
  source: Source;
  receipt: Receipt;
  subject: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface Memory {
  hashprice?: CarriedHashprice;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Reads a remembered hashprice defensively; anything malformed is dropped rather than trusted. */
export function parseMemory(raw: unknown): Memory {
  const h = isObj(raw) && isObj(raw.hashprice) ? raw.hashprice : undefined;
  if (!h) return {};
  const ok =
    typeof h.usdPerPhDay === "number" && Number.isFinite(h.usdPerPhDay) && h.usdPerPhDay > 0 &&
    (h.mode === "demo" || h.mode === "paid") &&
    typeof h.acceptedAt === "string" && Number.isFinite(Date.parse(h.acceptedAt)) &&
    typeof h.answeredAt === "string" && isObj(h.source) && typeof h.source.name === "string" && typeof h.source.id === "string" && isObj(h.receipt);
  return ok ? { hashprice: h as unknown as CarriedHashprice } : {};
}
