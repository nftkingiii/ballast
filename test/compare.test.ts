import assert from "node:assert/strict";
import { test } from "node:test";
import { runAll } from "../compare/compare.ts";
import { loadTruth } from "../compare/model.ts";
import { renderMarkdown } from "../compare/render.ts";
import { KINDS } from "../compare/world.ts";

// The comparison must reproduce from saved data alone: any network use is a bug.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("compare must not use the network"); }) as typeof fetch;
const results = await runAll();
globalThis.fetch = realFetch;

const inj = results.scenarios.injected!.policies;
const A = inj.find((p) => p.id === "A")!;
const B = inj.find((p) => p.id === "B")!;
/** Ballast as at e2f949b: the three fixes switched off by site config. */
const Bprev = inj.find((p) => p.id === "B-prev")!;
const hoursOf = (kind: string) => results.injection.hours.filter((h) => h.kind === kind).map((h) => h.hour);

test("the window is real ERCOT data with the injections placed once each, apart from each other", () => {
  assert.ok(results.window.hours >= 72);
  assert.equal(results.injection.hours.length, KINDS.length * 4);
  const ms = results.injection.hours.map((h) => Date.parse(h.hour)).sort((a, b) => a - b);
  assert.equal(new Set(ms).size, ms.length);
  ms.slice(1).forEach((t, i) => assert.ok(t - ms[i]! >= 2 * 3_600_000, "injected hours must not be adjacent"));
  assert.ok(loadTruth().hours.length === results.window.hours);
});

test("B-prev (e2f949b) names and rejects each crisp bad input and falls back to day-ahead; A takes the same input without a word", () => {
  for (const kind of ["stale-price", "wrong-node", "wrong-market", "disagreement"]) {
    for (const hour of hoursOf(kind)) {
      const a = A.rows.find((r) => r.hour === hour)!;
      const b = Bprev.rows.find((r) => r.hour === hour)!;
      assert.equal(a.flagged, false, `${kind} ${hour}: A has no way to notice`);
      assert.equal(b.flagged, true, `${kind} ${hour}: B must flag it`);
      assert.equal(b.basis, "day-ahead", `${kind} ${hour}: B falls back to the day-ahead price, labelled`);
      assert.ok(b.flags.length > 0 && b.flags.every((f) => f.length > 10));
    }
  }
  const text = Bprev.rows.filter((r) => r.injected && r.injected !== "missing-hashprice" && r.injected !== "negative-price").flatMap((r) => r.flags).join("\n");
  assert.match(text, /stale or substituted interval/);
  assert.match(text, /not HB_WEST/);
  assert.match(text, /asked for real-time but the provider answered day-ahead/);
  assert.match(text, /providers disagree/);
});

test("a missing hashprice is a justified HOLD for B-prev (e2f949b) and a silent carry-forward for A", () => {
  for (const hour of hoursOf("missing-hashprice")) {
    const b = Bprev.rows.find((r) => r.hour === hour)!;
    assert.equal(b.action, "HOLD");
    assert.equal(b.telegraphCostUsd, 0.0, "no prices are bought without a hashprice");
    const a = A.rows.find((r) => r.hour === hour)!;
    assert.notEqual(a.action, "HOLD");
    assert.equal(a.flagged, false);
  }
  assert.equal(Bprev.metrics.holds, 4);
  assert.equal(Bprev.metrics.holdsJustified, 4);
  assert.equal(Bprev.metrics.holdsUnjustified, 0);
  assert.equal(A.metrics.holds, 0);
});

test("a negative price is a valid input: both policies use it and run", () => {
  for (const hour of hoursOf("negative-price")) {
    for (const p of [A, B]) {
      const r = p.rows.find((x) => x.hour === hour)!;
      assert.equal(r.priceUsed, -18.4);
      assert.equal(r.action, "RUN");
      assert.equal(r.flagged, false);
    }
  }
});

test("no false alarms on clean hours, and clean data gives both policies the same price", () => {
  assert.equal(B.metrics.falseAlarms, 0);
  const clean = results.scenarios.clean!.policies;
  const a = clean.find((p) => p.id === "A")!, b = clean.find((p) => p.id === "B")!;
  assert.deepEqual(a.rows.map((r) => r.priceUsed), b.rows.map((r) => r.priceUsed));
  assert.equal(b.metrics.falseAlarms, 0);
  assert.equal(b.metrics.holds, 0);
});

test("evidence: every B-prev decision that acted has provider, time and receipt for both inputs; A has none of the receipts", () => {
  assert.equal(Bprev.metrics.evidenceCompletenessPct, 100);
  assert.equal(results.scenarios.clean!.policies.find((p) => p.id === "B")!.metrics.evidenceCompletenessPct, 100);
  assert.ok(A.metrics.evidenceCompletenessPct! < 50);
  assert.equal(results.scenarios.clean!.policies.find((p) => p.id === "B")!.metrics.telegraphCostPerDecisionUsd, 0.02);
  assert.equal(results.scenarios.clean!.policies.find((p) => p.id === "A")!.metrics.telegraphCostUsd, 0);
});

test("the recorded 2026-11-19 paid answers reproduce the live decision through Ballast's planner", () => {
  const a = results.anchor;
  assert.equal(a.action, "RUN");
  assert.equal(a.runFraction, 1);
  assert.equal(a.marginUsdPerMwh, 39.23);
  assert.equal(a.costUsd, 0.02);
  assert.equal(a.reproducesLiveDecision, true);
  assert.deepEqual(a.receipts.map((r) => r.receipt), [
    "0x685ac740498a1850728acbadc62639f9e4e26bf2250bff065ed46c5b9db63218",
    "0xb21b0c8b8212112ffd49a9564643d066a4d5e7db21f37654b21fd32e11685b94",
  ]);
});

test("results render with every label, and a second run gives the same numbers", async () => {
  const md = renderMarkdown(results);
  for (const s of ["public data", "recorded Telegraph answer", "synthetic injection", "stand-in", "## Failures, shared", "## What this shows, and what it does not"]) assert.ok(md.includes(s), s);
  const strip = (r: typeof results) => JSON.stringify(r.scenarios, (k, v) => (k === "ms" || k.startsWith("codeMs") ? 0 : v));
  assert.equal(strip(await runAll()), strip(results));
});

// ------------------------------------------------------------------ the three fixes, measured

const cleanRows = (id: string) => results.scenarios.clean!.policies.find((p) => p.id === id)!.rows;

test("B-prev (the three fixes switched off by site config) reproduces every e2f949b number, so the before column is not a claim", () => {
  assert.deepEqual(results.beforeAfter.switchedOffReproducesBaseline, { clean: true, injected: true });
  assert.equal(results.beforeAfter.baselineCommit, "e2f949b");
});

test("fix 1: a missing hashprice no longer holds B when an accepted one is inside the window; every such hour is labelled carried and flagged", () => {
  for (const hour of hoursOf("missing-hashprice")) {
    const b = B.rows.find((r) => r.hour === hour)!;
    assert.notEqual(b.action, "HOLD");
    assert.equal(b.carried, true);
    assert.equal(b.flagged, true, "a carried hashprice is still reported as a failed fresh check");
    assert.equal(b.evidenceFields, 6 - 0 - 0, "the carried hashprice keeps its provider, time and receipt");
  }
  assert.equal(B.metrics.holds, 0);
  assert.equal(B.metrics.carriedHours, 4);
  const k = results.perKind.find((x) => x.kind === "missing-hashprice")!;
  assert.ok(k.B.shortfallUsd < k.Bprev.shortfallUsd, `B lost ${k.B.shortfallUsd}, B-prev ${k.Bprev.shortfallUsd}`);
});

test("fix 2: a wrong-market answer is recovered from the public archive for that exact interval, labelled, and decides like a clean hour", () => {
  const clean = cleanRows("B");
  for (const hour of hoursOf("wrong-market")) {
    const b = B.rows.find((r) => r.hour === hour)!;
    assert.equal(b.recovered, true);
    assert.equal(b.basis, "real-time");
    assert.equal(b.flagged, true, "the wrong answer is still flagged");
    assert.match(b.flags.join("\n"), /asked for real-time but the provider answered day-ahead/);
    assert.equal(b.priceUsed, clean.find((r) => r.hour === hour)!.priceUsed, "same price a clean hour gets");
    assert.equal(b.evidenceFields, 5, "the archive number has a provider and a time but no receipt");
  }
  const k = results.perKind.find((x) => x.kind === "wrong-market")!;
  assert.ok(k.B.shortfallUsd < k.Bprev.shortfallUsd);
  // Wrong node and disagreement are not recovered: they fall back exactly as before.
  for (const kind of ["wrong-node", "disagreement"]) for (const hour of hoursOf(kind)) assert.equal(B.rows.find((r) => r.hour === hour)!.recovered, false);
  assert.equal(B.metrics.falseAlarms, 0);
});

test("fix 3: deciding earlier or later in the hour never scores worse than before on clean data, and is identical at :16", () => {
  for (const t of results.timing) {
    assert.ok(t.after.wrong <= t.before.wrong, `:${t.minute} wrong ${t.after.wrong} vs ${t.before.wrong}`);
    assert.ok(t.after.firstHalf.wrong <= t.before.firstHalf.wrong, `:${t.minute} first half`);
    assert.ok(t.after.secondHalf.wrong <= t.before.secondHalf.wrong, `:${t.minute} second half`);
  }
  const at = (m: number) => results.timing.find((t) => t.minute === m)!;
  assert.deepEqual(at(16).after, at(16).before);
  assert.ok(at(46).after.wrong < at(46).before.wrong);
  // Before any interval of the hour is published the decision is flagged provisional; after the first one it is not.
  assert.equal(at(1).after.provisionalHours, results.window.hours);
  assert.equal(at(14).after.provisionalHours, results.window.hours);
  for (const m of [16, 31, 46]) assert.equal(at(m).after.provisionalHours, 0);
  assert.equal(at(14).before.provisionalHours, 0);
});

test("fix 3: the planner does what the offline estimator study says, and the rule beats day-ahead for the unpublished intervals", () => {
  const study = (id: string) => results.studies.estimators.find((e) => e.id === id)!;
  for (const t of results.timing) assert.equal(t.after.wrong, study("hour-estimate").byMinute.find((m) => m.minute === t.minute)!.all.wrong, `:${t.minute}`);
  for (const t of results.timing) assert.equal(t.before.wrong, study("latest-interval").byMinute.find((m) => m.minute === t.minute)!.all.wrong, `:${t.minute} before`);
  const wrong16 = (id: string) => study(id).byMinute.find((m) => m.minute === 16)!.all.wrong;
  assert.ok(wrong16("all-day-ahead") > wrong16("hour-estimate"), "day-ahead for the rest is worse");
  assert.ok(wrong16("half-day-ahead") > wrong16("hour-estimate"));
});

test("the clean-window headline is unchanged by the fixes (they are for the failures and for other decision minutes)", () => {
  const clean = results.scenarios.clean!.policies;
  const b = clean.find((p) => p.id === "B")!.metrics, prev = clean.find((p) => p.id === "B-prev")!.metrics;
  assert.equal(b.correct, prev.correct);
  assert.equal(b.realizedUsd, prev.realizedUsd);
  assert.equal(b.holds, 0);
});

test("the hashprice window is justified from the data: day-to-day moves exceed the 5% tolerance, same-day moves inside 12 h do not", () => {
  const twelve = results.studies.hashpriceCarry.find((s) => s.ageHours === 12)!;
  assert.ok(twelve.sameDayPairs.maxPct! < 5, String(twelve.sameDayPairs.maxPct));
  assert.ok(results.studies.hashpriceDayToDay.some((d) => Math.abs(d.changePct) > 5));
  assert.equal(results.fixes.carryWindowMin, 720);
  assert.match(results.fixes.inSampleNote, /in-sample/);
});
