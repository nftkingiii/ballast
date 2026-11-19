import { createHash } from "node:crypto";
import { TransportError, type Answer, type AskRequest, type Transport } from "./telegraph.ts";

/** Keyless public data. Used as a free cross-check and for what Telegraph has no intent for (heat forecast, block tip). Never labelled as a Telegraph answer. */
export interface PublicSources {
  ercotPrice(node: string, market: "real-time" | "day-ahead", start: Date): Promise<{ lmp: number; source: string } | null>;
  tipHeight(): Promise<number>;
  hashprice(): Promise<{ usdPerPhDay: number; btcUsd: number; hashrateEhS: number; tipHeight: number; source: string }>;
  forecast(lat: number, lon: number): Promise<{ hourlyC: Record<string, number>; source: string }>;
  observedHigh(lat: number, lon: number, date: string): Promise<{ highC: number; source: string } | null>;
}

type Fetch = typeof fetch;

const ASSIZE = "https://assize.up.railway.app";
const MEMPOOL = "https://mempool.space";

/** BTC per block, reward + fees averaged over the last 144 blocks, converted to USD per PH/s per day. */
export function hashpriceUsdPerPhDay(avgRewardSatsPerBlock: number, btcUsd: number, hashrateEhS: number): number {
  const btcPerDay = (avgRewardSatsPerBlock / 1e8) * 144;
  return (btcPerDay * btcUsd) / (hashrateEhS * 1000);
}

export function createLivePublicSources(http: Fetch = fetch): PublicSources {
  const json = async <T>(url: string): Promise<T> => {
    const res = await http(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return (await res.json()) as T;
  };
  const tip = async () => Number(await (await http(`${MEMPOOL}/api/blocks/tip/height`, { signal: AbortSignal.timeout(20_000) })).text());
  return {
    async ercotPrice(node, market, start) {
      const url = `${ASSIZE}/ercot/price?node_or_zone=${node}&market=${market}&interval_start=${start.toISOString()}`;
      const res = await http(url, { signal: AbortSignal.timeout(45_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Assize answered ${res.status}`);
      const body = (await res.json()) as { lmp_usd_per_mwh: number; source: string };
      return { lmp: body.lmp_usd_per_mwh, source: body.source };
    },
    tipHeight: tip,
    async hashprice() {
      const [height, stats, prices, rate] = await Promise.all([
        tip(),
        json<{ totalReward: string; startBlock: number; endBlock: number }>(`${MEMPOOL}/api/v1/mining/reward-stats/144`),
        json<{ USD: number }>(`${MEMPOOL}/api/v1/prices`),
        json<{ currentHashrate: number }>(`${MEMPOOL}/api/v1/mining/hashrate/3d`),
      ]);
      const blocks = stats.endBlock - stats.startBlock + 1;
      const hashrateEhS = rate.currentHashrate / 1e18;
      return {
        usdPerPhDay: hashpriceUsdPerPhDay(Number(stats.totalReward) / blocks, prices.USD, hashrateEhS),
        btcUsd: prices.USD,
        hashrateEhS,
        tipHeight: height,
        source: "mempool.space reward-stats(144), prices, hashrate(3d)",
      };
    },
    async forecast(lat, lon) {
      const body = await json<{ hourly: { time: string[]; temperature_2m: number[] } }>(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&past_days=1&forecast_days=3&timezone=UTC`,
      );
      const hourlyC: Record<string, number> = {};
      body.hourly.time.forEach((t, i) => {
        const v = body.hourly.temperature_2m[i];
        if (v !== undefined && v !== null) hourlyC[`${t}:00.000Z`] = v;
      });
      return { hourlyC, source: "Open-Meteo forecast" };
    },
    async observedHigh(lat, lon, date) {
      const body = await json<{ daily?: { temperature_2m_max?: (number | null)[] } }>(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&daily=temperature_2m_max&timezone=UTC`,
      );
      const high = body.daily?.temperature_2m_max?.[0];
      return typeof high === "number" ? { highC: high, source: "Open-Meteo archive" } : null;
    },
  };
}

/** Everything recorded from public sources on one day. Telegraph answers are never invented: the `shaped` entries are labelled as stand-ins. */
export interface Fixture {
  label: string;
  recordedAt: string;
  note: string;
  public: {
    tipHeight: number;
    hashprice: { usdPerPhDay: number; btcUsd: number; hashrateEhS: number; source: string };
    ercot: { market: "real-time" | "day-ahead"; node: string; intervalStart: string; lmp: number; source: string }[];
    forecast: { hourlyC: Record<string, number>; source: string };
    observed: { date: string; highC: number; source: string }[];
  };
  shaped: {
    power: { market: "real-time" | "day-ahead"; minerId: string; intervalStart: string; answeredAt: string; result: Record<string, unknown>; recordedFrom: string }[];
    hashprice: { minerId: string; answeredAt: string; result: Record<string, unknown>; recordedFrom: string }[];
    weather: { minerId: string; date: string; answeredAt: string; result: Record<string, unknown>; recordedFrom: string }[];
  };
}

export function createFixturePublicSources(fx: Fixture): PublicSources {
  return {
    async ercotPrice(node, market, start) {
      const hit = fx.public.ercot.find((r) => r.node === node && r.market === market && r.intervalStart === start.toISOString());
      return hit ? { lmp: hit.lmp, source: `fixture: ${hit.source}` } : null;
    },
    async tipHeight() {
      return fx.public.tipHeight;
    },
    async hashprice() {
      return { ...fx.public.hashprice, tipHeight: fx.public.tipHeight, source: `fixture: ${fx.public.hashprice.source}` };
    },
    async forecast() {
      return { hourlyC: fx.public.forecast.hourlyC, source: `fixture: ${fx.public.forecast.source}` };
    },
    async observedHigh(_lat, _lon, date) {
      const hit = fx.public.observed.find((o) => o.date === date);
      return hit ? { highC: hit.highC, source: `fixture: ${hit.source}` } : null;
    },
  };
}

/** Demo transport: replays recorded answers, costs nothing, and returns `fixture:` receipts that cannot be mistaken for Telegraph's. */
export function createFixtureTransport(fx: Fixture): Transport {
  const receipt = (value: unknown) => `fixture:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12)}`;
  return {
    kind: "fixture",
    async ask(request: AskRequest): Promise<Answer> {
      if (request.intent === "GRID_POWER_PRICE_GENERAL") {
        const market = String(request.native?.payload.market ?? "real-time");
        const start = String(request.params.interval_start);
        const hit = fx.shaped.power.find((p) => p.minerId === request.minerId && p.market === market && p.intervalStart === start);
        if (!hit) throw new TransportError(`no recorded ${market} answer from ${request.minerId} for ${start}`);
        return { minerId: hit.minerId, result: hit.result, costUsd: 0, answeredAt: hit.answeredAt, receipt: { receiptHash: receipt(hit.result) } };
      }
      if (request.intent === "MINING_HASHPRICE_VERIFY_GENERAL") {
        const hit = fx.shaped.hashprice.find((h) => h.minerId === request.minerId);
        if (!hit) throw new TransportError(`no recorded hashprice answer from ${request.minerId}`);
        return { minerId: hit.minerId, result: hit.result, costUsd: 0, answeredAt: hit.answeredAt, receipt: { receiptHash: receipt(hit.result) } };
      }
      if (request.intent === "WEATHER_FORECAST_VERIFY_GENERAL") {
        const hit = fx.shaped.weather.find((w) => w.minerId === request.minerId && w.date === request.params.date);
        if (!hit) throw new TransportError(`no recorded weather answer from ${request.minerId} for ${String(request.params.date)}`);
        return { minerId: hit.minerId, result: hit.result, costUsd: 0, answeredAt: hit.answeredAt, receipt: { receiptHash: receipt(hit.result) } };
      }
      throw new TransportError(`no fixture for ${request.intent}`);
    },
  };
}
