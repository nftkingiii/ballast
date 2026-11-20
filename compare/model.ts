// Ground truth for the comparison: ERCOT's own published HB_WEST settlement point prices plus a daily hashprice from mempool.space.
// Everything is read from the saved files in compare/data/, so a run reproduces without network access.
import { readFileSync } from "node:fs";
import { hashpriceUsdPerPhDay } from "../src/sources.ts";

export const HOUR = 3_600_000;
export const QUARTER = 900_000;
export const NODE = "HB_WEST";
export const OTHER_NODE = "HB_HOUSTON";

const here = (name: string) => new URL(`./data/${name}`, import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(here(name), "utf8")) as T;

interface PriceFile {
  fetchedAt: string;
  node: string;
  market: string;
  urlPattern: string;
  rows: { intervalStart: string; lmp: number | null; source: string | null }[];
}
interface MempoolFile {
  fetchedAt: string;
  sources: string[];
  rewards: { avgHeight: number; timestamp: number; avgRewards: number; USD: number }[];
  hashrate: { hashrates: { timestamp: number; avgHashrate: number }[] };
}

export interface LiveRun {
  label: string;
  runAt: string;
  answers: {
    check: string;
    minerId: string;
    minerName: string;
    subject: string;
    result: Record<string, unknown>;
    receiptHash: string;
    costUsd: number;
  }[];
  totalCostUsd: number;
  decision: { action: string; runFraction: number; marginUsdPerMwh: number };
  failures: { minerId: string; what: string }[];
  latencyPerPaidAnswerSeconds: [number, number];
  latencyNote: string;
}

export interface Latency {
  measuredAt: string;
  note: string;
  samplesMs: Record<string, number[]>;
}

export interface Truth {
  /** ISO start of every decision hour that has all four real-time intervals and a day-ahead price. */
  hours: string[];
  rt: Map<string, number>;
  da: Map<string, number>;
  other: Map<string, number>;
  /** ERCOT real-time settlement price of the hour: mean of its four 15-minute intervals. */
  rtHour(hour: string): number;
  hashprice(hour: string): { usdPerPhDay: number; btcUsd: number; hashrateEhS: number; avgHeight: number };
  meta: { rtFetchedAt: string; daFetchedAt: string; mempoolFetchedAt: string; otherFetchedAt: string; rtSource: string; daSource: string; window: [string, string] };
}

const dayOf = (iso: string) => iso.slice(0, 10);

export function loadTruth(): Truth {
  const rtFile = read<PriceFile>("ercot-rt-15min.json");
  const daFile = read<PriceFile>("ercot-da-hourly.json");
  const otherFile = read<PriceFile>("ercot-rt-hb-houston-hour-start.json");
  const mp = read<MempoolFile>("mempool-hashprice-inputs.json");

  const rt = new Map<string, number>();
  const da = new Map<string, number>();
  const other = new Map<string, number>();
  for (const r of rtFile.rows) if (r.lmp !== null) rt.set(r.intervalStart, r.lmp);
  for (const r of daFile.rows) if (r.lmp !== null) da.set(r.intervalStart, r.lmp);
  for (const r of otherFile.rows) if (r.lmp !== null) other.set(r.intervalStart, r.lmp);

  const quarters = (h: string) => [0, 1, 2, 3].map((k) => new Date(Date.parse(h) + k * QUARTER).toISOString());
  const prevQ = (h: string) => new Date(Date.parse(h) - QUARTER).toISOString();
  const hours = daFile.rows
    .map((r) => r.intervalStart)
    .filter((h) => da.has(h) && quarters(h).every((q) => rt.has(q)) && rt.has(prevQ(h)) && other.has(h));

  // Daily hashprice: that day's mean reward per block (sats) and USD price, over that day's network hashrate.
  const daily = new Map<string, { usdPerPhDay: number; btcUsd: number; hashrateEhS: number; avgHeight: number }>();
  const byDay = new Map<string, MempoolFile["rewards"]>();
  for (const e of mp.rewards) {
    const d = dayOf(new Date(e.timestamp * 1000).toISOString());
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  const hashrates = mp.hashrate.hashrates.map((h) => ({ day: dayOf(new Date(h.timestamp * 1000).toISOString()), ehs: h.avgHashrate / 1e18 }));
  for (const [day, es] of byDay) {
    const hr = hashrates.filter((h) => h.day <= day).at(-1);
    if (!hr) continue;
    const sats = es.reduce((s, e) => s + e.avgRewards, 0) / es.length;
    const usd = es.reduce((s, e) => s + e.USD, 0) / es.length;
    daily.set(day, { usdPerPhDay: hashpriceUsdPerPhDay(sats, usd, hr.ehs), btcUsd: usd, hashrateEhS: hr.ehs, avgHeight: Math.round(es.reduce((s, e) => s + e.avgHeight, 0) / es.length) });
  }

  return {
    hours,
    rt,
    da,
    other,
    rtHour: (hour) => quarters(hour).reduce((s, q) => s + rt.get(q)!, 0) / 4,
    hashprice(hour) {
      const h = daily.get(dayOf(hour));
      if (!h) throw new Error(`no hashprice for ${dayOf(hour)}`);
      return h;
    },
    meta: {
      rtFetchedAt: rtFile.fetchedAt, daFetchedAt: daFile.fetchedAt, mempoolFetchedAt: mp.fetchedAt, otherFetchedAt: otherFile.fetchedAt,
      rtSource: rtFile.rows.find((r) => r.source)?.source ?? "", daSource: daFile.rows.find((r) => r.source)?.source ?? "",
      window: [hours[0]!, hours.at(-1)!],
    },
  };
}

export const loadLiveRun = (): LiveRun => read<LiveRun>("live-paid-2026-11-19.json");
export const loadLatency = (): Latency => read<Latency>("public-latency.json");

export interface HashpriceSample {
  /** ms since epoch of the mempool.space average-rewards entry */
  t: number;
  usdPerPhDay: number;
}

/** Finer hashprice series: one value per saved mempool.space reward entry (BTC price and fees at that time, that day's network hashrate). */
export function loadHashpriceSeries(): HashpriceSample[] {
  const mp = read<MempoolFile>("mempool-hashprice-inputs.json");
  const hashrates = mp.hashrate.hashrates.map((h) => ({ t: h.timestamp * 1000, ehs: h.avgHashrate / 1e18 }));
  return mp.rewards
    .map((e) => {
      const t = e.timestamp * 1000;
      const hr = hashrates.filter((h) => h.t <= t).at(-1) ?? hashrates[0]!;
      return { t, usdPerPhDay: hashpriceUsdPerPhDay(e.avgRewards, e.USD, hr.ehs) };
    })
    .sort((a, b) => a.t - b.t);
}

export const loadBaseline = () => read<{ clean: Record<string, { metrics: Record<string, number | number[] | null> }>; injected: Record<string, { metrics: Record<string, number | number[] | null> }>; perKind: { kind: string; hours: number; A: { correct: number; shortfallUsd: number }; B: { correct: number; holds: number; fellBackToDayAhead: number; flagged: number; shortfallUsd: number } }[]; commit: string }>("baseline-e2f949b.json");
