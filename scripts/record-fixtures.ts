// Records one day of public data into fixtures/recorded.json. Free keyless calls only; nothing here goes through Telegraph.
// Run:  node --experimental-transform-types scripts/record-fixtures.ts   (or: npx tsx scripts/record-fixtures.ts)
import { readFileSync, writeFileSync } from "node:fs";
import { parseSite } from "../src/config.ts";
import { createLivePublicSources, type Fixture } from "../src/sources.ts";

const site = parseSite(JSON.parse(readFileSync(new URL("../sites/west-texas.json", import.meta.url), "utf8")));
const pub = createLivePublicSources();
const HOUR = 3_600_000;
const QUARTER = 900_000;
const PECOS = "https://pecos-app.up.railway.app/price";
const GAUGE = "https://gauge.129.121.144.223.sslip.io/hashprice";

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

const now = Date.now();
const start = Math.floor(now / HOUR) * HOUR;
const hours = Array.from({ length: site.planning.hours }, (_, k) => new Date(start + k * HOUR));
const rtStart = new Date(Math.floor(now / QUARTER) * QUARTER - QUARTER);

const tip = await pub.tipHeight();
const hashprice = await pub.hashprice();
const forecast = await pub.forecast(site.location.lat, site.location.lon);
const yesterday = new Date(now - 24 * HOUR).toISOString().slice(0, 10);
const observed = await pub.observedHigh(site.location.lat, site.location.lon, yesterday);
if (!observed) throw new Error("no observation for yesterday");

const fx: Fixture = {
  label: "",
  recordedAt: "",
  note:
    "Recorded from free public sources. Telegraph was not called. `shaped` entries are the answers a Telegraph miner would give, taken " +
    "from the same underlying service (Pecos and Gauge answer on their own public endpoints) or derived from public data (weather). " +
    "They carry no Telegraph receipt.",
  public: {
    tipHeight: tip,
    hashprice: { usdPerPhDay: hashprice.usdPerPhDay, btcUsd: hashprice.btcUsd, hashrateEhS: hashprice.hashrateEhS, source: hashprice.source },
    ercot: [],
    forecast: { hourlyC: Object.fromEntries(Object.entries(forecast.hourlyC).filter(([k]) => hours.some((h) => h.toISOString() === k))), source: forecast.source },
    observed: [{ date: yesterday, highC: observed.highC, source: observed.source }],
  },
  shaped: { power: [], hashprice: [], weather: [] },
};

const wanted: { market: "real-time" | "day-ahead"; at: Date }[] = [
  { market: "real-time", at: rtStart },
  ...hours.map((h) => ({ market: "day-ahead" as const, at: h })),
];
for (const w of wanted) {
  const at = w.at.toISOString();
  const pecosUrl = `${PECOS}?node_or_zone=${site.node}&market=${w.market}&interval_start=${at}`;
  const body = await getJson(pecosUrl);
  fx.shaped.power.push({ market: w.market, minerId: site.intelligence.providers.power, intervalStart: at, answeredAt: String(body.fetched_at), result: body, recordedFrom: pecosUrl });
  const ref = await pub.ercotPrice(site.node, w.market, w.at);
  if (!ref) throw new Error(`public archive has no ${w.market} price for ${at}`);
  fx.public.ercot.push({ market: w.market, node: site.node, intervalStart: at, lmp: ref.lmp, source: ref.source });
}

const gaugeUrl = `${GAUGE}?block_height=${tip}`;
const gauge = await getJson(gaugeUrl);
fx.shaped.hashprice.push({ minerId: "4283", answeredAt: new Date().toISOString(), result: gauge, recordedFrom: gaugeUrl });

const meteoUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${site.location.lat}&longitude=${site.location.lon}&start_date=${yesterday}&end_date=${yesterday}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=UTC`;
const meteo = (await getJson(meteoUrl)).daily as { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_sum: number[] };
fx.shaped.weather.push({
  minerId: "76001", date: yesterday, answeredAt: new Date().toISOString(), recordedFrom: meteoUrl,
  result: { location: site.location.name, date: yesterday, temp_max_c: meteo.temperature_2m_max[0], temp_min_c: meteo.temperature_2m_min[0], precipitation_mm: meteo.precipitation_sum[0] },
});

fx.recordedAt = new Date().toISOString();
fx.label = `DEMO: recorded public data from ${fx.recordedAt.slice(0, 16)}Z, not Telegraph answers`;
writeFileSync(new URL("../fixtures/recorded.json", import.meta.url), JSON.stringify(fx, null, 2) + "\n");
console.log(`wrote fixtures/recorded.json at ${fx.recordedAt}: ${fx.shaped.power.length} power answers, tip ${tip}`);
