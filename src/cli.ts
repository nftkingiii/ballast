import { readFileSync } from "node:fs";
import { parseSite } from "./config.ts";
import { planSite } from "./plan.ts";
import { explainDecision, renderPlan } from "./render.ts";
import { demoDeps, loadFixture, paidDeps } from "./runtime.ts";
import { SCENARIOS } from "./scenarios.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const USAGE = `ballast plan [--site sites/west-texas.json] [--json] [--explain <hour>] [--scenario <name>] [--paid --cap <usd>]

Default is DEMO mode: recorded public data, no Telegraph calls, no cost.
--scenario stages a failure case on the recorded data (SYNTHETIC): ${Object.keys(SCENARIOS).join(', ')}.
--paid buys real Telegraph answers; it needs --cap (USD) and credentials in the environment
(ANJOMAN_API_KEY, or BALLAST_SIGNER_MODULE for an escrow wallet).`;

if (args[0] !== "plan") {
  console.log(USAGE);
  process.exit(args[0] === undefined || args[0] === "help" ? 0 : 1);
}

try {
  const raw = JSON.parse(readFileSync(value("site") ?? "sites/west-texas.json", "utf8")) as Record<string, any>;
  if (flag("paid")) {
    const cap = Number(value("cap"));
    if (!Number.isFinite(cap) || cap <= 0) throw new Error("--paid requires --cap <usd> above zero");
    raw.intelligence = { ...raw.intelligence, spendCapUsd: cap };
  }
  let site = parseSite(raw);
  let deps = flag("paid") ? await paidDeps(site) : demoDeps();
  const name = value("scenario");
  if (name) {
    const scenario = SCENARIOS[name];
    if (!scenario || flag("paid")) throw new Error(scenario ? "--scenario cannot be combined with --paid" : `unknown scenario "${name}"; choose from ${Object.keys(SCENARIOS).join(", ")}`);
    const staged = scenario.apply(loadFixture(), site);
    site = staged.site;
    deps = demoDeps(staged.fx);
    deps.label = `SYNTHETIC SCENARIO "${scenario.title}" - ${scenario.what} Edited recorded data, not live: ${deps.label}`;
  }
  const plan = await planSite(site, deps);
  const hour = value("explain");
  if (flag("json")) console.log(JSON.stringify(plan, null, 2));
  else console.log(hour ? explainDecision(plan, hour) : renderPlan(plan));
} catch (error) {
  console.error(`ballast: ${(error as Error).message}`);
  process.exit(1);
}
