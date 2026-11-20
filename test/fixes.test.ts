// Tests for the three fixes the with/without-Telegraph comparison exposed: carrying a recently accepted hashprice, recovering from a
// wrong-market or wrong-interval answer, and pricing the hour from the intervals already published. Recorded or SYNTHETIC data only:
// no network, nothing paid.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSite } from "../src/config.ts";
import { loadMemory, memoryAfter, saveMemory } from "../src/memory.ts";
import { DemoMonitor } from "../src/monitor-demo.ts";
import { planSite } from "../src/plan.ts";
import { renderPlan } from "../src/render.ts";
import { mayReuse, parseMemory, type CarriedHashprice } from "../src/reuse.ts";
import { demoDeps, loadFixture } from "../src/runtime.ts";
import { hourAt } from "../src/scenarios.ts";
import type { Fixture } from "../src/sources.ts";
import type { Answer, AskRequest, Transport } from "../src/telegraph.ts";
import { loadTimeline, type Timeline } from "../src/timeline.ts";
import type { Plan, SiteConfig } from "../src/types.ts";

const site = (): SiteConfig => parseSite(JSON.parse(readFileSync(new URL("../sites/west-texas.json", import.meta.url), "utf8")));
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ------------------------------------------------------------------ 1. hashprice memory in plan mode

async function accepted(): Promise<{ fx: Fixture; plan: Plan; mem: CarriedHashprice }> {
  const fx = loadFixture();
  const plan = await planSite(site(), demoDeps(fx));
  assert.ok(plan.hashpriceMemory);
  return { fx, plan, mem: plan.hashpriceMemory };
}

const withoutHashprice = (): Fixture => {
  const fx = loadFixture();
  fx.shaped.hashprice = [];
  return fx;
};

const aged = (mem: CarriedHashprice, fx: Fixture, hours: number): CarriedHashprice => ({ ...mem, acceptedAt: iso(Date.parse(fx.recordedAt) - hours * HOUR) });

test("a fresh hashprice is accepted and remembered with its provider, time and receipt", async () => {
  const { plan, mem } = await accepted();
  assert.equal(plan.hashpriceCarried, undefined);
  assert.equal(mem.mode, "demo");
  assert.equal(mem.source.id, "4283");
  assert.match(mem.receipt.receiptHash!, /^fixture:/);
  assert.equal(mem.usdPerPhDay, plan.hashpriceUsdPerPhDay);
});

test("a missing hashprice no longer holds the plan when one was accepted inside the window; it is labelled carried", async () => {
  const { fx, mem } = await accepted();
  const memory = { hashprice: aged(mem, fx, 5) };
  const plan = await planSite(site(), { ...demoDeps(withoutHashprice()), memory });
  assert.ok(plan.decisions.every((d) => d.action !== "HOLD"), "decided on the carried hashprice");
  assert.equal(plan.hashpriceUsdPerPhDay, mem.usdPerPhDay);
  assert.equal(plan.hashpriceCarried!.ageMin, 300);
  assert.equal(plan.hashpriceCarried!.windowMin, 720);
  // The carried item keeps the original provider, answer time and receipt, costs nothing, and says so.
  const item = plan.evidence.find((e) => e.carried)!;
  assert.equal(item.source.id, "4283");
  assert.equal(item.answeredAt, mem.answeredAt);
  assert.equal(item.receipt.receiptHash, mem.receipt.receiptHash);
  assert.equal(item.costUsd, 0);
  assert.match(item.subject, /carried from 2026-11-19T12:50Z/);
  assert.ok(plan.decisions.every((d) => d.evidence.includes(item.id)));
  assert.ok(plan.decisions[0]!.reasons.some((r) => /^hashprice carried from 2026-11-19T12:50Z/.test(r) && r.includes(mem.receipt.receiptHash!)));
  // The failed fresh attempt is not hidden.
  assert.ok(plan.evidence.some((e) => e.check === "hashprice" && !e.accepted));
  assert.ok(plan.missingChecks.some((g) => g.check === "hashprice" && /no recorded hashprice answer/.test(g.reason)));
  assert.ok(plan.missingChecks.some((g) => g.check === "hashprice" && /not a fresh answer/.test(g.reason)));
  assert.match(renderPlan(plan), /Hashprice used: \$[\d.]+ per PH\/s per day \(carried from 2026-11-19T12:50Z, 300 min old, inside the 720 min window/);
  assert.match(renderPlan(plan), /yes: carried from 2026-11-19T12:50Z/);
  // What is remembered for the next run is unchanged: carrying does not make the value look newer.
  assert.deepEqual(plan.hashpriceMemory, memory.hashprice);
});

test("hashprice carrying still HOLDs when the value is older than the window, or there is none, or the site turns it off", async () => {
  const { fx, mem } = await accepted();
  const old = await planSite(site(), { ...demoDeps(withoutHashprice()), memory: { hashprice: aged(mem, fx, 13) } });
  assert.ok(old.decisions.every((d) => d.action === "HOLD"));
  assert.ok(old.decisions[0]!.gaps.some((g) => /is not reused: the last accepted answer is 780 min old, past the 720 min window/.test(g.reason)));
  assert.equal(old.hashpriceCarried, undefined);
  const none = await planSite(site(), demoDeps(withoutHashprice()));
  assert.ok(none.decisions.every((d) => d.action === "HOLD"));
  assert.equal(none.hashpriceMemory, null);
  const off = site();
  off.intelligence.maxAgeMin.hashpriceCarry = 0;
  const switchedOff = await planSite(off, { ...demoDeps(withoutHashprice()), memory: { hashprice: aged(mem, fx, 1) } });
  assert.ok(switchedOff.decisions.every((d) => d.action === "HOLD"));
  assert.match(switchedOff.decisions[0]!.gaps.map((g) => g.reason).join(" "), /switched off for this site/);
  // The window is a site field: a 4 h window refuses what 12 h accepts.
  const short = site();
  short.intelligence.maxAgeMin.hashpriceCarry = 240;
  const p = await planSite(short, { ...demoDeps(withoutHashprice()), memory: { hashprice: aged(mem, fx, 5) } });
  assert.ok(p.decisions.every((d) => d.action === "HOLD"));
});

test("an earlier hashprice is not a substitute for an answer that arrived and was refused, for a mode change, or for a moved market", async () => {
  const { fx, mem } = await accepted();
  const memory = { hashprice: aged(mem, fx, 2) };
  // A fresh answer that arrives and disagrees with the public reference is a conflict, not an outage.
  const conflict = loadFixture();
  for (const h of conflict.shaped.hashprice) h.result = { ...h.result, hashprice_sats_per_ph_day: Number(h.result.hashprice_sats_per_ph_day) * 1.5 };
  const c = await planSite(site(), { ...demoDeps(conflict), memory });
  assert.ok(c.decisions.every((d) => d.action === "HOLD"));
  assert.match(c.decisions[0]!.gaps.map((g) => g.reason).join(" "), /did not fail by outage/);
  // A value kept from a demo run is never used in a paid run.
  const paidMode = await planSite(site(), { ...demoDeps(withoutHashprice()), mode: "paid", memory });
  assert.ok(paidMode.decisions.every((d) => d.action === "HOLD"));
  assert.match(paidMode.decisions[0]!.gaps.map((g) => g.reason).join(" "), /kept from a demo run, so it is not reused in a paid run/);
  // If the public reference has moved more than the tolerance since, the old value is not used.
  const moved = await planSite(site(), { ...demoDeps(withoutHashprice()), memory: { hashprice: { ...memory.hashprice, usdPerPhDay: memory.hashprice.usdPerPhDay * 1.2 } } });
  assert.ok(moved.decisions.every((d) => d.action === "HOLD"));
  assert.match(moved.decisions[0]!.gaps.map((g) => g.reason).join(" "), /more than 5% from the public reference/);
});

test("the reuse rule is one function shared by plan and monitor mode", () => {
  const outage = [{ check: "hashprice" as const, subject: "x", reason: "no recorded hashprice answer" }];
  const conflict = [{ check: "hashprice" as const, subject: "x", reason: "providers disagree" }];
  assert.equal(mayReuse({ gaps: outage, ageMs: 60 * 60_000, windowMin: 720 }).ok, true);
  assert.equal(mayReuse({ gaps: outage, ageMs: 721 * 60_000, windowMin: 720 }).ok, false);
  assert.equal(mayReuse({ gaps: conflict, ageMs: 60_000, windowMin: 720 }).ok, false);
  assert.equal(mayReuse({ gaps: outage, ageMs: 60_000, windowMin: 0 }).ok, false);
  assert.equal(mayReuse({ gaps: [], ageMs: 60_000, windowMin: 720 }).ok, false);
});

test("the remembered hashprice round-trips through a state file, and a damaged file is ignored rather than trusted", async () => {
  const { plan } = await accepted();
  const dir = mkdtempSync(join(tmpdir(), "ballast-"));
  const path = join(dir, "state.json");
  assert.deepEqual(loadMemory(path), {}, "no file, nothing remembered");
  saveMemory(path, memoryAfter(plan));
  assert.deepEqual(loadMemory(path).hashprice, plan.hashpriceMemory);
  assert.deepEqual(parseMemory({ hashprice: { usdPerPhDay: "NaN" } }), {});
  assert.deepEqual(parseMemory(null), {});
});

// ------------------------------------------------------------------ 2. recovery from a wrong-market or wrong-interval answer

const HOUR2 = (fx: Fixture) => hourAt(fx, 2);
const daRow = (fx: Fixture, hour: string) => fx.shaped.power.find((p) => p.market === "day-ahead" && p.intervalStart === hour)!;

/** Wraps a transport so a power answer can be altered for the n-th time that interval is asked. */
function tamper(inner: Transport, fx: Fixture, hour: string, alter: (n: number, a: Answer) => Answer): { transport: Transport; asked: () => number } {
  let n = 0;
  return {
    asked: () => n,
    transport: {
      kind: "fixture",
      async ask(req: AskRequest) {
        const a = await inner.ask(req);
        if (req.intent === "GRID_POWER_PRICE_GENERAL" && req.params.interval_start === hour && req.native?.payload.market === "day-ahead") {
          n += 1;
          return alter(n, a);
        }
        return a;
      },
    },
  };
}

test("wrong market, asked again: the provider's second answer is valid, so the hour is decided on it and the recovery is on the record", async () => {
  const fx = loadFixture();
  const hour = HOUR2(fx);
  const deps = demoDeps(fx);
  const t = tamper(deps.transport, fx, hour, (n, a) => (n === 1 ? { ...a, result: { ...a.result, market: "real-time" } } : a));
  const plan = await planSite(site(), { ...deps, transport: t.transport });
  assert.equal(t.asked(), 2);
  const d = plan.decisions.find((x) => x.hour === hour)!;
  assert.notEqual(d.action, "HOLD");
  assert.equal(d.basis, "day-ahead");
  assert.equal(d.powerPriceUsdPerMwh, Number(daRow(fx, hour).result.lmp_usd_per_mwh));
  const first = plan.evidence.find((e) => !e.accepted && /asked for day-ahead but the provider answered real-time/.test(e.reason ?? ""))!;
  const again = plan.evidence.find((e) => e.recovery?.via === "re-ask")!;
  assert.equal(again.recovery!.of, first.id);
  assert.equal(again.accepted, true);
  assert.ok(d.evidence.includes(first.id) && d.evidence.includes(again.id));
  assert.ok(d.reasons.some((r) => r.startsWith("recovered:") && /asking again/.test(r)));
  assert.ok(plan.missingChecks.some((g) => /answered real-time/.test(g.reason)), "the wrong answer is still flagged");
  assert.equal(plan.projectedPaidCostUsd, 0.11, "the second ask cost one answer");
  assert.match(renderPlan(plan), /yes: recovery of E\d+ via asking again/);
});

test("wrong market, still wrong when asked again: the exact interval is read from the public archive and labelled public", async () => {
  const fx = loadFixture();
  const hour = HOUR2(fx);
  daRow(fx, hour).result = { ...daRow(fx, hour).result, market: "real-time" };
  const plan = await planSite(site(), demoDeps(fx));
  const d = plan.decisions.find((x) => x.hour === hour)!;
  assert.notEqual(d.action, "HOLD");
  assert.equal(d.basis, "day-ahead");
  const archive = fx.public.ercot.find((r) => r.market === "day-ahead" && r.intervalStart === hour)!;
  assert.equal(d.powerPriceUsdPerMwh, archive.lmp);
  const rec = plan.evidence.find((e) => e.recovery?.via === "public-archive")!;
  assert.equal(rec.source.kind, "public");
  assert.deepEqual(rec.receipt, {}, "a public number has no receipt");
  assert.ok(d.reasons.some((r) => /used the public ERCOT archive for exactly HB_WEST day-ahead/.test(r) && /not a Telegraph answer/.test(r) && /no receipt/.test(r)));
  assert.equal(plan.telegraphCalls, 11, "one extra ask was spent on the retry");
  // With asking again switched off, the archive alone recovers it and nothing extra is bought.
  const s = site();
  s.intelligence.recovery.reask = false;
  const archiveOnly = await planSite(s, demoDeps(fx));
  assert.equal(archiveOnly.telegraphCalls, 10);
  assert.notEqual(archiveOnly.decisions.find((x) => x.hour === hour)!.action, "HOLD");
});

test("a wrong interval is recovered the same way; a wrong node or a disagreement is not (it is not a question of which market or interval)", async () => {
  const fx = loadFixture();
  const hour = HOUR2(fx);
  daRow(fx, hour).result = { ...daRow(fx, hour).result, interval_start: hourAt(fx, 1) };
  const plan = await planSite(site(), demoDeps(fx));
  assert.notEqual(plan.decisions.find((x) => x.hour === hour)!.action, "HOLD");
  assert.ok(plan.evidence.some((e) => e.recovery?.via === "public-archive"));
  const node = loadFixture();
  daRow(node, hour).result = { ...daRow(node, hour).result, node_or_zone: "HB_HOUSTON" };
  const n = await planSite(site(), demoDeps(node));
  assert.equal(n.decisions.find((x) => x.hour === hour)!.action, "HOLD");
  assert.equal(n.telegraphCalls, 10, "no retry for a different node");
});

test("when neither asking again nor the archive gives a valid answer, Ballast holds as before", async () => {
  const fx = loadFixture();
  const hour = HOUR2(fx);
  daRow(fx, hour).result = { ...daRow(fx, hour).result, market: "real-time" };
  fx.public.ercot = fx.public.ercot.filter((r) => !(r.market === "day-ahead" && r.intervalStart === hour));
  const plan = await planSite(site(), demoDeps(fx));
  const d = plan.decisions.find((x) => x.hour === hour)!;
  assert.equal(d.action, "HOLD");
  assert.match(d.gaps[0]!.reason, /asked for day-ahead but the provider answered real-time/);
  assert.equal(plan.evidence.filter((e) => e.recovery).length, 1, "the retry is on the record, rejected");
  assert.equal(plan.evidence.filter((e) => e.recovery && e.accepted).length, 0);
});

test("recovery never spends past the cap: with no budget left for another ask it goes straight to the free archive", async () => {
  const fx = loadFixture();
  const rt = fx.shaped.power.find((p) => p.market === "real-time")!;
  rt.result = { ...rt.result, market: "day-ahead" };
  const s = site();
  delete s.heat;
  s.intelligence.providers.weather = [];
  s.intelligence.spendCapUsd = 0.02;
  const plan = await planSite(s, demoDeps(fx));
  assert.ok(plan.projectedPaidCostUsd <= 0.02 + 1e-9);
  assert.equal(plan.telegraphCalls, 2, "hashprice and the one real-time ask, no retry");
  const d = plan.decisions[0]!;
  assert.equal(d.basis, "real-time");
  assert.notEqual(d.action, "HOLD");
  assert.ok(plan.evidence.some((e) => e.recovery?.via === "public-archive" && e.accepted));
  assert.equal(plan.budgetBreached, true);
});

// ------------------------------------------------------------------ 3. pricing the hour from the intervals already published

const RT_MINER = "7310042";
function addRealTime(fx: Fixture, start: string, lmp: number, opts: { provider?: boolean; answeredAt?: string } = {}) {
  fx.public.ercot.push({ market: "real-time", node: "HB_WEST", intervalStart: start, lmp, source: "ERCOT public MIS archive (recorded)" });
  if (opts.provider)
    fx.shaped.power.push({
      market: "real-time", minerId: RT_MINER, intervalStart: start, answeredAt: opts.answeredAt ?? fx.recordedAt, recordedFrom: "SYNTHETIC test data",
      result: { lmp_usd_per_mwh: lmp, node_or_zone: "HB_WEST", market: "real-time", interval_start: start, currency: "USD", iso: "ERCOT" },
    });
}

test("the current hour is the mean of its published intervals with the latest repeated for the rest, not the latest interval alone", async () => {
  const fx = loadFixture(); // decided at 17:50Z: 17:00, 17:15 and 17:30 are published, 17:30 is the one bought ($16.79)
  addRealTime(fx, "2026-11-19T17:00:00.000Z", 10);
  addRealTime(fx, "2026-11-19T17:15:00.000Z", 20);
  const plan = await planSite(site(), demoDeps(fx));
  const d = plan.decisions[0]!;
  assert.equal(d.basis, "real-time");
  assert.ok(Math.abs(d.powerPriceUsdPerMwh! - (10 + 20 + 16.79 + 16.79) / 4) < 0.011, String(d.powerPriceUsdPerMwh));
  assert.ok(d.reasons.some((r) => /^hour estimate: 3 of 4 intervals are published for this hour \(17:00 \$10, 17:15 \$20, 17:30 \$16\.79; the earlier ones from the public ERCOT archive, public and not a Telegraph answer\)/.test(r)));
  assert.ok(d.evidence.some((id) => plan.evidence.find((e) => e.id === id)!.subject.endsWith("17:00:00.000Z") && plan.evidence.find((e) => e.id === id)!.source.kind === "public"));
  assert.equal(plan.telegraphCalls, 10, "the earlier intervals come from the free archive: nothing extra is bought");
  assert.deepEqual(plan.missingChecks, [], "an estimate is not a missing check");
  // The old rule is one site field away and reproduces the old price.
  const old = site();
  old.planning.hourEstimate.mode = "latest-interval";
  const before = await planSite(old, demoDeps(fx));
  assert.equal(before.decisions[0]!.powerPriceUsdPerMwh, 16.79);
  assert.ok(!before.decisions[0]!.reasons.some((r) => r.startsWith("hour estimate")));
});

test("the earlier intervals can be bought from the provider instead, validated and receipted like any other answer", async () => {
  const fx = loadFixture();
  for (const [start, lmp] of [["2026-11-19T17:00:00.000Z", 10], ["2026-11-19T17:15:00.000Z", 20]] as const) addRealTime(fx, start, lmp, { provider: true, answeredAt: "2026-11-19T17:50:10.000Z" });
  const s = site();
  s.planning.hourEstimate.earlierIntervals = "telegraph";
  const plan = await planSite(s, demoDeps(fx));
  assert.ok(Math.abs(plan.decisions[0]!.powerPriceUsdPerMwh! - 15.895) < 0.011);
  assert.equal(plan.telegraphCalls, 12);
  assert.match(plan.decisions[0]!.reasons.find((r) => r.startsWith("hour estimate"))!, /the earlier ones from the provider/);
});

test("when published intervals cannot be read the estimate falls back to the latest one and says so", async () => {
  const plan = await planSite(site(), demoDeps(loadFixture())); // the recorded day only has the 17:30 interval
  const d = plan.decisions[0]!;
  assert.equal(d.powerPriceUsdPerMwh, 16.79);
  assert.ok(d.reasons.some((r) => /2 published intervals of this hour could not be read and were not used/.test(r)));
});

test("before any interval of the hour is published the price is provisional, says when to decide again, and uses the previous hour's last interval", async () => {
  const fx = loadFixture();
  const now = new Date("2026-11-19T17:10:00.000Z");
  addRealTime(fx, "2026-11-19T16:45:00.000Z", 30, { provider: true, answeredAt: iso(now.getTime() - 20_000) });
  const plan = await planSite(site(), { ...demoDeps(fx), now });
  const d = plan.decisions[0]!;
  assert.equal(d.hour, "2026-11-19T17:00:00.000Z");
  assert.equal(d.powerPriceUsdPerMwh, 30);
  assert.equal(d.revisitAt, "2026-11-19T17:15:00.000Z");
  assert.ok(d.reasons.some((r) => /^provisional: no 15-minute interval of this hour is published yet \(the first, 17:00, ends at 17:15Z\).*decide again after 17:15Z/.test(r)));
  assert.equal(plan.decisions[1]!.revisitAt, undefined, "later hours are day-ahead and not provisional");
  assert.match(renderPlan(plan), /Provisional: 11-19 17:00 \(decide again after 17:15Z\)/);
});

// ------------------------------------------------------------------ monitor mode shares all three

const load = (name: string): Timeline => loadTimeline(new URL(`../fixtures/monitor-${name}.json`, import.meta.url));
const monitorSite = () => site();

function outageTimeline(carryMin?: number): Timeline {
  const demo = load("demo");
  return {
    ...demo, synthetic: true, label: "SYNTHETIC: hashprice accepted at 18:14, provider outage from 19:14",
    siteOverrides: { planning: { hours: 6 }, ...(carryMin !== undefined ? { intelligence: { maxAgeMin: { hashpriceCarry: carryMin } } } : {}) },
    ticks: [
      { events: [{ type: "hashprice", usd: 29.31, public: 28.15 }, { type: "realTime", lmp: 15.92 }] }, {}, {}, {},
      { note: "Hashprice provider goes down at the hourly refresh.", events: [{ type: "hashprice", available: false }] }, {},
    ],
  };
}

test("monitor mode carries the accepted hashprice by the same rule and the same site window as plan mode", async () => {
  const m = new DemoMonitor(monitorSite(), outageTimeline());
  await m.runAll();
  const t = m.session.history[4]!;
  assert.ok(t.hours.every((h) => h.action !== "NO RECOMMENDATION"), "decided on the carried hashprice");
  assert.equal(t.hashpriceUsdPerPhDay, 29.31);
  assert.ok(t.actions.some((a) => /hashprice refresh failed .*; carried from 18:14Z \(60 min old\), inside its 720 min window/.test(a)), t.actions.join("\n"));
  assert.ok(t.hours[0]!.reasons.some((r) => /^hashprice carried from 18:14Z/.test(r)));
  // The site's own window decides: a 30 minute window refuses the 60 minute old value and the hours abstain.
  const short = new DemoMonitor(monitorSite(), outageTimeline(30));
  await short.runAll();
  const s = short.session.history[4]!;
  assert.ok(s.hours.every((h) => h.action === "NO RECOMMENDATION" && h.abstain?.kind === "missing"));
  assert.ok(s.actions.some((a) => /the earlier answer is not reused: the last accepted answer is 60 min old, past the 30 min window/.test(a)), s.actions.join("\n"));
});

test("monitor mode recovers a day-ahead answer for the wrong hour from the public archive, and still abstains on a stale real-time feed", async () => {
  const m = new DemoMonitor(monitorSite(), load("stale"));
  await m.runAll();
  const [t0, t1, t2] = m.session.history;
  const twenty = t0!.hours.find((h) => h.hour.slice(11, 16) === "20:00")!;
  assert.notEqual(twenty.action, "NO RECOMMENDATION");
  assert.ok(twenty.reasons.some((r) => /^recovered: .*stale or substituted interval.*used the public ERCOT archive for exactly HB_WEST day-ahead 2026-11-19T20:00/.test(r)), twenty.reasons.join("\n"));
  assert.ok(m.session.ctx.evidence.some((e) => e.recovery?.via === "public-archive" && e.accepted));
  // A real-time feed that serves two-hour-old answers is not a wrong interval: no recovery, the current hour still abstains.
  const lag = t1!.hours.find((h) => h.hour.slice(11, 16) === "18:00")!;
  assert.equal(lag.action, "NO RECOMMENDATION");
  assert.equal(lag.abstain?.kind, "stale");
  assert.ok(t2!.hours.every((h) => h.action !== "NO RECOMMENDATION"));
});

test("monitor mode prices the current hour the same way: provisional early in the hour, the same estimate later", async () => {
  const m = new DemoMonitor(monitorSite(), load("demo"));
  await m.runAll();
  // Tick 1 is 18:14: no interval of 18:00 is published yet.
  const first = m.session.history[0]!.hours[0]!;
  assert.ok(first.reasons.some((r) => /^provisional: no 15-minute interval of this hour is published yet/.test(r)));
  assert.equal(first.snapshot.priceUsd, 15.92);
  // Tick 2 is 18:29: the 18:00 interval is published and is the latest, so it is the only one: the hour estimate says so.
  const second = m.session.history[1]!.hours[0]!;
  assert.ok(!second.reasons.some((r) => r.startsWith("provisional")));
  assert.ok(second.reasons.some((r) => /^hour estimate: 18:00 is the only interval published for this hour/.test(r)), second.reasons.join("\n"));
});
