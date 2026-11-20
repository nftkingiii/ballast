// Monitor mode: Ballast re-checks a site on a cadence, revisits earlier decisions when new evidence arrives, says what
// changed and why, flags hours that may flip, and abstains (NO RECOMMENDATION) when it should not decide.
//
// One session keeps one evidence ledger and one spend budget across every tick, so the cap is per session, not per run.
// A tick buys only what is due: real-time for the current hour every tick, hashprice and day-ahead on a schedule, and
// anything that is missing is retried. Slow inputs are reused while they are inside their configured freshness window.
import { writeFileSync } from "node:fs";
import { anticipate, type Anticipation } from "./anticipate.ts";
import { decideHour } from "./decide.ts";
import { diffHour, shortReceipt, usd, type AbstainKind, type Abstention, type Change, type HourState, type MonitorAction, type Need, type Snapshot } from "./diff.ts";
import { gatherHashprice, gatherPower, gatherWeather, type Ctx, type HashpriceInput, type PowerInput, type WeatherInput } from "./evidence.ts";
import { receiptOf } from "./render.ts";
import { paidDeps, RuntimeError } from "./runtime.ts";
import type { PublicSources } from "./sources.ts";
import { Budget, ENGINE_ASK_USD, type Transport } from "./telegraph.ts";
import type { Evidence, Gap, HourDecision, SiteConfig } from "./types.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const QUARTER = 900_000;

export interface MonitorPolicy {
  /** Re-buy day-ahead for upcoming hours this often (it is published once a day, so this is slow by default). */
  dayAheadEveryMin: number;
  hashpriceEveryMin: number;
  weatherEveryMin: number;
  /** How far above day-ahead real-time is assumed able to land when flagging hours at risk. An assumption, not a measurement. */
  stressUsdPerMwh: number;
}

export const DEFAULT_POLICY: MonitorPolicy = { dayAheadEveryMin: 360, hashpriceEveryMin: 60, weatherEveryMin: 360, stressUsdPerMwh: 20 };

export interface TickEnv {
  now: Date;
  transport: Transport;
  pub: PublicSources;
  note?: string;
}

export interface Bought {
  id: string;
  check: string;
  subject: string;
  provider: string;
  costUsd: number;
  receipt: string;
  accepted: boolean;
  reason?: string;
}

export interface TickResult {
  tick: number;
  at: string;
  note?: string;
  hours: HourState[];
  changes: Change[];
  /** Hours that left the planning window since the last tick, with the state they ended on. */
  elapsed: HourState[];
  forecast: Anticipation[];
  /** What this tick refreshed, kept, or could not refresh. */
  actions: string[];
  bought: Bought[];
  spend: { tickUsd: number; sessionUsd: number; capUsd: number; remainingUsd: number; capReached: boolean };
  hashpriceUsdPerPhDay: number | null;
}

interface Cached<T> {
  input: T;
  at: number;
}

type PowerCache = Cached<PowerInput> & { interval?: string };

/** Which kind of problem a gap is. Precedence when several apply: budget, conflict, stale, missing. */
export function classifyGap(g: Gap): AbstainKind {
  if (g.check === "budget" || /spend cap/i.test(g.reason)) return "budget";
  if (/disagree/i.test(g.reason)) return "conflict";
  if (/stale|substituted|older than|answered at/i.test(g.reason)) return "stale";
  return "missing";
}
const PRECEDENCE: AbstainKind[] = ["budget", "conflict", "stale", "missing"];

export function needFor(site: SiteConfig, g: Gap, kind: AbstainKind): Need {
  const p = site.intelligence.providers;
  const t = site.intelligence.tolerances;
  const how = kind === "conflict" ? "the two sources must agree again" : kind === "stale" ? "a fresh answer for the right interval" : kind === "budget" ? "budget to buy it" : "an answer from the provider";
  switch (g.check) {
    case "power-real-time":
      return { check: "power-real-time", provider: `Pecos ${p.power} plus the public ERCOT archive`, detail: `${how}: latest complete 15-minute interval for ${site.node}, within max($${t.priceUsd}, ${t.pricePct}%) of the archive` };
    case "power-day-ahead":
      return { check: "power-day-ahead", provider: `Pecos ${p.power} plus the public ERCOT archive`, detail: `${how}: day-ahead price for ${g.subject.split(" ").at(-1)?.slice(0, 16) ?? "the hour"}, within max($${t.priceUsd}, ${t.pricePct}%) of the archive` };
    case "hashprice":
      return { check: "hashprice", provider: `Gauge ${p.hashprice.join(", ")} plus mempool.space`, detail: `${how}: hashprice within ${t.hashpricePct}% of the public reference, no more than ${site.intelligence.maxBlocksBehind} blocks behind the tip` };
    case "weather-verify":
      return { check: "weather-verify", provider: `weather miner ${p.weather.join(", ")} plus the Open-Meteo archive`, detail: `${how}: yesterday's high within ${t.weatherC}C of the observation` };
    case "weather-forecast":
      return { check: "weather-forecast", provider: "Open-Meteo hourly forecast (public)", detail: `${how}: a temperature for every planned hour` };
    default:
      return { check: "budget", provider: "the session owner", detail: `raise the session spend cap or stop; each needed answer costs about $${ENGINE_ASK_USD.toFixed(2)}` };
  }
}

export function abstentionFrom(site: SiteConfig, gaps: Gap[], lastDecided: Abstention["lastDecided"]): Abstention {
  const tagged = gaps.map((g) => ({ g, kind: classifyGap(g) }));
  const kind = PRECEDENCE.find((k) => tagged.some((t) => t.kind === k)) ?? "missing";
  // "not bought: no hashprice" is a consequence of the missing hashprice, not a separate missing input.
  const hasHashpriceGap = gaps.some((g) => g.check === "hashprice");
  const real = tagged.filter((t) => !(hasHashpriceGap && /^not bought/.test(t.g.reason)));
  const reasons = [...new Set(real.map((t) => t.g.reason))];
  const needs = new Map<string, Need>();
  for (const t of real) {
    const n = needFor(site, t.g, t.kind);
    needs.set(`${n.check}|${n.detail}`, n);
  }
  const abstention: Abstention = { kind, reasons: reasons.length ? reasons : ["inputs missing"], needs: [...needs.values()] };
  if (lastDecided) {
    abstention.lastDecided = lastDecided;
    abstention.reasons.push(`the earlier ${lastDecided.action} (tick ${lastDecided.tick + 1}, ${lastDecided.at.slice(11, 16)}Z) has not been refreshed and must not be treated as current`);
  }
  return abstention;
}

const outageOnly = (gaps: Gap[]): boolean => gaps.length > 0 && gaps.every((g) => ["missing", "budget"].includes(classifyGap(g)));

export class MonitorSession {
  readonly ctx: Ctx;
  readonly history: TickResult[] = [];
  readonly policy: MonitorPolicy;
  private states = new Map<string, HourState>();
  private lastDecided = new Map<string, { action: MonitorAction; tick: number; at: string }>();
  private hp?: Cached<HashpriceInput>;
  private wx?: Cached<WeatherInput>;
  private rt = new Map<string, PowerCache>();
  private da = new Map<string, PowerCache>();

  constructor(
    readonly site: SiteConfig,
    readonly sessionCapUsd: number,
    readonly label: string,
    deps: { transport: Transport; pub: PublicSources; now: Date },
    policy: Partial<MonitorPolicy> = {},
  ) {
    if (!(sessionCapUsd >= 0)) throw new RuntimeError("the session spend cap must be zero or more");
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.ctx = { site, transport: deps.transport, pub: deps.pub, budget: new Budget(sessionCapUsd), now: deps.now, evidence: [] };
  }

  get capReached(): boolean {
    return this.ctx.budget.breached || this.ctx.budget.spentUsd + ENGINE_ASK_USD > this.sessionCapUsd + 1e-9;
  }

  get spentUsd(): number {
    return Math.round(this.ctx.budget.spentUsd * 1e6) / 1e6;
  }

  async step(env: TickEnv): Promise<TickResult> {
    const { ctx, site, policy } = this;
    ctx.now = env.now;
    ctx.transport = env.transport;
    ctx.pub = env.pub;
    const now = env.now.getTime();
    const spent0 = ctx.budget.spentUsd;
    const ev0 = ctx.evidence.length;
    const actions: string[] = [];
    const tick = this.history.length;
    const start = Math.floor(now / HOUR) * HOUR;
    const hours = Array.from({ length: site.planning.hours }, (_, k) => new Date(start + k * HOUR));
    const keys = hours.map((h) => h.toISOString());
    const mins = (since: number) => Math.round((now - since) / MIN);

    // 1. Hashprice: needed by every hour, so it is checked first and nothing else is bought without it.
    const hpDue = !this.hp || this.hp.input.usdPerPhDay === null || now - this.hp.at >= policy.hashpriceEveryMin * MIN;
    if (hpDue) {
      const fresh = await gatherHashprice(ctx);
      if (fresh.usdPerPhDay !== null) {
        const e = ctx.evidence.find((x) => fresh.evidence.includes(x.id) && x.check === "hashprice" && x.source.kind !== "public");
        const was = this.hp?.input.usdPerPhDay ?? null;
        const moved = was !== null && Math.abs(was - fresh.usdPerPhDay) >= 0.005 ? `${fresh.usdPerPhDay > was ? "rose" : "fell"} from ${usd(was)} to ` : "";
        this.hp = { input: fresh, at: now };
        actions.push(`hashprice refreshed: ${moved}${usd(fresh.usdPerPhDay)}/PH/day${e ? ` (${e.id}, receipt ${shortReceipt(receiptOf(e))})` : ""}`);
      } else if (this.hp?.input.usdPerPhDay != null && outageOnly(fresh.gaps) && now - this.hp.at <= site.intelligence.maxAgeMin.hashprice * MIN) {
        actions.push(`hashprice refresh failed (${fresh.gaps[0]?.reason}); keeping the answer from ${mins(this.hp.at)} min ago, inside its ${site.intelligence.maxAgeMin.hashprice} min limit`);
      } else {
        this.hp = { input: fresh, at: now };
        actions.push(`hashprice unavailable: ${fresh.gaps.map((g) => g.reason).join(" | ")}`);
      }
    }
    const hp = this.hp!.input;
    const hpOk = hp.usdPerPhDay !== null;

    // 2. Weather trust and the temperature forecast (only when the site has heat limits).
    let wx: WeatherInput = { required: false, tempC: {}, trusted: true, evidence: [], gaps: [] };
    if (site.heat) {
      const lookahead = Array.from({ length: site.planning.hours * 2 }, (_, k) => new Date(start + k * HOUR).toISOString());
      const missingTemp = this.wx ? keys.some((k) => this.wx!.input.tempC[k] === undefined) : true;
      const due = !this.wx || !this.wx.input.trusted || missingTemp || now - this.wx.at >= policy.weatherEveryMin * MIN;
      if (due && hpOk) {
        const fresh = await gatherWeather(ctx, lookahead);
        const keep = this.wx?.input.trusted && !fresh.trusted && outageOnly(fresh.gaps) && Object.keys(this.wx.input.tempC).length > 0 && now - this.wx.at <= site.intelligence.maxAgeMin.weather * MIN;
        if (keep) actions.push(`weather check failed (${fresh.gaps[0]?.reason}); keeping the verified answer from ${mins(this.wx!.at)} min ago`);
        else {
          this.wx = { input: fresh, at: now };
          actions.push(fresh.trusted ? "weather verified and forecast refreshed" : `weather not verified: ${fresh.gaps.map((g) => g.reason).join(" | ")}`);
        }
      }
      wx = this.wx?.input ?? wx;
    }

    // 3. Power: real-time for the current hour every tick (strict, no day-ahead fallback), day-ahead for later hours when due.
    const interval = new Date(Math.floor(now / QUARTER) * QUARTER - QUARTER).toISOString();
    const power = new Map<string, PowerInput>();
    const budgetGap = (k: string): PowerInput => ({
      basis: "none", price: null, evidence: [], notes: [],
      gap: { check: "budget", subject: k, reason: `spend cap $${this.sessionCapUsd.toFixed(2)} reached ($${this.spentUsd.toFixed(2)} spent); no further intelligence bought` },
    });
    for (const [i, hour] of hours.entries()) {
      const k = keys[i]!;
      if (!hpOk) {
        const old = (i === 0 ? this.rt : this.da).get(k);
        power.set(k, old && old.input.price !== null ? old.input : {
          basis: "none", price: null, evidence: [], notes: [],
          gap: { check: i === 0 ? "power-real-time" : "power-day-ahead", subject: k, reason: "not bought: no hashprice, so no hour can be decided" },
        });
        continue;
      }
      if (i === 0) {
        const cached = this.rt.get(k);
        if (cached && cached.interval === interval && cached.input.price !== null) {
          power.set(k, cached.input);
          continue;
        }
        if (this.capReached) {
          power.set(k, budgetGap(k));
          actions.push(`${k.slice(11, 16)} real-time not refreshed: spend cap reached`);
          continue;
        }
        const got = await gatherPower(ctx, hour, "real-time");
        const input: PowerInput = { basis: got.price === null ? "none" : "real-time", price: got.price, evidence: got.evidence, notes: [], gap: got.gap };
        this.rt.set(k, { input, at: now, interval });
        power.set(k, input);
        continue;
      }
      const cached = this.da.get(k);
      const due = !cached || cached.input.price === null || now - cached.at >= policy.dayAheadEveryMin * MIN;
      if (!due) {
        power.set(k, cached!.input);
        continue;
      }
      if (this.capReached) {
        // A slow input that cannot be refreshed keeps riding on its answer while it is inside its freshness window.
        if (cached && cached.input.price !== null && now - cached.at <= site.intelligence.maxAgeMin.dayAhead * MIN) {
          power.set(k, cached.input);
          actions.push(`${k.slice(11, 16)} day-ahead refresh skipped: spend cap reached; using the answer from ${mins(cached.at)} min ago`);
        } else power.set(k, budgetGap(k));
        continue;
      }
      const got = await gatherPower(ctx, hour, "day-ahead");
      const fresh: PowerInput = { basis: got.price === null ? "none" : "day-ahead", price: got.price, evidence: got.evidence, notes: [], gap: got.gap };
      if (got.price === null && cached?.input.price != null && got.gap && outageOnly([got.gap]) && now - cached.at <= site.intelligence.maxAgeMin.dayAhead * MIN) {
        power.set(k, cached.input);
        actions.push(`${k.slice(11, 16)} day-ahead refresh failed (${got.gap.reason}); keeping the answer from ${mins(cached.at)} min ago`);
      } else {
        this.da.set(k, { input: fresh, at: now });
        power.set(k, fresh);
      }
    }

    // 4. Decide every hour from what is on file now, then turn HOLD into an explicit NO RECOMMENDATION.
    const byId = new Map(ctx.evidence.map((e) => [e.id, e]));
    const states: HourState[] = [];
    for (const [i, hour] of hours.entries()) {
      const k = keys[i]!;
      const p = power.get(k)!;
      const d = decideHour(site, {
        hour: k, hashpriceUsdPerPhDay: hp.usdPerPhDay, hashpriceGaps: hp.gaps, power: p, tempC: wx.tempC[k], weatherRequired: wx.required,
        weatherTrusted: wx.trusted, weatherGaps: wx.gaps, evidence: [...hp.evidence, ...wx.evidence.filter(Boolean), ...p.evidence],
        forward: hour.getTime() > now,
      });
      const state = this.toState(d, byId, tick);
      if (state.action !== "NO RECOMMENDATION") this.lastDecided.set(k, { action: state.action, tick, at: env.now.toISOString() });
      states.push(state);
    }

    // 5. Diff against the previous tick.
    const changes = states.map((s) => diffHour(this.states.get(s.hour), s));
    const elapsed = [...this.states.values()].filter((s) => !keys.includes(s.hour));
    for (const s of elapsed) this.states.delete(s.hour);
    for (const s of states) this.states.set(s.hour, s);

    const forecast = anticipate(site, states, hp.usdPerPhDay, policy.stressUsdPerMwh);
    const bought: Bought[] = ctx.evidence.slice(ev0).filter((e) => e.source.kind !== "public").map((e) => this.boughtOf(e));
    const sessionUsd = this.spentUsd;
    const result: TickResult = {
      tick, at: env.now.toISOString(), note: env.note, hours: states, changes, elapsed, forecast, actions, bought,
      spend: {
        tickUsd: Math.round((ctx.budget.spentUsd - spent0) * 1e6) / 1e6, sessionUsd, capUsd: this.sessionCapUsd,
        remainingUsd: Math.max(0, Math.round((this.sessionCapUsd - sessionUsd) * 1e6) / 1e6), capReached: this.capReached,
      },
      hashpriceUsdPerPhDay: hp.usdPerPhDay,
    };
    this.history.push(result);
    return result;
  }

  private boughtOf(e: Evidence): Bought {
    return { id: e.id, check: e.check, subject: e.subject, provider: e.source.name.replace(/ \(recorded stand-in.*$/, ""), costUsd: e.costUsd, receipt: receiptOf(e), accepted: e.accepted, reason: e.reason };
  }

  private toState(d: HourDecision, byId: Map<string, Evidence>, tick: number): HourState {
    const ev = d.evidence.map((id) => byId.get(id)).filter((e): e is Evidence => Boolean(e));
    const isPower = (e: Evidence) => e.check === "power-real-time" || e.check === "power-day-ahead";
    const priceEv = ev.find((e) => isPower(e) && e.source.kind !== "public" && e.accepted);
    const crossEv = ev.find((e) => isPower(e) && e.source.kind === "public" && e.subject === priceEv?.subject);
    const hpEv = ev.find((e) => e.check === "hashprice" && e.source.kind !== "public" && e.accepted);
    const citeOf = (e?: Evidence) => (e ? { evidence: e.id, receipt: receiptOf(e) } : undefined);
    const snapshot: Snapshot = {
      basis: d.basis,
      priceUsd: d.powerPriceUsdPerMwh,
      interval: priceEv ? String(priceEv.params.interval_start ?? "") || null : null,
      provider: priceEv ? priceEv.source.name.split(" ")[0]! : "provider",
      priceCite: citeOf(priceEv),
      crossCheck: priceEv ? (crossEv && crossEv.accepted ? { lmp: Number(crossEv.result.lmp_usd_per_mwh), evidence: crossEv.id } : crossEv ? null : undefined) : undefined,
      hashpriceUsd: hashpriceOf(this.hp),
      hashpriceCite: citeOf(hpEv),
      tempC: d.tempC,
      marginUsd: d.marginUsdPerMwh,
      revenueUsd: d.revenueUsdPerMwh,
      costUsd: d.powerCostUsdPerMwh,
    };
    const base = { hour: d.hour, runFraction: d.runFraction, snapshot, reasons: d.reasons, evidence: d.evidence, expectedProfitUsd: d.expectedProfitUsd };
    if (d.action !== "HOLD") return { ...base, action: d.action };
    const last = this.lastDecided.get(d.hour);
    return { ...base, action: "NO RECOMMENDATION", abstain: abstentionFrom(this.site, d.gaps, last && last.tick < tick ? last : undefined) };
  }

  /** Per hour: the sequence of actions it went through, for the end-of-run summary. */
  path(): Map<string, { tick: number; at: string; action: MonitorAction }[]> {
    const out = new Map<string, { tick: number; at: string; action: MonitorAction }[]>();
    for (const t of this.history) {
      for (const h of t.hours) {
        const list = out.get(h.hour) ?? [];
        if (list.at(-1)?.action !== h.action) list.push({ tick: t.tick, at: t.at, action: h.action });
        out.set(h.hour, list);
      }
    }
    return out;
  }

  toJSON() {
    return {
      label: this.label, site: this.site.name, sessionCapUsd: this.sessionCapUsd, spentUsd: this.spentUsd, policy: this.policy,
      evidence: this.ctx.evidence, ticks: this.history,
    };
  }

  writeLog(path: string): void {
    writeFileSync(path, JSON.stringify(this.toJSON(), null, 2));
  }
}

const hashpriceOf = (c?: Cached<HashpriceInput>): number | null => c?.input.usdPerPhDay ?? null;

export { usd };

/**
 * Live monitor loop. It buys real answers every cycle, so it refuses to start unless paid mode is explicitly requested with
 * a spend cap above zero (the same rule as `plan --paid`), and it stops as soon as the session cap would be exceeded.
 * Credentials come from the environment only. Nothing in the demo path or the tests calls this with a network.
 */
export async function runLive(opts: {
  site: SiteConfig;
  paid: boolean;
  capUsd: number;
  cadenceMin: number;
  maxTicks?: number;
  env?: NodeJS.ProcessEnv;
  onTick?: (r: TickResult, s: MonitorSession) => void;
  sleep?: (ms: number) => Promise<void>;
  policy?: Partial<MonitorPolicy>;
}): Promise<MonitorSession> {
  if (!opts.paid) throw new RuntimeError("live monitoring buys real answers: pass --paid");
  if (!Number.isFinite(opts.capUsd) || opts.capUsd <= 0) throw new RuntimeError("live monitoring needs --cap <usd> above zero (a whole-session cap)");
  if (!(opts.cadenceMin > 0)) throw new RuntimeError("cadence must be above zero minutes");
  const site = { ...opts.site, intelligence: { ...opts.site.intelligence, spendCapUsd: opts.capUsd } };
  const deps = await paidDeps(site, opts.env);
  const session = new MonitorSession(site, opts.capUsd, deps.label, deps, opts.policy);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let n = 0; opts.maxTicks === undefined || n < opts.maxTicks; n++) {
    const r = await session.step({ now: new Date(), transport: deps.transport, pub: deps.pub });
    opts.onTick?.(r, session);
    // Stop when nothing more can be bought: the current hour's real-time answer is due every tick.
    if (session.capReached) break;
    await sleep(opts.cadenceMin * MIN);
  }
  return session;
}
