import type { PublicSources } from "./sources.ts";
import { ENGINE_ASK_USD, Budget, TransportError, type Answer, type AskRequest, type Transport } from "./telegraph.ts";
import { mayReuse, type CarriedHashprice } from "./reuse.ts";
import type { Check, Evidence, Gap, Mode, SiteConfig, Source } from "./types.ts";

export const INTENTS = {
  power: "GRID_POWER_PRICE_GENERAL",
  hashprice: "MINING_HASHPRICE_VERIFY_GENERAL",
  weather: "WEATHER_FORECAST_VERIFY_GENERAL",
} as const;

const KNOWN_MINERS: Record<string, string> = {
  "7310042": "Pecos ERCOT Power Prices",
  "4283": "Gauge",
  "67008": "Blockchair BTC Stats",
  "76001": "Open-Meteo Hourly Forecast Verify",
};

const HOUR = 3_600_000;
const QUARTER = 900_000;

export interface Ctx {
  site: SiteConfig;
  transport: Transport;
  pub: PublicSources;
  budget: Budget;
  now: Date;
  evidence: Evidence[];
}

export interface PowerInput {
  basis: "real-time" | "day-ahead" | "none";
  price: number | null;
  evidence: string[];
  notes: string[];
  gap?: Gap;
  /** The price is provisional: decide again after this time, when more of the hour is published. */
  revisitAt?: string;
}

export interface HashpriceInput {
  usdPerPhDay: number | null;
  evidence: string[];
  gaps: Gap[];
  /** The public reference at fetch time, when it was read. */
  reference?: number;
  /** Set when usdPerPhDay is an earlier accepted answer standing in for a fresh one. */
  carried?: { acceptedAt: string; ageMin: number; windowMin: number; provider: string; receipt: string; because: string };
  /** The accepted answer to keep for the next run (the fresh one, or the unchanged earlier one when carried). */
  memory?: CarriedHashprice;
}

export interface WeatherInput {
  required: boolean;
  tempC: Record<string, number>;
  trusted: boolean;
  evidence: string[];
  gaps: Gap[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A number from a number or a plain numeric string ("47,572" too); NaN otherwise. */
const num = (v: unknown): number => {
  if (finite(v)) return v;
  if (typeof v === "string" && /^\s*-?[\d,]+(\.\d+)?\s*$/.test(v)) return Number(v.replace(/,/g, ""));
  return NaN;
};

/** Lifts a single nested object (e.g. { result: {...} } or { answer: {...} }) so restated answers read the same. */
function flattenAnswer(result: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["result", "answer", "data", "response"]) {
    const inner = result[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return { ...(inner as Record<string, unknown>), ...result };
  }
  return { ...result };
}
const sameInstant = (a: unknown, b: Date) => typeof a === "string" && Date.parse(a) === b.getTime();

function record(ctx: Ctx, e: Omit<Evidence, "id">): Evidence {
  const full = { id: `E${ctx.evidence.length + 1}`, ...e };
  ctx.evidence.push(full);
  return full;
}

function telegraphSource(ctx: Ctx, minerId: string): Source {
  const name = KNOWN_MINERS[minerId] ?? `miner ${minerId}`;
  return ctx.transport.kind === "fixture"
    ? { kind: "fixture", id: minerId, name: `${name} (recorded stand-in, not a Telegraph answer)` }
    : { kind: "telegraph", id: minerId, name };
}

function publicEvidence(ctx: Ctx, check: Check, subject: string, source: string, params: Record<string, unknown>, result: Record<string, unknown>, accepted = true, reason?: string): Evidence {
  return record(ctx, {
    check, subject, source: { kind: "public", id: "keyless", name: source }, requestedAt: iso(ctx.now.getTime()), answeredAt: iso(ctx.now.getTime()),
    costUsd: 0, receipt: {}, params, result, accepted, reason,
  });
}

function nativeFor(ctx: Ctx, minerId: string, payload: Record<string, unknown>): AskRequest["native"] {
  const endpoint = ctx.site.intelligence.endpoints[minerId];
  return endpoint ? { method: "GET", endpoint, payload } : undefined;
}

type Asked = { ok: true; answer: Answer; evidence: Evidence } | { ok: false; gap: Gap; evidence?: Evidence };

/** Buys one Telegraph answer within the budget. Failures are recorded as evidence and returned as gaps, never papered over. */
async function ask(ctx: Ctx, check: Check, subject: string, request: Omit<AskRequest, "maxCostUsd">): Promise<Asked> {
  if (!ctx.budget.reserve(ENGINE_ASK_USD)) {
    return { ok: false, gap: { check: "budget", subject, reason: `spend cap $${ctx.budget.capUsd.toFixed(2)} reached ($${ctx.budget.spentUsd.toFixed(2)} spent); no further intelligence bought` } };
  }
  const requestedAt = iso(ctx.now.getTime());
  const remaining = ctx.budget.capUsd - ctx.budget.spentUsd;
  try {
    const answer = await ctx.transport.ask({ ...request, maxCostUsd: Math.max(ENGINE_ASK_USD, Math.min(0.3, remaining)) });
    // A fixture replay is free, but counts as a projected paid call so the demo respects the cap the same way.
    const charged = ctx.transport.kind === "fixture" ? ENGINE_ASK_USD : answer.costUsd;
    ctx.budget.record(charged);
    const evidence = record(ctx, {
      check, subject, source: telegraphSource(ctx, answer.minerId), requestedAt, answeredAt: answer.answeredAt, costUsd: answer.costUsd,
      receipt: answer.receipt, params: request.native?.payload ?? request.params, result: answer.result, accepted: true,
    });
    return { ok: true, answer, evidence };
  } catch (error) {
    const reason = error instanceof TransportError ? error.message : `unexpected error: ${(error as Error).message}`;
    const evidence = record(ctx, {
      check, subject, source: telegraphSource(ctx, request.minerId), requestedAt, answeredAt: requestedAt, costUsd: 0, receipt: {},
      params: request.native?.payload ?? request.params, result: {}, accepted: false, reason,
    });
    return { ok: false, gap: { check, subject, reason: `${evidence.source.name} gave no answer: ${reason}` }, evidence };
  }
}

const reject = (e: Evidence, reason: string): string => {
  e.accepted = false;
  e.reason = reason;
  return reason;
};

const agree = (a: number, b: number, absTol: number, pctTol: number) => Math.abs(a - b) <= Math.max(absTol, (pctTol / 100) * Math.abs((a + b) / 2));

function tooOld(ctx: Ctx, answeredAt: string, maxMin: number): boolean {
  return ctx.now.getTime() - Date.parse(answeredAt) > maxMin * 60_000;
}

export async function gatherHashprice(ctx: Ctx): Promise<HashpriceInput> {
  const { site } = ctx;
  const out: HashpriceInput = { usdPerPhDay: null, evidence: [], gaps: [] };
  let tip: number;
  let reference: Awaited<ReturnType<PublicSources["hashprice"]>>;
  try {
    [tip, reference] = await Promise.all([ctx.pub.tipHeight(), ctx.pub.hashprice()]);
  } catch (error) {
    out.gaps.push({ check: "hashprice", subject: "block tip", reason: `could not read the chain tip or the public reference: ${(error as Error).message}` });
    return out;
  }
  out.reference = reference.usdPerPhDay;
  const publicRef = publicEvidence(ctx, "hashprice", `block ${tip}`, reference.source, { block_height: tip }, {
    hashprice_usd_per_ph_day: reference.usdPerPhDay, btc_usd: reference.btcUsd, hashrate_eh_s: reference.hashrateEhS,
  });
  out.evidence.push(publicRef.id);

  const accepted: { usd: number; evidence: Evidence }[] = [];
  for (const minerId of site.intelligence.providers.hashprice) {
    const params = { block_height: tip };
    const got = await ask(ctx, "hashprice", `block ${tip}`, { intent: INTENTS.hashprice, minerId, params, native: nativeFor(ctx, minerId, params) });
    if (!got.ok) {
      out.gaps.push(got.gap);
      if (got.evidence) out.evidence.push(got.evidence.id);
      if (got.gap.check === "budget") break;
      continue;
    }
    const { evidence, answer } = got;
    out.evidence.push(evidence.id);
    const r = flattenAnswer(answer.result);
    // Anjoman's agent may restate the miner's JSON: numbers as strings, nesting, or USD only. Read either unit,
    // convert with the public BTC price, and keep what arrived when it can't be read.
    let sats = num(r.hashprice_sats_per_ph_day);
    let usd = num(r.hashprice_usd_per_ph_day);
    if (!(sats > 0) && usd > 0) sats = (usd / reference.btcUsd) * 1e8;
    if (!(usd > 0) && sats > 0) usd = (sats / 1e8) * reference.btcUsd;
    if (finite(r.block_height) === false && num(r.block_height) > 0) r.block_height = num(r.block_height);
    let bad: string | undefined;
    if (!(sats > 0) || !(usd > 0)) bad = `no positive hashprice (sats or USD per PH/s per day) in the answer: ${JSON.stringify(answer.result).slice(0, 160)}`;
    else if (finite(r.block_height) && tip - r.block_height > site.intelligence.maxBlocksBehind) bad = `stale: answer is for block ${r.block_height}, chain tip is ${tip}`;
    else if (tooOld(ctx, answer.answeredAt, site.intelligence.maxAgeMin.hashprice)) bad = `stale: answered at ${answer.answeredAt}`;
    if (bad) {
      out.gaps.push({ check: "hashprice", subject: `block ${tip}`, reason: `${evidence.source.name}: ${reject(evidence, bad)}` });
      continue;
    }
    accepted.push({ usd, evidence });
  }

  // Every accepted answer must agree with the public reference and with each other.
  const tol = site.intelligence.tolerances.hashpricePct;
  for (const a of accepted) {
    if (!agree(a.usd, reference.usdPerPhDay, 0, tol)) {
      const reason = `disagrees with the public reference: ${a.usd.toFixed(2)} vs ${reference.usdPerPhDay.toFixed(2)} USD/PH/day (tolerance ${tol}%)`;
      out.gaps.push({ check: "hashprice", subject: `block ${tip}`, reason: `${a.evidence.source.name} ${reject(a.evidence, reason)}` });
    }
  }
  const live = accepted.filter((a) => a.evidence.accepted);
  const spread = live.length > 1 && live.some((a) => !agree(a.usd, live[0]!.usd, 0, tol));
  if (spread) {
    out.gaps.push({ check: "hashprice", subject: `block ${tip}`, reason: `Telegraph providers disagree beyond ${tol}%: ${live.map((a) => `${a.evidence.source.id}=${a.usd.toFixed(2)}`).join(", ")}` });
    for (const a of live) reject(a.evidence, "providers disagree");
    return out;
  }
  if (live.length === 0) {
    if (out.gaps.length === 0) out.gaps.push({ check: "hashprice", subject: `block ${tip}`, reason: "no hashprice provider is configured" });
    return out;
  }
  out.usdPerPhDay = live[0]!.usd;
  return out;
}

export async function gatherWeather(ctx: Ctx, hours: string[]): Promise<WeatherInput> {
  const { site } = ctx;
  const out: WeatherInput = { required: Boolean(site.heat), tempC: {}, trusted: true, evidence: [], gaps: [] };
  if (!site.heat) return out;
  try {
    const f = await ctx.pub.forecast(site.location.lat, site.location.lon);
    for (const h of hours) if (finite(f.hourlyC[h])) out.tempC[h] = f.hourlyC[h]!;
    out.evidence.push(publicEvidence(ctx, "weather-forecast", site.location.name, f.source, { lat: site.location.lat, lon: site.location.lon }, { hours: hours.length, found: Object.keys(out.tempC).length }).id);
  } catch (error) {
    out.gaps.push({ check: "weather-forecast", subject: site.location.name, reason: `no hourly temperature forecast: ${(error as Error).message}` });
  }

  // Telegraph's weather intent verifies a past day, so use it to prove the weather data can be trusted.
  const date = iso(ctx.now.getTime() - 24 * HOUR).slice(0, 10);
  const observed = await ctx.pub.observedHigh(site.location.lat, site.location.lon, date).catch(() => null);
  if (observed) {
    out.evidence.push(publicEvidence(ctx, "weather-verify", date, observed.source, { date }, { temp_max_c: observed.highC }).id);
  }
  let verified = 0;
  for (const minerId of site.intelligence.providers.weather) {
    const params = { location: site.location.name, date };
    const got = await ask(ctx, "weather-verify", date, { intent: INTENTS.weather, minerId, params, native: nativeFor(ctx, minerId, params) });
    if (!got.ok) {
      out.gaps.push(got.gap);
      if (got.evidence) out.evidence.push(got.evidence.id);
      out.trusted = false;
      if (got.gap.check === "budget") break;
      continue;
    }
    out.evidence.push(got.evidence.id);
    const high = got.answer.result.temp_max_c;
    let bad: string | undefined;
    if (!finite(high)) bad = "no temp_max_c in the answer";
    else if (tooOld(ctx, got.answer.answeredAt, site.intelligence.maxAgeMin.weather)) bad = `stale: answered at ${got.answer.answeredAt}`;
    else if (!observed) bad = "no public observation to check it against";
    else if (Math.abs(high - observed.highC) > site.intelligence.tolerances.weatherC) {
      bad = `disagrees with the public observation: ${high}C vs ${observed.highC}C for ${date} (tolerance ${site.intelligence.tolerances.weatherC}C)`;
    }
    if (bad) {
      out.gaps.push({ check: "weather-verify", subject: date, reason: `${got.evidence.source.name}: ${reject(got.evidence, bad)}` });
      out.trusted = false;
    } else verified += 1;
  }
  if (verified === 0) {
    out.trusted = false;
    if (out.gaps.every((g) => g.check !== "weather-verify" && g.check !== "budget")) {
      out.gaps.push({ check: "weather-verify", subject: date, reason: "no weather verification was obtained" });
    }
  }
  return out;
}


const stamp = (ms: number) => iso(ms).slice(11, 16);
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Hashprice for a run: a fresh accepted answer when there is one; otherwise an earlier accepted answer (`prior`) when the fresh
 * one failed by outage, the earlier one is inside the site's freshness window and it still agrees with the free public
 * reference. The carried item keeps its original provider, answer time and receipt and says "carried from <time>"; the failed
 * fresh attempt stays in the evidence and the gaps, so nothing is hidden. Monitor mode applies the same test (mayReuse).
 */
export async function resolveHashprice(ctx: Ctx, prior: CarriedHashprice | undefined, mode: Mode): Promise<HashpriceInput> {
  const { site } = ctx;
  const fresh = await gatherHashprice(ctx);
  if (fresh.usdPerPhDay !== null) {
    const e = ctx.evidence.find((x) => fresh.evidence.includes(x.id) && x.check === "hashprice" && x.source.kind !== "public" && x.accepted);
    if (e) {
      fresh.memory = {
        usdPerPhDay: fresh.usdPerPhDay, mode, acceptedAt: iso(ctx.now.getTime()), answeredAt: e.answeredAt, source: e.source, receipt: e.receipt,
        subject: e.subject, params: e.params, result: e.result,
      };
    }
    return fresh;
  }
  if (!prior) return fresh;
  fresh.memory = prior;
  const windowMin = site.intelligence.maxAgeMin.hashpriceCarry;
  const label = `${prior.source.name.replace(/ \(recorded stand-in.*$/, "")} accepted ${prior.acceptedAt.slice(0, 16)}Z`;
  if (prior.mode !== mode) {
    fresh.gaps.push({ check: "hashprice", subject: prior.subject, reason: `an earlier hashprice (${label}) was kept from a ${prior.mode} run, so it is not reused in a ${mode} run` });
    return fresh;
  }
  const verdict = mayReuse({ gaps: fresh.gaps, ageMs: ctx.now.getTime() - Date.parse(prior.acceptedAt), windowMin });
  if (!verdict.ok) {
    fresh.gaps.push({ check: "hashprice", subject: prior.subject, reason: `the last accepted hashprice (${label}) is not reused: ${verdict.why}` });
    return fresh;
  }
  const tol = site.intelligence.tolerances.hashpricePct;
  if (fresh.reference !== undefined && !agree(prior.usdPerPhDay, fresh.reference, 0, tol)) {
    fresh.gaps.push({
      check: "hashprice", subject: prior.subject,
      reason: `the last accepted hashprice (${label}, ${prior.usdPerPhDay.toFixed(2)}) is not reused: it is more than ${tol}% from the public reference ${fresh.reference.toFixed(2)} USD/PH/day now`,
    });
    return fresh;
  }
  const because = fresh.gaps[0]?.reason ?? "no fresh answer";
  const carried = { acceptedAt: prior.acceptedAt, ageMin: verdict.ageMin, windowMin, provider: prior.source.name, receipt: prior.receipt.receiptHash ?? prior.receipt.jobId ?? prior.receipt.signalHash ?? "-", because };
  const item = record(ctx, {
    check: "hashprice", subject: `${prior.subject}, carried from ${prior.acceptedAt.slice(0, 16)}Z`, source: prior.source, requestedAt: iso(ctx.now.getTime()), answeredAt: prior.answeredAt,
    costUsd: 0, receipt: prior.receipt, params: prior.params, result: prior.result, accepted: true, carried: { acceptedAt: prior.acceptedAt, ageMin: verdict.ageMin, windowMin, because },
  });
  fresh.usdPerPhDay = prior.usdPerPhDay;
  fresh.evidence.push(item.id);
  fresh.carried = carried;
  return fresh;
}

export interface PowerResult {
  price: number | null;
  evidence: string[];
  gap?: Gap;
  /** What was recovered or estimated, in words, for the decision's reasons. */
  notes: string[];
}

const latestIntervalStart = (ctx: Ctx): Date => new Date(Math.floor(ctx.now.getTime() / QUARTER) * QUARTER - QUARTER);

interface Verdict {
  bad?: string;
  /** The provider answered a different market or interval from the one asked: asking again or reading the archive can fix it. */
  recoverable: boolean;
}

function judgePower(ctx: Ctx, r: Record<string, unknown>, answeredAt: string, market: "real-time" | "day-ahead", start: Date): Verdict {
  const { site } = ctx;
  const maxAge = market === "real-time" ? site.intelligence.maxAgeMin.realTime : site.intelligence.maxAgeMin.dayAhead;
  if (!finite(r.lmp_usd_per_mwh) || r.lmp_usd_per_mwh < -2000 || r.lmp_usd_per_mwh > 20000) return { bad: "no usable lmp_usd_per_mwh in the answer", recoverable: false };
  if (String(r.node_or_zone ?? "").toUpperCase() !== site.node) return { bad: `answer is for ${String(r.node_or_zone)}, not ${site.node}`, recoverable: false };
  if (String(r.market ?? "").toLowerCase() !== market) return { bad: `asked for ${market} but the provider answered ${String(r.market)}`, recoverable: true };
  if (!sameInstant(r.interval_start, start)) return { bad: `stale or substituted interval: asked ${iso(start.getTime())}, got ${String(r.interval_start)}`, recoverable: true };
  if (tooOld(ctx, answeredAt, maxAge)) return { bad: `stale: answered at ${answeredAt}, older than ${maxAge} minutes`, recoverable: false };
  if (market === "real-time" && ctx.now.getTime() - (start.getTime() + QUARTER) > maxAge * 60_000) return { bad: `stale: the interval ended more than ${maxAge} minutes ago`, recoverable: false };
  return { recoverable: false };
}

type PowerAsk = { check: Check; subject: string; params: Record<string, unknown>; market: "real-time" | "day-ahead"; start: Date };

/** Free public cross-check of the same quantity. Disagreement beyond tolerance means we do not know which is right. */
async function crossCheck(ctx: Ctx, a: PowerAsk & { answer: Evidence; lmp: number; evidence: string[] }): Promise<PowerResult> {
  const { site } = ctx;
  const ref = await ctx.pub.ercotPrice(site.node, a.market, a.start).catch(() => null);
  if (!ref) {
    a.evidence.push(publicEvidence(ctx, a.check, a.subject, "public ERCOT archive", a.params, {}, false, "cross-check unavailable").id);
    return { price: a.lmp, evidence: a.evidence, notes: [] };
  }
  a.evidence.push(publicEvidence(ctx, a.check, a.subject, ref.source, a.params, { lmp_usd_per_mwh: ref.lmp }).id);
  const t = site.intelligence.tolerances;
  if (!agree(a.lmp, ref.lmp, t.priceUsd, t.pricePct)) {
    const reason = `providers disagree: ${a.answer.source.name} says ${a.lmp}, public ERCOT archive says ${ref.lmp} USD/MWh (tolerance max($${t.priceUsd}, ${t.pricePct}%))`;
    reject(a.answer, reason);
    return { price: null, evidence: a.evidence, gap: { check: a.check, subject: a.subject, reason }, notes: [] };
  }
  return { price: a.lmp, evidence: a.evidence, notes: [] };
}

/**
 * The answer was for the wrong market or interval. Ask the provider again once (if the site allows and the cap does), then read
 * the public ERCOT archive for that exact interval (labelled public: no receipt and no second opinion). Returns null when
 * neither gives a valid price, and the caller falls back or holds as before.
 */
async function recoverPower(ctx: Ctx, a: PowerAsk & { request: Omit<AskRequest, "maxCostUsd">; first: Evidence; why: string; evidence: string[] }): Promise<PowerResult | null> {
  const { site } = ctx;
  const when = `${site.node} ${a.market} ${iso(a.start.getTime())}`;
  const first = a.first.source.name.replace(/ \(recorded stand-in.*$/, "");
  let askedAgain = false;
  if (site.intelligence.recovery.reask) {
    const again = await ask(ctx, a.check, a.subject, a.request);
    if (again.ok) {
      askedAgain = true;
      again.evidence.recovery = { of: a.first.id, via: "re-ask", note: `asked again after: ${a.why}` };
      a.evidence.push(again.evidence.id);
      const v = judgePower(ctx, again.answer.result, again.answer.answeredAt, a.market, a.start);
      if (v.bad) reject(again.evidence, v.bad);
      else {
        const done = await crossCheck(ctx, { ...a, answer: again.evidence, lmp: again.answer.result.lmp_usd_per_mwh as number });
        return { ...done, notes: done.price !== null ? [`recovered: ${first} first answered the wrong thing (${a.why}); asking again for ${when} gave a valid answer (${again.evidence.id})`] : [] };
      }
    } else if (again.evidence) a.evidence.push(again.evidence.id);
  }
  if (site.intelligence.recovery.publicArchive) {
    const ref = await ctx.pub.ercotPrice(site.node, a.market, a.start).catch(() => null);
    if (ref && finite(ref.lmp) && ref.lmp >= -2000 && ref.lmp <= 20000) {
      const item = publicEvidence(ctx, a.check, a.subject, ref.source, a.params, { lmp_usd_per_mwh: ref.lmp });
      item.recovery = { of: a.first.id, via: "public-archive", note: `${first} answered the wrong thing (${a.why})` };
      a.evidence.push(item.id);
      return {
        price: ref.lmp, evidence: a.evidence,
        notes: [`recovered: ${first} answered the wrong thing (${a.why})${askedAgain ? " and again when asked a second time" : ""}; used the public ERCOT archive for exactly ${when}: $${ref.lmp} (public data, not a Telegraph answer, no receipt, no second opinion; ${item.id})`],
      };
    }
  }
  return null;
}

async function gatherPowerAt(ctx: Ctx, start: Date, market: "real-time" | "day-ahead"): Promise<PowerResult> {
  const { site } = ctx;
  const check: Check = market === "day-ahead" ? "power-day-ahead" : "power-real-time";
  const subject = `${site.node} ${market} ${iso(start.getTime())}`;
  const params = { node_or_zone: site.node, interval_start: iso(start.getTime()) };
  const evidence: string[] = [];
  const request: Omit<AskRequest, "maxCostUsd"> = {
    intent: INTENTS.power, minerId: site.intelligence.providers.power, params,
    native: { method: "GET", endpoint: "/price", payload: { ...params, market } },
  };

  const got = await ask(ctx, check, subject, request);
  if (!got.ok) {
    if (got.evidence) evidence.push(got.evidence.id);
    return { price: null, evidence, gap: got.gap, notes: [] };
  }
  evidence.push(got.evidence.id);
  const verdict = judgePower(ctx, got.answer.result, got.answer.answeredAt, market, start);
  if (verdict.bad) {
    const gap = { check, subject, reason: `${got.evidence.source.name}: ${reject(got.evidence, verdict.bad)}` };
    const rec = site.intelligence.recovery;
    if (verdict.recoverable && (rec.reask || rec.publicArchive)) {
      const recovered = await recoverPower(ctx, { check, subject, params, market, start, request, first: got.evidence, why: verdict.bad, evidence });
      if (recovered) return recovered.price === null && !recovered.gap ? { ...recovered, gap } : recovered;
    }
    return { price: null, evidence, gap, notes: [] };
  }
  return crossCheck(ctx, { check, subject, params, market, start, answer: got.evidence, lmp: got.answer.result.lmp_usd_per_mwh as number, evidence });
}

/** Latest complete 15-minute real-time interval, or the day-ahead hour. Recovers once from a wrong-market or wrong-interval answer. */
export async function gatherPower(ctx: Ctx, hour: Date, market: "real-time" | "day-ahead"): Promise<PowerResult> {
  return gatherPowerAt(ctx, market === "day-ahead" ? hour : latestIntervalStart(ctx), market);
}

export interface HourEstimate {
  price: number;
  notes: string[];
  evidence: string[];
  revisitAt?: string;
}

/**
 * Prices the current hour. ERCOT settles an hour as the mean of its four 15-minute prices, so the best estimate uses the
 * intervals already published for this hour as they are and repeats the latest one for the rest. Day-ahead is not used for the
 * rest: on the saved window it was a worse stand-in than the latest interval (see compare/results.md). When no interval of the
 * hour is published yet, the price is the previous hour's last interval and is labelled provisional with the time to decide again.
 */
export async function estimateHour(ctx: Ctx, hour: Date, latest: { price: number; start: Date }): Promise<HourEstimate> {
  const cfg = ctx.site.planning.hourEstimate;
  if (cfg.mode === "latest-interval") return { price: latest.price, notes: [], evidence: [] };
  const now = ctx.now.getTime();
  const hourMs = hour.getTime();
  const starts = [0, 1, 2, 3].map((k) => hourMs + k * QUARTER).filter((s) => s + QUARTER <= now);
  if (starts.length === 0) {
    return {
      price: latest.price, evidence: [], revisitAt: iso(hourMs + QUARTER),
      notes: [`provisional: no 15-minute interval of this hour is published yet (the first, ${stamp(hourMs)}, ends at ${stamp(hourMs + QUARTER)}Z), so the hour is priced at the last interval of the previous hour, $${latest.price}; decide again after ${stamp(hourMs + QUARTER)}Z`],
    };
  }
  const values = new Map<number, number>([[latest.start.getTime(), latest.price]]);
  const evidence: string[] = [];
  let unreadable = 0;
  for (const s of starts) {
    if (values.has(s)) continue;
    if (cfg.earlierIntervals === "telegraph") {
      const got = await gatherPowerAt(ctx, new Date(s), "real-time");
      evidence.push(...got.evidence);
      if (got.price !== null) values.set(s, got.price);
      else unreadable += 1;
      continue;
    }
    const ref = await ctx.pub.ercotPrice(ctx.site.node, "real-time", new Date(s)).catch(() => null);
    if (ref && finite(ref.lmp)) {
      values.set(s, ref.lmp);
      evidence.push(publicEvidence(ctx, "power-real-time", `${ctx.site.node} real-time ${iso(s)}`, ref.source, { node_or_zone: ctx.site.node, interval_start: iso(s) }, { lmp_usd_per_mwh: ref.lmp }).id);
    } else unreadable += 1;
  }
  const known = [...values.entries()].sort((a, b) => a[0] - b[0]);
  const price = cents((known.reduce((sum, [, v]) => sum + v, 0) + (4 - known.length) * latest.price) / 4);
  const where = cfg.earlierIntervals === "telegraph" ? "from the provider" : "from the public ERCOT archive, public and not a Telegraph answer";
  const note =
    known.length === 1
      ? `hour estimate: ${stamp(known[0]![0])} is the only interval published for this hour ($${latest.price}); the other 3 are assumed to repeat it, so the hour is $${price}/MWh`
      : `hour estimate: ${known.length} of 4 intervals are published for this hour (${known.map(([s, v]) => `${stamp(s)} $${v}`).join(", ")}; the earlier ones ${where}); the other ${4 - known.length} are assumed to repeat the latest ($${latest.price}), so the hour is $${price}/MWh rather than the latest interval alone`;
  return { price, evidence, notes: [note, ...(unreadable ? [`${unreadable} published interval${unreadable === 1 ? "" : "s"} of this hour could not be read and ${unreadable === 1 ? "was" : "were"} not used`] : [])] };
}

export async function gatherPowerHour(ctx: Ctx, hour: Date): Promise<PowerInput> {
  const current = ctx.now.getTime() >= hour.getTime() && ctx.now.getTime() < hour.getTime() + HOUR;
  const evidence: string[] = [];
  const notes: string[] = [];
  let firstGap: Gap | undefined;
  if (current) {
    const rt = await gatherPower(ctx, hour, "real-time");
    evidence.push(...rt.evidence);
    if (rt.price !== null) {
      const est = await estimateHour(ctx, hour, { price: rt.price, start: latestIntervalStart(ctx) });
      evidence.push(...est.evidence);
      return { basis: "real-time", price: est.price, evidence, notes: [...rt.notes, ...est.notes], revisitAt: est.revisitAt };
    }
    firstGap = rt.gap;
    if (rt.gap?.check === "budget") return { basis: "none", price: null, evidence, notes, gap: rt.gap };
    notes.push(`real-time price not usable (${rt.gap?.reason ?? "unknown"}); fell back to day-ahead`);
  }
  const da = await gatherPower(ctx, hour, "day-ahead");
  evidence.push(...da.evidence);
  if (da.price !== null) return { basis: "day-ahead", price: da.price, evidence, notes: [...notes, ...da.notes] };
  return { basis: "none", price: null, evidence, notes, gap: da.gap ?? firstGap };
}
