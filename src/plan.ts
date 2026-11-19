import { decideHour } from "./decide.ts";
import { gatherHashprice, gatherPowerHour, gatherWeather, type Ctx, type PowerInput } from "./evidence.ts";
import type { PublicSources } from "./sources.ts";
import { Budget, type Transport } from "./telegraph.ts";
import type { Gap, Mode, Plan, SiteConfig } from "./types.ts";

const HOUR = 3_600_000;

export interface PlanDeps {
  transport: Transport;
  pub: PublicSources;
  now: Date;
  mode: Mode;
  /** Printed at the top of every rendering, so demo output can never pass for live output. */
  label: string;
}

export async function planSite(site: SiteConfig, deps: PlanDeps): Promise<Plan> {
  const start = site.planning.startHour ? Date.parse(site.planning.startHour) : Math.floor(deps.now.getTime() / HOUR) * HOUR;
  const hours = Array.from({ length: site.planning.hours }, (_, k) => new Date(start + k * HOUR));
  const hourIso = hours.map((h) => h.toISOString());

  const ctx: Ctx = { site, transport: deps.transport, pub: deps.pub, budget: new Budget(site.intelligence.spendCapUsd), now: deps.now, evidence: [] };

  // Buy the inputs every hour needs first; if one is missing there is no point buying prices.
  const hashprice = await gatherHashprice(ctx);
  const weather = await gatherWeather(ctx, hourIso);

  const power = new Map<string, PowerInput>();
  for (const hour of hours) {
    if (hashprice.usdPerPhDay === null) {
      power.set(hour.toISOString(), {
        basis: "none", price: null, evidence: [], notes: [],
        gap: { check: "power-day-ahead", subject: hour.toISOString(), reason: "not bought: no hashprice, so no hour can be decided" },
      });
      continue;
    }
    power.set(hour.toISOString(), await gatherPowerHour(ctx, hour));
  }

  const decisions = hours.map((hour) => {
    const key = hour.toISOString();
    const p = power.get(key)!;
    return decideHour(site, {
      hour: key,
      hashpriceUsdPerPhDay: hashprice.usdPerPhDay,
      hashpriceGaps: hashprice.gaps,
      power: p,
      tempC: weather.tempC[key],
      weatherRequired: weather.required,
      weatherTrusted: weather.trusted,
      weatherGaps: weather.gaps,
      evidence: [...hashprice.evidence, ...weather.evidence.filter(Boolean), ...p.evidence],
      forward: hour.getTime() > deps.now.getTime(),
    });
  });

  const missing = new Map<string, Gap>();
  const note = (g: Gap) => missing.set(`${g.check}|${g.subject}|${g.reason}`, g);
  decisions.forEach((d) => d.gaps.forEach(note));
  hashprice.gaps.forEach(note);
  weather.gaps.forEach(note);
  for (const e of ctx.evidence) {
    if (e.reason === "cross-check unavailable") note({ check: e.check, subject: e.subject, reason: "free public cross-check unavailable; this price rests on one source" });
  }
  // A rejected answer is a missing check even when another source covered for it (for example real-time fell back to day-ahead).
  for (const e of ctx.evidence) {
    if (e.accepted || !e.reason || e.reason === "cross-check unavailable") continue;
    if ([...missing.values()].some((g) => g.reason.includes(e.reason!))) continue;
    note({ check: e.check, subject: e.subject, reason: `${e.source.name}: ${e.reason}` });
  }
  if (ctx.budget.breached) note({ check: "budget", subject: "plan", reason: `spend cap $${site.intelligence.spendCapUsd.toFixed(2)} reached; later hours were not priced` });

  const telegraphCalls = ctx.evidence.filter((e) => e.source.kind !== "public").length;
  return {
    mode: deps.mode,
    label: deps.label,
    site: site.name,
    generatedAt: deps.now.toISOString(),
    hashpriceUsdPerPhDay: hashprice.usdPerPhDay,
    decisions,
    evidence: ctx.evidence,
    intelligenceCostUsd: round(ctx.evidence.reduce((sum, e) => sum + e.costUsd, 0), 4),
    telegraphCalls,
    projectedPaidCostUsd: round(ctx.budget.spentUsd, 4),
    spendCapUsd: site.intelligence.spendCapUsd,
    budgetBreached: ctx.budget.breached,
    missingChecks: [...missing.values()],
  };
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
