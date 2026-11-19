# Ballast research (Phase 1, read-only)

Date: 2026-11-19. Everything below was read from public pages, public GitHub, free GET endpoints and one unpaid POST that returned the 402 payment challenge (nothing signed, nothing paid, no account created). Where a page was client-rendered or gated, that is said. Treat prices and limits as current only as of today.

## 1. Bounty #200 (Mission 12, Mining & Power, Season II)

Source: github.com/telegraphprotocol/bounties/issues/200 (read through a summarising fetch, not verbatim; re-read before submitting).

- Route we take: hourly mining/compute allocation using hashprice and grid power price evidence. Track: Apps & Agents ($3,000 of the $7,000 Season II main pool; nothing guaranteed).
- First milestone: one realistic input, a paid Telegraph request, a checked result with source and uncertainty, a useful action, a receipt with total cost, and one failure case.
- Tests asked for: negative-price hour, stale power price, telemetry outage, budget-cap breach. Ballast has all four as scenarios (`--scenario negative-price | stale-price | weather-outage | spend-cap`), plus provider disagreement and missing hashprice.
- Metrics: estimated margin per MWh, cost per decision, SLA verification reliability, forecast timestamp precision.
- Use exact live `intent_name` and `request.params`, verified on the node. (Done below.)
- Apps score: technical quality and mainnet readiness 35 (min 24), commercial viability 25, independent adoption 10, integration and usage 5, reproducibility 5, growth 20. Growth needs at least three original progress updates on separate dates and starring the bounties repo.
- Process: `/claim`, then `/progress` at least every 72 hours, `/submit` with links and evidence, plus the official Anjoman submission form (GitHub comments are not the entry). Nov 20 progress showcase; deadline Dec 1 2026 23:59 UTC. The H2 form was not open as of Nov 15.
- Evidence wanted: live demo or endpoint, public-safe repo, run instructions, real request ids and receipts, one failure test, honest costs, limitations.

## 2. Minds by Animoca Brands (hellominds.ai)

What I could and could not read:

- `hellominds.ai` pages are a client-rendered app; `/docs/overview` returned only its title. `llms.txt`, `llms-full.txt`, `/.well-known/agents.json` and `build.hellominds.ai` (Builder Hub, server-rendered) were readable and are the sources here. The Builder Hub `/docs` index lists: account-setup, CLI, client library, Connect SDK, building-skills, circles. The Bazaar, the Builder console and the API reference were not read (login or client-rendered). I did not sign up.
- A Mind is a persistent personal agent reached by email, Telegram, iMessage or WeChat. Extension unit: **Tools** (one operation, typically one API call), **Skills** (learned playbooks), **Apps** (bundles of Tools under one identity). Items are published to the Bazaar (Marketplace) with a Verified or Wild trust label; builders are rewarded when items are used.
- How a Skill is built (Builder Hub guide "building skills"): you describe it to your Mind in chat; the Mind builds four parts for you: Registry Offering, **App Manifest** (how it connects to the app), **Tool Schemas** (allowed actions) and Skill Playbook. API keys for the connected app go in Profile > My Connections > Save Key; the platform stores the key, not the Mind. Publishing is "publish this Skill to the Bazaar" in chat.
- **MCP:** no page I could read mentions MCP for Minds. Do not assume Minds can attach an MCP server. This is the largest open question; confirm in the Builder console or with the Minds team before building anything Minds-specific around MCP.
- What a builder needs: a Minds account and at least one Mind; for the CLI a Builder API key (Builder console, name + expiry, shown once, `MINDS_BUILDER_API_KEY`, sent as `X-Api-Key`; the "Unlock Builder Access" button suggests a gate that is not explained). CLI: `npm install -g @animocabrands/minds-cli` (Node 22+), `minds bazaar skills list`, `minds mind skills equip --mind <id> --id <skillId>`. The CLI page documents equipping, not creating or publishing.
- Cost: free to launch a Mind, no card or wallet. Cognition credits power reasoning and tool calls: homepage says +200 on each of your first 3 Minds and a +200 daily top-up; paid plans $10 / 1,000, $25 / 2,500, $50 / 5,000 credits (also as one-time top-ups). Per-tool-call credit cost was not published on the pages I read.
- Sharing so others can reproduce: publish the Skill/App to the Bazaar; others equip it by pasting an activation message to their Mind or with the CLI. For code reproducibility (bounty "reproducibility" points) a public repo with the README is still needed.
- Builder program: Minds Investment Programme (up to US$10M, applications at build.hellominds.ai), not required for this bounty.

## 3. Anjoman / Telegraph integration

Sources: anjoman.ai/docs and its `/docs/using/*` pages (engine-ask, x402-inference, escrow-inference, api-keys), the telegraph-mcp repo (README, `skills/anjoman/SKILL.md`, `scripts/anjoman.mjs`, read on GitHub, not run), the live node, and bounty issue #214. `anjoman.ai/dashboard/integrations` is a signed-in page and was not read.

### Three ways to call Telegraph

| Path | Auth and payment | Request shape | Receipt |
| --- | --- | --- | --- |
| **Engine ask, escrow** (`POST devnode.telegraphprotocol.com/engine/v1/ask` or `/ask/{minerId}`) | Wallet. Deposit USDC once into the Diamond escrow (Ethereum Sepolia), then for each call sign the 402 challenge's message with EIP-191 `personal_sign` and resend with `X-PAYMENT`. | Exact: `intent` + `params`, or the miner's native `method`/`endpoint`/`payload`. Pick the miner by id in the path, or let ranking choose on `/ask`. | `X-PAYMENT-RESPONSE`: `receipt_hash`, `rail: escrow`, `payer`, `miner`, `intent`, `amount_uusdc`, `epoch_id`. Body: `signal_hash`, `cost_usd`, `fulfillment.payments[].receipt_hash`. Receipt lookup `GET /engine/v1/signal/{hash}`. |
| **Engine ask, x402 `exact`** | Wallet, per-call EIP-3009 style signature (`PAYMENT-SIGNATURE`), settled by `facilitator.x402.rs`. | Same. | `X-TELEGRAPH-RECEIPT` incl. `tx_hash`. **Broken since 2026-11-17/18: every paid ask returns 402 "settlement failed ... context deadline exceeded" (bounty #214, both Sepolia and Base Sepolia).** |
| **Anjoman API key** (`POST backend.telegraphprotocol.com/agent/chat`) | `Authorization: Bearer anjoman_...`. Pays from the account's escrow balance (deposit on the website; the key holds no money). `maxSpendUsd` caps one message (up to 100). 30 requests/min/key. | **Plain language only** (`message`, max 2000 chars). Keys cannot call `/engine/ask` (403). The agent plans, picks ranked miners and recovers from failures. | Reply has `jobId`, `conversationId`, `status`, `sources[]` (each with `receiptHash` per the CLI script), `costUsd` (null if no price reported). `GET /agent/jobs/{id}`, `GET /agent/spend`, `GET /engine/escrow/balance`. 202 + `jobId` after ~80 s. |

- #214 workaround confirmed by a builder on 18 Nov: fund the escrow with `depositUSDC(2000000)` (2 test USDC) on the Sepolia Diamond, sign the challenge template, send in `X-PAYMENT`; paid asks returned 200 with `rail: escrow` receipts. The deposit took about 10 minutes to show in the engine balance. I did not test this myself (no wallet, no payment allowed here). The other builder who "used the Anjoman paid API" (job ids like 460d3ff2) used the API-key path.
- Escrow challenge (recorded from a real unpaid request, saved as `fixtures/x402-challenge-pecos.b64`): `accepts` has three `exact` options (Sepolia, Base Sepolia, Solana devnet) and one `escrow` option on `eip155:11155111` with `extra.message`, the template to sign: "Telegraph Escrow Payment / Wallet: {from} / Pay To: ... / Network / Amount: 10000 uUSDC / Resource: /v1/ask/7310042 / Nonce / Valid After / Valid Before". Price $0.01 per call for Pecos. The window must be 2 minutes or less; nonce unique per attempt; `value` must match the quote.
- Budgeted asks: `max_budget_usdc` (μUSDC integer, 10,000 to 260,000 on testnet) enables multi-miner recovery; only used answers are billed. Without it you pay for the one miner called.
- Provider choice: `/engine/v1/ask/{minerId}` names the provider; `/ask` lets Telegraph route by the miner's leaderboard score for the intent (`reasoning` and `fulfillment.provenance` say who and why). The MCP server's `telegraph_ask` routes to the top miner, `telegraph_ask_miner` names one. Ballast names its providers in the site config so each answer has a known source.
- The telegraph-mcp server (`npx -y @telegraphprotocol/telegraph-protocol-mcp`) creates `~/.telegraph/wallet.json`, funds escrow, exposes `telegraph_ask`, `telegraph_ask_miner`, `telegraph_find_intents`, `telegraph_intent`, `telegraph_find_miners`, `telegraph_ranking`, `telegraph_account`, `telegraph_docs`, with `TELEGRAPH_MAX_ASK_USD` (default 0.5) and `TELEGRAPH_DAILY_LIMIT_USD` (default 5). In API-key mode it offers only `telegraph_ask`, `telegraph_account` and the free tools. There is also an `anjoman` skill (`npx skills add telegraphprotocol/telegraph-mcp --skill anjoman`, `ANJOMAN_API_KEY`) that wraps `/agent/chat`.

### The three intents (live node, free GETs)

`GRID_POWER_PRICE_GENERAL` (38 miners, deterministic, scored with a comparator at 30 bps)
- request.params: `node_or_zone` (string, required), `interval_start` (datetime, required).
- response: `lmp_usd_per_mwh` (number, USD/MWh, range -2000..20000, 6 decimals), plus off-chain `node_or_zone`, `market` (day-ahead or real-time), `interval_start`, `currency`.
- **Gap that matters:** `market` is an answer field, not a request param. Through the generic intent request you cannot demand day-ahead versus real-time. Pecos's own `/price` endpoint takes `market`, so Ballast uses the **native direct ask** (`POST /engine/v1/ask/7310042` with `{"method":"GET","endpoint":"/price","payload":{node_or_zone, market, interval_start}}`) and refuses any answer whose `market` or `interval_start` is not what it asked for. Whether the node's request builder forwards `market` on the canonical form was not testable without paying.
- Miners: Pecos (7310042, ours) is the only miner listed for ERCOT; the others are CAISO, UK, DE, FR, FI. So a second Telegraph opinion on an ERCOT price does not exist today; Ballast cross-checks against the free public ERCOT archive via Assize instead, and labels it as public, not Telegraph.

`MINING_HASHPRICE_VERIFY_GENERAL` (30 miners, deterministic, comparator tolerance 400 bps)
- request.params: `block_height` (integer, 0..100,000,000). Not a time and not a "now": Ballast takes the tip height from mempool.space.
- response: `hashprice_sats_per_ph_day` (number, sats per PH/s per day, scored), off-chain `block_height`, `hashrate_eh_s`, `hashprice_usd_per_ph_day` (may be null; Gauge returned null).
- Miners include Gauge (4283, two sources must agree within 0.1%; endpoint `/hashprice`), Blockchair (67008), WhatToMine-based (190089). Gauge's listing flags "block_height cannot be sent as integer" for the generic request builder, so Ballast sends Gauge's native `/hashprice` call.
- Sanity check on 2026-11-19: Gauge 46,739 sats/PH/day at tip 976,618; at BTC $63,253 that is $29.57; Ballast's own mempool-derived reference was $29.39 (hashrate source differs by about 5%). Tolerance default 5%.

`WEATHER_FORECAST_VERIFY_GENERAL` (26 miners, judgment class, evaluated by an adapter)
- request.params: `location` (string), `date` (a **past** date).
- response: `temp_max_c`, `temp_min_c`, `precipitation_mm`, `condition`, plus `location`, `date`.
- It answers "what actually happened on that date", so it cannot tell you tomorrow's heat. Ballast uses it to prove the weather data is trustworthy (yesterday's recorded high must match the free Open-Meteo archive within 3 C), and takes forward hourly temperatures from the free Open-Meteo forecast, labelled public. `WEATHER_FORECAST_GENERAL` (window max/min, 26 miners) is the Telegraph intent for the future temperature if you want that paid too.

### Truth sources and our own miner

- Pecos (miner 7310042, https://pecos-app.up.railway.app): `/price?node_or_zone&market&interval_start`, ERCOT Public API, errors explicit (`404 interval_not_published`), returns `fetched_at`.
- Assize (`https://assize.up.railway.app/ercot/price`): same quantity from the ERCOT public MIS archive (NP4-190-CD day-ahead, NP6-905-CD real-time), keyless. Two different paths to the same ERCOT data, so agreement is a real check against a parsing or substitution error, not against ERCOT itself. Recorded 2026-11-19 prices for HB_WEST agreed to the cent.
- No negative or spike hour exists in the days I could scan (HB_WEST DA/RT from Nov 15 to Nov 19 stayed between about $1 and $92/MWh), so the negative-price and stale cases are synthetic scenarios and are labelled that way.

## 4. Recommendation

Core (Ballast library) stays transport-agnostic. For each surface:

1. **Telegraph side, paid runs: engine ask with the escrow scheme and a named miner** (`createEngineTransport`). It is the only path that gives exact `intent` + `params`, a named provider, `receipt_hash` and `signal_hash` per answer, and it works while x402 `exact` is down. Needs a funded wallet and a signer module (Ballast never holds a key). Fallback: **Anjoman API key** (`createAnjomanTransport`), which needs no wallet and matches what other builders did, but is natural language, cannot be forced onto a miner, and costs more per answer (the account holds back about $0.26 per specialist while it works and returns the unused part). Ballast parses one JSON object from the reply and fails closed otherwise. Skill vs MCP: the Anjoman Skill and telegraph-mcp are for agents that want to ask Telegraph directly; Ballast is the app that decides, so it calls the API itself instead of going through either.
2. **Minds side: an HTTP tool (REST + OpenAPI) behind a Minds App, with the Mind building the manifest and tool schemas from `GET /openapi.json`.** Minds' documented extension path is App Manifest + Tool Schemas + an API key stored in My Connections, which is an HTTP-tool shape; MCP support is undocumented. Ballast also ships a stdio MCP server (same two tools) for Claude and other MCP hosts, and a ready-to-paste Skill playbook in `minds/SKILL-PROMPT.md`. Ballast's HTTP server needs to be hosted at a public URL for a Mind to reach it (a deploy the user has not authorised yet).
3. **Evidence rule:** every answer carries provider, time, cost and receipt/job id; `fixture:` receipts mark demo data and can never look like Telegraph ones.

## 5. What this research could not settle (needs the user or a paid call)

- Whether Minds can call an arbitrary public HTTP API as a Tool (and the exact App Manifest fields), and the per-call Cognition cost. Needs a Minds account and Builder access.
- Whether the engine's request builder forwards `market` on a canonical `GRID_POWER_PRICE_GENERAL` ask (the native form avoids the question).
- The exact JSON a successful `/agent/chat` reply puts the answer in (`answer` per the CLI script); Ballast reads `answer` or `reply`. First paid smoke call confirms it.
- Whether Gauge and the weather miner answer the native endpoint form through the node (compat notes in the miner list suggest yes for Gauge `/hashprice`; the weather miner's endpoint is `/query` and its params are unmapped, so the weather call may need the canonical form or a different miner).
