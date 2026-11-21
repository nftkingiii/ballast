# Ballast judge demo: shot list (about 2:00, 16:9, 30 fps)

Tempo: synthesized pulse at 100 BPM (one bar = 2.4 s). Cuts on downbeats. Captions instead of voice. Every number below comes from BRIEF.md's truth sheet.

| # | Time | Event (start → end) | Reads, in order | Source | Camera / transition | Sound |
|---|---|---|---|---|---|---|
| 01 | 0.0–4.8 | Telegram: the question is typed and sent | "Should we hash or curtail tonight?" → send | user's Telegram recording | full frame, slow push-in | type ticks, send pop |
| 02 | 4.8–12.0 | Title + the site | "Ballast" · "a Mind for Bitcoin mining sites" → site card: ERCOT HB_WEST · 500 PH/s · 21 J/TH | sites/west-texas.json | hard cut on downbeat, card slides up | low thump |
| 03 | 12.0–31.2 | The Mind's live answer arrives | reply text scrolls in (sped up 4×, labelled) → highlight "all eight hours came back RUN" → margins $47.18 → $26.73/MWh | Telegram recording (plan f2efd8bf94) | match cut to recording, highlight boxes (no glow) | soft chime on RUN |
| 04 | 31.2–48.0 | Every number has a receipt | Gauge 4283 hashprice 46,872.87 sats/PH/day, receipt 0x424f1568… → Pecos 7310042 $2.04 = ERCOT archive $2.04 → 7 day-ahead receipts "matched ERCOT to the cent" → "10 Telegraph calls · $0.11" | Mind reply + PROJECT_STATE | zoom into evidence lines, tick per receipt | tick per line |
| 05 | 48.0–67.2 | It holds instead of guessing | earlier reply: "every hour … came back HOLD" → cause 1: hashprice null via one route → cause 2: forecast fetch failed → "HOLD names the missing check, never a guessed number" → "fixed: named providers on escrow, weather fallback" | screenshots 06a48c8e23 / 055fe017b0 | split: reply left, cause cards right | low pulse, error tick |
| 06 | 67.2–86.4 | With vs without Telegraph | 89 real ERCOT hours · clean: 82/89 both → bad inputs injected (label SYNTHETIC) → web-only used 20/20 bad inputs, Ballast caught 20/20 → lost $2,199 vs $210 | compare.txt (c82beb1) | two columns count up | riser into the $ numbers |
| 07 | 86.4–100.8 | Monitor mode explains changes | "18:00 changed RUN → CURTAIL: real-time rose from $15.92 to $142.10 … margin −$86.95" → "19:00 NO RECOMMENDATION: providers disagree" | monitor-demo.txt (label: demo timeline, SYNTHETIC after tick 1) | terminal lines type on | type ticks |
| 08 | 100.8–112.8 | How it's wired, and what it cost | Mind → Ballast tool → Telegraph: escrow (Pecos power, Gauge hashprice), Anjoman API (weather) → "$0.11 per 8-hour plan · Sepolia test USDC" | runtime.ts, live run | diagram draws left → right | whoosh per hop |
| 09 | 112.8–120.0 | End card | github.com/nftkingiii/ballast · ballast-app.up.railway.app · "Recommendations only. No miner was switched." · @telegraphprotoc | repo | hold, fade to slate | success chord |

Honesty captions shown on screen: "testnet (Sepolia test USDC)" in 03–04 and 08; "sped up" on the recording; "SYNTHETIC" on 06 injections and 07 timeline; "Pecos is our own miner" small line in 04.
9:16 cut: shots 01, 03 (crop to the reply), 04 → end card, about 30 s.
