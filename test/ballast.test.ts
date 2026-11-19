import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSite, ConfigError } from "../src/config.ts";
import { decideHour, fleetMw } from "../src/decide.ts";
import { planSite } from "../src/plan.ts";
import { demoDeps, loadFixture, paidDeps } from "../src/runtime.ts";
import { hourAt, SCENARIOS } from "../src/scenarios.ts";
import { explainDecision, renderPlan } from "../src/render.ts";
import type { Plan, SiteConfig } from "../src/types.ts";

const site = (): SiteConfig => parseSite(JSON.parse(readFileSync(new URL("../sites/west-texas.json", import.meta.url), "utf8")));

async function run(scenario?: string): Promise<{ plan: Plan; fx: ReturnType<typeof loadFixture>; site: SiteConfig }> {
  let s = site();
  let fx = loadFixture();
  if (scenario) ({ fx, site: s } = SCENARIOS[scenario]!.apply(fx, s));
  const deps = demoDeps(fx);
  return { plan: await planSite(s, deps), fx, site: s };
}

const at = (plan: Plan, fx: ReturnType<typeof loadFixture>, k: number) => plan.decisions.find((d) => d.hour === hourAt(fx, k))!;

test("normal hour: recorded day plans every hour with labelled, receipted evidence", async () => {
  const { plan, fx } = await run();
  assert.equal(plan.mode, "demo");
  assert.match(plan.label, /^DEMO MODE/);
  assert.equal(plan.decisions.length, 8);
  assert.ok(plan.decisions.every((d) => d.action !== "HOLD"));
  assert.equal(plan.intelligenceCostUsd, 0);
  assert.equal(plan.projectedPaidCostUsd, 0.1);
  assert.deepEqual(plan.missingChecks, []);
  const telegraphShaped = plan.evidence.filter((e) => e.source.kind === "fixture");
  assert.equal(telegraphShaped.length, 10);
  assert.ok(telegraphShaped.every((e) => e.receipt.receiptHash?.startsWith("fixture:") && e.source.name.includes("not a Telegraph answer")));
  // The current hour is priced from the latest real-time interval, later hours from day-ahead.
  assert.equal(at(plan, fx, 0).basis, "real-time");
  assert.equal(at(plan, fx, 1).basis, "day-ahead");
  const text = renderPlan(plan);
  assert.match(text, /Intelligence cost/);
  assert.match(text, /Missing checks: none/);
});

test("margin arithmetic: revenue per MWh is hashprice over fleet draw, minus power cost", async () => {
  const { plan, site: s } = await run();
  const d = plan.decisions[1]!;
  const mw = (500_000 * 21) / 1e6;
  const revenue = (plan.hashpriceUsdPerPhDay! * 500) / 24 / mw;
  assert.equal(d.fleetMw, 10.5);
  assert.ok(Math.abs(d.revenueUsdPerMwh! - revenue) < 0.01);
  // realtime exposure: lmp + adder + forward buffer for a day-ahead hour
  assert.ok(Math.abs(d.powerCostUsdPerMwh! - (d.powerPriceUsdPerMwh! + s.power.adderUsdPerMwh + s.operating.forwardBufferUsdPerMwh)) < 0.01);
  assert.ok(Math.abs(d.marginUsdPerMwh! - (d.revenueUsdPerMwh! - d.powerCostUsdPerMwh!)) < 0.02);
});

test("negative-price hour: running earns, and a spike is curtailed", async () => {
  const { plan, fx } = await run("negative-price");
  const neg = at(plan, fx, 2);
  assert.equal(neg.action, "RUN");
  assert.ok(neg.powerCostUsdPerMwh! < 0);
  assert.ok(neg.marginUsdPerMwh! > neg.revenueUsdPerMwh!);
  assert.ok(neg.reasons.some((r) => r.includes("negative price")));
  const spike = at(plan, fx, 3);
  assert.equal(spike.action, "CURTAIL");
  assert.equal(spike.expectedProfitUsd, 0);
});

test("throttle band: a thin positive margin runs part of the fleet", () => {
  const s = site();
  const d = decideHour(s, {
    hour: "2026-11-19T23:00:00.000Z", hashpriceUsdPerPhDay: 29.39, hashpriceGaps: [], tempC: 15, weatherRequired: false, weatherTrusted: true,
    weatherGaps: [], evidence: [], forward: true, power: { basis: "day-ahead", price: 45.45, evidence: [], notes: [] },
  });
  assert.equal(d.action, "THROTTLE");
  assert.equal(d.runFraction, 0.5);
});

test("stale price: an old real-time answer is rejected and named, a substituted interval is a HOLD", async () => {
  const { plan, fx } = await run("stale-price");
  const now = at(plan, fx, 0);
  assert.equal(now.basis, "day-ahead");
  assert.ok(now.reasons.some((r) => r.includes("fell back to day-ahead")));
  const stale = plan.evidence.find((e) => e.check === "power-real-time" && !e.accepted)!;
  assert.match(stale.reason!, /stale/);
  const held = at(plan, fx, 2);
  assert.equal(held.action, "HOLD");
  assert.match(held.gaps[0]!.reason, /stale or substituted interval/);
  assert.ok(plan.missingChecks.some((g) => g.check === "power-real-time"));
});

test("provider disagreement: HOLD with both values named, neighbours unaffected", async () => {
  const { plan, fx } = await run("disagreement");
  const held = at(plan, fx, 2);
  assert.equal(held.action, "HOLD");
  assert.match(held.gaps[0]!.reason, /says 61, public ERCOT archive says 13\.16/);
  assert.equal(at(plan, fx, 1).action, "RUN");
  assert.equal(at(plan, fx, 3).action, "RUN");
});

test("missing hashprice: every hour is HOLD and no prices are bought", async () => {
  const { plan } = await run("missing-hashprice");
  assert.ok(plan.decisions.every((d) => d.action === "HOLD"));
  assert.equal(plan.hashpriceUsdPerPhDay, null);
  assert.equal(plan.evidence.filter((e) => e.check.startsWith("power")).length, 0);
  assert.match(plan.decisions[0]!.gaps.map((g) => g.reason).join(" "), /no recorded hashprice answer/);
});

test("spend cap breach: buying stops, cost never passes the cap, unpriced hours are HOLD", async () => {
  const { plan } = await run("spend-cap");
  assert.equal(plan.budgetBreached, true);
  assert.ok(plan.projectedPaidCostUsd <= 0.05 + 1e-9);
  assert.equal(plan.telegraphCalls, 5);
  const held = plan.decisions.filter((d) => d.action === "HOLD");
  assert.ok(held.length >= 4);
  assert.ok(held.every((d) => d.gaps.some((g) => g.check === "budget")));
  assert.ok(plan.missingChecks.some((g) => g.check === "budget"));
  assert.match(renderPlan(plan), /SPEND CAP REACHED/);
});

test("weather outage: hot hours HOLD, and verified heat derates efficiency", async () => {
  const outage = await run("weather-outage");
  assert.ok(outage.plan.decisions.every((d) => d.action === "HOLD"));
  assert.ok(outage.plan.missingChecks.some((g) => g.check === "weather-verify"));
  const heat = await run("heat");
  const hot = heat.plan.decisions[4]!;
  assert.ok(hot.tempC! > 30);
  assert.ok(hot.fleetMw! > 10.5);
  assert.equal(hot.fleetMw, Number(fleetMw(heat.site, hot.tempC!).toFixed(3)));
  assert.ok(hot.reasons.some((r) => r.includes("efficiency penalty")));
});

test("a provider answering the wrong market is refused", async () => {
  const s = site();
  const fx = loadFixture();
  const da = fx.shaped.power.find((p) => p.market === "day-ahead" && p.intervalStart === hourAt(fx, 2))!;
  da.result = { ...da.result, market: "real-time" };
  const plan = await planSite(s, demoDeps(fx));
  const bad = plan.decisions.find((d) => d.hour === da.intervalStart)!;
  assert.equal(bad.action, "HOLD");
  assert.match(bad.gaps[0]!.reason, /asked for day-ahead but the provider answered real-time/);
});

test("explain_decision names provider, time and receipt for each input", async () => {
  const { plan, fx } = await run();
  const text = explainDecision(plan, hourAt(fx, 1));
  assert.match(text, /receipt fixture:/);
  assert.match(text, /Pecos ERCOT Power Prices/);
  assert.match(text, /margin \$/);
});

test("site config: problems are listed and nothing is guessed", () => {
  assert.throws(() => parseSite({ node: "NOT_A_NODE" }), (e) => e instanceof ConfigError && e.problems.length > 3 && e.problems.some((p) => p.includes("ERCOT")));
  assert.throws(() => parseSite({ ...JSON.parse(readFileSync(new URL("../sites/west-texas.json", import.meta.url), "utf8")), power: { mode: "fixed" } }), /fixedUsdPerMwh/);
});

test("paid mode refuses to start without credentials or a cap, and never reads a key from the plan", async () => {
  const s = site();
  await assert.rejects(() => paidDeps(s, {}), /ANJOMAN_API_KEY/);
  s.intelligence.spendCapUsd = 0;
  await assert.rejects(() => paidDeps(s, { ANJOMAN_API_KEY: "x" }), /spendCapUsd above zero/);
  const plan = JSON.stringify((await run()).plan);
  assert.ok(!/anjoman_|private|secret/i.test(plan));
});
