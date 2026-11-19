import type { Evidence, HourDecision, Plan } from "./types.ts";

const money = (n: number | null, digits = 2) => (n === null ? "-" : n.toFixed(digits));
const hh = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;

function pad(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd()).join("\n");
}

export function receiptOf(e: Evidence): string {
  const r = e.receipt;
  return r.receiptHash ?? r.jobId ?? r.signalHash ?? "-";
}

export function sourceLabel(e: Evidence): string {
  return `${e.source.kind}:${e.source.id} ${e.source.name}`;
}

export function renderPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(plan.label, `Site: ${plan.site}   Generated: ${plan.generatedAt}`);
  lines.push(`Hashprice used: ${plan.hashpriceUsdPerPhDay === null ? "none (no accepted answer)" : `$${money(plan.hashpriceUsdPerPhDay)} per PH/s per day`}`, "");

  const shared = plan.decisions.length ? plan.decisions[0]!.evidence.filter((id) => plan.decisions.every((d) => d.evidence.includes(id))) : [];
  const table: string[][] = [["Hour (UTC)", "Action", "Run", "Power $/MWh", "Cost", "Revenue", "Margin", "Temp C", "Est. $", "Evidence"]];
  for (const d of plan.decisions) {
    table.push([
      hh(d.hour), d.action, d.action === "HOLD" ? "-" : `${Math.round(d.runFraction * 100)}%`,
      d.powerPriceUsdPerMwh === null ? "-" : `${money(d.powerPriceUsdPerMwh)} ${d.basis === "real-time" ? "RT" : "DA"}`,
      money(d.powerCostUsdPerMwh), money(d.revenueUsdPerMwh), money(d.marginUsdPerMwh), d.tempC === null ? "-" : String(d.tempC),
      money(d.expectedProfitUsd, 0), d.evidence.filter((id) => !shared.includes(id)).join(",") || "-",
    ]);
  }
  lines.push(pad(table), `Shared by every hour: ${shared.join(", ") || "none"}`, "");

  const holds = plan.decisions.filter((d) => d.action === "HOLD");
  if (holds.length) {
    lines.push("HOLD reasons:");
    for (const d of holds) lines.push(`  ${hh(d.hour)}  ${d.gaps.map((g) => g.reason).join(" | ")}`);
    lines.push("");
  }

  const ev: string[][] = [["Id", "Check", "Subject", "Provider", "Answered (UTC)", "Cost $", "Receipt / job", "Accepted"]];
  for (const e of plan.evidence) {
    ev.push([e.id, e.check, e.subject, sourceLabel(e), e.answeredAt.slice(0, 19), money(e.costUsd, 4), receiptOf(e), e.accepted ? "yes" : `NO: ${e.reason ?? ""}`]);
  }
  lines.push("Evidence", pad(ev), "");

  const paid = plan.mode === "paid";
  lines.push(
    `Intelligence cost: $${plan.intelligenceCostUsd.toFixed(4)} (${plan.telegraphCalls} Telegraph call${plan.telegraphCalls === 1 ? "" : "s"}, cap $${plan.spendCapUsd.toFixed(2)})` +
      (paid ? "" : `; a paid run of this plan would cost about $${plan.projectedPaidCostUsd.toFixed(2)}`),
  );
  if (plan.budgetBreached) lines.push("SPEND CAP REACHED: no further intelligence was bought; unpriced hours are on HOLD.");
  lines.push(
    plan.missingChecks.length
      ? `Missing checks:\n${plan.missingChecks.map((g) => `  - [${g.check}] ${g.subject}: ${g.reason}`).join("\n")}`
      : "Missing checks: none",
  );
  return lines.join("\n");
}

export function explainDecision(plan: Plan, hour: string): string {
  const d = plan.decisions.find((x) => x.hour === hour || x.hour.startsWith(hour));
  if (!d) return `No decision for ${hour}. Planned hours: ${plan.decisions.map((x) => x.hour).join(", ")}`;
  return explainOne(plan, d);
}

function explainOne(plan: Plan, d: HourDecision): string {
  const out = [plan.label, `${d.hour}: ${d.action}${d.action === "HOLD" ? "" : ` (${Math.round(d.runFraction * 100)}% of fleet)`}`];
  if (d.fleetMw !== null) out.push(`Fleet draw ${d.fleetMw} MW; margin $${money(d.marginUsdPerMwh)}/MWh = revenue $${money(d.revenueUsdPerMwh)} - cost $${money(d.powerCostUsdPerMwh)} - other variable cost.`);
  for (const r of d.reasons) out.push(`- ${r}`);
  out.push("Inputs:");
  for (const id of d.evidence) {
    const e = plan.evidence.find((x) => x.id === id);
    if (e) out.push(`  ${e.id} ${e.check} ${e.subject} from ${sourceLabel(e)} at ${e.answeredAt}, $${e.costUsd.toFixed(4)}, receipt ${receiptOf(e)}${e.accepted ? "" : `, REJECTED: ${e.reason}`}`);
  }
  if (d.gaps.length) out.push("Missing:", ...d.gaps.map((g) => `  - [${g.check}] ${g.reason}`));
  return out.join("\n");
}
