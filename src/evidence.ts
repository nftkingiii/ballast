import type { PublicSources } from "./sources.ts";
import { ENGINE_ASK_USD, Budget, TransportError, type Answer, type AskRequest, type Transport } from "./telegraph.ts";
import type { Check, Evidence, Gap, SiteConfig, Source } from "./types.ts";

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
}

export interface HashpriceInput {
  usdPerPhDay: number | null;
  evidence: string[];
  gaps: Gap[];
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
    const r = answer.result;
    const sats = r.hashprice_sats_per_ph_day;
    const usd = finite(r.hashprice_usd_per_ph_day) && r.hashprice_usd_per_ph_day > 0 ? r.hashprice_usd_per_ph_day : finite(sats) ? (sats / 1e8) * reference.btcUsd : NaN;
    let bad: string | undefined;
    if (!finite(sats) || sats <= 0) bad = "no positive hashprice_sats_per_ph_day in the answer";
    else if (!finite(usd) || usd <= 0) bad = "could not express the answer in USD per PH/s per day";
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

/** Latest complete 15-minute real-time interval, or the day-ahead hour. */
export async function gatherPower(ctx: Ctx, hour: Date, market: "real-time" | "day-ahead"): Promise<{ price: number | null; evidence: string[]; gap?: Gap }> {
  const { site } = ctx;
  const start = market === "day-ahead" ? hour : new Date(Math.floor(ctx.now.getTime() / QUARTER) * QUARTER - QUARTER);
  const check: Check = market === "day-ahead" ? "power-day-ahead" : "power-real-time";
  const subject = `${site.node} ${market} ${iso(start.getTime())}`;
  const params = { node_or_zone: site.node, interval_start: iso(start.getTime()) };
  const evidence: string[] = [];

  const got = await ask(ctx, check, subject, {
    intent: INTENTS.power, minerId: site.intelligence.providers.power, params,
    native: { method: "GET", endpoint: "/price", payload: { ...params, market } },
  });
  if (!got.ok) {
    if (got.evidence) evidence.push(got.evidence.id);
    return { price: null, evidence, gap: got.gap };
  }
  evidence.push(got.evidence.id);
  const r = got.answer.result;
  const maxAge = market === "real-time" ? site.intelligence.maxAgeMin.realTime : site.intelligence.maxAgeMin.dayAhead;
  let bad: string | undefined;
  if (!finite(r.lmp_usd_per_mwh) || r.lmp_usd_per_mwh < -2000 || r.lmp_usd_per_mwh > 20000) bad = "no usable lmp_usd_per_mwh in the answer";
  else if (String(r.node_or_zone ?? "").toUpperCase() !== site.node) bad = `answer is for ${String(r.node_or_zone)}, not ${site.node}`;
  else if (String(r.market ?? "").toLowerCase() !== market) bad = `asked for ${market} but the provider answered ${String(r.market)}`;
  else if (!sameInstant(r.interval_start, start)) bad = `stale or substituted interval: asked ${iso(start.getTime())}, got ${String(r.interval_start)}`;
  else if (tooOld(ctx, got.answer.answeredAt, maxAge)) bad = `stale: answered at ${got.answer.answeredAt}, older than ${maxAge} minutes`;
  else if (market === "real-time" && ctx.now.getTime() - (start.getTime() + QUARTER) > maxAge * 60_000) bad = `stale: the interval ended more than ${maxAge} minutes ago`;
  if (bad) return { price: null, evidence, gap: { check, subject, reason: `${got.evidence.source.name}: ${reject(got.evidence, bad)}` } };
  const lmp = r.lmp_usd_per_mwh as number;

  // Free public cross-check of the same quantity. Disagreement beyond tolerance means we do not know which is right.
  const ref = await ctx.pub.ercotPrice(site.node, market, start).catch(() => null);
  if (!ref) {
    evidence.push(publicEvidence(ctx, check, subject, "public ERCOT archive", params, {}, false, "cross-check unavailable").id);
    return { price: lmp, evidence };
  }
  const pe = publicEvidence(ctx, check, subject, ref.source, params, { lmp_usd_per_mwh: ref.lmp });
  evidence.push(pe.id);
  const t = site.intelligence.tolerances;
  if (!agree(lmp, ref.lmp, t.priceUsd, t.pricePct)) {
    const reason = `providers disagree: ${got.evidence.source.name} says ${lmp}, public ERCOT archive says ${ref.lmp} USD/MWh (tolerance max($${t.priceUsd}, ${t.pricePct}%))`;
    reject(got.evidence, reason);
    return { price: null, evidence, gap: { check, subject, reason } };
  }
  return { price: lmp, evidence };
}

export async function gatherPowerHour(ctx: Ctx, hour: Date): Promise<PowerInput> {
  const current = ctx.now.getTime() >= hour.getTime() && ctx.now.getTime() < hour.getTime() + HOUR;
  const evidence: string[] = [];
  const notes: string[] = [];
  let firstGap: Gap | undefined;
  if (current) {
    const rt = await gatherPower(ctx, hour, "real-time");
    evidence.push(...rt.evidence);
    if (rt.price !== null) return { basis: "real-time", price: rt.price, evidence, notes };
    firstGap = rt.gap;
    if (rt.gap?.check === "budget") return { basis: "none", price: null, evidence, notes, gap: rt.gap };
    notes.push(`real-time price not usable (${rt.gap?.reason ?? "unknown"}); fell back to day-ahead`);
  }
  const da = await gatherPower(ctx, hour, "day-ahead");
  evidence.push(...da.evidence);
  if (da.price !== null) return { basis: "day-ahead", price: da.price, evidence, notes };
  return { basis: "none", price: null, evidence, notes, gap: da.gap ?? firstGap };
}
