// Tool surface for monitor mode (HTTP and MCP): monitor_site and whats_changed. Sessions live in memory on the server.
// Paid mode is a server setting: there, each monitor_site call runs ONE live cycle (the caller schedules the cadence),
// and the session's spend cap is enforced across calls and clamped to the server ceiling.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSite } from "./config.ts";
import { DEFAULT_MONITOR_CAP_USD, DemoMonitor, timelineByName } from "./monitor-demo.ts";
import { renderChanges, renderHeader, renderSummary, renderTick } from "./monitor-render.ts";
import { MonitorSession, type TickResult } from "./monitor.ts";
import type { PlanDeps } from "./plan.ts";
import { paidDeps } from "./runtime.ts";
import type { ToolOptions } from "./tools.ts";

const DEFAULT_SITE = new URL("../sites/west-texas.json", import.meta.url);

interface Entry {
  session: MonitorSession;
  demo?: DemoMonitor;
  live?: PlanDeps;
}

export interface MonitorOutput {
  monitorId: string;
  text: string;
  /** Latest tick. */
  tick: TickResult | undefined;
  done: boolean;
  spentUsd: number;
  capUsd: number;
}

export function createMonitorTools(options: ToolOptions) {
  const sessions = new Map<string, Entry>();
  let counter = 0;

  const view = (id: string, e: Entry, text: string): MonitorOutput => ({
    monitorId: id,
    text,
    tick: e.session.history.at(-1),
    done: e.demo ? e.demo.done : e.session.capReached,
    spentUsd: e.session.spentUsd,
    capUsd: e.session.sessionCapUsd,
  });

  return {
    /**
     * Start a monitor session, or advance one with `monitorId`. Demo mode replays a recorded/SYNTHETIC timeline (all of it
     * by default, or `ticks` of it). Paid mode runs one live cycle per call.
     */
    async monitor_site(input: { site?: unknown; timeline?: string; ticks?: number; monitorId?: string; capUsd?: number }): Promise<MonitorOutput> {
      let id = input.monitorId;
      let entry = id ? sessions.get(id) : undefined;
      if (id && !entry) throw new Error(`Unknown monitorId ${id}. Call monitor_site without a monitorId to start one; sessions are kept in memory only.`);
      const fresh = !entry;
      if (!entry) {
        const site = parseSite((input.site ?? options.defaultSite ?? JSON.parse(readFileSync(DEFAULT_SITE, "utf8"))) as Record<string, any>);
        const asked = Number(input.capUsd);
        if (options.paid) {
          const cap = Math.min(Number.isFinite(asked) && asked > 0 ? asked : options.maxCapUsd, options.maxCapUsd);
          const paidSite = { ...site, intelligence: { ...site.intelligence, spendCapUsd: cap } };
          const deps = await paidDeps(paidSite, options.env);
          entry = { session: new MonitorSession(paidSite, cap, deps.label, deps), live: deps };
        } else {
          const timeline = timelineByName(input.timeline ?? "demo");
          const cap = Math.min(Number.isFinite(asked) && asked >= 0 ? asked : (timeline.sessionCapUsd ?? DEFAULT_MONITOR_CAP_USD), options.maxCapUsd);
          const demo = new DemoMonitor(site, timeline, options.fixture, cap);
          entry = { session: demo.session, demo };
        }
        counter += 1;
        id = `m${counter.toString(36)}${createHash("sha256").update(`${Date.now()}${counter}`).digest("hex").slice(0, 6)}`;
        sessions.set(id, entry);
        if (sessions.size > 20) sessions.delete(sessions.keys().next().value as string);
      }
      const e = entry;
      const lines: string[] = [];
      if (fresh) lines.push(renderHeader(e.session));
      if (e.demo) {
        const want = input.ticks === undefined ? (fresh ? e.demo.total : 1) : Math.max(1, Math.min(Math.floor(Number(input.ticks)) || 1, e.demo.total));
        for (let n = 0; n < want && !e.demo.done; n++) lines.push(renderTick((await e.demo.next())!, e.demo.total), "");
        if (e.demo.done) lines.push(renderSummary(e.session));
      } else if (e.live) {
        const r = await e.session.step({ now: new Date(), transport: e.live.transport, pub: e.live.pub });
        lines.push(renderTick(r), "", `Call monitor_site again with monitorId ${id} at the next cadence step (15 minutes).`);
      }
      return view(id!, e, lines.join("\n"));
    },

    /** What changed on a tick of a monitor session (default: the latest), with what is held, anticipated and spent. Buys nothing. */
    async whats_changed(input: { monitorId: string; tick?: number }): Promise<{ text: string }> {
      const e = sessions.get(input.monitorId);
      if (!e) return { text: `Unknown monitorId ${input.monitorId}. Call monitor_site first; sessions are kept in memory only.` };
      const history = e.session.history;
      if (history.length === 0) return { text: "The monitor has not run a tick yet." };
      const index = input.tick === undefined ? history.length - 1 : Math.floor(Number(input.tick)) - 1;
      const r = history[index];
      if (!r) return { text: `No tick ${input.tick}. This session has ${history.length} tick${history.length === 1 ? "" : "s"} (numbered from 1).` };
      return {
        text: `${e.session.label}\nTick ${r.tick + 1} of ${history.length} at ${r.at.slice(0, 16)}Z${r.note ? ` (${r.note})` : ""}\n${renderChanges(r)}\nSPEND: session $${r.spend.sessionUsd.toFixed(2)} of $${r.spend.capUsd.toFixed(2)} cap${r.spend.capReached ? "; CAP REACHED" : ""}`,
      };
    },
  };
}

export const MONITOR_TOOL_SCHEMAS = {
  monitor_site: {
    description:
      "Monitor a Bitcoin mining site in ERCOT over time. Re-checks the plan every cadence step (ERCOT real-time is 15 minutes), keeps a decision history, " +
      "and reports per hour what changed since the last check and why (with evidence ids and receipts), which upcoming hours may flip (labelled FORECAST), " +
      "and NO RECOMMENDATION states when inputs conflict, are stale or missing, or the session spend cap is reached, with what is needed to decide. " +
      "Demo mode (default) replays a recorded/SYNTHETIC timeline quickly without waiting; paid mode (a server setting) runs one live check per call. " +
      "Pass monitorId to advance an existing session.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "object", description: "Site config, as for plan_site. Omit to use the bundled West Texas example." },
        timeline: { type: "string", description: "Demo mode only: demo, disagreement, stale, missing-hashprice, spend-cap or negative-price." },
        ticks: { type: "number", description: "How many ticks to run (demo: default all for a new session, 1 when advancing)." },
        monitorId: { type: "string", description: "A monitorId returned earlier, to advance that session." },
        capUsd: { type: "number", description: "Whole-session spend cap in USD, clamped to the server ceiling." },
      },
    },
  },
  whats_changed: {
    description: "What changed on a tick of a monitor session and why, what is held with NO RECOMMENDATION and what it needs, which hours may flip, and spend so far. Buys nothing.",
    inputSchema: {
      type: "object",
      properties: {
        monitorId: { type: "string", description: "The monitorId returned by monitor_site." },
        tick: { type: "number", description: "Tick number, starting at 1. Default: the latest." },
      },
      required: ["monitorId"],
    },
  },
} as const;
