// HTTP tool surface for Minds (and anything else that can call a REST API).
//   GET  /health            liveness
//   GET  /openapi.json      tool definitions to paste into a Minds App manifest
//   POST /plan_site         { site? }                -> { planId, text, plan }
//   POST /explain_decision  { planId, hour }         -> { text }
// Set BALLAST_TOOL_TOKEN to require it as the x-api-key header. Paid mode is BALLAST_PAID=1 on the server only.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createTools, TOOL_SCHEMAS, type Tools } from "./tools.ts";

const MAX_BODY = 64 * 1024;

export function openApi(baseUrl: string) {
  const op = (name: keyof typeof TOOL_SCHEMAS) => ({
    post: {
      operationId: name,
      description: TOOL_SCHEMAS[name].description,
      requestBody: { required: name === "explain_decision", content: { "application/json": { schema: TOOL_SCHEMAS[name].inputSchema } } },
      responses: { "200": { description: "Result", content: { "application/json": { schema: { type: "object" } } } } },
    },
  });
  return {
    openapi: "3.0.3",
    info: { title: "Ballast", version: "0.1.0", description: "Hourly hash-or-curtail decisions for a Bitcoin mining site, with every input's provider, time and receipt." },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "x-api-key" } } },
    security: [{ key: [] }],
    paths: { "/plan_site": op("plan_site"), "/explain_decision": op("explain_decision") },
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("body is not JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createHandler(tools: Tools, token = process.env.BALLAST_TOOL_TOKEN) {
  let windowStart = Date.now();
  let count = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/openapi.json") return send(200, openApi(process.env.BALLAST_PUBLIC_URL ?? `http://${req.headers.host ?? "localhost"}`));
    if (req.method !== "POST") return send(404, { error: "not_found" });

    if (token && !safeEqual(String(req.headers["x-api-key"] ?? ""), token)) return send(401, { error: "bad_api_key" });
    if (Date.now() - windowStart > 60_000) [windowStart, count] = [Date.now(), 0];
    if (++count > 30) return send(429, { error: "rate_limited" });

    try {
      const body = (await readBody(req)) as Record<string, unknown>;
      if (url.pathname === "/plan_site") return send(200, await tools.plan_site({ site: body.site }));
      if (url.pathname === "/explain_decision") return send(200, await tools.explain_decision({ planId: String(body.planId ?? ""), hour: String(body.hour ?? "") }));
      return send(404, { error: "not_found" });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      return send(status, { error: (error as Error).message });
    }
  };
}

if (process.argv[1]?.endsWith("http.ts")) {
  const paid = process.env.BALLAST_PAID === "1";
  const tools = createTools({ paid, maxCapUsd: Number(process.env.BALLAST_MAX_CAP_USD ?? "0.5") });
  const port = Number(process.env.PORT ?? 8787);
  createServer(createHandler(tools)).listen(port, () => {
    console.log(`ballast listening on :${port} in ${paid ? "PAID" : "DEMO"} mode${process.env.BALLAST_TOOL_TOKEN ? ", api key required" : ", NO api key set"}`);
  });
}
