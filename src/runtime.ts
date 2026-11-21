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
/** An escrow signer from BALLAST_SIGNER_KEY (a hex key in the environment) or BALLAST_SIGNER_MODULE (a local module). */
export async function loadSigner(env: NodeJS.ProcessEnv): Promise<EscrowSigner | undefined> {
  if (env.BALLAST_SIGNER_KEY) {
    const { privateKeyToAccount } = await import("viem/accounts");
    let key = env.BALLAST_SIGNER_KEY.trim();
    if (!key.startsWith("0x")) key = `0x${key}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new RuntimeError("BALLAST_SIGNER_KEY is not a 32-byte hex key");
    const account = privateKeyToAccount(key as `0x${string}`);
    return { address: account.address, personalSign: (message) => account.signMessage({ message }) };
  }
  if (env.BALLAST_SIGNER_MODULE) {
    const mod = (await import(pathToFileURL(env.BALLAST_SIGNER_MODULE).href)) as { default?: EscrowSigner };
    if (!mod.default?.address || typeof mod.default.personalSign !== "function") {
      throw new RuntimeError("BALLAST_SIGNER_MODULE must default-export { address, personalSign(message) }");
    }
    return mod.default;
  }
  return undefined;
}

/**
 * Picks the payment route per question. GRID_POWER_PRICE goes on the escrow route straight to the named miner,
 * because the Anjoman API treats a named miner as a hint and its ranking sent ERCOT HB_WEST asks to NYISO "WEST"
 * providers (2026-11-20). Everything else goes through the Anjoman API key, whose routing works for it.
 */
// Hashprice joined on 2026-11-21: through the API key, answers attributed to Gauge came back all null while
// Gauge itself answered the same blocks correctly, so the named provider was not the one answering.
export function hybridTransport(
  escrow: Transport,
  anjoman: Transport,
  escrowIntents: Set<string> = new Set(["GRID_POWER_PRICE_GENERAL", "MINING_HASHPRICE_VERIFY_GENERAL"]),
): Transport {
  return { kind: "hybrid", ask: (request) => (escrowIntents.has(request.intent) ? escrow : anjoman).ask(request) };
}

export async function paidDeps(site: SiteConfig, env: NodeJS.ProcessEnv = process.env): Promise<PlanDeps> {
  if (!(site.intelligence.spendCapUsd > 0)) throw new RuntimeError("paid mode needs intelligence.spendCapUsd above zero");
  let transport: Transport;
  let via: string;
  const signer = await loadSigner(env);
  if (env.ANJOMAN_API_KEY && signer) {
    transport = hybridTransport(createEngineTransport(signer), createAnjomanTransport(env.ANJOMAN_API_KEY));
    via = `Telegraph escrow for power prices and hashprice (wallet ${signer.address}) and the Anjoman API key for the rest`;
  } else if (env.ANJOMAN_API_KEY) {
    transport = createAnjomanTransport(env.ANJOMAN_API_KEY);
    via = "Anjoman account balance (API key)";
  } else if (signer) {
    transport = createEngineTransport(signer);
    via = `Telegraph escrow, wallet ${signer.address}`;
  } else {
    throw new RuntimeError("paid mode needs ANJOMAN_API_KEY (Anjoman account) and/or an escrow signer (BALLAST_SIGNER_KEY or BALLAST_SIGNER_MODULE) in the environment");
  }
  return {
    transport,
    pub: createLivePublicSources(),
    now: new Date(),
    mode: "paid",
    label: `LIVE PAID - Telegraph answers bought via ${via}, spend cap $${site.intelligence.spendCapUsd.toFixed(2)}.`,
  };
}
