// Minimal MCP server over stdio (newline-delimited JSON-RPC). No dependencies.
import { createInterface } from "node:readline";
import { createTools, TOOL_SCHEMAS, type Tools } from "./tools.ts";

export interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, any>;
}

export async function handleRpc(tools: Tools, message: Rpc): Promise<object | null> {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: message.id ?? null, result });
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id ?? null, error: { code, message: text } });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ballast", version: "0.1.0" },
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: Object.entries(TOOL_SCHEMAS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = String(message.params?.name);
      const args = (message.params?.arguments ?? {}) as Record<string, any>;
      try {
        if (name === "plan_site") {
          const out = await tools.plan_site({ site: args.site });
          return reply({ content: [{ type: "text", text: `planId: ${out.planId}\n\n${out.text}` }], structuredContent: out.plan });
        }
        if (name === "explain_decision") {
          const out = await tools.explain_decision({ planId: String(args.planId), hour: String(args.hour) });
          return reply({ content: [{ type: "text", text: out.text }] });
        }
        return fail(-32602, `unknown tool ${name}`);
      } catch (error) {
        return reply({ isError: true, content: [{ type: "text", text: `Ballast refused: ${(error as Error).message}` }] });
      }
    }
    default:
      return message.id === undefined ? null : fail(-32601, `method not found: ${message.method}`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("mcp.ts")) {
  const tools = createTools({ paid: process.env.BALLAST_PAID === "1", maxCapUsd: Number(process.env.BALLAST_MAX_CAP_USD ?? "0.5") });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let message: Rpc;
    try {
      message = JSON.parse(line) as Rpc;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    const out = await handleRpc(tools, message);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
