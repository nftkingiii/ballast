// Decision diff: compares what Ballast decided for an hour on one tick with what it decided before, and says in plain
// language what changed and why, citing evidence ids and receipts. Pure functions, no I/O.

export type MonitorAction = "RUN" | "THROTTLE" | "CURTAIL" | "NO RECOMMENDATION";
export type AbstainKind = "conflict" | "stale" | "missing" | "budget";

/** What the monitor would need in order to decide: which check, from which provider. */
export interface Need {
  check: string;
  provider: string;
  detail: string;
}

export interface Abstention {
  kind: AbstainKind;
  reasons: string[];
  needs: Need[];
  /** The last decision this hour had before it was held, if any. It is NOT current. */
  lastDecided?: { action: MonitorAction; tick: number; at: string };
}

export interface Cite {
  evidence: string;
  receipt: string;
}

/** The inputs a decision rested on, flattened so two decisions can be compared. */
export interface Snapshot {
  basis: "real-time" | "day-ahead" | "none";
  priceUsd: number | null;
  /** Start of the interval (real-time) or hour (day-ahead) the price is for. */
  interval: string | null;
  provider: string;
  priceCite?: Cite;
  crossCheck?: { lmp: number; evidence: string } | null;
  hashpriceUsd: number | null;
  hashpriceCite?: Cite;
  tempC: number | null;
  marginUsd: number | null;
  revenueUsd: number | null;
  costUsd: number | null;
}

export interface HourState {
  hour: string;
  action: MonitorAction;
  runFraction: number;
  snapshot: Snapshot;
  abstain?: Abstention;
  reasons: string[];
  evidence: string[];
  expectedProfitUsd: number | null;
}

export type ChangeKind = "new" | "flipped" | "abstained" | "resolved" | "still-abstaining" | "unchanged";

export interface Change {
  hour: string;
  kind: ChangeKind;
  from: MonitorAction | null;
  to: MonitorAction;
  text: string;
  /** Evidence ids that explain the change (the new inputs). */
  evidence: string[];
}

export const usd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
export const hhmm = (iso: string): string => iso.slice(11, 16);

export function shortReceipt(receipt: string): string {
  return receipt.startsWith("0x") && receipt.length > 18 ? `${receipt.slice(0, 10)}…${receipt.slice(-4)}` : receipt;
}

const cite = (c?: Cite): string => (c ? ` (${c.evidence}, receipt ${shortReceipt(c.receipt)})` : "");
const intervalLabel = (s: Snapshot): string => (s.interval ? hhmm(s.interval) : "?");
const eq = (a: number | null, b: number | null, eps = 0.005) => (a === null || b === null ? a === b : Math.abs(a - b) < eps);

function priceCause(p: Snapshot | undefined, n: Snapshot): string | undefined {
  if (n.priceUsd === null) return undefined;
  const what = `${n.provider} ${n.basis} for ${intervalLabel(n)}`;
  const withCheck = (text: string) => {
    if (n.crossCheck === undefined) return text;
    if (n.crossCheck === null) return `${text}; no public cross-check was available`;
    const gap = Math.abs(n.crossCheck.lmp - n.priceUsd!);
    return `${text}; public ERCOT archive ${gap < 0.005 ? "agrees exactly" : `agrees within ${usd(gap)}`} (${n.crossCheck.evidence})`;
  };
  if (!p) return withCheck(`priced from ${what} at ${usd(n.priceUsd)}${cite(n.priceCite)}`);
  if (p.priceUsd === null) return withCheck(`${what} is now available at ${usd(n.priceUsd)}${cite(n.priceCite)}`);
  if (p.basis !== n.basis) return withCheck(`now priced from ${what} at ${usd(n.priceUsd)}${cite(n.priceCite)} instead of ${p.basis} ${usd(p.priceUsd)} for ${intervalLabel(p)}`);
  if (!eq(p.priceUsd, n.priceUsd)) {
    const moved = `${n.priceUsd > p.priceUsd ? "rose" : "fell"} from ${usd(p.priceUsd)} to ${usd(n.priceUsd)}`;
    return withCheck(`${what} ${moved}${cite(n.priceCite)}`);
  }
  return undefined;
}

function otherCauses(p: Snapshot | undefined, n: Snapshot): string[] {
  const out: string[] = [];
  if (n.hashpriceUsd !== null && p && p.hashpriceUsd !== null && !eq(p.hashpriceUsd, n.hashpriceUsd)) {
    out.push(`hashprice ${n.hashpriceUsd > p.hashpriceUsd ? "rose" : "fell"} from ${usd(p.hashpriceUsd)} to ${usd(n.hashpriceUsd)}/PH/day${cite(n.hashpriceCite)}`);
  } else if (n.hashpriceUsd !== null && p && p.hashpriceUsd === null) {
    out.push(`hashprice is now available at ${usd(n.hashpriceUsd)}/PH/day${cite(n.hashpriceCite)}`);
  }
  if (p && n.tempC !== null && p.tempC !== null && Math.abs(n.tempC - p.tempC) >= 0.5) {
    out.push(`forecast temperature ${n.tempC > p.tempC ? "rose" : "fell"} from ${p.tempC}C to ${n.tempC}C`);
  }
  return out;
}

function marginPhrase(p: Snapshot | undefined, n: Snapshot): string {
  if (n.marginUsd === null) return "";
  if (!p || p.marginUsd === null) return `margin ${usd(n.marginUsd)}/MWh`;
  if (eq(p.marginUsd, n.marginUsd)) return `margin unchanged at ${usd(n.marginUsd)}/MWh`;
  return `margin ${n.marginUsd < p.marginUsd ? "fell" : "rose"} from ${usd(p.marginUsd)} to ${usd(n.marginUsd)}/MWh`;
}

const idsOf = (n: Snapshot): string[] => [n.priceCite?.evidence, n.crossCheck?.evidence, n.hashpriceCite?.evidence].filter((x): x is string => Boolean(x));

/** Compares an hour's new state with the state it had on the previous tick (undefined when the hour is new to the window). */
export function diffHour(prev: HourState | undefined, next: HourState): Change {
  const label = hhmm(next.hour);
  const base = { hour: next.hour, to: next.action, from: prev?.action ?? null, evidence: idsOf(next.snapshot) };
  const p = prev?.snapshot;
  const n = next.snapshot;
  const causes = [priceCause(p, n), ...otherCauses(p, n)].filter((x): x is string => Boolean(x));
  const why = causes.length ? causes.join("; ") : "the inputs are the same; the decision was re-evaluated against the same evidence";

  if (!prev) {
    if (next.action === "NO RECOMMENDATION") {
      return { ...base, kind: "new", text: `${label} NO RECOMMENDATION: ${next.abstain?.reasons.join(" | ")}` };
    }
    return { ...base, kind: "new", text: `${label} ${next.action}: ${causes.join("; ") || "evidence on file"}; ${marginPhrase(undefined, n)}` };
  }

  const was = prev.action;
  const now = next.action;
  if (was !== "NO RECOMMENDATION" && now === "NO RECOMMENDATION") {
    return { ...base, kind: "abstained", text: `${label} changed ${was} → NO RECOMMENDATION: ${next.abstain?.reasons.join(" | ")}` };
  }
  if (was === "NO RECOMMENDATION" && now !== "NO RECOMMENDATION") {
    return { ...base, kind: "resolved", text: `${label} revisited: NO RECOMMENDATION → ${now}: ${why}; ${marginPhrase(undefined, n)}` };
  }
  if (was === "NO RECOMMENDATION" && now === "NO RECOMMENDATION") {
    const same = prev.abstain?.reasons.join("|") === next.abstain?.reasons.join("|");
    return { ...base, kind: "still-abstaining", text: `${label} still NO RECOMMENDATION${same ? "" : " (reason changed)"}: ${next.abstain?.reasons.join(" | ")}` };
  }
  if (was !== now) {
    return { ...base, kind: "flipped", text: `${label} changed ${was} → ${now}: ${why}; ${marginPhrase(p, n)}.` };
  }
  const moved = n.marginUsd !== null && p?.marginUsd != null && Math.abs(n.marginUsd - p.marginUsd) >= 0.5;
  const drift = moved ? ` (margin ${usd(p!.marginUsd!)} → ${usd(n.marginUsd!)})` : "";
  return { ...base, kind: "unchanged", text: `${label} ${now} unchanged${drift}` };
}
