// A "world" is the truth for the window plus a set of SYNTHETIC injections. Both policies read the same world, so the bad inputs are identical.
import { decideHour } from "../src/decide.ts";
import { parseSite } from "../src/config.ts";
import { readFileSync } from "node:fs";
import { HOUR, NODE, OTHER_NODE, QUARTER, type Truth } from "./model.ts";
import type { SiteConfig } from "../src/types.ts";

export type Kind = "stale-price" | "wrong-node" | "wrong-market" | "disagreement" | "missing-hashprice" | "negative-price";
export const KINDS: Kind[] = ["stale-price", "wrong-node", "wrong-market", "disagreement", "missing-hashprice", "negative-price"];

export const NEGATIVE_PRICE = -18.4;
export const STALE_HOURS = 3;
export const DISAGREEMENT_DELTA = -30;
export const PER_KIND = 4;

/** What the single ERCOT price source says for the interval a policy asks about (the first quarter-hour of the hour). */
export interface Observation {
  lmp: number;
  node: string;
  market: "real-time" | "day-ahead";
  intervalStart: string;
}

export interface World {
  truth: Truth;
  hours: string[];
  /** Per-hour injected failure, if any. */
  kind: Map<string, Kind>;
  rt: Map<string, number>;
  da: Map<string, number>;
  /** True ERCOT real-time settlement price of the hour (mean of its four intervals) after any injected negative price. */
  rtHour(hour: string): number;
  /** The value the price source serves for the first quarter-hour of the hour, after injections. */
  observation(hour: string): Observation;
  hashpriceAvailable(hour: string): boolean;
  hashprice(hour: string): { usdPerPhDay: number; btcUsd: number; hashrateEhS: number; avgHeight: number };
}

const iso = (ms: number) => new Date(ms).toISOString();

export function loadSite(): SiteConfig {
  const raw = JSON.parse(readFileSync(new URL("../sites/west-texas.json", import.meta.url), "utf8")) as Record<string, any>;
  // The comparison is about price and hashprice inputs. Heat is removed (cold November, and a web-only Mind has no weather check to compare).
  delete raw.heat;
  raw.planning = { hours: 1 };
  raw.intelligence = { ...raw.intelligence, providers: { ...raw.intelligence.providers, weather: [] } };
  return parseSite(raw);
}

export function buildWorld(truth: Truth, injections: Map<string, Kind>): World {
  const rt = new Map(truth.rt);
  const da = new Map(truth.da);
  for (const [h, k] of injections) {
    if (k !== "negative-price") continue;
    for (let q = 0; q < 4; q++) rt.set(iso(Date.parse(h) + q * QUARTER), NEGATIVE_PRICE);
    da.set(h, NEGATIVE_PRICE);
  }
  const rtHour = (h: string) => [0, 1, 2, 3].reduce((s, q) => s + rt.get(iso(Date.parse(h) + q * QUARTER))!, 0) / 4;
  const clean = (h: string): Observation => ({ lmp: rt.get(h)!, node: NODE, market: "real-time", intervalStart: h });
  return {
    truth, hours: truth.hours, kind: injections, rt, da, rtHour,
    observation(h) {
      switch (injections.get(h)) {
        case "stale-price": { const old = iso(Date.parse(h) - STALE_HOURS * HOUR); return { lmp: rt.get(old)!, node: NODE, market: "real-time", intervalStart: old }; }
        case "wrong-node": return { lmp: truth.other.get(h)!, node: OTHER_NODE, market: "real-time", intervalStart: h };
        case "wrong-market": return { lmp: da.get(h)!, node: NODE, market: "day-ahead", intervalStart: h };
        case "disagreement": return { ...clean(h), lmp: Math.round((rt.get(h)! + DISAGREEMENT_DELTA) * 100) / 100 };
        default: return clean(h);
      }
    },
    hashpriceAvailable: (h) => injections.get(h) !== "missing-hashprice",
    hashprice: (h) => truth.hashprice(h),
  };
}

/** Hindsight numbers for one hour: the margin the site really earns per MWh at ERCOT's settled price and the day's hashprice. */
export function trueEconomics(site: SiteConfig, w: World, h: string) {
  const mw = (site.fleet.hashrateTh * site.fleet.efficiencyJPerTh) / 1e6;
  const hp = w.hashprice(h).usdPerPhDay;
  const revenue = (hp * (site.fleet.hashrateTh / 1000)) / 24 / mw;
  const margin = revenue - (w.rtHour(h) + site.power.adderUsdPerMwh) - site.operating.otherVariableUsdPerMwh;
  return { mw, revenue, margin, best: Math.max(0, margin) * mw };
}

/** Profit of running `fraction` of the fleet for the hour at the true margin (a negative margin loses money). */
export const profitAt = (site: SiteConfig, w: World, h: string, fraction: number) => fraction * trueEconomics(site, w, h).margin * trueEconomics(site, w, h).mw;

/** The oracle knows ERCOT's settled hourly price and the true hashprice, and applies Ballast's own thresholds. */
export function oracle(site: SiteConfig, w: World, h: string) {
  const d = decideHour(site, {
    hour: h, hashpriceUsdPerPhDay: w.hashprice(h).usdPerPhDay, hashpriceGaps: [], tempC: undefined, weatherRequired: false, weatherTrusted: true, weatherGaps: [],
    evidence: [], forward: false, power: { basis: "real-time", price: w.rtHour(h), evidence: [], notes: [] },
  });
  return { action: d.action, fraction: d.runFraction };
}

/**
 * Chooses where the six failures land. They are placed at the hours where each would hurt a policy that trusts it the most
 * (no hour is used twice, none adjacent), so the dollar figures are a worst-case-placement bound, not an expected rate.
 */
export function chooseInjections(site: SiteConfig, truth: Truth, perKind = PER_KIND): Map<string, Kind> {
  const base = buildWorld(truth, new Map());
  const used = new Set<string>();
  const out = new Map<string, Kind>();
  const free = (h: string) => ![-1, 0, 1].some((d) => used.has(iso(Date.parse(h) + d * HOUR)));
  const take = (kind: Kind, ranked: string[]) => {
    let n = 0;
    for (const h of ranked) {
      if (n >= perKind) break;
      if (!free(h)) continue;
      used.add(h);
      out.set(h, kind);
      n++;
    }
  };
  // Damage to a policy that trusts the corrupted price as-is: hindsight-best profit minus the profit it earns on that price.
  const damage = (kind: Kind, h: string) => {
    const w = buildWorld(truth, new Map([[h, kind]]));
    const o = w.observation(h);
    const d = decideHour(site, {
      hour: h, hashpriceUsdPerPhDay: base.hashprice(h).usdPerPhDay, hashpriceGaps: [], tempC: undefined, weatherRequired: false, weatherTrusted: true, weatherGaps: [],
      evidence: [], forward: false, power: { basis: "real-time", price: o.lmp, evidence: [], notes: [] },
    });
    return trueEconomics(site, base, h).best - profitAt(site, base, h, d.runFraction);
  };
  const hours = truth.hours.slice(1); // stale needs history
  const byDamage = (kind: Kind) => [...hours]
    .map((h) => ({ h, dmg: damage(kind, h), gap: Math.abs(buildWorld(truth, new Map([[h, kind]])).observation(h).lmp - base.rtHour(h)) }))
    .sort((a, b) => b.dmg - a.dmg || b.gap - a.gap || Date.parse(a.h) - Date.parse(b.h))
    .map((x) => x.h);
  const eligibleStale = hours.filter((h) => truth.rt.has(iso(Date.parse(h) - STALE_HOURS * HOUR)));
  take("stale-price", byDamage("stale-price").filter((h) => eligibleStale.includes(h)));
  take("wrong-node", byDamage("wrong-node"));
  take("wrong-market", byDamage("wrong-market"));
  take("disagreement", byDamage("disagreement"));
  // Missing hashprice has no price damage to rank on: spread the outages evenly over the window.
  const step = Math.floor(hours.length / (perKind + 1));
  take("missing-hashprice", Array.from({ length: perKind * 3 }, (_, k) => hours[(k + 1) * step % hours.length]!));
  // Negative prices happen in the cheapest hours (wind), so use the lowest real hours.
  take("negative-price", [...hours].sort((a, b) => base.rtHour(a) - base.rtHour(b)));
  return out;
}

/** The site as e2f949b ran it: no hashprice carrying, no wrong-market or wrong-interval recovery, the whole hour priced at the latest interval. */
export function legacySite(site: SiteConfig = loadSite()): SiteConfig {
  const s = JSON.parse(JSON.stringify(site)) as SiteConfig;
  s.intelligence.maxAgeMin.hashpriceCarry = 0;
  s.intelligence.recovery = { reask: false, publicArchive: false };
  s.planning.hourEstimate = { mode: "latest-interval", earlierIntervals: "public" };
  return s;
}
