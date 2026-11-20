import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSite } from "./config.ts";
import { memoryAfter } from "./memory.ts";
import type { Memory } from "./reuse.ts";
import { createMonitorTools, MONITOR_TOOL_SCHEMAS } from "./monitor-tools.ts";
import { planSite } from "./plan.ts";
import { explainDecision, renderPlan } from "./render.ts";
import { demoDeps, paidDeps, type RuntimeError } from "./runtime.ts";
import type { Fixture } from "./sources.ts";
import type { Plan } from "./types.ts";

export interface ToolOptions {
  /** Paid mode is a property of the server, never of a request: a caller cannot switch it on. */
  paid: boolean;
  /** Hard ceiling on spend per plan in paid mode, whatever the request asks for. */
  maxCapUsd: number;
  env?: NodeJS.ProcessEnv;
  fixture?: Fixture;
  defaultSite?: unknown;
}

const DEFAULT_SITE = new URL("../sites/west-texas.json", import.meta.url);

export function createTools(options: ToolOptions) {
  const plans = new Map<string, Plan>();
  /** The last accepted hashprice per site and mode, kept in this process only, so a repeat plan_site can reuse it inside the site's window. */
  const memories = new Map<string, Memory>();
  const remember = (plan: Plan): string => {
    const id = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 10);
    plans.set(id, plan);
    if (plans.size > 50) plans.delete(plans.keys().next().value as string);
    return id;
  };

  return {
    ...createMonitorTools(options),
    /** Plan the next hours for a site: RUN, THROTTLE, CURTAIL or HOLD per hour, with the evidence behind each. */
    async plan_site(input: { site?: unknown }): Promise<{ planId: string; text: string; plan: Plan }> {
      const raw = (input.site ?? options.defaultSite ?? JSON.parse(readFileSync(DEFAULT_SITE, "utf8"))) as Record<string, any>;
      if (options.paid) {
        const asked = Number(raw.intelligence?.spendCapUsd);
        raw.intelligence = { ...raw.intelligence, spendCapUsd: Math.min(Number.isFinite(asked) ? asked : options.maxCapUsd, options.maxCapUsd) };
      }
      const site = parseSite(raw);
      const deps = options.paid ? await paidDeps(site, options.env) : demoDeps(options.fixture);
      const key = `${deps.mode}|${site.name}|${site.node}`;
      const plan = await planSite(site, { ...deps, memory: memories.get(key) });
      if (plan.hashpriceMemory) memories.set(key, memoryAfter(plan));
      return { planId: remember(plan), text: renderPlan(plan), plan };
    },

    /** Explain one hour of a plan: the margin arithmetic, the reasons, and each input's provider, time and receipt. */
    async explain_decision(input: { planId: string; hour: string }): Promise<{ text: string }> {
      const plan = plans.get(input.planId);
      if (!plan) return { text: `Unknown planId ${input.planId}. Call plan_site first; plans are kept in memory only.` };
      return { text: explainDecision(plan, input.hour) };
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
export type { RuntimeError };

export const TOOL_SCHEMAS = {
  plan_site: {
    description:
      "Plan the next hours for a Bitcoin mining site in ERCOT. Returns, per hour, RUN, THROTTLE, CURTAIL or HOLD with the margin per MWh, " +
      "and a table of every input with its provider, time and receipt, the total intelligence cost and the checks that are missing. " +
      "Runs in DEMO mode on recorded data unless the server was started in paid mode. Omit `site` to use the bundled West Texas example.",
    inputSchema: {
      type: "object",
      properties: {
        site: {
          type: "object",
          description:
            "Site config: node (ERCOT hub or load zone), location {name,lat,lon}, fleet {hashrateTh,efficiencyJPerTh}, power {mode,adderUsdPerMwh,...}, " +
            "operating, optional heat, planning {hours}, intelligence {spendCapUsd, providers}. See sites/west-texas.json.",
        },
      },
    },
  },
  explain_decision: {
    description: "Explain one hour of a plan returned by plan_site: arithmetic, reasons, and the evidence (provider, time, receipt) behind it.",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "The planId returned by plan_site." },
        hour: { type: "string", description: "The hour as an ISO timestamp, e.g. 2026-11-19T19:00:00.000Z (a prefix such as 2026-11-19T19 works)." },
      },
      required: ["planId", "hour"],
    },
  },
  ...MONITOR_TOOL_SCHEMAS,
} as const;
