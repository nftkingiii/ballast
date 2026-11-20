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
const hoursOf = (kind: string) => results.injection.hours.filter((h) => h.kind === kind).map((h) => h.hour);

test("the window is real ERCOT data with the injections placed once each, apart from each other", () => {
  assert.ok(results.window.hours >= 72);
  assert.equal(results.injection.hours.length, KINDS.length * 4);
  const ms = results.injection.hours.map((h) => Date.parse(h.hour)).sort((a, b) => a - b);
  assert.equal(new Set(ms).size, ms.length);
  ms.slice(1).forEach((t, i) => assert.ok(t - ms[i]! >= 2 * 3_600_000, "injected hours must not be adjacent"));
  assert.ok(loadTruth().hours.length === results.window.hours);
});

test("B names and rejects each crisp bad input; A takes the same input without a word", () => {
  for (const kind of ["stale-price", "wrong-node", "wrong-market", "disagreement"]) {
    for (const hour of hoursOf(kind)) {
      const a = A.rows.find((r) => r.hour === hour)!;
      const b = B.rows.find((r) => r.hour === hour)!;
      assert.equal(a.flagged, false, `${kind} ${hour}: A has no way to notice`);
      assert.equal(b.flagged, true, `${kind} ${hour}: B must flag it`);
      assert.equal(b.basis, "day-ahead", `${kind} ${hour}: B falls back to the day-ahead price, labelled`);
      assert.ok(b.flags.length > 0 && b.flags.every((f) => f.length > 10));
    }
  }
  const text = B.rows.filter((r) => r.injected && r.injected !== "missing-hashprice" && r.injected !== "negative-price").flatMap((r) => r.flags).join("\n");
  assert.match(text, /stale or substituted interval/);
  assert.match(text, /not HB_WEST/);
  assert.match(text, /asked for real-time but the provider answered day-ahead/);
  assert.match(text, /providers disagree/);
});

test("a missing hashprice is a justified HOLD for B and a silent carry-forward for A", () => {
  for (const hour of hoursOf("missing-hashprice")) {
    const b = B.rows.find((r) => r.hour === hour)!;
    assert.equal(b.action, "HOLD");
    assert.equal(b.telegraphCostUsd, 0.0, "no prices are bought without a hashprice");
    const a = A.rows.find((r) => r.hour === hour)!;
    assert.notEqual(a.action, "HOLD");
    assert.equal(a.flagged, false);
  }
  assert.equal(B.metrics.holds, 4);
  assert.equal(B.metrics.holdsJustified, 4);
  assert.equal(B.metrics.holdsUnjustified, 0);
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

test("evidence: every B decision that acted has provider, time and receipt for both inputs; A has none of the receipts", () => {
  assert.equal(B.metrics.evidenceCompletenessPct, 100);
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
