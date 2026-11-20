// Second free fetch: (1) the HB_HOUSTON real-time price at the first quarter-hour of every window hour, used as the real "wrong node" value
// for the injection; (2) latency samples of the free public calls a web-only Mind would make.
//   node compare/fetch-extra.ts      (run after fetch-data.ts)
import { readFileSync, writeFileSync } from "node:fs";

const ASSIZE = "https://assize.up.railway.app/ercot/price";
const out = (name: string) => new URL(`./data/${name}`, import.meta.url);
const da = JSON.parse(readFileSync(out("ercot-da-hourly.json"), "utf8")) as { rows: { intervalStart: string; lmp: number | null }[] };
const hours = da.rows.filter((r) => r.lmp !== null).map((r) => r.intervalStart);

async function get(url: string, tries = 12): Promise<{ status: number; body: string; ms: number }> {
  for (let i = 0; i < tries; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      const ms = performance.now() - t0;
      if (res.status === 404 || res.ok) return { status: res.status, body: await res.text(), ms };
      await new Promise((r) => setTimeout(r, res.status === 429 ? 4000 + 3000 * i : 800 * (i + 1)));
    } catch { await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  throw new Error("gave up on " + url);
}

const rows: { intervalStart: string; lmp: number | null; source: string | null }[] = [];
const fetchedAt = new Date().toISOString();
for (const h of hours) {
  const r = await get(`${ASSIZE}?node_or_zone=HB_HOUSTON&market=real-time&interval_start=${h}`);
  if (r.status === 404) rows.push({ intervalStart: h, lmp: null, source: null });
  else { const j = JSON.parse(r.body) as { lmp_usd_per_mwh: number; source: string }; rows.push({ intervalStart: h, lmp: j.lmp_usd_per_mwh, source: j.source }); }
  await new Promise((r) => setTimeout(r, 1700));
}
writeFileSync(out("ercot-rt-hb-houston-hour-start.json"), JSON.stringify({
  fetchedAt, node: "HB_HOUSTON", market: "real-time", urlPattern: `${ASSIZE}?node_or_zone=HB_HOUSTON&market=real-time&interval_start=<hour start ISO>`, rows,
}, null, 1) + "\n");
console.log(`houston ${rows.length} rows, ${rows.filter((r) => r.lmp === null).length} missing`);

// Latency of the free calls a web-only Mind would make (6 samples each, spaced to respect Assize's rate limit).
const probes: Record<string, string> = {
  "assize ercot real-time price": `${ASSIZE}?node_or_zone=HB_WEST&market=real-time&interval_start=${hours.at(-1)}`,
  "assize ercot day-ahead price": `${ASSIZE}?node_or_zone=HB_WEST&market=day-ahead&interval_start=${hours.at(-1)}`,
  "mempool.space tip height": "https://mempool.space/api/blocks/tip/height",
  "mempool.space reward-stats(144)": "https://mempool.space/api/v1/mining/reward-stats/144",
  "mempool.space prices": "https://mempool.space/api/v1/prices",
  "mempool.space hashrate(3d)": "https://mempool.space/api/v1/mining/hashrate/3d",
};
const samplesMs: Record<string, number[]> = {};
for (const [name, url] of Object.entries(probes)) {
  samplesMs[name] = [];
  for (let i = 0; i < 6; i++) {
    const r = await get(url);
    samplesMs[name]!.push(Math.round(r.ms));
    await new Promise((r) => setTimeout(r, name.startsWith("assize") ? 1700 : 300));
  }
}
writeFileSync(out("public-latency.json"), JSON.stringify({
  measuredAt: new Date().toISOString(),
  note: "Wall-clock latency of the free public calls, measured from the machine that fetched the data (a developer laptop on an ordinary home connection). Real Minds run elsewhere, so treat these as an order of magnitude.",
  samplesMs,
}, null, 1) + "\n");
console.log("latency saved");
