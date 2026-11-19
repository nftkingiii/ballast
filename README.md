# Ballast

Hourly hash-or-curtail decisions for a Bitcoin mining site in ERCOT. For each hour Ballast compares what the fleet earns (hashprice) with what the power costs and answers RUN, THROTTLE, CURTAIL or HOLD, with every input's provider, time and receipt, the total intelligence cost, and the checks that are missing. Built for Telegraph Hackathon Season II, Mission 12 (Mining & Power), and shaped to run as a tool for a Mind on Minds by Animoca Brands.

Status: the core, the demo mode and both tool surfaces are built and tested. **Paid mode has not been run against Telegraph yet** (no account, key or funds); see RESEARCH.md for what that needs.

## Run the demo (no account, no cost)

```powershell
npm install
npm test
npm run plan                                  # recorded public data, labelled DEMO
npm run plan -- --scenario negative-price     # SYNTHETIC failure cases on the recorded day
npm run plan -- --explain 2026-11-19T23       # one hour: arithmetic, reasons, evidence
```

Scenarios: `negative-price`, `stale-price`, `disagreement`, `missing-hashprice`, `weather-outage`, `heat`, `spend-cap`. They edit the recorded day and say so in the first line of the output. The recorded day itself had no negative price or spike.

Demo mode replays `fixtures/recorded.json`: Pecos's and Gauge's own public endpoints, the public ERCOT archive, mempool.space and Open-Meteo, recorded 2026-11-19. They are **not Telegraph answers**: the providers are labelled "recorded stand-in", receipts start with `fixture:`, and cost is $0. The table also shows what the same plan would cost in paid mode.

## How a decision is made

For hour h, with fleet `H` TH/s at `e` J/TH: draw `MW = H * e / 1e6` (heat above the site limit worsens `e`), revenue per MWh `= hashprice($/PH/day) * H/1000 / 24 / MW`, power cost per MWh from the site's contract:

- `realtime`: settlement price + adder (+ a forward buffer when the hour is priced from day-ahead).
- `fixed`: the contract price, or, with `resellAtLmp`, the settlement price (running forgoes the resale).

`margin = revenue - cost - other variable cost`. At or above the throttle band: RUN. Between zero and the band: THROTTLE (a fraction of the fleet). Negative: CURTAIL. A negative price makes cost negative, so running earns. At or above the shutdown temperature: CURTAIL.

HOLD, with the gap named, when a required input is missing, stale, for the wrong market or interval, or when two sources disagree beyond tolerance. The current hour uses the latest complete 15-minute real-time interval (day-ahead only as a labelled fallback); later hours use day-ahead. The spend cap stops all further buying; unpriced hours are HOLD. If hashprice is missing no prices are bought at all.

## Evidence

| Check | Telegraph intent (miner) | Free public cross-check |
| --- | --- | --- |
| Power price, day-ahead and real-time | `GRID_POWER_PRICE_GENERAL` (Pecos 7310042, native `/price` call because `market` is not an intent param) | ERCOT public archive via Assize |
| Hashprice | `MINING_HASHPRICE_VERIFY_GENERAL` (Gauge 4283) | mempool.space reward stats, price, hashrate |
| Weather trust | `WEATHER_FORECAST_VERIFY_GENERAL` (76001), yesterday's high | Open-Meteo archive; hourly forecast from Open-Meteo (public, not Telegraph) |

Providers and tolerances are in the site config (`sites/west-texas.json`). Public sources are cross-checks and are never counted as Telegraph answers.

## Paid mode (needs the user, off by default)

Requires all of `--paid`, `--cap <usd>`, and credentials in the environment. Nothing is read from or written to files, and no key is ever printed.

```powershell
# Option A: Anjoman account balance (API key from anjoman.ai/dashboard/api-keys, account funded on the site)
$env:ANJOMAN_API_KEY = "<set it in your own terminal>"
npm run plan -- --paid --cap 0.30

# Option B: Telegraph escrow with a wallet you control (works while x402 settlement is down, bounty #214)
$env:BALLAST_SIGNER_MODULE = "C:\path\to\signer.mjs"   # default-exports { address, personalSign(message) }
npm run plan -- --paid --cap 0.30
```

A plan of 8 hours costs about $0.10 to $0.12 at $0.01 per answer. First paid run should be tiny: `--cap 0.05` and a 1-hour site, then read the receipts.

## Tools for a Mind (and other agents)

Two tools, `plan_site(site?)` and `explain_decision(planId, hour)`.

```powershell
npm run serve        # HTTP on :8787  GET /openapi.json, POST /plan_site, POST /explain_decision
npm run mcp          # MCP over stdio, same two tools
```

- Set `BALLAST_TOOL_TOKEN` to require it as the `x-api-key` header. Paid mode is a server setting (`BALLAST_PAID=1`, ceiling `BALLAST_MAX_CAP_USD`, default 0.5); a request cannot switch it on.
- For Minds: host the HTTP server at a public URL, then ask your Mind to build an App from `<url>/openapi.json`, save the token under My Connections, and paste `minds/SKILL-PROMPT.md` as the Skill playbook. Whether Minds accepts an arbitrary HTTP tool this way is unconfirmed (RESEARCH.md section 2).
- For Claude Code: `claude mcp add ballast -- npx tsx C:\path\to\Ballast\src\mcp.ts`.

## Layout

`src/decide.ts` the margin and action logic (pure). `src/evidence.ts` buys and checks each input. `src/plan.ts` orchestrates and totals. `src/telegraph.ts` the escrow and Anjoman transports and the budget. `src/sources.ts` public sources and the fixture replay. `src/scenarios.ts` the staged failures. `scripts/record-fixtures.ts` re-records the day from free public sources (`node --experimental-transform-types scripts/record-fixtures.ts`).

Node 22, `tsx`, no other runtime dependency. Tests inject `fetch` and replay recorded data; the 402 challenge in `fixtures/` is a real unpaid response from the node.

## Limits

One site, ERCOT only. Power cost model is marginal (no demand charges, ramp costs, or take-or-pay). Hashprice is a single network-wide number held for all hours. Heat uses a linear efficiency penalty. Day-ahead price is the forward estimate for future hours. Not financial advice.
