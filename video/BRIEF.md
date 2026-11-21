# Ballast demo film: brief

## Goal
- Kind: judge demo, about 90-120 s, 16:9 (plus a 9:16 social cut of the first 30 s).
- Audience: Telegraph/Anjoman organisers and builders (Season II, Minds & Agents forum, X).
- The one thing to understand: a Mind can make an hourly hash-or-curtail call for a mining site with real, paid, receipted Telegraph intelligence, and it says HOLD instead of guessing when an input is missing or conflicting.
- Where: Discord Minds forum + Gold Rush/thread links, X (tag @telegraphprotoc @ysiu @marcmcg), GitHub README. 30 fps.
- Hard limits: none stated by the organisers for length; keep under 2:00.

## Truth sheet (the film may only show what is here)
| Claim / number / screen | Evidence | Status |
|---|---|---|
| Mind ↔ Ballast via a custom HTTP skill + private credential | user's Telegram conversation (screen recording), Ballast/minds/SKILL-HTTP.md | live (Minds) |
| Full live run, plan 708b2b3a8b, generated 05:11 UTC (window 05:00-12:00 UTC): 8/8 hours RUN at 100%, revenue $52.30/MWh, margins $47.19 (05:00, provisional) then $43.16, $41.83, $41.50, $36.93, $33.01, $26.81, $26.34/MWh (12:00) | Mind reply, refs/telegram-ask.mp4, scroll at 0:02:04-0:03:34 of the recording (bubble stamped 21:14 local) | live, paid, testnet (Sepolia test USDC) |
| Question "Should we hash or curtail tonight?" typed and sent, then about 3 min of waiting (trimmed in the film; bubble stamps 21:11 to 21:14) | refs/telegram-ask.mp4 0:02-0:13, wait 0:13-3:22 | live |
| 10 Telegraph calls, $0.11 (cap $0.40, no breach), missing checks: none | same reply | live, paid, testnet |
| Gauge 4283 hashprice $26.36/PH/day = 46,755.12 sats/PH-day at block 976849, receipt 0x5fe34d4a..., $0.01; public mempool.space $26.54/PH/day (BTC $56,377, 965 EH/s) | same reply | live, paid |
| Pecos 7310042 05:00 real-time $2.11/MWh, receipt 0x96acdb78..., matches public ERCOT MIS NP6-905-CD; 05:00 is PROVISIONAL (no 15-min interval of the hour published yet) | same reply | live, paid |
| Day-ahead 06:00-12:00 from Pecos 7310042, 7 receipts at $0.01 each (0x93d575a3..., 0x71c46ea9..., 0xa204ea35..., 0xc2ea0c39..., 0x6fab076f..., 0x89f34993..., 0xbf450484...), each matched ERCOT MIS NP4-190-CD to the cent | same reply | live, paid |
| Weather verify, Telegraph 76001, $0.02, accepted max 21.5 C (public Open-Meteo archive max 22.8 C) | same reply | live, paid |
| Earlier HOLD runs: Gauge null via Anjoman route; forecast fetch failed; ERCOT ask routed to NYISO "WEST" | Mind replies 06a48c8e23 / 055fe017b0, Anjoman job text, research/report-anjoman-routing.md | live |
| Hashprice mismatch traced to hashrate basis (965.1 vs 1,026.4 EH/s; 7.6% → 1.3%) | Ballast commit b916857 | live |
| With vs without Telegraph, 89 real ERCOT hours: clean 82/89 both; injected bad inputs: Ballast caught 20/20, lost $210 vs $2,199 web-only | compare/results.md (c82beb1) | offline replay; injections synthetic; Telegraph answers mostly stand-ins except 2 recorded |
| Monitor mode explains changes ("18:00 RUN → CURTAIL …") | `npm run monitor` output | demo timeline, SYNTHETIC after tick 1 (must be labelled) |
| Recommendations only; no miner switched | Mind replies | true |
- Must be labelled: testnet/test USDC; monitor demo = SYNTHETIC timeline; comparison injections = synthetic; Pecos is our own miner (internal test, not outside usage).

## Inputs
- Product: https://ballast-app.up.railway.app (key-protected HTTP tool), repo https://github.com/nftkingiii/ballast, CLI output (`npm run plan`, `monitor`, `compare`).
- Captures needed FROM THE USER (I can't capture Telegram or Minds):
  1. Telegram screen recording: asking the Mind "Should we hash or curtail tonight?" through to its full reply (desktop Telegram, 1080p, no other chats visible).
  2. Screenshots of the two earlier HOLD replies (06a48c8e23, 055fe017b0) if still in the chat.
  3. Minds skill/credential screen with the credential value hidden (optional).
  4. Anjoman dashboard jobs/spend page (optional, no keys visible).
- Captures I make: CLI runs (real output, rendered as terminal frames), repo page, openapi.json, results.md tables, ERCOT/receipt lookups.
- Look: derived from the domain: grid/night-shift operations (deep slate, signal amber for RUN, cyan for data, red for CURTAIL/HOLD); one display face (e.g. Space Grotesk) + one mono (JetBrains Mono). No warm neutrals, no serif.
- Music: synthesized (sfx.mjs cues); no voice unless you want captions-only narration (default: on-screen captions).

## Beat sheet: to be written in docs/shotlist.md after this brief is agreed.

## Gates
1. Brief + truth sheet agreed
2. Shot list on the beat grid agreed
3. Stills and contact sheet reviewed (scores logged in docs/review_log.md)
4. Hardest 2-4 s checked with a strip; `--verify` deterministic
5. Full render, mix, check.mjs (contact, phone, loudness), watched with sound
6. Deliverables: out/final.mp4 (+ 9:16 cut), poster.png, contact.jpg, credits line
