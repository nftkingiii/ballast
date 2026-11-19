import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHandler } from "../src/http.ts";
import { handleRpc } from "../src/mcp.ts";
import { createAnjomanTransport, createEngineTransport, Budget, TransportError } from "../src/telegraph.ts";
import { createTools } from "../src/tools.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const challenge = readFileSync(new URL("../fixtures/x402-challenge-pecos.b64", import.meta.url), "utf8").trim();
const request = {
  intent: "GRID_POWER_PRICE_GENERAL",
  minerId: "7310042",
  params: { node_or_zone: "HB_WEST", interval_start: "2026-11-19T20:00:00Z" },
  native: { method: "GET" as const, endpoint: "/price", payload: { node_or_zone: "HB_WEST", market: "day-ahead", interval_start: "2026-11-19T20:00:00Z" } },
  maxCostUsd: 0.01,
};

test("engine transport: reads the real 402 challenge, signs the escrow message, returns the receipt", async () => {
  const calls: { headers: Record<string, string>; body: string }[] = [];
  let signed = "";
  const http = (async (_url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ headers, body: String(init.body) });
    if (!headers["x-payment"]) return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
    const receipt = { receipt_hash: "0xabc", rail: "escrow", amount_uusdc: 10000 };
    return new Response(JSON.stringify({ result: { lmp_usd_per_mwh: 12.5 }, signal_hash: "0xdef" }), {
      status: 200,
      headers: { "x-payment-response": Buffer.from(JSON.stringify(receipt)).toString("base64") },
    });
  }) as unknown as typeof fetch;
  const signer = { address: "0xAbCdEf0000000000000000000000000000000001", personalSign: async (m: string) => ((signed = m), "0xsig") };
  const answer = await createEngineTransport(signer, http, () => 1_800_000_000_000).ask(request);

  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0]!.body), { method: "GET", endpoint: "/price", payload: request.native.payload });
  assert.match(signed, /Telegraph Escrow Payment/);
  assert.match(signed, /Wallet: 0xabcdef0000000000000000000000000000000001/);
  assert.match(signed, /Amount: 10000 uUSDC/);
  assert.match(signed, /Resource: \/v1\/ask\/7310042/);
  assert.ok(!signed.includes("{nonce}") && !signed.includes("{from}"));
  const sent = JSON.parse(Buffer.from(calls[1]!.headers["x-payment"]!, "base64").toString("utf8"));
  assert.equal(sent.scheme, "escrow");
  assert.equal(sent.network, "eip155:11155111");
  assert.equal(sent.payload.signature, "0xsig");
  assert.equal(sent.payload.authorization.value, "10000");
  assert.ok(sent.payload.authorization.validBefore - sent.payload.authorization.validAfter <= 120);
  assert.equal(answer.costUsd, 0.01);
  assert.equal(answer.receipt.receiptHash, "0xabc");
  assert.equal(answer.receipt.rail, "escrow");
});

test("engine transport: refuses a quote above the per-call limit and signs nothing", async () => {
  let signs = 0;
  const http = (async () => new Response("{}", { status: 402, headers: { "payment-required": challenge } })) as unknown as typeof fetch;
  const signer = { address: "0x1", personalSign: async () => (signs++, "0x") };
  await assert.rejects(() => createEngineTransport(signer, http).ask({ ...request, maxCostUsd: 0.005 }), /above the \$0\.005 limit/);
  assert.equal(signs, 0);
});

test("anjoman transport: parses a JSON answer, job id, cost and receipt; refuses anything it cannot parse", async () => {
  const ok = (async () =>
    new Response(JSON.stringify({ jobId: "460d3ff2", status: "complete", answer: 'Here you go: {"lmp_usd_per_mwh": 12.5, "market": "day-ahead"}', costUsd: 0.01, sources: [{ receiptHash: "0xr1", miner: { id: "7310042" } }] }), { status: 200 })) as unknown as typeof fetch;
  const answer = await createAnjomanTransport("k", ok).ask(request);
  assert.equal(answer.result.lmp_usd_per_mwh, 12.5);
  assert.equal(answer.receipt.jobId, "460d3ff2");
  assert.equal(answer.receipt.receiptHash, "0xr1");
  assert.equal(answer.costUsd, 0.01);

  const prose = (async () => new Response(JSON.stringify({ jobId: "j", status: "complete", answer: "about twelve dollars", costUsd: 0.01 }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => createAnjomanTransport("k", prose).ask(request), TransportError);
  const noCost = (async () => new Response(JSON.stringify({ jobId: "j", status: "complete", answer: '{"a":1}', costUsd: null }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => createAnjomanTransport("k", noCost).ask(request), /reported no cost/);
  const denied = (async () => new Response("{}", { status: 402 })) as unknown as typeof fetch;
  await assert.rejects(() => createAnjomanTransport("k", denied).ask(request), /402/);
});

test("anjoman transport: follows a 202 job to completion", async () => {
  let polls = 0;
  const http = (async (url: string) => {
    if (url.endsWith("/agent/chat")) return new Response(JSON.stringify({ jobId: "j1", status: "running" }), { status: 202 });
    polls++;
    return new Response(JSON.stringify({ jobId: "j1", status: "complete", answer: '{"x":1}', costUsd: 0.02 }), { status: 200 });
  }) as unknown as typeof fetch;
  const answer = await createAnjomanTransport("k", http, () => Date.now()).ask(request);
  assert.equal(polls, 1);
  assert.equal(answer.costUsd, 0.02);
});

test("budget: a refusal is permanent", () => {
  const b = new Budget(0.02);
  assert.ok(b.reserve(0.01));
  b.record(0.01);
  assert.ok(b.reserve(0.01));
  b.record(0.01);
  assert.ok(!b.reserve(0.01));
  assert.ok(!b.reserve(0));
  assert.equal(b.breached, true);
});

test("MCP: lists both tools and plans a site in demo mode", async () => {
  const tools = createTools({ paid: false, maxCapUsd: 0.5 });
  const list = (await handleRpc(tools, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map((t) => t.name), ["plan_site", "explain_decision"]);
  const call = (await handleRpc(tools, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "plan_site", arguments: {} } })) as { result: { content: { text: string }[] } };
  const text = call.result.content[0]!.text;
  assert.match(text, /^planId: [0-9a-f]{10}/);
  assert.match(text, /DEMO MODE/);
  const planId = /planId: (\w+)/.exec(text)![1]!;
  const hour = /(\d{4}-\d\d-\d\dT\d\d):00/.exec(text)?.[0] ?? "2026-11-19T18";
  const explained = (await handleRpc(tools, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "explain_decision", arguments: { planId, hour: "2026-11-19T18" } } })) as { result: { content: { text: string }[] } };
  assert.match(explained.result.content[0]!.text, /2026-11-19T18:00:00.000Z: RUN/);
  assert.ok(hour);
  const bad = (await handleRpc(tools, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "plan_site", arguments: { site: { node: "X" } } } })) as { result: { isError: boolean } };
  assert.equal(bad.result.isError, true);
});

test("HTTP tool surface: needs the api key, serves the OpenAPI document, never lets a caller turn on paid mode", async () => {
  const handler = createHandler(createTools({ paid: false, maxCapUsd: 0.5 }), "secret-token");
  const call = async (method: string, url: string, body?: unknown, key?: string) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const listeners: Record<string, (c?: Buffer) => void> = {};
    const req = { method, url, headers: { host: "t", ...(key ? { "x-api-key": key } : {}) }, on: (e: string, f: (c?: Buffer) => void) => ((listeners[e] = f), req), destroy() {} } as unknown as IncomingMessage;
    let status = 0;
    let out = "";
    const res = { writeHead: (s: number) => (status = s), end: (t: string) => (out = t) } as unknown as ServerResponse;
    const done = handler(req, res);
    chunks.forEach((c) => listeners.data?.(c));
    listeners.end?.();
    await done;
    return { status, body: JSON.parse(out) as Record<string, any> };
  };
  assert.equal((await call("GET", "/health")).status, 200);
  assert.equal((await call("GET", "/openapi.json")).body.paths["/plan_site"].post.operationId, "plan_site");
  assert.equal((await call("POST", "/plan_site", {})).status, 401);
  const ok = await call("POST", "/plan_site", { paid: true }, "secret-token");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.plan.mode, "demo");
});
