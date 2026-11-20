// The comparison itself: replays both policies over the saved window. No network, no Telegraph call, no payment.
import { readFileSync } from "node:fs";
import type { Plan } from "../src/types.ts";
import { planSite } from "../src/plan.ts";
import { TransportError, type Answer, type Transport } from "../src/telegraph.ts";
import { loadLatency, loadLiveRun, loadTruth, NODE, QUARTER, type Truth } from "./model.ts";
import { policyA, policyB, type Decided } from "./policies.ts";
import { buildWorld, chooseInjections, DISAGREEMENT_DELTA, KINDS, loadSite, NEGATIVE_PRICE, oracle, profitAt, STALE_HOURS, trueEconomics, type Kind, type World } from "./world.ts";

export const PAID_SECONDS: [number, number] = [8, 15];

export interface Row {
  hour: string;
  injected: Kind | null;
  oracleAction: string;
  action: string;
  correct: boolean;
  hold: boolean;
  profit: number;
  best: number;
  shortfall: number;
  truePrice: number;
  priceUsed: number | null;
  basis: string;
  flagged: boolean;
  flags: string[];
  evidenceFields: number | null;
  telegraphCostUsd: number;
  paidAnswers: number;
  ms: number;
}

export interface PolicyResult {
  id: string;
  title: string;
  origin: string;
  rows: Row[];
  metrics: ReturnType<typeof summarize>;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const r2 = (n: number) => Math.round(n * 100) / 100;
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0; };

function toRow(site: ReturnType<typeof loadSite>, w: World, d: Decided): Row {
  const o = oracle(site, w, d.hour);
  const e = trueEconomics(site, w, d.hour);
  const profit = d.action === "HOLD" ? 0 : profitAt(site, w, d.hour, d.fraction);
  const evidenceFields = d.evidence ? [...d.evidence.power, ...d.evidence.hashprice].filter(Boolean).length : null;
  return {
    hour: d.hour, injected: w.kind.get(d.hour) ?? null, oracleAction: o.action, action: d.action, correct: d.action === o.action, hold: d.action === "HOLD",
    profit: r2(profit), best: r2(e.best), shortfall: r2(e.best - profit), truePrice: r2(w.rtHour(d.hour)), priceUsed: d.priceUsed, basis: d.basis,
    flagged: d.flagged, flags: d.flags, evidenceFields, telegraphCostUsd: d.telegraphCostUsd, paidAnswers: d.paidAnswers, ms: d.ms,
  };
}

/** Injections that are bad inputs (a negative price is a valid input and must be used, not rejected). */
const isBadInput = (k: Kind | null): boolean => k !== null && k !== "negative-price";
/** A HOLD is justified when a required input really was missing or unusable at that hour. Only the missing hashprice leaves no usable input at all. */
const holdJustified = (r: Row) => r.injected === "missing-hashprice";

export function summarize(rows: Row[], oracleProfit: number, perDecisionLiveSeconds: (r: Row) => [number, number]) {
  const acted = rows.filter((r) => !r.hold);
  const wrong = rows.filter((r) => !r.hold && !r.correct);
  const holds = rows.filter((r) => r.hold);
  const bad = rows.filter((r) => isBadInput(r.injected));
  const flaggedClean = rows.filter((r) => r.flagged && r.injected === null);
  const fields = acted.filter((r) => r.evidenceFields !== null).map((r) => r.evidenceFields!);
  const live = rows.map(perDecisionLiveSeconds);
  return {
    decisions: rows.length,
    correct: rows.filter((r) => r.correct).length,
    correctPct: r2((100 * rows.filter((r) => r.correct).length) / rows.length),
    wrongActions: wrong.length,
    holds: holds.length,
    holdsJustified: holds.filter(holdJustified).length,
    holdsUnjustified: holds.filter((r) => !holdJustified(r)).length,
    realizedUsd: r2(sum(rows.map((r) => r.profit))),
    oracleUsd: r2(oracleProfit),
    hindsightBestUsd: r2(sum(rows.map((r) => r.best))),
    shortfallVsBestUsd: r2(sum(rows.map((r) => r.shortfall))),
    lostOnWrongActionsUsd: r2(sum(wrong.map((r) => r.shortfall))),
    lostToHoldsUsd: r2(sum(holds.map((r) => r.shortfall))),
    badInputHours: bad.length,
    badInputsCaught: bad.filter((r) => r.flagged || r.hold).length,
    badInputsUsedSilently: bad.filter((r) => !r.flagged && !r.hold).length,
    badInputsThatCostMoney: bad.filter((r) => !r.hold && r.shortfall > 0.005 && !r.flagged).length,
    falseAlarms: flaggedClean.length,
    fallbackToDayAhead: rows.filter((r) => !r.hold && r.basis === "day-ahead").length,
    meanAbsPriceErrorUsdPerMwh: r2(sum(acted.map((r) => Math.abs((r.priceUsed ?? 0) - r.truePrice))) / Math.max(1, acted.length)),
    evidenceCompletenessPct: fields.length ? r2((100 * sum(fields)) / (6 * fields.length)) : null,
    telegraphCostUsd: r2(sum(rows.map((r) => r.telegraphCostUsd))),
    telegraphCostPerDecisionUsd: r2(sum(rows.map((r) => r.telegraphCostUsd)) / rows.length * 1000) / 1000,
    netOfIntelligenceCostUsd: r2(sum(rows.map((r) => r.profit)) - sum(rows.map((r) => r.telegraphCostUsd))),
    paidAnswers: sum(rows.map((r) => r.paidAnswers)),
    codeMsMean: r2(sum(rows.map((r) => r.ms)) / rows.length * 1000) / 1000,
    codeMsP95: r2(quantile(rows.map((r) => r.ms), 0.95) * 1000) / 1000,
    liveSecondsPerDecisionMean: [r2(sum(live.map((l) => l[0])) / rows.length), r2(sum(live.map((l) => l[1])) / rows.length)] as [number, number],
  };
}

async function anchor(truth: Truth) {
  // Replays the 2026-11-19 paid run through Ballast's real planner with the recorded answers and their real receipts.
  const live = loadLiveRun();
  const fx = JSON.parse(readFileSync(new URL("../fixtures/recorded.json", import.meta.url), "utf8")) as { public: { tipHeight: number; hashprice: { usdPerPhDay: number; btcUsd: number; hashrateEhS: number } } };
  const site = loadSite();
  const now = new Date("2026-11-19T18:14:30Z");
  const gauge = live.answers.find((a) => a.minerId === "4283")!;
  const pecos = live.answers.find((a) => a.minerId === "7310042")!;
  const transport: Transport = {
    kind: "engine",
    async ask(req): Promise<Answer> {
      const a = req.minerId === "4283" ? gauge : req.minerId === "7310042" ? pecos : undefined;
      if (!a) throw new TransportError(`HTTP 503 from miner ${req.minerId}`, 503);
      const result = req.minerId === "4283"
        ? { hashprice_sats_per_ph_day: ((a.result.hashprice_usd_per_ph_day as number) / fx.public.hashprice.btcUsd) * 1e8, hashprice_usd_per_ph_day: null, block_height: fx.public.tipHeight }
        : a.result;
      return { minerId: a.minerId, result, costUsd: a.costUsd, answeredAt: "2026-11-19T18:14:20.000Z", receipt: { receiptHash: a.receiptHash } };
    },
  };
  const pub = {
    async ercotPrice(node: string, market: "real-time" | "day-ahead", start: Date) {
      const v = node === NODE && market === "real-time" ? truth.rt.get(start.toISOString()) : undefined;
      return v === undefined ? null : { lmp: v, source: "ERCOT public MIS archive via Assize (saved)" };
    },
    tipHeight: async () => fx.public.tipHeight,
    hashprice: async () => ({ ...fx.public.hashprice, tipHeight: fx.public.tipHeight, source: "mempool.space as recorded 2026-11-19T17:50Z (fixtures/recorded.json)" }),
    forecast: async () => { throw new Error("unused"); },
    observedHigh: async () => null,
  };
  const plan: Plan = await planSite({ ...site, planning: { hours: 1, startHour: "2026-11-19T18:00:00.000Z" } }, { transport, pub, now, mode: "paid", label: "replay of the 2026-11-19 paid run" });
  const d = plan.decisions[0]!;
  return {
    origin: "live paid answer, 2026-11-19 (answers and receipts) replayed through Ballast's planner; public cross-check data saved",
    action: d.action, runFraction: d.runFraction, marginUsdPerMwh: d.marginUsdPerMwh, costUsd: plan.intelligenceCostUsd, answers: plan.telegraphCalls,
    receipts: plan.evidence.filter((e) => e.source.kind === "telegraph").map((e) => ({ check: e.check, provider: `${e.source.id} ${e.source.name}`, answeredAt: e.answeredAt, receipt: e.receipt.receiptHash })),
    publicCrossCheckLmp17_45: truth.rt.get("2026-11-19T17:45:00.000Z") ?? null,
    recordedLive: live.decision,
    reproducesLiveDecision: d.action === live.decision.action && d.marginUsdPerMwh === live.decision.marginUsdPerMwh,
    gaugeVsPublicHashpricePct: r2((100 * ((gauge.result.hashprice_usd_per_ph_day as number) - fx.public.hashprice.usdPerPhDay)) / fx.public.hashprice.usdPerPhDay),
    hashpriceAcceptedAfterCrossCheck: d.action !== "HOLD",
  };
}

export async function runAll() {
  const t0 = performance.now();
  const truth = loadTruth();
  const site = loadSite();
  const live = loadLiveRun();
  const lat = loadLatency();
  const median = (name: string) => quantile(lat.samplesMs[name] ?? [0], 0.5) / 1000;
  const publicSeconds = median("assize ercot real-time price") + median("mempool.space reward-stats(144)") + median("mempool.space prices") + median("mempool.space hashrate(3d)");
  const [lo, hi] = live.latencyPerPaidAnswerSeconds;
  const aLive = (): [number, number] => [publicSeconds, publicSeconds];
  const bLive = (r: Row): [number, number] => [publicSeconds + r.paidAnswers * lo, publicSeconds + r.paidAnswers * hi];

  const injections = chooseInjections(site, truth);
  const worlds = { clean: buildWorld(truth, new Map()), injected: buildWorld(truth, injections) };

  const scenarios: Record<string, { title: string; origin: string; policies: PolicyResult[] }> = {};
  const plansByHour: Record<string, Plan> = {};
  for (const [name, w] of Object.entries(worlds) as [string, World][]) {
    const defs: { id: string; title: string; origin: string; run: (h: string, carried: { hashprice: number }) => Promise<Decided>; live: (r: Row) => [number, number] }[] = [
      { id: "A", title: "A: web-only Mind (latest price, unchecked)", origin: "modelled policy on public data", run: async (h, c) => policyA(site, w, h, c), live: aLive },
      {
        id: "B", title: "B: Ballast with Telegraph (decides at :16)", origin: "Ballast's real planner; provider answers are public-data stand-ins (recorded live answers on 2026-11-19 are in the anchor)",
        run: async (h) => { const r = await policyB(site, w, h); if (name === "injected" && w.kind.has(h)) plansByHour[h] = r.plan; return r.decided; }, live: bLive,
      },
    ];
    if (name === "clean") {
      defs.push(
        { id: "A-DA", title: "A-DA: web-only Mind reading the day-ahead table", origin: "modelled policy on public data", run: async (h, c) => policyA(site, w, h, c, "day-ahead"), live: aLive },
        { id: "A@14", title: "A@:14: web-only Mind, latest interval at :14", origin: "modelled policy on public data", run: async (h, c) => policyA(site, w, h, c, "latest-at-14"), live: aLive },
        { id: "B@14", title: "B@:14: Ballast deciding at :14 like the live run", origin: "Ballast's real planner on stand-in answers", run: async (h) => (await policyB(site, w, h, 14)).decided, live: bLive },
      );
    }
    const policies: PolicyResult[] = [];
    for (const def of defs) {
      const rows: Row[] = [];
      const carried = { hashprice: w.hashprice(w.hours[0]!).usdPerPhDay };
      for (const h of w.hours) rows.push(toRow(site, w, await def.run(h, carried)));
      const oracleProfit = sum(w.hours.map((h) => { const o = oracle(site, w, h); return profitAt(site, w, h, o.fraction); }));
      policies.push({ id: def.id, title: def.title, origin: def.origin, rows, metrics: summarize(rows, oracleProfit, def.live) });
    }
    scenarios[name] = {
      title: name === "clean" ? "Clean: ERCOT's published prices as they are, no injections" : "Injected: the same window with 24 SYNTHETIC bad inputs, identical for every policy",
      origin: name === "clean" ? "public data (ERCOT via Assize, mempool.space)" : "public data plus synthetic injection",
      policies,
    };
  }

  // Per injection kind: how each policy fared on exactly those hours.
  const perKind = KINDS.map((kind) => {
    const hours = [...injections].filter(([, k]) => k === kind).map(([h]) => h).sort();
    const stat = (id: string) => {
      const rows = scenarios.injected!.policies.find((p) => p.id === id)!.rows.filter((r) => r.injected === kind);
      return {
        correct: rows.filter((r) => r.correct).length, holds: rows.filter((r) => r.hold).length, fellBackToDayAhead: rows.filter((r) => !r.hold && r.basis === "day-ahead").length,
        flagged: rows.filter((r) => r.flagged || r.hold).length, shortfallUsd: r2(sum(rows.map((r) => r.shortfall))), profitUsd: r2(sum(rows.map((r) => r.profit))),
        detail: rows.map((r) => ({ hour: r.hour, truePrice: r.truePrice, priceUsed: r.priceUsed, action: r.action, oracle: r.oracleAction })),
      };
    };
    return { kind, hours, A: stat("A"), B: stat("B"), description: describeKind(kind) };
  });

  const wInj = worlds.injected;
  const results = {
    generatedBy: "npm run compare (reads compare/data/, no network)",
    labels: {
      "public data": "ERCOT HB_WEST settlement point prices via Assize (ERCOT public MIS archive NP6-905-CD real-time 15 min, NP4-190-CD day-ahead hourly) and mempool.space",
      "recorded Telegraph answer": "only the two answers bought on 2026-11-19 (anchor section); everything else the provider returns in policy B is a public-data stand-in",
      "synthetic injection": "the 24 bad-input hours in the Injected scenario",
    },
    window: { firstHour: truth.meta.window[0], lastHour: truth.meta.window[1], hours: truth.hours.length, node: NODE },
    fetchedAt: { ercotRealTime: truth.meta.rtFetchedAt, ercotDayAhead: truth.meta.daFetchedAt, mempool: truth.meta.mempoolFetchedAt, wrongNode: truth.meta.otherFetchedAt },
    site: { fleetMw: trueEconomics(site, wInj, truth.hours[0]!).mw, adderUsdPerMwh: site.power.adderUsdPerMwh, throttleBandUsdPerMwh: site.operating.throttleBandUsdPerMwh, throttleFraction: site.operating.throttleFraction },
    truthSummary: {
      rtHourMin: r2(Math.min(...truth.hours.map((h) => buildWorld(truth, new Map()).rtHour(h)))),
      rtHourMax: r2(Math.max(...truth.hours.map((h) => buildWorld(truth, new Map()).rtHour(h)))),
      hoursOracleNotRun: worlds.clean.hours.filter((h) => oracle(site, worlds.clean, h).action !== "RUN").length,
      hashpriceRange: [r2(Math.min(...truth.hours.map((h) => truth.hashprice(h).usdPerPhDay))), r2(Math.max(...truth.hours.map((h) => truth.hashprice(h).usdPerPhDay)))],
    },
    injection: { rule: "placed where each failure would hurt a policy that trusts it the most; non-adjacent, no hour used twice", staleHours: STALE_HOURS, disagreementDeltaUsd: DISAGREEMENT_DELTA, negativePriceUsd: NEGATIVE_PRICE, hours: [...injections].map(([hour, kind]) => ({ hour, kind })).sort((a, b) => a.hour.localeCompare(b.hour)) },
    assumptions: {
      paidAnswerUsd: 0.01,
      paidAnswerSeconds: live.latencyPerPaidAnswerSeconds,
      publicFetchSecondsPerDecision: Math.round(publicSeconds * 100) / 100,
      holdTreatedAs: "idle that hour (profit $0); the cost of each HOLD is reported separately",
      decisionTime: "H:16 UTC; the current hour is priced from the latest complete 15-minute interval (H:00)",
      evidenceFields: "per input: provider named, as-of time/interval, receipt; 2 inputs x 3 fields = 6 per decision",
    },
    scenarios,
    perKind,
    anchor: await anchor(truth),
    latencySamplesMs: lat.samplesMs,
    runtimeSeconds: r2((performance.now() - t0) / 1000),
  };
  return results;
}

function describeKind(k: Kind): string {
  switch (k) {
    case "stale-price": return `price source serves the interval from ${STALE_HOURS} hours earlier`;
    case "wrong-node": return "price source serves HB_HOUSTON (a real, different ERCOT hub) instead of HB_WEST";
    case "wrong-market": return "price source serves the day-ahead price when the real-time one was asked for";
    case "disagreement": return `price source under-reports the real-time price by $${-DISAGREEMENT_DELTA}/MWh while the public archive stays right`;
    case "missing-hashprice": return "hashprice source returns no answer (HTTP 503)";
    case "negative-price": return `ERCOT settles at $${NEGATIVE_PRICE}/MWh for the whole hour (truth edited, so every source and the oracle agree)`;
  }
}

