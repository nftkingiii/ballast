// Read-only data for the public page: preset sites (sites/*.json only) and the comparison, taken from compare/results.md and results.json.
import { readdirSync, readFileSync } from "node:fs";

const SITES_DIR = new URL("../sites/", import.meta.url);
const COMPARE_DIR = new URL("../compare/", import.meta.url);

/** The preset the recorded demo answers belong to (node HB_WEST). */
export const DEMO_SITE_ID = "west-texas";

export interface SitePreset {
  id: string;
  name: string;
  node: string;
  location: string;
  hours: number;
  fleet: string;
  /** True when the Demo run can replay recorded answers for exactly this site. */
  demoMatches: boolean;
  providers: { power: string; hashprice: string[]; weather: string[] };
}

export function listSites(dir: URL = SITES_DIR): SitePreset[] {
  const out: SitePreset[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^([a-z0-9-]{1,40})\.json$/.exec(f);
    if (!m) continue;
    const raw = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    out.push({
      id: m[1]!,
      name: String(raw.name),
      node: String(raw.node),
      location: String(raw.location?.name ?? ""),
      hours: Number(raw.planning?.hours ?? 8),
      fleet: `${(Number(raw.fleet?.hashrateTh) / 1000).toFixed(0)} PH/s at ${raw.fleet?.efficiencyJPerTh} J/TH`,
      demoMatches: m[1] === DEMO_SITE_ID,
      providers: raw.intelligence?.providers,
    });
  }
  // The recorded demo is West Texas, so it leads the picker; the rest follow by id.
  return out.sort((a, b) => Number(b.id === DEMO_SITE_ID) - Number(a.id === DEMO_SITE_ID) || a.id.localeCompare(b.id));
}

/** Raw site config for a preset id. The id must match a file in sites/; nothing else is read. */
export function loadSite(id: string, dir: URL = SITES_DIR): Record<string, any> | undefined {
  if (!/^[a-z0-9-]{1,40}$/.test(id) || !listSites(dir).some((s) => s.id === id)) return undefined;
  return JSON.parse(readFileSync(new URL(`${id}.json`, dir), "utf8"));
}

/** A markdown table section as header + rows of cells. */
export function parseTable(md: string, heading: string): { header: string[]; rows: string[][] } | undefined {
  const start = md.indexOf(heading);
  if (start < 0) return undefined;
  const lines = md.slice(start).split("\n").slice(1);
  const table: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (!cells.every((c) => /^:?-+:?$/.test(c))) table.push(cells);
    } else if (table.length) break;
  }
  return table.length ? { header: table[0]!, rows: table.slice(1) } : undefined;
}

export function loadComparison(dir: URL = COMPARE_DIR) {
  const md = readFileSync(new URL("results.md", dir), "utf8");
  const json = JSON.parse(readFileSync(new URL("results.json", dir), "utf8"));
  const headline = parseTable(md, "## Headline");
  if (!headline) throw new Error("compare/results.md has no Headline table");
  const perKind = parseTable(md, "Per failure kind, B only:");
  const injected = parseTable(md, "## The six injected failures (SYNTHETIC)");
  return {
    window: json.window as { firstHour: string; lastHour: string; hours: number; node: string },
    headline,
    perKind,
    injectedKinds: injected,
    anchor: json.anchor,
    labels: json.labels as Record<string, string>,
    assumptions: json.assumptions,
  };
}
