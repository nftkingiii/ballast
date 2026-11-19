import type { Fixture } from "./sources.ts";
import type { SiteConfig } from "./types.ts";

/**
 * Edits to the recorded fixture that stage the failure cases from the bounty. They are SYNTHETIC: the real
 * recorded day has none of these events. Output built from them is labelled so it cannot pass for live data.
 */
export interface Scenario {
  title: string;
  what: string;
  apply(fx: Fixture, site: SiteConfig): { fx: Fixture; site: SiteConfig };
}

const HOUR = 3_600_000;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const hourAt = (fx: Fixture, k: number): string => new Date(Math.floor(Date.parse(fx.recordedAt) / HOUR) * HOUR + k * HOUR).toISOString();

/** Sets the day-ahead price for an hour in both the provider answer and the public cross-check, so they agree. */
export function setDayAhead(fx: Fixture, hour: string, lmp: number): void {
  for (const p of fx.shaped.power) if (p.market === "day-ahead" && p.intervalStart === hour) p.result = { ...p.result, lmp_usd_per_mwh: lmp };
  for (const r of fx.public.ercot) if (r.market === "day-ahead" && r.intervalStart === hour) r.lmp = lmp;
}

export const SCENARIOS: Record<string, Scenario> = {
  "negative-price": {
    title: "Negative-price hour",
    what: "Hour +2 settles at -$18.40/MWh and hour +3 spikes to $450/MWh.",
    apply(base, site) {
      const fx = copy(base);
      setDayAhead(fx, hourAt(fx, 2), -18.4);
      setDayAhead(fx, hourAt(fx, 3), 450);
      return { fx, site };
    },
  },
  "stale-price": {
    title: "Stale power price",
    what: "The real-time answer is 3 hours old, and the day-ahead answer for hour +2 is for the previous hour.",
    apply(base, site) {
      const fx = copy(base);
      const rt = fx.shaped.power.find((p) => p.market === "real-time")!;
      rt.answeredAt = new Date(Date.parse(fx.recordedAt) - 3 * HOUR).toISOString();
      const da = fx.shaped.power.find((p) => p.market === "day-ahead" && p.intervalStart === hourAt(fx, 2))!;
      da.result = { ...da.result, interval_start: hourAt(fx, 1) };
      return { fx, site };
    },
  },
  disagreement: {
    title: "Providers disagree",
    what: "Pecos answers $61/MWh for hour +2 while the public ERCOT archive says otherwise.",
    apply(base, site) {
      const fx = copy(base);
      const da = fx.shaped.power.find((p) => p.market === "day-ahead" && p.intervalStart === hourAt(fx, 2))!;
      da.result = { ...da.result, lmp_usd_per_mwh: 61 };
      return { fx, site };
    },
  },
  "missing-hashprice": {
    title: "Missing hashprice",
    what: "The hashprice provider gives no answer, so no hour can be decided and no prices are bought.",
    apply(base, site) {
      const fx = copy(base);
      fx.shaped.hashprice = [];
      return { fx, site };
    },
  },
  "weather-outage": {
    title: "Weather telemetry outage during a heat wave",
    what: "Forecast temperatures are raised 22C and the weather verification provider is down.",
    apply(base, site) {
      const fx = copy(base);
      for (const k of Object.keys(fx.public.forecast.hourlyC)) fx.public.forecast.hourlyC[k]! += 22;
      fx.shaped.weather = [];
      return { fx, site };
    },
  },
  heat: {
    title: "Heat derate with verified weather",
    what: "Forecast temperatures are raised 22C (about 33-41C) and the weather check passes.",
    apply(base, site) {
      const fx = copy(base);
      for (const k of Object.keys(fx.public.forecast.hourlyC)) fx.public.forecast.hourlyC[k]! += 22;
      return { fx, site };
    },
  },
  "spend-cap": {
    title: "Spend cap breach",
    what: "The cap is $0.05, enough for five Telegraph calls, so later hours are never priced.",
    apply(base, site) {
      const s = copy(site);
      s.intelligence.spendCapUsd = 0.05;
      return { fx: copy(base), site: s };
    },
  },
};
