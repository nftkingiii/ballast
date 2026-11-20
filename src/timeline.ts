// Timelines for monitor demo mode: a recorded day plus a list of dated events that change what the providers answer.
// Everything a timeline adds on top of fixtures/recorded.json is SYNTHETIC and says so. No real waiting, no network.
import { readFileSync } from "node:fs";
import { createFixturePublicSources, createFixtureTransport, type Fixture, type PublicSources } from "./sources.ts";
import { TransportError, type Answer, type AskRequest, type Transport } from "./telegraph.ts";
import type { SiteConfig } from "./types.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const QUARTER = 900_000;
const POWER_MINER = "7310042";

export type TimelineEvent =
  | { type: "realTime"; lmp?: number; public?: number | null; available?: boolean; staleMin?: number }
  | { type: "dayAhead"; hour: string; lmp?: number; public?: number | null; available?: boolean; substituted?: boolean; restore?: boolean }
  | { type: "hashprice"; usd?: number; public?: number; available?: boolean }
  | { type: "weather"; available: boolean }
  | { type: "heat"; deltaC: number };

export interface Timeline {
  label: string;
  /** True when anything beyond tick 0 is invented. Always printed. */
  synthetic: boolean;
  /** Which real numbers, if any, the first tick is anchored to. */
  anchor?: string;
  startAt: string;
  cadenceMin: number;
  sessionCapUsd?: number;
  /** Merged over the site config (for example a shorter planning window). */
  siteOverrides?: Record<string, unknown>;
  policy?: { dayAheadEveryMin?: number; hashpriceEveryMin?: number; weatherEveryMin?: number; stressUsdPerMwh?: number };
  ticks: { at?: string; note?: string; events?: TimelineEvent[] }[];
}

export function loadTimeline(path: URL | string): Timeline {
  const tl = JSON.parse(readFileSync(path, "utf8")) as Timeline;
  const problems: string[] = [];
  if (!tl.label || typeof tl.label !== "string") problems.push("label is required");
  if (!Number.isFinite(Date.parse(tl.startAt))) problems.push("startAt must be an ISO timestamp");
  if (!(tl.cadenceMin > 0)) problems.push("cadenceMin must be above zero");
  if (!Array.isArray(tl.ticks) || tl.ticks.length === 0) problems.push("ticks must be a non-empty list");
  if (problems.length) throw new Error(`invalid timeline: ${problems.join("; ")}`);
  return tl;
}

export function tickTime(tl: Timeline, index: number): Date {
  const t = tl.ticks[index]?.at;
  return new Date(t ? Date.parse(t) : Date.parse(tl.startAt) + index * tl.cadenceMin * MIN);
}

export function applySiteOverrides(site: SiteConfig, tl: Timeline): SiteConfig {
  const merge = (a: any, b: any): any => {
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const out = { ...(a ?? {}) };
      for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
      return out;
    }
    return b;
  };
  return tl.siteOverrides ? (merge(site, tl.siteOverrides) as SiteConfig) : site;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const iso = (ms: number) => new Date(ms).toISOString();

interface DaOverride {
  lmp?: number;
  public?: number | null;
  mode: "ok" | "substituted" | "missing";
}

/**
 * Mutable world state. Events are cumulative: a price set at tick 3 stays until another event changes it.
 * `at(now)` renders the state into a Fixture for that instant and wraps it as a transport and public sources.
 */
export class World {
  private rt = { lmp: undefined as number | undefined, public: undefined as number | null | undefined, available: true, staleMin: 0 };
  private da = new Map<string, DaOverride>();
  private hp = { usd: undefined as number | undefined, public: undefined as number | undefined, available: true };
  private wxAvailable = true;
  private heatDelta = 0;

  constructor(
    private readonly base: Fixture,
    private readonly site: SiteConfig,
  ) {
    const lastRt = base.shaped.power.filter((p) => p.market === "real-time").at(-1);
    this.rt.lmp = lastRt ? Number(lastRt.result.lmp_usd_per_mwh) : undefined;
  }

  /** Describes the event for the tick log. */
  apply(events: TimelineEvent[], startAt: string): string[] {
    const notes: string[] = [];
    for (const e of events) {
      if (e.type === "realTime") {
        if (e.lmp !== undefined) this.rt.lmp = e.lmp;
        if (e.public !== undefined) this.rt.public = e.public;
        else if (e.lmp !== undefined) this.rt.public = undefined;
        if (e.available !== undefined) this.rt.available = e.available;
        this.rt.staleMin = e.staleMin ?? 0;
        notes.push(`real-time: ${e.available === false ? "provider unavailable" : e.staleMin ? `answers are ${e.staleMin} min old` : `provider $${this.rt.lmp}${e.public !== undefined ? `, public archive ${e.public === null ? "unavailable" : `$${e.public}`}` : ""}`}`);
      } else if (e.type === "dayAhead") {
        const hour = this.resolveHour(e.hour, startAt);
        if (e.restore) this.da.delete(hour);
        else this.da.set(hour, { lmp: e.lmp, public: e.public, mode: e.available === false ? "missing" : e.substituted ? "substituted" : "ok" });
        notes.push(`day-ahead ${hour.slice(11, 16)}: ${e.restore ? "back to recorded" : e.available === false ? "provider unavailable" : e.substituted ? "provider answers for the wrong hour" : `$${e.lmp}`}`);
      } else if (e.type === "hashprice") {
        if (e.usd !== undefined) this.hp.usd = e.usd;
        this.hp.public = e.public;
        if (e.available !== undefined) this.hp.available = e.available;
        notes.push(`hashprice: ${e.available === false ? "provider unavailable" : `provider $${this.hp.usd ?? "recorded"}${e.public !== undefined ? `, public reference $${e.public}` : ""}`}`);
      } else if (e.type === "weather") {
        this.wxAvailable = e.available;
        notes.push(`weather verification: ${e.available ? "available" : "provider unavailable"}`);
      } else if (e.type === "heat") {
        this.heatDelta = e.deltaC;
        notes.push(`forecast temperature ${e.deltaC >= 0 ? "+" : ""}${e.deltaC}C`);
      }
    }
    return notes;
  }

  private resolveHour(h: string, startAt: string): string {
    if (/^\d\d:\d\d$/.test(h)) {
      const s = new Date(startAt);
      const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), Number(h.slice(0, 2)), Number(h.slice(3, 5))));
      if (d.getTime() < Math.floor(s.getTime() / HOUR) * HOUR) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    }
    return new Date(h).toISOString();
  }

  /** Renders the world at `now`. Hours missing from the recorded day are filled in (SYNTHETIC) so a long timeline never runs off the data. */
  at(now: Date): { fixture: Fixture; transport: Transport; pub: PublicSources; synthetic: string[] } {
    const fx = copy(this.base);
    const synthetic: string[] = [];
    const node = this.site.node;
    const t = now.getTime();
    const horizonHours = Math.max(this.site.planning.hours, 1) * 2 + 2;
    const first = Math.floor(t / HOUR) * HOUR;

    // Day-ahead: extend past the recorded day with the last recorded price repeated, then apply overrides.
    const lastDa = [...fx.shaped.power.filter((p) => p.market === "day-ahead")].sort((a, b) => a.intervalStart.localeCompare(b.intervalStart)).at(-1);
    for (let k = 0; k < horizonHours; k++) {
      const hour = iso(first + k * HOUR);
      if (!fx.shaped.power.some((p) => p.market === "day-ahead" && p.intervalStart === hour) && lastDa && Date.parse(hour) > Date.parse(lastDa.intervalStart)) {
        const lmp = Number(lastDa.result.lmp_usd_per_mwh);
        fx.shaped.power.push({ ...lastDa, intervalStart: hour, result: { ...lastDa.result, interval_start: hour, lmp_usd_per_mwh: lmp } });
        fx.public.ercot.push({ market: "day-ahead", node, intervalStart: hour, lmp, source: "synthetic extension" });
        synthetic.push(`day-ahead ${hour.slice(5, 16)}Z repeats the last recorded hour ($${lmp})`);
      }
    }
    for (const [hour, o] of this.da) {
      const idx = fx.shaped.power.findIndex((p) => p.market === "day-ahead" && p.intervalStart === hour);
      if (o.mode === "missing") {
        if (idx >= 0) fx.shaped.power.splice(idx, 1);
        continue;
      }
      if (idx < 0) continue;
      const row = fx.shaped.power[idx]!;
      const lmp = o.lmp ?? Number(row.result.lmp_usd_per_mwh);
      row.result = { ...row.result, lmp_usd_per_mwh: lmp, interval_start: o.mode === "substituted" ? iso(Date.parse(hour) - HOUR) : hour };
      const pub = fx.public.ercot.find((r) => r.market === "day-ahead" && r.intervalStart === hour && r.node === node);
      if (o.public === null) fx.public.ercot = fx.public.ercot.filter((r) => r !== pub);
      else if (pub) pub.lmp = o.public ?? lmp;
    }

    // Real-time: one answer for the latest complete 15-minute interval, as the planner asks for it.
    fx.shaped.power = fx.shaped.power.filter((p) => p.market !== "real-time");
    fx.public.ercot = fx.public.ercot.filter((r) => r.market !== "real-time");
    const interval = iso(Math.floor(t / QUARTER) * QUARTER - QUARTER);
    if (this.rt.available && this.rt.lmp !== undefined) {
      fx.shaped.power.push({
        market: "real-time", minerId: POWER_MINER, intervalStart: interval, answeredAt: iso(t - 5000 - this.rt.staleMin * MIN),
        result: { lmp_usd_per_mwh: this.rt.lmp, node_or_zone: node, market: "real-time", interval_start: interval, currency: "USD", iso: "ERCOT" },
        recordedFrom: "synthetic timeline",
      });
    }
    if (this.rt.public !== null && this.rt.lmp !== undefined) {
      fx.public.ercot.push({ market: "real-time", node, intervalStart: interval, lmp: this.rt.public ?? this.rt.lmp, source: "synthetic timeline" });
    }

    // Hashprice and chain tip.
    const elapsedBlocks = Math.floor((t - Date.parse(this.base.recordedAt)) / (10 * MIN));
    fx.public.tipHeight = this.base.public.tipHeight + Math.max(0, elapsedBlocks);
    const btcUsd = fx.public.hashprice.btcUsd;
    if (this.hp.usd !== undefined || this.hp.public !== undefined) {
      const usd = this.hp.usd ?? fx.public.hashprice.usdPerPhDay;
      fx.public.hashprice = { ...fx.public.hashprice, usdPerPhDay: this.hp.public ?? usd };
      fx.shaped.hashprice = fx.shaped.hashprice.map((h) => ({ ...h, result: { ...h.result, hashprice_sats_per_ph_day: (usd / btcUsd) * 1e8, hashprice_usd_per_ph_day: null } }));
    }
    fx.shaped.hashprice = this.hp.available
      ? fx.shaped.hashprice.map((h) => ({ ...h, answeredAt: iso(t - 5000), result: { ...h.result, block_height: fx.public.tipHeight } }))
      : [];

    // Weather: extend the recorded forecast with its last value (SYNTHETIC) and apply any heat shift.
    const temps = fx.public.forecast.hourlyC;
    const known = Object.keys(temps).sort();
    const lastT = known.length ? temps[known.at(-1)!]! : 15;
    for (let k = 0; k < horizonHours; k++) {
      const hour = iso(first + k * HOUR);
      if (temps[hour] === undefined) {
        temps[hour] = lastT;
        synthetic.push(`forecast ${hour.slice(5, 16)}Z repeats the last recorded value (${lastT}C)`);
      }
    }
    for (const k of Object.keys(temps)) temps[k] = Math.round((temps[k]! + this.heatDelta) * 10) / 10;
    if (!this.wxAvailable) fx.shaped.weather = [];

    const inner = createFixtureTransport(fx);
    const transport: Transport = {
      kind: "fixture",
      async ask(request: AskRequest): Promise<Answer> {
        try {
          return await inner.ask(request);
        } catch (error) {
          if (error instanceof TransportError) throw new TransportError(`provider unavailable (SYNTHETIC outage): ${error.message}`);
          throw error;
        }
      },
    };
    return { fixture: fx, transport, pub: createFixturePublicSources(fx), synthetic };
  }
}
