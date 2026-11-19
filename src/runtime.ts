import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createFixturePublicSources, createFixtureTransport, createLivePublicSources, type Fixture } from "./sources.ts";
import { createAnjomanTransport, createEngineTransport, type EscrowSigner, type Transport } from "./telegraph.ts";
import type { PlanDeps } from "./plan.ts";
import type { SiteConfig } from "./types.ts";

export const DEFAULT_FIXTURE = new URL("../fixtures/recorded.json", import.meta.url);

export class RuntimeError extends Error {}

export function loadFixture(path: URL | string = DEFAULT_FIXTURE): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

export function demoDeps(fx: Fixture = loadFixture()): PlanDeps {
  return {
    transport: createFixtureTransport(fx),
    pub: createFixturePublicSources(fx),
    now: new Date(fx.recordedAt),
    mode: "demo",
    label: `DEMO MODE - ${fx.label}. No Telegraph calls were made and nothing was paid; receipts below start with "fixture:".`,
  };
}

/**
 * Paid mode needs all of: the explicit flag, a spend cap above zero on the site, and credentials in the environment.
 * Credentials are read from the environment only and never printed.
 */
export async function paidDeps(site: SiteConfig, env: NodeJS.ProcessEnv = process.env): Promise<PlanDeps> {
  if (!(site.intelligence.spendCapUsd > 0)) throw new RuntimeError("paid mode needs intelligence.spendCapUsd above zero");
  let transport: Transport;
  let via: string;
  if (env.ANJOMAN_API_KEY) {
    transport = createAnjomanTransport(env.ANJOMAN_API_KEY);
    via = "Anjoman account balance (API key)";
  } else if (env.BALLAST_SIGNER_MODULE) {
    const mod = (await import(pathToFileURL(env.BALLAST_SIGNER_MODULE).href)) as { default?: EscrowSigner };
    if (!mod.default?.address || typeof mod.default.personalSign !== "function") {
      throw new RuntimeError("BALLAST_SIGNER_MODULE must default-export { address, personalSign(message) }");
    }
    transport = createEngineTransport(mod.default);
    via = `Telegraph escrow, wallet ${mod.default.address}`;
  } else {
    throw new RuntimeError("paid mode needs ANJOMAN_API_KEY (Anjoman account) or BALLAST_SIGNER_MODULE (escrow wallet signer) in the environment");
  }
  return {
    transport,
    pub: createLivePublicSources(),
    now: new Date(),
    mode: "paid",
    label: `LIVE PAID - Telegraph answers bought via ${via}, spend cap $${site.intelligence.spendCapUsd.toFixed(2)}.`,
  };
}
