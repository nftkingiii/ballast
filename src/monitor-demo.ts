// Demo monitor: replays a timeline (fixtures/monitor-*.json) against the recorded day, one tick per cadence step, with no
// real waiting, no network and no payment. Anything the timeline adds is SYNTHETIC and printed as such.
import { readdirSync } from "node:fs";
import { MonitorSession, type TickResult } from "./monitor.ts";
import { loadFixture } from "./runtime.ts";
import type { Fixture } from "./sources.ts";
import { applySiteOverrides, loadTimeline, tickTime, World, type Timeline } from "./timeline.ts";
import type { SiteConfig } from "./types.ts";

export const DEFAULT_TIMELINE = new URL("../fixtures/monitor-demo.json", import.meta.url);
export const DEFAULT_MONITOR_CAP_USD = 0.5;

/** Timelines are looked up by bare name (monitor-<name>.json in fixtures/) so a tool caller cannot read arbitrary files. */
export function timelineByName(name: string): Timeline {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`unknown timeline "${name}"`);
  try {
    return loadTimeline(new URL(`../fixtures/monitor-${name}.json`, import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown timeline "${name}"`);
    throw error;
  }
}

export function demoTimelineNames(): string[] {
  const dir = new URL("../fixtures/", import.meta.url);
  const names: string[] = [];
  for (const f of readdirSyncSafe(dir)) {
    const m = /^monitor-([a-z0-9-]+)\.json$/.exec(f);
    if (m) names.push(m[1]!);
  }
  return names.sort();
}

function readdirSyncSafe(dir: URL): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export class DemoMonitor {
  readonly session: MonitorSession;
  readonly world: World;
  readonly timeline: Timeline;
  readonly site: SiteConfig;
  private index = 0;

  constructor(site: SiteConfig, timeline: Timeline, fixture: Fixture = loadFixture(), capUsd?: number) {
    this.timeline = timeline;
    this.site = applySiteOverrides(site, timeline);
    this.world = new World(fixture, this.site);
    const first = this.world.at(tickTime(timeline, 0));
    const cap = capUsd ?? timeline.sessionCapUsd ?? DEFAULT_MONITOR_CAP_USD;
    const label =
      `MONITOR DEMO - replay of a timeline, no real waiting, no Telegraph calls, nothing paid; receipts start with "fixture:". ` +
      `${timeline.synthetic ? "SYNTHETIC: " : ""}${timeline.label}${timeline.anchor ? ` Anchor: ${timeline.anchor}` : ""}`;
    this.session = new MonitorSession(this.site, cap, label, { transport: first.transport, pub: first.pub, now: tickTime(timeline, 0) }, timeline.policy);
  }

  get total(): number {
    return this.timeline.ticks.length;
  }

  get done(): boolean {
    return this.index >= this.timeline.ticks.length;
  }

  async next(): Promise<TickResult | undefined> {
    if (this.done) return undefined;
    const i = this.index++;
    const tick = this.timeline.ticks[i]!;
    const at = tickTime(this.timeline, i);
    const events = this.world.apply(tick.events ?? [], this.timeline.startAt);
    const env = this.world.at(at);
    const note = [tick.note, events.length ? `[${events.join("; ")}]` : ""].filter(Boolean).join(" ");
    return this.session.step({ now: at, transport: env.transport, pub: env.pub, note });
  }

  async runAll(onTick?: (r: TickResult) => void): Promise<MonitorSession> {
    for (let r = await this.next(); r; r = await this.next()) onTick?.(r);
    return this.session;
  }
}


