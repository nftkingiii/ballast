export type Action = "RUN" | "THROTTLE" | "CURTAIL" | "HOLD";

export interface SiteConfig {
  name: string;
  /** ERCOT settlement point, e.g. HB_WEST or LZ_WEST. */
  node: string;
  location: { name: string; lat: number; lon: number };
  fleet: { hashrateTh: number; efficiencyJPerTh: number };
  power: {
    /** realtime: you pay the settlement point price. fixed: you pay a contract price. */
    mode: "realtime" | "fixed";
    adderUsdPerMwh: number;
    fixedUsdPerMwh?: number;
    /** Fixed contract only: unused energy can be sold back at the settlement price, so that price is the real cost of running. */
    resellAtLmp?: boolean;
  };
  operating: {
    otherVariableUsdPerMwh: number;
    /** Margin below this (but above zero) throttles instead of running flat out. */
    throttleBandUsdPerMwh: number;
    throttleFraction: number;
    /** Added to day-ahead prices for hours whose real-time price is not known yet (realtime exposure only). */
    forwardBufferUsdPerMwh: number;
  };
  /** Optional heat limits. When present, a weather check is required. */
  heat?: { derateAboveC: number; efficiencyPenaltyPctPerC: number; shutdownAboveC: number };
  planning: { hours: number; startHour?: string };
  intelligence: {
    spendCapUsd: number;
    providers: { power: string; hashprice: string[]; weather: string[] };
    /** Miners whose HTTP endpoint is called natively (POST /engine/v1/ask/{id} with method+endpoint+payload) because the generic intent request cannot reach them. */
    endpoints: Record<string, string>;
    tolerances: {
      priceUsd: number;
      pricePct: number;
      hashpricePct: number;
      weatherC: number;
    };
    maxAgeMin: { realTime: number; dayAhead: number; hashprice: number; weather: number };
    maxBlocksBehind: number;
  };
}

export type Mode = "demo" | "paid";

export interface Source {
  kind: "telegraph" | "public" | "fixture";
  id: string;
  name: string;
}

export interface Receipt {
  receiptHash?: string;
  signalHash?: string;
  jobId?: string;
  rail?: string;
}

export type Check = "power-day-ahead" | "power-real-time" | "hashprice" | "weather-verify" | "weather-forecast";

export interface Evidence {
  id: string;
  check: Check;
  /** What this answer is about: an hour, a block height, a date. */
  subject: string;
  source: Source;
  requestedAt: string;
  answeredAt: string;
  costUsd: number;
  receipt: Receipt;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  accepted: boolean;
  reason?: string;
}

export interface Gap {
  check: Check | "budget";
  subject: string;
  reason: string;
}

export interface HourDecision {
  hour: string;
  action: Action;
  runFraction: number;
  basis: "real-time" | "day-ahead" | "none";
  powerPriceUsdPerMwh: number | null;
  powerCostUsdPerMwh: number | null;
  revenueUsdPerMwh: number | null;
  marginUsdPerMwh: number | null;
  tempC: number | null;
  fleetMw: number | null;
  expectedProfitUsd: number | null;
  reasons: string[];
  evidence: string[];
  gaps: Gap[];
}

export interface Plan {
  mode: Mode;
  label: string;
  site: string;
  generatedAt: string;
  hashpriceUsdPerPhDay: number | null;
  decisions: HourDecision[];
  evidence: Evidence[];
  intelligenceCostUsd: number;
  /** Telegraph calls made (or replayed in demo mode). */
  telegraphCalls: number;
  /** What the same plan would cost in paid mode at the quoted per-call price. Equals intelligenceCostUsd in paid mode. */
  projectedPaidCostUsd: number;
  spendCapUsd: number;
  budgetBreached: boolean;
  missingChecks: Gap[];
}
