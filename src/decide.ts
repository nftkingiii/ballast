import type { PowerInput } from "./evidence.ts";
import type { Gap, HourDecision, SiteConfig } from "./types.ts";

export interface HourInputs {
  hour: string;
  hashpriceUsdPerPhDay: number | null;
  hashpriceGaps: Gap[];
  power: PowerInput;
  tempC: number | undefined;
  weatherRequired: boolean;
  weatherTrusted: boolean;
  weatherGaps: Gap[];
  evidence: string[];
  /** The hour has not started, so a real-time price cannot exist yet. */
  forward: boolean;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Fleet draw in MW: TH/s times J/TH is watts. Heat makes each joule buy less hashrate. */
export function fleetMw(site: SiteConfig, tempC: number | undefined): number {
  const penalty =
    site.heat && tempC !== undefined && tempC > site.heat.derateAboveC
      ? 1 + (site.heat.efficiencyPenaltyPctPerC / 100) * (tempC - site.heat.derateAboveC)
      : 1;
  return (site.fleet.hashrateTh * site.fleet.efficiencyJPerTh * penalty) / 1e6;
}

/** What one more MWh of running actually costs, given how the site buys power. */
export function powerCost(site: SiteConfig, lmp: number, forward: boolean): { cost: number; why: string } {
  const p = site.power;
  if (p.mode === "fixed" && !p.resellAtLmp) return { cost: p.fixedUsdPerMwh ?? 0, why: `fixed contract at $${p.fixedUsdPerMwh}/MWh` };
  const buffer = forward && p.mode === "realtime" ? site.operating.forwardBufferUsdPerMwh : 0;
  const base = lmp + p.adderUsdPerMwh + buffer;
  const why =
    p.mode === "fixed"
      ? `fixed contract with resale, so running forgoes the $${lmp}/MWh settlement price (+$${p.adderUsdPerMwh} adder)`
      : `real-time exposure: $${lmp}/MWh settlement price + $${p.adderUsdPerMwh} adder${buffer ? ` + $${buffer} forward buffer` : ""}`;
  return { cost: base, why };
}

export function decideHour(site: SiteConfig, i: HourInputs): HourDecision {
  const base: HourDecision = {
    hour: i.hour, action: "HOLD", runFraction: 0, basis: i.power.basis, powerPriceUsdPerMwh: i.power.price, powerCostUsdPerMwh: null,
    revenueUsdPerMwh: null, marginUsdPerMwh: null, tempC: i.tempC ?? null, fleetMw: null, expectedProfitUsd: null, reasons: [],
    evidence: i.evidence, gaps: [],
  };

  // Fail closed: name every missing required input instead of deciding on part of the picture.
  const gaps: Gap[] = [];
  if (i.hashpriceUsdPerPhDay === null) gaps.push(...(i.hashpriceGaps.length ? i.hashpriceGaps : [{ check: "hashprice" as const, subject: i.hour, reason: "no hashprice" }]));
  if (i.power.price === null) gaps.push(i.power.gap ?? { check: "power-day-ahead", subject: i.hour, reason: "no power price for this hour" });
  if (i.weatherRequired) {
    if (i.tempC === undefined) gaps.push({ check: "weather-forecast", subject: i.hour, reason: "no temperature forecast for this hour" });
    else if (!i.weatherTrusted && site.heat && i.tempC >= site.heat.derateAboveC - 5) {
      gaps.push(...(i.weatherGaps.length ? i.weatherGaps : [{ check: "weather-verify" as const, subject: i.hour, reason: "weather data could not be verified" }]));
    }
  }
  if (gaps.length) {
    return { ...base, gaps, reasons: [`HOLD: ${gaps.map((g) => g.reason).join(" | ")}`] };
  }

  const lmp = i.power.price as number;
  const hashprice = i.hashpriceUsdPerPhDay as number;
  const mw = fleetMw(site, i.tempC);
  const { cost, why } = powerCost(site, lmp, i.forward && i.power.basis === "day-ahead");
  const revenuePerHour = (hashprice * (site.fleet.hashrateTh / 1000)) / 24;
  const revenue = revenuePerHour / mw;
  const margin = revenue - cost - site.operating.otherVariableUsdPerMwh;
  const reasons = [...i.power.notes, why, `revenue $${round(revenue)}/MWh at hashprice $${round(hashprice)}/PH/day`];

  const out = { ...base, powerCostUsdPerMwh: round(cost), revenueUsdPerMwh: round(revenue), marginUsdPerMwh: round(margin), fleetMw: round(mw, 3), reasons };
  if (site.heat && i.tempC !== undefined && i.tempC >= site.heat.shutdownAboveC) {
    return { ...out, action: "CURTAIL", runFraction: 0, expectedProfitUsd: 0, reasons: [`${i.tempC}C is at or above the ${site.heat.shutdownAboveC}C shutdown limit`, ...reasons] };
  }
  if (site.heat && i.tempC !== undefined && i.tempC > site.heat.derateAboveC) reasons.push(`${i.tempC}C is above ${site.heat.derateAboveC}C: efficiency penalty applied, fleet draws ${round(mw, 2)} MW`);
  if (cost < 0) reasons.push(`negative price: running earns $${round(-cost)}/MWh on top of mining revenue`);

  if (margin >= site.operating.throttleBandUsdPerMwh) {
    return { ...out, action: "RUN", runFraction: 1, expectedProfitUsd: round(margin * mw) };
  }
  if (margin >= 0) {
    const f = site.operating.throttleFraction;
    reasons.push(`margin is inside the $${site.operating.throttleBandUsdPerMwh}/MWh band, so run ${Math.round(f * 100)}% of the fleet`);
    return { ...out, action: "THROTTLE", runFraction: f, expectedProfitUsd: round(margin * mw * f) };
  }
  reasons.push(`margin is negative: every MWh run loses $${round(-margin)}`);
  return { ...out, action: "CURTAIL", runFraction: 0, expectedProfitUsd: 0 };
}
