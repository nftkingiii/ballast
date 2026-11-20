// Fetches the ground-truth window from free, keyless public sources and saves raw data under compare/data/ with fetch timestamps.
// Nothing here touches Telegraph and nothing is paid. `npm run compare` does NOT run this; it reads the saved files.
//   node compare/fetch-data.ts [startIso] [endIso]
// Assize rate-limits (HTTP 429), so requests go one at a time, spaced out, with a resumable on-disk cache (data/.fetch-cache.jsonl, deleted at the end).
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const ASSIZE = "https://assize.up.railway.app/ercot/price";
const NODE = "HB_WEST";
const START = Date.parse(process.argv[2] ?? "2026-11-16T00:00:00Z");
const END = Date.parse(process.argv[3] ?? "2026-11-19T18:00:00Z");
const QUARTER = 900_000;
const HOUR = 3_600_000;
const SPACING_MS = 1700;
const out = (name: string) => new URL(`./data/${name}`, import.meta.url);
const cachePath = out(".fetch-cache.jsonl");

const cache = new Map<string, { fetchedAt: string; lmp: number | null; source: string | null }>();
if (existsSync(cachePath)) for (const line of readFileSync(cachePath, "utf8").split("\n").filter(Boolean)) { const [k, v] = JSON.parse(line) as [string, never]; cache.set(k, v); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, tries = 40): Promise<{ status: number; body: string }> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (res.status === 404 || res.ok) return { status: res.status, body: await res.text() };
      await sleep(res.status === 429 ? 8000 : 1500 * (i + 1));
    } catch { await sleep(1500 * (i + 1)); }
  }
  throw new Error("gave up on " + url);
}

async function ercot(market: "real-time" | "day-ahead", step: number) {
  const starts: number[] = [];
  for (let t = START; t < END; t += step) starts.push(t);
  let done = 0;
  const rows = [];
  for (const t of starts) {
    const iso = new Date(t).toISOString();
    const key = `${market}|${iso}`;
    let hit = cache.get(key);
    if (!hit) {
      const r = await getText(`${ASSIZE}?node_or_zone=${NODE}&market=${market}&interval_start=${iso}`);
      const fetchedAt = new Date().toISOString();
      if (r.status === 404) hit = { fetchedAt, lmp: null, source: null };
      else { const j = JSON.parse(r.body) as { lmp_usd_per_mwh: number; source: string }; hit = { fetchedAt, lmp: j.lmp_usd_per_mwh, source: j.source }; }
      cache.set(key, hit);
      appendFileSync(cachePath, JSON.stringify([key, hit]) + "\n");
      await sleep(SPACING_MS);
    }
    rows.push({ intervalStart: iso, lmp: hit.lmp, source: hit.source, fetchedAt: hit.fetchedAt });
    if (++done % 25 === 0) console.log(`${market} ${done}/${starts.length}`);
  }
  return { fetchedAt: rows.map((r) => r.fetchedAt).sort()[0] ?? new Date().toISOString(), node: NODE, market, urlPattern: `${ASSIZE}?node_or_zone=${NODE}&market=${market}&interval_start=<ISO>`, rows };
}

const da = await ercot("day-ahead", HOUR);
writeFileSync(out("ercot-da-hourly.json"), JSON.stringify(da, null, 1) + "\n");
console.log(`da ${da.rows.length} rows, ${da.rows.filter((r) => r.lmp === null).length} missing`);
const rt = await ercot("real-time", QUARTER);
writeFileSync(out("ercot-rt-15min.json"), JSON.stringify(rt, null, 1) + "\n");
console.log(`rt ${rt.rows.length} rows, ${rt.rows.filter((r) => r.lmp === null).length} missing`);

// Hashprice inputs from mempool.space: per-block-group average reward (sats) with the USD price, and daily network hashrate.
const M = "https://mempool.space/api/v1/mining";
const rewards = await getText(`${M}/blocks/rewards/1w`);
const hashrate = await getText(`${M}/hashrate/1w`);
writeFileSync(out("mempool-hashprice-inputs.json"), JSON.stringify({
  fetchedAt: new Date().toISOString(),
  sources: [`${M}/blocks/rewards/1w`, `${M}/hashrate/1w`],
  rewards: JSON.parse(rewards.body), hashrate: JSON.parse(hashrate.body),
}, null, 1) + "\n");
console.log("saved mempool inputs");
try { unlinkSync(cachePath); } catch { /* keep the cache if it cannot be removed */ }
