import type { SiteConfig } from "./types.ts";

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid site config: ${problems.join("; ")}`);
  }
}

export const ERCOT_POINTS = new Set([
  "HB_BUSAVG", "HB_HOUSTON", "HB_HUBAVG", "HB_NORTH", "HB_PAN", "HB_SOUTH", "HB_WEST",
  "LZ_AEN", "LZ_CPS", "LZ_HOUSTON", "LZ_LCRA", "LZ_NORTH", "LZ_RAYBN", "LZ_SOUTH", "LZ_WEST",
]);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Validates a site description and fills defaults. Throws with every problem listed rather than guessing. */
export function parseSite(raw: unknown): SiteConfig {
  const r = obj(raw);
  const problems: string[] = [];
  const num = (value: unknown, name: string, ok: (n: number) => boolean, fallback?: number): number => {
    const v = value === undefined ? fallback : value;
    if (typeof v !== "number" || !Number.isFinite(v) || !ok(v)) {
      problems.push(`${name} is missing or out of range`);
      return 0;
    }
    return v;
  };

  const node = String(r.node ?? "").toUpperCase();
  if (!ERCOT_POINTS.has(node)) problems.push(`node must be an ERCOT hub or load zone (got "${node}")`);

  const loc = obj(r.location);
  const fleet = obj(r.fleet);
  const power = obj(r.power);
  const op = obj(r.operating);
  const planning = obj(r.planning);
  const intel = obj(r.intelligence);
  const prov = obj(intel.providers);
  const tol = obj(intel.tolerances);
  const age = obj(intel.maxAgeMin);

  const mode = power.mode === "fixed" ? "fixed" : power.mode === "realtime" ? "realtime" : (problems.push("power.mode must be realtime or fixed"), "realtime");
  const fixed = power.fixedUsdPerMwh;
  if (mode === "fixed" && typeof fixed !== "number") problems.push("power.fixedUsdPerMwh is required for a fixed contract");

  let heat: SiteConfig["heat"];
  if (r.heat !== undefined) {
    const h = obj(r.heat);
    heat = {
      derateAboveC: num(h.derateAboveC, "heat.derateAboveC", (n) => n > -40 && n < 80),
      efficiencyPenaltyPctPerC: num(h.efficiencyPenaltyPctPerC, "heat.efficiencyPenaltyPctPerC", (n) => n >= 0 && n < 20, 0.8),
      shutdownAboveC: num(h.shutdownAboveC, "heat.shutdownAboveC", (n) => n > -40 && n < 90),
    };
  }

  const strings = (v: unknown, name: string): string[] => {
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string")) {
      problems.push(`${name} must be a non-empty list of miner ids`);
      return [];
    }
    return v as string[];
  };

  const site: SiteConfig = {
    name: String(r.name ?? "unnamed site"),
    node,
    location: {
      name: String(loc.name ?? ""),
      lat: num(loc.lat, "location.lat", (n) => n >= -90 && n <= 90),
      lon: num(loc.lon, "location.lon", (n) => n >= -180 && n <= 180),
    },
    fleet: {
      hashrateTh: num(fleet.hashrateTh, "fleet.hashrateTh (TH/s)", (n) => n > 0),
      efficiencyJPerTh: num(fleet.efficiencyJPerTh, "fleet.efficiencyJPerTh", (n) => n > 0 && n < 200),
    },
    power: {
      mode,
      adderUsdPerMwh: num(power.adderUsdPerMwh, "power.adderUsdPerMwh", (n) => n > -1000 && n < 1000, 0),
      fixedUsdPerMwh: typeof fixed === "number" ? fixed : undefined,
      resellAtLmp: power.resellAtLmp === true,
    },
    operating: {
      otherVariableUsdPerMwh: num(op.otherVariableUsdPerMwh, "operating.otherVariableUsdPerMwh", (n) => n >= 0, 0),
      throttleBandUsdPerMwh: num(op.throttleBandUsdPerMwh, "operating.throttleBandUsdPerMwh", (n) => n >= 0, 8),
      throttleFraction: num(op.throttleFraction, "operating.throttleFraction", (n) => n > 0 && n < 1, 0.5),
      forwardBufferUsdPerMwh: num(op.forwardBufferUsdPerMwh, "operating.forwardBufferUsdPerMwh", (n) => n >= 0, 5),
    },
    heat,
    planning: {
      hours: num(planning.hours, "planning.hours", (n) => Number.isInteger(n) && n >= 1 && n <= 48, 8),
      startHour: typeof planning.startHour === "string" ? planning.startHour : undefined,
    },
    intelligence: {
      spendCapUsd: num(intel.spendCapUsd, "intelligence.spendCapUsd", (n) => n >= 0 && n <= 100),
      providers: {
        power: typeof prov.power === "string" ? prov.power : (problems.push("intelligence.providers.power is required"), ""),
        hashprice: strings(prov.hashprice, "intelligence.providers.hashprice"),
        weather: heat ? strings(prov.weather, "intelligence.providers.weather") : Array.isArray(prov.weather) ? (prov.weather as string[]) : [],
      },
      endpoints: Object.fromEntries(Object.entries(obj(intel.endpoints)).filter(([, v]) => typeof v === "string")) as Record<string, string>,
      tolerances: {
        priceUsd: num(tol.priceUsd, "tolerances.priceUsd", (n) => n >= 0, 2),
        pricePct: num(tol.pricePct, "tolerances.pricePct", (n) => n >= 0, 5),
        hashpricePct: num(tol.hashpricePct, "tolerances.hashpricePct", (n) => n > 0, 5),
        weatherC: num(tol.weatherC, "tolerances.weatherC", (n) => n > 0, 3),
      },
      maxAgeMin: {
        realTime: num(age.realTime, "maxAgeMin.realTime", (n) => n > 0, 45),
        dayAhead: num(age.dayAhead, "maxAgeMin.dayAhead", (n) => n > 0, 24 * 60),
        hashprice: num(age.hashprice, "maxAgeMin.hashprice", (n) => n > 0, 6 * 60),
        weather: num(age.weather, "maxAgeMin.weather", (n) => n > 0, 24 * 60),
      },
      maxBlocksBehind: num(intel.maxBlocksBehind, "intelligence.maxBlocksBehind", (n) => n >= 0, 6),
    },
  };
  if (problems.length) throw new ConfigError(problems);
  return site;
}
