// Monitor mode tests. Every timeline here is recorded or SYNTHETIC (fixtures/monitor-*.json on top of fixtures/recorded.json):
// no network, no payment, no real waiting.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSite } from "../src/config.ts";
import { diffHour, type HourState, type Snapshot } from "../src/diff.ts";
import { createHandler } from "../src/http.ts";
import { handleRpc } from "../src/mcp.ts";
import { DemoMonitor } from "../src/monitor-demo.ts";
import { renderTick } from "../src/monitor-render.ts";
import { runLive, type TickResult } from "../src/monitor.ts";
import { loadTimeline, type Timeline } from "../src/timeline.ts";
import { createTools } from "../src/tools.ts";

const site = () => parseSite(JSON.parse(readFileSync(new URL("../sites/west-texas.json", import.meta.url), "utf8")));
const load = (name: string): Timeline => loadTimeline(new URL(`../fixtures/monitor-${name}.json`, import.meta.url));

async function run(name: string, cap?: number, timeline: Timeline = load(name)) {
  const demo = new DemoMonitor(site(), timeline, undefined, cap);
  await demo.runAll();
  return demo.session;
}
const hourOf = (r: TickResult, hhmm: string) => r.hours.find((h) => h.hour.slice(11, 16) === hhmm)!;
const changeOf = (r: TickResult, hhmm: string) => r.changes.find((c) => c.hour.slice(11, 16) === hhmm)!;

test("price spike flips RUN to CURTAIL and says why, with evidence ids and receipts", async () => {
  const s = await run("demo");
  const first = s.history[0]!;
  // Tick 1 reproduces the recorded live run: hashprice $29.31, real-time $15.92 for 17:45, RUN at $39.23/MWh.
  assert.equal(first.hashpriceUsdPerPhDay, 29.31);
  assert.equal(hourOf(first, "18:00").action, "RUN");
  assert.equal(hourOf(first, "18:00").snapshot.marginUsd, 39.23);
  assert.equal(hourOf(first, "18:00").snapshot.interval, "2026-11-19T17:45:00.000Z");

  const spike = changeOf(s.history[2]!, "18:00");
  assert.equal(spike.kind, "flipped");
  assert.deepEqual([spike.from, spike.to], ["RUN", "CURTAIL"]);
  assert.match(spike.text, /^18:00 changed RUN → CURTAIL: /);
  assert.match(spike.text, /Pecos real-time for 18:15 rose from \$15\.92 to \$142\.10 \(E\d+, receipt fixture:[0-9a-f]{12}\)/);
  assert.match(spike.text, /public ERCOT archive agrees within \$0\.40 \(E\d+\)/);
  assert.match(spike.text, /margin fell from \$39\.23 to -\$86\.95\/MWh/);
  // Every cited id is a real item in the session ledger.
  for (const id of spike.text.match(/E\d+/g)!) assert.ok(s.ctx.evidence.some((e) => e.id === id), `${id} exists`);
  assert.ok(s.history[2]!.hours.every((h) => h.hour === "2026-11-19T18:00:00.000Z" || h.action !== "CURTAIL"), "only the spiking hour flipped");
});

test("price recovers: CURTAIL goes back to RUN", async () => {
  const s = await run("demo");
  const back = changeOf(s.history[3]!, "18:00");
  assert.equal(back.kind, "flipped");
  assert.deepEqual([back.from, back.to], ["CURTAIL", "RUN"]);
  assert.match(back.text, /fell from \$142\.10 to \$24\.00/);
  assert.match(back.text, /margin rose from -\$86\.95 to \$31\.15\/MWh/);
});

test("unchanged decisions are reported briefly, and a new real-time answer for the same price is not a change", async () => {
  const s = await run("demo");
  const quiet = s.history[1]!;
  assert.ok(quiet.changes.every((c) => c.kind === "unchanged"));
  assert.match(renderTick(quiet), /CHANGED: nothing\nUNCHANGED: 18:00 RUN; 19:00 RUN/);
  // The spike tick leaves the other hours alone.
  assert.ok(s.history[2]!.changes.filter((c) => c.hour.slice(11, 16) !== "18:00").every((c) => c.kind === "unchanged"));
  // The hour that moves from day-ahead to real-time at 19:14 stays RUN but its margin is reported when it moves.
  const nineteen = changeOf(s.history[4]!, "19:00");
  assert.equal(nineteen.kind, "unchanged");
  assert.match(nineteen.text, /margin \$36\.99 → \$/);
});

test("providers disagree beyond tolerance: NO RECOMMENDATION, then revisited when they agree", async () => {
  const s = await run("disagreement");
  const [t0, t1, t2, t3] = s.history;
  assert.equal(hourOf(t0!, "18:00").action, "RUN");
  const held = hourOf(t1!, "18:00");
  assert.equal(held.action, "NO RECOMMENDATION");
  assert.equal(held.abstain?.kind, "conflict");
  assert.match(held.abstain!.reasons.join(" "), /disagree.*says 20.*archive says 95/);
  assert.equal(held.abstain!.lastDecided?.action, "RUN");
  assert.ok(held.abstain!.needs.some((n) => n.check === "power-real-time" && /Pecos 7310042/.test(n.provider) && /ERCOT archive/.test(n.provider)));
  assert.equal(changeOf(t1!, "18:00").kind, "abstained");
  assert.match(changeOf(t1!, "18:00").text, /changed RUN → NO RECOMMENDATION/);
  assert.equal(changeOf(t2!, "18:00").kind, "still-abstaining");
  const resolved = changeOf(t3!, "18:00");
  assert.equal(resolved.kind, "resolved");
  assert.equal(resolved.to, "RUN");
  assert.match(resolved.text, /revisited: NO RECOMMENDATION → RUN/);
  // The other hours were never in doubt.
  assert.ok(t1!.hours.filter((h) => h.hour.slice(11, 16) !== "18:00").every((h) => h.action !== "NO RECOMMENDATION"));
});

test("stale price: held while the answer is stale, revisited when a fresh one arrives", async () => {
  const s = await run("stale");
  const [t0, t1, t2] = s.history;
  // Tick 1: Pecos answers the 20:00 day-ahead question with 19:00's price.
  const wrongHour = hourOf(t0!, "20:00");
  assert.equal(wrongHour.action, "NO RECOMMENDATION");
  assert.equal(wrongHour.abstain?.kind, "stale");
  assert.match(wrongHour.abstain!.reasons.join(" "), /stale or substituted interval/);
  assert.equal(hourOf(t0!, "18:00").action, "RUN");
  // Tick 2: real-time feed serves two-hour-old answers. The current hour is held, not decided from day-ahead.
  const lag = hourOf(t1!, "18:00");
  assert.equal(lag.action, "NO RECOMMENDATION");
  assert.equal(lag.abstain?.kind, "stale");
  assert.match(lag.abstain!.reasons.join(" "), /stale: answered at/);
  assert.equal(hourOf(t1!, "20:00").action, "NO RECOMMENDATION", "retried and still wrong");
  // Tick 3: both recover and both held hours are revisited.
  assert.equal(changeOf(t2!, "18:00").kind, "resolved");
  assert.equal(changeOf(t2!, "20:00").kind, "resolved");
  assert.ok(t2!.hours.every((h) => h.action !== "NO RECOMMENDATION"));
});

test("missing hashprice: nothing is decided and nothing is bought, then every hour is revisited when it arrives", async () => {
  const s = await run("missing-hashprice");
  const [t0, t1, t2, t3] = s.history;
  for (const t of [t0!, t1!]) {
    assert.ok(t.hours.every((h) => h.action === "NO RECOMMENDATION" && h.abstain?.kind === "missing"));
    assert.ok(t.hours.every((h) => h.abstain!.needs.some((n) => n.check === "hashprice" && /Gauge 4283/.test(n.provider))));
    assert.equal(t.spend.sessionUsd, 0, "no prices are bought without a hashprice");
    assert.equal(t.hashpriceUsdPerPhDay, null);
  }
  assert.ok(t2!.changes.every((c) => c.kind === "resolved" && c.from === "NO RECOMMENDATION"));
  assert.ok(t2!.hours.every((h) => h.action !== "NO RECOMMENDATION"));
  assert.ok(t3!.changes.every((c) => c.kind === "unchanged"));
});

test("the spend cap is per session: buying stops, and hours that needed a refresh are NO RECOMMENDATION", async () => {
  const s = await run("spend-cap");
  assert.ok(s.spentUsd <= 0.12 + 1e-9);
  const h = s.history;
  assert.equal(h[3]!.spend.capReached, false);
  const capped = hourOf(h[4]!, "19:00");
  assert.equal(h[4]!.spend.capReached, true);
  assert.equal(capped.action, "NO RECOMMENDATION");
  assert.equal(capped.abstain?.kind, "budget");
  assert.match(capped.abstain!.reasons.join(" "), /spend cap \$0\.12 reached/);
  assert.equal(capped.abstain!.lastDecided?.action, "RUN");
  assert.ok(capped.abstain!.needs.some((n) => n.check === "budget"));
  // Nothing more is bought after the cap, even though the world kept changing.
  assert.equal(h[5]!.bought.length, 0);
  assert.equal(h[6]!.bought.length, 0);
  assert.equal(h[6]!.spend.sessionUsd, h[4]!.spend.sessionUsd);
  // Hours priced from day-ahead earlier still stand: day-ahead is slow and was fresh.
  assert.equal(hourOf(h[6]!, "21:00").action, "RUN");
  assert.equal(hourOf(h[6]!, "19:00").action, "NO RECOMMENDATION");
});

test("a cap lower than the timeline's own cap stops the session early and never misses a spike silently", async () => {
  const s = await run("demo", 0.09);
  assert.ok(s.spentUsd <= 0.09 + 1e-9);
  const spikeTick = s.history[2]!;
  const hour = hourOf(spikeTick, "18:00");
  assert.equal(hour.action, "NO RECOMMENDATION", "the spike tick could not be bought, so no stale RUN is shown");
  assert.equal(hour.abstain?.kind, "budget");
  assert.match(changeOf(spikeTick, "18:00").text, /NO RECOMMENDATION/);
});

test("negative-price hour: running earns, and a day-ahead revision to $450 flips that hour to CURTAIL", async () => {
  const s = await run("negative-price");
  const t1 = s.history[1]!;
  const neg = hourOf(t1, "21:00");
  assert.equal(neg.snapshot.priceUsd, -18.4);
  assert.equal(neg.action, "RUN");
  assert.match(neg.reasons.join(" "), /negative price: running earns \$10\.4\/MWh/);
  const spike = changeOf(t1, "22:00");
  assert.deepEqual([spike.from, spike.to], ["RUN", "CURTAIL"]);
  assert.match(spike.text, /Pecos day-ahead for 22:00 rose from \$33\.19 to \$450\.00/);
  assert.ok(!t1.forecast.some((f) => /22:00/.test(f.text)), "a $450 hour is not about to flip, so it is not flagged");
  // Real-time for the current hour goes negative at tick 3.
  const t2 = s.history[2]!;
  assert.equal(hourOf(t2, "18:00").snapshot.priceUsd, -6.5);
  assert.match(hourOf(t2, "18:00").reasons.join(" "), /negative price/);
  assert.equal(hourOf(t2, "18:00").action, "RUN");
});

test("anticipation is labelled as a forecast, names the break-even price, and never changes a decision", async () => {
  const s = await run("demo");
  const t0 = s.history[0]!;
  assert.ok(t0.forecast.length > 0);
  assert.ok(t0.forecast.every((f) => f.text.startsWith("FORECAST, not a decision:")));
  const f = t0.forecast.find((x) => /23:00/.test(x.text))!;
  assert.match(f.text, /could flip to CURTAIL if real-time tracks day-ahead above \$55\.15\/MWh/);
  assert.equal(f.thresholdUsdPerMwh, 55.15);
  assert.equal(hourOf(t0, "23:00").action, "THROTTLE", "the forecast did not alter the decision");
  // The threshold moves with hashprice: after it fell to $27.00 the break-even is lower.
  assert.match(s.history[5]!.forecast.map((x) => x.text).join("\n"), /above \$50\.57\/MWh/);
});

test("heat anticipation: a hot forecast is flagged before the shutdown limit", async () => {
  const base = load("demo");
  const tl: Timeline = { ...base, policy: { weatherEveryMin: 15 }, ticks: [base.ticks[0]!, { note: "SYNTHETIC heat wave in the forecast.", events: [{ type: "heat", deltaC: 18 }] }] };
  const s = await run("demo", undefined, tl);
  const t1 = s.history[1]!;
  assert.ok(t1.forecast.some((f) => f.kind === "heat" && /above 30C/.test(f.text)), t1.forecast.map((f) => f.text).join("\n"));
  assert.ok(hourOf(t1, "19:00").snapshot.tempC! > 30);
});

test("the monitor reuses slow inputs: a quiet tick costs one real-time answer", async () => {
  const s = await run("demo");
  assert.equal(s.history[0]!.spend.tickUsd, 0.08);
  assert.equal(s.history[1]!.spend.tickUsd, 0.01);
  assert.ok(s.history.every((t) => t.spend.sessionUsd <= t.spend.capUsd));
  assert.equal(s.spentUsd, 0.23);
});

test("diffHour: wording for a new hour, a flip, an abstention and a revisit", () => {
  const snap = (over: Partial<Snapshot>): Snapshot => ({
    basis: "real-time", priceUsd: 20, interval: "2026-11-19T18:00:00.000Z", provider: "Pecos", priceCite: { evidence: "E1", receipt: "0xb21b0c8b8212112ffd49a9564643d066a4d5e7db21f37654b21fd32e11685b94" },
    crossCheck: { lmp: 20.1, evidence: "E2" }, hashpriceUsd: 29.31, tempC: null, marginUsd: 35, revenueUsd: 58, costUsd: 23, ...over,
  });
  const st = (action: HourState["action"], s: Snapshot, abstain?: HourState["abstain"]): HourState => ({ hour: "2026-11-19T19:00:00.000Z", action, runFraction: 1, snapshot: s, abstain, reasons: [], evidence: [], expectedProfitUsd: null });
  const run = st("RUN", snap({}));
  const bad = st("CURTAIL", snap({ priceUsd: 90, marginUsd: -35, crossCheck: { lmp: 90.3, evidence: "E4" }, priceCite: { evidence: "E3", receipt: "0xabc" } }));
  assert.match(diffHour(undefined, run).text, /^19:00 RUN: priced from Pecos real-time for 18:00 at \$20\.00 \(E1, receipt 0xb21b0c8b…5b94\)/);
  assert.match(diffHour(run, bad).text, /^19:00 changed RUN → CURTAIL: Pecos real-time for 18:00 rose from \$20\.00 to \$90\.00 \(E3, receipt 0xabc\); public ERCOT archive agrees within \$0\.30 \(E4\); margin fell from \$35\.00 to -\$35\.00\/MWh\.$/);
  const held = st("NO RECOMMENDATION", snap({ priceUsd: null, marginUsd: null }), { kind: "stale", reasons: ["stale: answered at 15:00"], needs: [] });
  assert.equal(diffHour(run, held).kind, "abstained");
  assert.equal(diffHour(held, held).kind, "still-abstaining");
  assert.equal(diffHour(held, run).kind, "resolved");
  assert.equal(diffHour(run, run).kind, "unchanged");
});

test("the decision history is kept in memory and written to a JSON log", async () => {
  const demo = new DemoMonitor(site(), load("disagreement"));
  const dir = mkdtempSync(join(tmpdir(), "ballast-monitor-"));
  const path = join(dir, "log.json");
  await demo.runAll(() => demo.session.writeLog(path));
  const log = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(log.ticks.length, demo.total);
  assert.equal(log.sessionCapUsd, 0.5);
  assert.equal(log.evidence.length, demo.session.ctx.evidence.length);
  assert.equal(log.ticks[1].changes.find((c: { kind: string }) => c.kind === "abstained").to, "NO RECOMMENDATION");
  const path2 = [...demo.session.path()].find(([h]) => h.endsWith("18:00:00.000Z"))![1];
  assert.deepEqual(path2.map((p) => p.action), ["RUN", "NO RECOMMENDATION", "RUN"]);
});

test("live mode is a code path that refuses to start without --paid, a cap, and credentials", async () => {
  await assert.rejects(runLive({ site: site(), paid: false, capUsd: 1, cadenceMin: 15, env: {} }), /pass --paid/);
  await assert.rejects(runLive({ site: site(), paid: true, capUsd: 0, cadenceMin: 15, env: {} }), /cap/);
  await assert.rejects(runLive({ site: site(), paid: true, capUsd: Number.NaN, cadenceMin: 15, env: {} }), /cap/);
  await assert.rejects(runLive({ site: site(), paid: true, capUsd: 0.2, cadenceMin: 15, env: {} }), /ANJOMAN_API_KEY.*BALLAST_SIGNER_MODULE/);
});

test("tools: monitor_site replays a timeline, whats_changed explains a tick, and the demo cannot be talked into paid mode", async () => {
  const tools = createTools({ paid: false, maxCapUsd: 0.5 });
  const out = await tools.monitor_site({ timeline: "disagreement" });
  assert.match(out.monitorId, /^m/);
  assert.equal(out.done, true);
  assert.match(out.text, /MONITOR DEMO/);
  assert.match(out.text, /NO RECOMMENDATION/);
  const second = await tools.whats_changed({ monitorId: out.monitorId, tick: 2 });
  assert.match(second.text, /changed RUN → NO RECOMMENDATION/);
  assert.match(second.text, /needs: power-real-time from Pecos 7310042/);
  assert.match((await tools.whats_changed({ monitorId: out.monitorId })).text, /Tick 5 of 5/);
  assert.match((await tools.whats_changed({ monitorId: "nope" })).text, /Unknown monitorId/);
  assert.match((await tools.whats_changed({ monitorId: out.monitorId, tick: 99 })).text, /No tick 99/);
  // Step-by-step advance.
  const a = await tools.monitor_site({ timeline: "stale", ticks: 1 });
  assert.equal(a.done, false);
  assert.equal(a.tick?.tick, 0);
  const b = await tools.monitor_site({ monitorId: a.monitorId });
  assert.equal(b.tick?.tick, 1);
  // Caller input cannot read other files, raise the ceiling, or switch paid mode on.
  await assert.rejects(tools.monitor_site({ timeline: "../recorded" }), /unknown timeline/);
  await assert.rejects(tools.monitor_site({ timeline: "nope" }), /unknown timeline/);
  assert.equal((await tools.monitor_site({ timeline: "demo", capUsd: 99, ticks: 1 })).capUsd, 0.5);
  const paidAsk = await tools.monitor_site({ timeline: "demo", ticks: 1, ...({ paid: true } as object) });
  assert.match(paidAsk.text, /MONITOR DEMO/);
});

test("tools: a paid server without credentials refuses instead of falling back to the demo", async () => {
  const tools = createTools({ paid: true, maxCapUsd: 0.2, env: {} });
  await assert.rejects(tools.monitor_site({}), /ANJOMAN_API_KEY|BALLAST_SIGNER_MODULE/);
});

test("MCP and HTTP expose monitor_site and whats_changed", async () => {
  const tools = createTools({ paid: false, maxCapUsd: 0.5 });
  const rpc = async (id: number, name: string, args: object) => (await handleRpc(tools, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } };
  const started = await rpc(1, "monitor_site", { timeline: "missing-hashprice" });
  const text = started.result.content[0]!.text;
  assert.match(text, /^monitorId: m/);
  const monitorId = /monitorId: (\w+)/.exec(text)![1]!;
  const changed = await rpc(2, "whats_changed", { monitorId, tick: 3 });
  assert.match(changed.result.content[0]!.text, /revisited: NO RECOMMENDATION → RUN/);
  assert.equal((await rpc(3, "monitor_site", { timeline: "bogus" })).result.isError, true);

  const handler = createHandler(tools, "secret-token");
  const call = async (method: string, url: string, body?: unknown, key?: string) => {
    const listeners: Record<string, (c?: Buffer) => void> = {};
    const req = { method, url, headers: { host: "t", ...(key ? { "x-api-key": key } : {}) }, on: (e: string, f: (c?: Buffer) => void) => ((listeners[e] = f), req), destroy() {} } as unknown as IncomingMessage;
    let status = 0;
    let out = "";
    const res = { writeHead: (s: number) => (status = s), end: (t: string) => (out = t) } as unknown as ServerResponse;
    const done = handler(req, res);
    if (body !== undefined) listeners.data?.(Buffer.from(JSON.stringify(body)));
    listeners.end?.();
    await done;
    return { status, body: JSON.parse(out) as Record<string, any> };
  };
  const api = (await call("GET", "/openapi.json")).body;
  assert.equal(api.paths["/monitor_site"].post.operationId, "monitor_site");
  assert.equal(api.paths["/whats_changed"].post.operationId, "whats_changed");
  assert.equal((await call("POST", "/monitor_site", {})).status, 401);
  const ran = await call("POST", "/monitor_site", { timeline: "spend-cap", paid: true }, "secret-token");
  assert.equal(ran.status, 200);
  assert.match(ran.body.text, /MONITOR DEMO/);
  const who = await call("POST", "/whats_changed", { monitorId: ran.body.monitorId, tick: 5 }, "secret-token");
  assert.match(who.body.text, /\[budget\]/);
});
