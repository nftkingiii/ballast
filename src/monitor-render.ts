import { hhmm, usd, type HourState } from "./diff.ts";
import type { MonitorSession, TickResult } from "./monitor.ts";

const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

function pad(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd()).join("\n");
}

function hourTable(hours: HourState[]): string {
  const rows: string[][] = [["Hour (UTC)", "Action", "Run", "Power $/MWh", "Margin", "Evidence"]];
  for (const h of hours) {
    const s = h.snapshot;
    rows.push([
      hhmm(h.hour), h.action, h.action === "NO RECOMMENDATION" ? "-" : `${Math.round(h.runFraction * 100)}%`,
      s.priceUsd === null ? "-" : `${s.priceUsd.toFixed(2)} ${s.basis === "real-time" ? "RT" : "DA"}`,
      s.marginUsd === null ? "-" : s.marginUsd.toFixed(2),
      [s.priceCite?.evidence, s.hashpriceCite?.evidence].filter(Boolean).join(",") || "-",
    ]);
  }
  return pad(rows);
}

/** What changed since the previous tick, what is held and why, what may flip, and what was spent. */
export function renderChanges(r: TickResult): string {
  const out: string[] = [];
  const moved = r.changes.filter((c) => c.kind !== "unchanged");
  const same = r.changes.filter((c) => c.kind === "unchanged");
  out.push(r.tick === 0 ? "INITIAL DECISIONS" : moved.length ? "CHANGED" : "CHANGED: nothing");
  for (const c of moved) out.push(`  - ${c.text}`);
  if (r.elapsed.length) out.push(`  (left the window: ${r.elapsed.map((h) => `${hhmm(h.hour)} ended on ${h.action}`).join(", ")})`);
  if (same.length) out.push(`UNCHANGED: ${same.map((c) => c.text.replace(" unchanged", "")).join("; ")}`);

  const held = r.hours.filter((h) => h.abstain);
  if (held.length) {
    out.push("NO RECOMMENDATION (held; revisited automatically when the missing input arrives)");
    for (const h of held) {
      const a = h.abstain!;
      out.push(`  ${hhmm(h.hour)} [${a.kind}] ${a.reasons.join(" | ")}`);
      for (const n of a.needs) out.push(`      needs: ${n.check} from ${n.provider}: ${n.detail}`);
    }
  }
  if (r.forecast.length) {
    out.push("ANTICIPATED (forecast from day-ahead prices and the weather forecast, not decisions)");
    for (const f of r.forecast) out.push(`  - ${f.text}`);
  }
  return out.join("\n");
}

export function renderTick(r: TickResult, total?: number): string {
  const out: string[] = [];
  out.push(`=== Tick ${r.tick + 1}${total ? `/${total}` : ""}  ${stamp(r.at)}  hashprice ${r.hashpriceUsdPerPhDay === null ? "MISSING" : `$${r.hashpriceUsdPerPhDay.toFixed(2)}/PH/day`} ===`);
  if (r.note) out.push(`world: ${r.note}`);
  if (r.actions.length) out.push(...r.actions.map((a) => `refresh: ${a}`));
  if (r.tick === 0) out.push(hourTable(r.hours), "");
  out.push(renderChanges(r));
  const bought = r.bought.length ? `bought ${r.bought.map((b) => `${b.id} ${b.check}${b.accepted ? "" : " (rejected)"}`).join(", ")}` : "bought nothing";
  out.push(`SPEND: this tick $${r.spend.tickUsd.toFixed(2)} (${bought}); session $${r.spend.sessionUsd.toFixed(2)} of $${r.spend.capUsd.toFixed(2)} cap${r.spend.capReached ? "; CAP REACHED, no further intelligence is bought" : ""}`);
  return out.join("\n");
}

export function renderSummary(s: MonitorSession): string {
  const out: string[] = ["=== Decision history per hour (action and the tick it began) ==="];
  for (const [hour, path] of s.path()) {
    out.push(`  ${hour.slice(5, 10)} ${hhmm(hour)}  ${path.map((p) => `${p.action} (tick ${p.tick + 1}, ${hhmm(p.at)}Z)`).join(" → ")}`);
  }
  const last = s.history.at(-1);
  out.push(`Ticks: ${s.history.length}; session spend $${s.spentUsd.toFixed(2)} of $${s.sessionCapUsd.toFixed(2)}; evidence items: ${s.ctx.evidence.length}.`);
  if (last?.spend.capReached) out.push("The session ended at its spend cap: hours that needed a refresh are NO RECOMMENDATION, not stale RUN/CURTAIL.");
  return out.join("\n");
}

export function renderHeader(s: MonitorSession, extra: string[] = []): string {
  return [s.label, ...extra, `Site: ${s.site.name}   Session spend cap: ${usd(s.sessionCapUsd)}`, ""].join("\n");
}
