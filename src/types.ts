import type { CarriedHashprice } from "./reuse.ts";

export type Action ="RUN" | "THROTTLE" | "CURTAIL" | "HOLD";

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
  planning: {
    hours: number;
    startHour?: string;
    /**
     * How the current hour is priced from the 15-minute real-time intervals. ERCOT settles an hour as the mean of its four
     * intervals, so "hour-estimate" uses the intervals already published for the hour and repeats the latest one for the rest
     * (measured on the saved window: day-ahead is a worse stand-in for the unpublished intervals than the latest interval, so
     * it is not used). "latest-interval" prices the whole hour at the latest complete interval (the behaviour before this field).
     */
    hourEstimate: {
      mode: "hour-estimate" | "latest-interval";
      /** Where intervals of this hour other than the latest come from: the free public archive (labelled public), or bought from the power provider. */
      earlierIntervals: "public" | "telegraph";
    };
  };
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
    /**
     * hashprice: how old a freshly delivered provider answer may be. hashpriceCarry: how long a hashprice Ballast already
     * accepted may stand in when a fresh one cannot be had (0 turns carrying off). Default 720 min, see config.ts.
     */
    maxAgeMin: { realTime: number; dayAhead: number; hashprice: number; hashpriceCarry: number; weather: number };
    /** When a provider answers the wrong market or interval: ask once more, then use the public archive for that exact interval. */
    recovery: { reask: boolean; publicArchive: boolean };
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
  /** Set when this item is not a fresh answer: an earlier accepted answer standing in (its original provider, time and receipt are kept). */
  carried?: { acceptedAt: string; ageMin: number; windowMin: number; because: string };
  /** Set when this item exists to recover from the rejected answer `of` (asked again, or read from the public archive). */
  recovery?: { of: string; via: "re-ask" | "public-archive"; note: string };
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
  /** Set when the price is provisional: decide again after this time, when more of the hour is published. */
  revisitAt?: string;
}

export interface Plan {
  mode: Mode;
  label: string;
  site: string;
  generatedAt: string;
  hashpriceUsdPerPhDay: number | null;
  /** Set when the hashprice is an earlier accepted answer standing in for a fresh one. */
  hashpriceCarried?: { acceptedAt: string; ageMin: number; windowMin: number; provider: string; receipt: string; because: string };
  /** The accepted hashprice to keep for the next run (pass it back as `memory.hashprice`); null when none was ever accepted. */
  hashpriceMemory: CarriedHashprice | null;
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
