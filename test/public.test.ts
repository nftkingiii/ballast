import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createHandler } from "../src/http.ts";
import { createPublicApi, type PublicOptions } from "../src/public-api.ts";
import { LiveLimiter, WindowLimiter } from "../src/public-limits.ts";
import { demoDeps } from "../src/runtime.ts";
import { readLedgerAvailableUsd, type Transport } from "../src/telegraph.ts";
import { createTools } from "../src/tools.ts";
import { loadComparison, loadSite, listSites } from "../src/public-data.ts";

const WALLET = "0xSECRETWALLETADDRESS000000000000000000000001";

/** A "live" transport that answers from the recorded fixture but charges, so cost, cap and receipts can be tested without paying. */
function chargingDeps(perCall: number, gate?: Promise<void>) {
  return async () => {
    const base = demoDeps();
    const transport: Transport = {
      kind: "engine",
      async ask(request) {
        if (gate) await gate;
        const a = await base.transport.ask(request);
        return { ...a, costUsd: perCall, receipt: { receiptHash: `0x${"ab".repeat(32)}`, rail: "escrow" } };
      },
    };
    return { ...base, transport, mode: "paid" as const, label: `LIVE PAID via wallet ${WALLET}` };
  };
}

async function serve(overrides: Partial<PublicOptions> = {}, token?: string) {
  const api = createPublicApi({
    liveEnabled: true,
    liveDeps: chargingDeps(0.01),
    demoDeps: () => demoDeps(),
    getBalanceUsd: async () => 5,
    ...overrides,
  });
  const tools = createTools({ paid: false, maxCapUsd: 0.5 });
  const server: Server = createServer(createHandler(tools, token, api));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function post(base: string, body: unknown, ip = "1.1.1.1") {
  const res = await fetch(`${base}/public/run`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("ndjson")) return { status: res.status, events: text.trim().split("\n").map((l) => JSON.parse(l)), text };
  return { status: res.status, body: JSON.parse(text), text };
}
const last = (events: any[]) => events.at(-1);

test("limiter: one at a time, daily total, per IP, UTC rollover, and a released uncommitted slot costs nothing", () => {
  let t = Date.parse("2026-11-21T10:00:00Z");
  const l = new LiveLimiter({ dailyMax: 4, perIpMax: 2, now: () => new Date(t) });
  const a = l.reserve("a");
  assert.ok("ticket" in a);
  assert.deepEqual(l.reserve("b"), { refused: "busy" });
  a.ticket.release(); // refused before buying: not counted
  assert.equal(l.status("a").usedToday, 0);
  for (let i = 0; i < 2; i++) {
    const r = l.reserve("a");
    assert.ok("ticket" in r);
    r.ticket.commit();
    r.ticket.release();
    r.ticket.release();
  }
  assert.deepEqual(l.reserve("a"), { refused: "ip" });
  for (const ip of ["b", "c"]) {
    const r = l.reserve(ip) as { ticket: any };
    r.ticket.commit();
    r.ticket.release();
  }
  assert.deepEqual(l.reserve("d"), { refused: "daily" });
  assert.equal(l.status("d").remainingToday, 0);
  t = Date.parse("2026-11-22T00:00:01Z");
  assert.ok("ticket" in l.reserve("a"), "a new UTC day resets both counts");
});

test("limiter defaults are 20 a day and 3 per IP", () => {
  const l = new LiveLimiter();
  assert.equal(l.dailyMax, 20);
  assert.equal(l.perIpMax, 3);
});

test("demo window limiter", () => {
  let t = 0;
  const w = new WindowLimiter(2, 1000, () => t);
  assert.ok(w.allow("x") && w.allow("x"));
  assert.ok(!w.allow("x"));
  t = 1001;
  assert.ok(w.allow("x"));
});

test("demo run: streams each ask, labels DEMO, makes no paid calls, and is not stored as a live run", async () => {
  const s = await serve();
  try {
    const r = await post(s.base, { site: "west-texas", mode: "demo" });
    assert.equal(r.status, 200);
    const ev = r.events!;
    assert.equal(ev[0].type, "start");
    assert.ok(ev.some((e) => e.type === "ask") && ev.some((e) => e.type === "answer"));
    const res = last(ev);
    assert.equal(res.type, "result");
    assert.equal(res.mode, "demo");
    assert.match(res.label, /DEMO/);
    assert.match(res.plan.label, /DEMO/);
    assert.equal(res.plan.intelligenceCostUsd, 0);
    assert.equal(s.api.recent.length, 0);
    assert.equal(s.api.limiter.status("1.1.1.1").usedToday, 0);
  } finally {
    await s.close();
  }
});

test("live run: stays under the per-run cap, labels live, hides the wallet, is listed and counted", async () => {
  const s = await serve({ liveDeps: chargingDeps(0.05) });
  try {
    const r = await post(s.base, { site: "west-texas", mode: "live" });
    assert.equal(r.status, 200);
    const res = last(r.events!);
    assert.equal(res.type, "result");
    assert.equal(res.mode, "live");
    assert.equal(res.plan.label, "live · testnet (Sepolia test USDC)");
    assert.ok(res.plan.spendCapUsd <= 0.4 + 1e-9, "the per-run cap is $0.40");
    assert.ok(res.plan.intelligenceCostUsd <= 0.4 + 1e-9, `spent ${res.plan.intelligenceCostUsd}`);
    assert.equal(res.plan.budgetBreached, true, "at $0.05 a call the fixture plan needs more than the cap, so later hours are held");
    assert.ok(res.plan.decisions.some((d: any) => d.action === "HOLD"));
    assert.ok(!r.text.includes(WALLET), "the paid label (which names the wallet) never reaches the browser");
    assert.equal(res.remainingToday, 19);
    const list = (await (await fetch(`${s.base}/public/runs`)).json()) as any;
    assert.equal(list.runs.length, 1);
    assert.equal(list.runs[0].costUsd, res.plan.intelligenceCostUsd);
    const one = (await (await fetch(`${s.base}/public/runs/${res.runId}`)).json()) as any;
    assert.equal(one.mode, "live");
    const st = (await (await fetch(`${s.base}/public/status`, { headers: { "x-real-ip": "1.1.1.1" } })).json()) as any;
    assert.equal(st.live.remainingToday, 19);
    assert.equal(st.live.remainingForYou, 2);
  } finally {
    await s.close();
  }
});

test("live run: a cheap run is whole and under the cap", async () => {
  const s = await serve({ liveDeps: chargingDeps(0.01) });
  try {
    const res = last((await post(s.base, { site: "west-texas", mode: "live" })).events!);
    assert.equal(res.plan.budgetBreached, false);
    assert.ok(res.plan.intelligenceCostUsd > 0 && res.plan.intelligenceCostUsd <= 0.4);
    assert.ok(res.plan.evidence.some((e: any) => e.receipt.receiptHash));
  } finally {
    await s.close();
  }
});

test("live run refused below $1 of escrow, or when the balance cannot be read: nothing bought, nothing counted, demo offered", async () => {
  let asked = 0;
  const liveDeps = async (site: any) => ((asked++, chargingDeps(0.01)()));
  for (const getBalanceUsd of [async () => 0.99, async () => { throw new Error("401"); }]) {
    const s = await serve({ getBalanceUsd, liveDeps });
    try {
      const r = await post(s.base, { site: "west-texas", mode: "live" });
      assert.equal(r.status, 503);
      assert.ok((r.body as any).offerDemo);
      assert.match((r.body as any).message, /nothing was paid/);
      assert.equal(asked, 0);
      assert.equal(s.api.limiter.status("1.1.1.1").usedToday, 0);
      assert.equal(s.api.limiter.busy, false, "the slot is released");
      const st = (await (await fetch(`${s.base}/public/status`)).json()) as any;
      assert.equal(st.live.available, false);
    } finally {
      await s.close();
    }
  }
  const ok = await serve({ getBalanceUsd: async () => 1.0 });
  try {
    assert.equal((await post(ok.base, { site: "west-texas", mode: "live" })).status, 200, "exactly $1 is enough");
  } finally {
    await ok.close();
  }
});

test("live run: only one at a time; the other caller is told it is busy and nothing is counted for it", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const s = await serve({ liveDeps: chargingDeps(0.01, gate) });
  try {
    const first = post(s.base, { site: "west-texas", mode: "live" }, "2.2.2.2");
    while (!s.api.limiter.busy) await new Promise((r) => setTimeout(r, 5));
    const second = await post(s.base, { site: "west-texas", mode: "live" }, "3.3.3.3");
    assert.equal(second.status, 409);
    assert.match((second.body as any).message, /in progress/);
    assert.ok((second.body as any).offerDemo);
    // demo still works while a live run is in flight
    assert.equal((await post(s.base, { site: "west-texas", mode: "demo" }, "3.3.3.3")).status, 200);
    open();
    assert.equal(last((await first).events!).type, "result");
    assert.equal(s.api.limiter.busy, false);
    assert.equal(s.api.limiter.status("3.3.3.3").usedToday, 1, "only the first run counted");
  } finally {
    open();
    await s.close();
  }
});

test("live run: 3 per IP per day, 20 per day overall, both refused before any buying", async () => {
  const s = await serve();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(s.base, { site: "west-texas", mode: "live" }, "9.9.9.9")).status, 200);
    const fourth = await post(s.base, { site: "west-texas", mode: "live" }, "9.9.9.9");
    assert.equal(fourth.status, 429);
    assert.match((fourth.body as any).message, /3 live runs/);
    // other addresses carry on up to the daily total of 20 (3 already used)
    let n = 3;
    for (let i = 0; n < 20; i++, n++) assert.equal((await post(s.base, { site: "west-texas", mode: "live" }, `10.0.0.${i}`)).status, 200);
    const over = await post(s.base, { site: "west-texas", mode: "live" }, "10.0.1.1");
    assert.equal(over.status, 429);
    assert.match((over.body as any).message, /All 20 live runs/);
    const list = (await (await fetch(`${s.base}/public/runs`)).json()) as any;
    assert.equal(list.runs.length, 20, "last 20 kept");
  } finally {
    await s.close();
  }
});

test("live run: a failed run is reported, offers the demo, and the slot is freed", async () => {
  const s = await serve({ liveDeps: async () => ({ ...(await chargingDeps(0.01)()), transport: { kind: "engine", ask: async () => { throw new Error("boom"); } } as Transport }) });
  try {
    const r = await post(s.base, { site: "west-texas", mode: "live" });
    const res = last(r.events!);
    // the planner turns failed asks into HOLDs, so a result with missing checks is the honest outcome
    assert.equal(res.type, "result");
    assert.ok(res.plan.decisions.every((d: any) => d.action === "HOLD"));
    assert.ok(r.events!.some((e) => e.type === "failed"));
    assert.equal(s.api.limiter.busy, false);
  } finally {
    await s.close();
  }
  const s2 = await serve({ liveDeps: async () => { throw new Error("no credentials"); } });
  try {
    const r = await post(s2.base, { site: "west-texas", mode: "live" });
    assert.equal(r.status, 503);
    assert.ok((r.body as any).offerDemo);
    assert.equal(s2.api.limiter.status("1.1.1.1").usedToday, 0);
  } finally {
    await s2.close();
  }
});

test("live switched off: refused with a clear message, demo untouched", async () => {
  const s = await serve({ liveEnabled: false });
  try {
    const r = await post(s.base, { site: "west-texas", mode: "live" });
    assert.equal(r.status, 503);
    assert.match((r.body as any).message, /switched off/);
    const st = (await (await fetch(`${s.base}/public/status`)).json()) as any;
    assert.equal(st.live.available, false);
  } finally {
    await s.close();
  }
});

test("only preset sites are accepted: no free-form site, no path tricks", async () => {
  const s = await serve();
  try {
    for (const site of ["../package", "west-texas.json", "nope", "", { node: "HB_WEST" }]) assert.equal((await post(s.base, { site, mode: "demo" })).status, 400);
    assert.equal((await post(s.base, { site: "west-texas", mode: "paid" })).status, 400);
    assert.equal(loadSite("../package"), undefined);
    assert.deepEqual(listSites().map((x) => x.id), ["west-texas"]);
  } finally {
    await s.close();
  }
});

test("page and data routes are served; the key-protected tool routes are unchanged", async () => {
  const s = await serve({}, "secret-token");
  try {
    const page = await fetch(`${s.base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="video"/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    for (const secret of ["secret-token", "BALLAST_TOOL_TOKEN", "BALLAST_SIGNER", "ANJOMAN_API_KEY"]) {
      for (const f of ["/", "/app.js", "/app.css"]) assert.ok(!(await (await fetch(`${s.base}${f}`)).text()).includes(secret), `${f} mentions ${secret}`);
    }
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
    assert.equal((await fetch(`${s.base}/openapi.json`)).status, 200);
    assert.equal((await fetch(`${s.base}/plan_site`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${s.base}/plan_site`, { method: "POST", body: "{}", headers: { "x-api-key": "secret-token" } })).status, 200);
    const rec = (await (await fetch(`${s.base}/public/recorded`)).json()) as any;
    assert.equal(rec.planId, "708b2b3a8b");
    assert.equal(rec.summary.cost, "$0.11");
    assert.equal(rec.receipts.reduce((n: number, r: any) => n + r.cost, 0).toFixed(2), "0.11");
    assert.equal(rec.hours.length, 8);
    assert.equal((await fetch(`${s.base}/nonsense`)).status, 404);
  } finally {
    await s.close();
  }
});

test("comparison data is read from compare/results.md", () => {
  const c = loadComparison();
  const row = (n: string) => c.headline.rows.find((r) => r[0]!.startsWith(n))!;
  assert.equal(c.window.hours, 89);
  assert.deepEqual(row("Bad inputs caught").slice(3), ["0/20", "20/20"]);
  assert.equal(row("Lost to wrong decisions")[4], "$210");
  assert.equal(row("Lost to wrong decisions")[3], "$2199");
  assert.match(row("Decisions correct")[1]!, /^82\/89/);
  assert.equal(c.injectedKinds!.rows.length, 6);
});

test("ledger balance reader: the recorded node response shape, micro-USDC strings, fails closed", async () => {
  const addr = "0xF276ECa360dFF2c0119e15CCb20645071d18F18A";
  const recorded = { available: "4700000", balance: "4700000", charged: "300000", deposited: "5000000" };
  let url = "";
  const reply = (body: unknown, status = 200) => (async (u: string) => ((url = u), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
  assert.equal(await readLedgerAvailableUsd(addr, reply(recorded)), 4.7);
  assert.equal(url, `https://devnode.telegraphprotocol.com/v1/ledger/account/${addr}`);
  assert.equal(await readLedgerAvailableUsd(addr, reply({ available: "999999" })), 0.999999);
  for (const bad of [{ available: "abc" }, { available: "1.5" }, { available: "-5" }, { available: null }, {}, { balance: "4700000" }]) await assert.rejects(readLedgerAvailableUsd(addr, reply(bad)));
  await assert.rejects(readLedgerAvailableUsd(addr, reply(recorded, 500)));
  await assert.rejects(readLedgerAvailableUsd("../x", reply(recorded)));
});

test("status shows the escrow available in dollars to the cent and never an address", async () => {
  const s = await serve({ getBalanceUsd: async () => 4.7 });
  try {
    const text = await (await fetch(`${s.base}/public/status`)).text();
    assert.equal(JSON.parse(text).live.escrowAvailableUsd, 4.7);
    assert.ok(!/0x[0-9a-fA-F]{40}/.test(text));
  } finally {
    await s.close();
  }
});
