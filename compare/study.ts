// Offline studies that justify the three fixes. They read only the saved data and apply Ballast's own decideHour, so a different
// rule can be tried without touching the planner. None of them is a claim about future prices: each is a measurement on 89 hours.
import { decideHour } from "../src/decide.ts";
import type { SiteConfig } from "../src/types.ts";
import { HOUR, loadHashpriceSeries, QUARTER, type Truth } from "./model.ts";
import { oracle, profitAt, trueEconomics, type World } from "./world.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const MINUTES = [1, 14, 16, 31, 46] as const;

export type EstimatorId = "latest-interval" | "hour-estimate" | "half-day-ahead" | "all-day-ahead";

export const ESTIMATORS: { id: EstimatorId; title: string }[] = [
  { id: "latest-interval", title: "whole hour at the latest complete interval (before)" },
  { id: "hour-estimate", title: "published intervals as they are, latest repeated for the rest (chosen)" },
  { id: "half-day-ahead", title: "published intervals, the rest half day-ahead and half latest" },
  { id: "all-day-ahead", title: "published intervals, the rest at day-ahead (the textbook suggestion)" },
];

/** The price each estimator would put on `hour` when deciding `minute` minutes past it. Same information the planner has: nothing after `now`. */
export function estimate(w: World, hour: string, minute: number, id: EstimatorId): number {
  const now = Date.parse(hour) + minute * 60_000;
  const latestStart = Math.floor(now / QUARTER) * QUARTER - QUARTER;
  const latest = w.rt.get(iso(latestStart))!;
  const known = [0, 1, 2, 3].map((k) => Date.parse(hour) + k * QUARTER).filter((s) => s + QUARTER <= now).map((s) => w.rt.get(iso(s))!);
  if (id === "latest-interval" || known.length === 0) return latest;
  const da = w.da.get(hour)!;
  const rest = id === "hour-estimate" ? latest : id === "half-day-ahead" ? (latest + da) / 2 : da;
  return (sum(known) + (4 - known.length) * rest) / 4;
}

export interface StudyRow {
  wrong: number;
  shortfallUsd: number;
  meanAbsErrorUsdPerMwh: number;
  realizedUsd: number;
}

function score(site: SiteConfig, w: World, hours: string[], price: (h: string) => number): StudyRow {
  let wrong = 0, shortfall = 0, abs = 0, realized = 0;
  for (const h of hours) {
    const p = price(h);
    const d = decideHour(site, {
      hour: h, hashpriceUsdPerPhDay: w.hashprice(h).usdPerPhDay, hashpriceGaps: [], tempC: undefined, weatherRequired: false, weatherTrusted: true, weatherGaps: [],
      evidence: [], forward: false, power: { basis: "real-time", price: p, evidence: [], notes: [] },
    });
    if (d.action !== oracle(site, w, h).action) wrong += 1;
    const profit = profitAt(site, w, h, d.runFraction);
    realized += profit;
    shortfall += trueEconomics(site, w, h).best - profit;
    abs += Math.abs(p - w.rtHour(h));
  }
  return { wrong, shortfallUsd: r2(shortfall), meanAbsErrorUsdPerMwh: r2(abs / hours.length), realizedUsd: r2(realized) };
}

/** Each estimator at each decision minute, on the clean window and on its two halves (the rule was chosen on principle, the halves check it is not one stretch of prices). */
export function estimatorStudy(site: SiteConfig, w: World) {
  const halves = { all: w.hours, firstHalf: w.hours.slice(0, Math.floor(w.hours.length / 2)), secondHalf: w.hours.slice(Math.floor(w.hours.length / 2)) };
  return ESTIMATORS.map((e) => ({
    id: e.id,
    title: e.title,
    byMinute: MINUTES.map((minute) => ({
      minute,
      all: score(site, w, halves.all, (h) => estimate(w, h, minute, e.id)),
      firstHalf: score(site, w, halves.firstHalf, (h) => estimate(w, h, minute, e.id)),
      secondHalf: score(site, w, halves.secondHalf, (h) => estimate(w, h, minute, e.id)),
    })),
  }));
}

/**
 * How wrong is reusing an old hashprice? For each age, decide every hour at :16 with the hashprice from that long before, and
 * count the hours whose action differs from deciding with the hashprice of that moment (same price input in both, so only the
 * hashprice differs). Uses the finer mempool.space series, not the daily mean the oracle uses.
 */
export function hashpriceCarryStudy(site: SiteConfig, w: World, truth: Truth) {
  const series = loadHashpriceSeries();
  const at = (t: number) => series.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), series[0]!);
  const lo = series[0]!.t, hi = series.at(-1)!.t;
  const decideFull = (h: string, hp: number) =>
    decideHour(site, {
      hour: h, hashpriceUsdPerPhDay: hp, hashpriceGaps: [], tempC: undefined, weatherRequired: false, weatherTrusted: true, weatherGaps: [], evidence: [], forward: false,
      power: { basis: "real-time", price: w.rtHour(h), evidence: [], notes: [] },
    });
  const decide = (h: string, hp: number) => decideFull(h, hp).action;
  const mw = (site.fleet.hashrateTh * site.fleet.efficiencyJPerTh) / 1e6;
  /** What running `fraction` of the fleet for the hour earns when the hashprice really is `hp` (the settled price is the same in every case). */
  const profit = (h: string, hp: number, fraction: number) =>
    fraction * ((hp * (site.fleet.hashrateTh / 1000)) / 24 / mw - (w.rtHour(h) + site.power.adderUsdPerMwh) - site.operating.otherVariableUsdPerMwh) * mw;
  const lags = [1, 3, 6, 12, 24, 48];
  const day = (t: number) => iso(t).slice(0, 10);
  const changeStats = (ls: number, sameDay: boolean) => {
    const d: number[] = [];
    for (const p of series) {
      // Both ends inside the scored window: the daily hashrate steps at 00:00 UTC before it are not part of what is being decided.
      if (p.t - ls * HOUR < Date.parse(truth.hours[0]!) || p.t - ls * HOUR < lo) continue;
      const q = at(p.t - ls * HOUR);
      if (sameDay && day(q.t) !== day(p.t)) continue;
      if (Math.abs(q.t - (p.t - ls * HOUR)) < 20 * 60_000) d.push((Math.abs(p.usdPerPhDay / q.usdPerPhDay - 1)) * 100);
    }
    d.sort((a, b) => a - b);
    return d;
  };
  const pct = (d: number[], q: number) => (d.length ? r2(d[Math.min(d.length - 1, Math.floor(q * d.length))]!) : null);
  return lags.map((ls) => {
    const hours = truth.hours.filter((h) => Date.parse(h) + 16 * 60_000 - ls * HOUR >= lo && Date.parse(h) + 16 * 60_000 <= hi);
    const flips = hours.filter((h) => {
      const t = Date.parse(h) + 16 * 60_000;
      return decide(h, at(t).usdPerPhDay) !== decide(h, at(t - ls * HOUR).usdPerPhDay);
    }).length;
    // Dollars: deciding with the old hashprice, against deciding with the current one, and against HOLDing (which earns nothing).
    let carryLoss = 0, holdLoss = 0;
    for (const h of hours) {
      const t = Date.parse(h) + 16 * 60_000;
      const now = at(t).usdPerPhDay;
      const best = profit(h, now, decideFull(h, now).runFraction);
      carryLoss += best - profit(h, now, decideFull(h, at(t - ls * HOUR).usdPerPhDay).runFraction);
      holdLoss += best;
    }
    const d = changeStats(ls, false), same = changeStats(ls, true);
    return {
      ageHours: ls, hoursCompared: hours.length, actionFlips: flips, carryLossUsd: r2(carryLoss), holdLossUsd: r2(holdLoss),
      anyPairs: { n: d.length, medianPct: pct(d, 0.5), p90Pct: pct(d, 0.9), maxPct: d.length ? r2(d.at(-1)!) : null },
      sameDayPairs: { n: same.length, medianPct: pct(same, 0.5), p90Pct: pct(same, 0.9), maxPct: same.length ? r2(same.at(-1)!) : null },
    };
  });
}

/** Day-to-day change of the daily mean hashprice the oracle uses, in the saved window. */
export function hashpriceDayToDay(truth: Truth) {
  const days = [...new Set(truth.hours.map((h) => h.slice(0, 10)))];
  const v = days.map((d) => ({ day: d, usdPerPhDay: r2(truth.hashprice(`${d}T12:00:00.000Z`).usdPerPhDay) }));
  return v.slice(1).map((x, i) => ({ from: v[i]!.day, to: x.day, changePct: r2((100 * (x.usdPerPhDay / v[i]!.usdPerPhDay - 1))) }));
}
