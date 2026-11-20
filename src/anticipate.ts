// Anticipation: uses the day-ahead prices and the weather forecast already on file to flag upcoming hours that could
// flip. Everything here is a FORECAST, never a decision. It buys nothing.
import { fleetMw } from "./decide.ts";
import { hhmm, usd, type HourState } from "./diff.ts";
import type { SiteConfig } from "./types.ts";

export interface Anticipation {
  kind: "price" | "heat";
  level: "watch" | "likely";
  from: string;
  to: string;
  /** Real-time price above which (price risk) the hour would turn to CURTAIL, or below which it would turn back to RUN. */
  thresholdUsdPerMwh?: number;
  text: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * For each upcoming hour priced from day-ahead: the real-time price at which margin crosses zero is
 * `revenue - adder - other variable cost`. An hour is "at risk" when real-time only has to land `stressUsdPerMwh`
 * above day-ahead to cross it, and "likely" when it is already inside the forward buffer. The stress figure is an
 * assumption (policy.stressUsdPerMwh), not a measured volatility.
 */
export function anticipate(site: SiteConfig, hours: HourState[], hashpriceUsd: number | null, stressUsdPerMwh: number): Anticipation[] {
  const out: Anticipation[] = [];
  const upcoming = hours.filter((h) => h.snapshot.basis === "day-ahead" && h.action !== "NO RECOMMENDATION" && h.snapshot.priceUsd !== null && h.snapshot.revenueUsd !== null);

  type Row = { hour: string; level: "watch" | "likely"; be: number; da: number; action: string; negative: boolean };
  const rows: Row[] = [];
  if (site.power.mode === "realtime" || site.power.resellAtLmp) {
    for (const h of upcoming) {
      const s = h.snapshot;
      const be = round((s.revenueUsd as number) - site.power.adderUsdPerMwh - site.operating.otherVariableUsdPerMwh);
      const da = s.priceUsd as number;
      const headroom = be - da;
      if (h.action === "CURTAIL") {
        // Only hours close to break-even are worth flagging; a $450 hour is not about to flip.
        if (headroom > -stressUsdPerMwh) rows.push({ hour: h.hour, level: headroom > -site.operating.forwardBufferUsdPerMwh ? "likely" : "watch", be, da, action: h.action, negative: da < 0 });
      } else if (headroom <= site.operating.forwardBufferUsdPerMwh) rows.push({ hour: h.hour, level: "likely", be, da, action: h.action, negative: da < 0 });
      else if (headroom <= stressUsdPerMwh) rows.push({ hour: h.hour, level: "watch", be, da, action: h.action, negative: da < 0 });
    }
  }
  // Group consecutive hours with the same level and the same current action.
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1]!.level === rows[i]!.level && rows[j + 1]!.action === rows[i]!.action && Date.parse(rows[j + 1]!.hour) - Date.parse(rows[j]!.hour) === 3_600_000) j += 1;
    const group = rows.slice(i, j + 1);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const span = group.length === 1 ? `${hhmm(first.hour)}` : `${hhmm(first.hour)}-${hhmm(new Date(Date.parse(last.hour) + 3_600_000).toISOString())}`;
    const lowestBe = Math.min(...group.map((r) => r.be));
    const das = group.map((r) => r.da);
    const daText = Math.min(...das) === Math.max(...das) ? usd(das[0]!) : `${usd(Math.min(...das))} to ${usd(Math.max(...das))}`;
    let text: string;
    if (first.action === "CURTAIL") {
      text = `${span} currently CURTAIL on day-ahead ${daText}; ${first.level === "likely" ? "likely" : "could"} flip to RUN if real-time lands below ${usd(lowestBe)}/MWh.`;
    } else {
      text = `${span} ${first.level === "likely" ? "likely" : "could"} flip to CURTAIL if real-time tracks day-ahead above ${usd(lowestBe)}/MWh (day-ahead ${daText}, only ${usd(round(Math.min(...group.map((r) => r.be - r.da))))} of headroom).`;
    }
    out.push({ kind: "price", level: first.level, from: first.hour, to: last.hour, thresholdUsdPerMwh: lowestBe, text: `FORECAST, not a decision: ${text}` });
    i = j + 1;
  }

  // Heat: the decision already uses the forecast temperature; flag hours where it is close to a limit.
  if (site.heat && hashpriceUsd !== null) {
    const heat = site.heat;
    for (const h of hours) {
      const t = h.snapshot.tempC;
      if (t === null || h.action === "NO RECOMMENDATION") continue;
      if (t >= heat.shutdownAboveC - 3 && t < heat.shutdownAboveC) {
        out.push({ kind: "heat", level: "likely", from: h.hour, to: h.hour, text: `FORECAST, not a decision: ${hhmm(h.hour)} forecast ${t}C is within 3C of the ${heat.shutdownAboveC}C shutdown limit; CURTAIL if it reaches it.` });
      } else if (t > heat.derateAboveC && t < heat.shutdownAboveC) {
        const hot = fleetMw(site, t);
        const cool = fleetMw(site, undefined);
        out.push({ kind: "heat", level: "watch", from: h.hour, to: h.hour, text: `FORECAST, not a decision: ${hhmm(h.hour)} forecast ${t}C is above ${heat.derateAboveC}C, so the fleet draws ${round(hot)} MW instead of ${round(cool)} MW and the break-even price is lower.` });
      }
    }
  }
  return out;
}
