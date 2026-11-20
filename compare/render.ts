import type { runAll } from "./compare.ts";

type Results = Awaited<ReturnType<typeof runAll>>;
type Policy = Results["scenarios"][string]["policies"][number];

const usd = (n: number, d = 2) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(d)}`;
const numeric = (c: string) => c === "n/a" || /^-?\$?-?[\d.,]+( ms| s|%| to [\d.]+|\/\d+)?( \(.*\))?$/.test(c);
const table = (rows: string[][]) => {
  const right = rows[0]!.map((_, i) => i > 0 && rows.slice(1).every((r) => numeric(r[i] ?? "")));
  return [`| ${rows[0]!.join(" | ")} |`, `| ${right.map((x) => (x ? "---:" : "---")).join(" | ")} |`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n");
};
const pol = (r: Results, sc: string, id: string): Policy => r.scenarios[sc]!.policies.find((p) => p.id === id)!;
const range = (a: [number, number], d = 1) => (a[0] === a[1] ? a[0].toFixed(d) : `${a[0].toFixed(d)} to ${a[1].toFixed(d)}`);

export function findings(r: Results): string[] {
  const aC = pol(r, "clean", "A").metrics, bC = pol(r, "clean", "B").metrics, daC = pol(r, "clean", "A-DA").metrics;
  const a = pol(r, "injected", "A").metrics, b = pol(r, "injected", "B").metrics;
  const out: string[] = [];
  out.push(
    `**On clean data Telegraph changes almost nothing in the decision.** Over ${r.window.hours} real hours, web-only A (latest ERCOT interval) and Ballast B made ${aC.correct} and ${bC.correct} correct decisions out of ${aC.decisions}, realizing ${usd(aC.realizedUsd, 0)} and ${usd(bC.realizedUsd, 0)}. The provider answers in B are stand-ins for the same ERCOT report, so B cannot be more accurate than the data both read; ` +
      `the hindsight ceiling is ${usd(aC.hindsightBestUsd, 0)}. The shortfall in both comes from using one 15-minute interval as a proxy for an hourly settlement (the oracle itself throttles or curtails in ${r.truthSummary.hoursOracleNotRun} of ${r.window.hours} hours, so the price moves enough inside an hour to matter), not from bad data.`,
  );
  out.push(
    `**Reading the wrong table is the cheapest way to lose money on clean data.** A-DA (a Mind that reads the day-ahead table) got ${daC.correct}/${daC.decisions} right and realized ${usd(daC.realizedUsd, 0)}, ${usd(aC.realizedUsd - daC.realizedUsd, 0)} less than reading the real-time interval; its mean price error was ${usd(daC.meanAbsPriceErrorUsdPerMwh)}/MWh against ${usd(aC.meanAbsPriceErrorUsdPerMwh)} for A.`,
  );
  out.push(
    `**The difference appears when inputs go bad.** With 24 identical synthetic injections (20 of them bad inputs, 4 negative prices), A used ${a.badInputsUsedSilently} of ${a.badInputHours} bad inputs without any warning and realized ${usd(a.realizedUsd, 0)} (${usd(a.shortfallVsBestUsd, 0)} below hindsight-best, ${usd(a.lostOnWrongActionsUsd, 0)} of it on wrong actions). ` +
      `B flagged ${b.badInputsCaught} of ${b.badInputHours}, held on ${b.holds}, fell back to day-ahead on ${b.fallbackToDayAhead}, realized ${usd(b.realizedUsd, 0)} (${usd(b.shortfallVsBestUsd, 0)} below hindsight-best, ${usd(b.lostOnWrongActionsUsd, 0)} on wrong actions, ${usd(b.lostToHoldsUsd, 0)} given up by holding) and had ${b.falseAlarms} false alarms on clean hours.`,
  );
  const k = (kind: string) => r.perKind.find((x) => x.kind === kind)!;
  const ba = r.beforeAfter.perKind.find((x) => x.kind === "wrong-market")!, bm = r.beforeAfter.perKind.find((x) => x.kind === "missing-hashprice")!;
  const t = (m: number) => r.timing.find((x) => x.minute === m)!;
  const est = (id: string, m: number) => r.studies.estimators.find((e) => e.id === id)!.byMinute.find((x) => x.minute === m)!.all;
  out.push(
    `**Two of the three weaknesses are closed on the injected hours, the third on timing.** A missing hashprice no longer costs the hour: B carried the hashprice it had accepted an hour earlier (labelled, with its original provider, time and receipt) on ${k("missing-hashprice").B.carried} of ${k("missing-hashprice").hours.length} hours and lost ${usd(bm.after.lostUsd, 0)} instead of ${usd(bm.before.lostUsd, 0)} (A lost ${usd(k("missing-hashprice").A.shortfallUsd, 0)}). ` +
      `A wrong-market answer is now recovered: B recovered ${k("wrong-market").B.recovered} of ${k("wrong-market").hours.length} from the public archive for the exact interval (labelled public, no receipt, no second opinion) and lost ${usd(ba.after.lostUsd, 0)} instead of ${usd(ba.before.lostUsd, 0)}. ` +
      `Both fixes were written after these injected results were seen, so the injected improvement is partly in-sample; the clean-window result and the timing table below are the less biased check.`,
  );
  out.push(
    `**Decision timing: the rule helps late in the hour and cannot help early, so early decisions are now labelled provisional.** ERCOT settles an hour as the mean of four 15-minute prices. Deciding at :14 (or :01) gets ${t(14).before.wrong} of ${r.window.hours} clean hours wrong under any rule, because no interval of the hour is published yet; B now says so (\"provisional, decide again after :15\") and at :16, when the first interval is out, gets ${t(16).after.wrong} wrong, unchanged. ` +
      `Later in the hour the published intervals are used as they are and the latest is repeated for the rest: at :31 ${t(31).before.wrong} to ${t(31).after.wrong} wrong (but ${usd(t(31).before.shortfallUsd, 0)} to ${usd(t(31).after.shortfallUsd, 0)} below hindsight-best, so not better in dollars), at :46 ${t(46).before.wrong} to ${t(46).after.wrong} wrong (${usd(t(46).before.shortfallUsd, 0)} to ${usd(t(46).after.shortfallUsd, 0)}). ` +
      `The textbook alternative, day-ahead for the unpublished intervals, is worse at every minute with an interval published (at :16 ${est("all-day-ahead", 16).wrong} wrong against ${est("hour-estimate", 16).wrong}), so it is not used.`,
  );
  out.push(
    `**Net of the intelligence cost, B ${b.netOfIntelligenceCostUsd >= a.netOfIntelligenceCostUsd ? "comes out ahead" : "does not come out ahead"} in the injected window**: ${usd(b.netOfIntelligenceCostUsd, 2)} against ${usd(a.netOfIntelligenceCostUsd, 2)} (B paid ${usd(b.telegraphCostUsd, 2)} for ${b.paidAnswers} answers at $0.01). ` +
      `That result depends on where the failures landed: they were placed where they hurt a trusting policy most, so it is a worst-case-placement figure. On the clean window the cost bought no extra profit (${usd(bC.realizedUsd - aC.realizedUsd, 2)} difference before a ${usd(bC.telegraphCostUsd, 2)} bill).`,
  );
  out.push(
    `**Evidence and speed are where the tools differ without any bad data.** Every B decision carries provider, as-of time and a receipt for both inputs (${bC.evidenceCompletenessPct!.toFixed(0)}% of the six fields, modelled receipts here and two real ones in the anchor); the modelled web-only Mind cites a page at best (${aC.evidenceCompletenessPct!.toFixed(1)}%). ` +
      `The price is time: about ${range(bC.liveSecondsPerDecisionMean, 0)} s per decision live for B (${bC.codeMsMean.toFixed(2)} ms of that is Ballast's own code, answers replayed) against about ${range(aC.liveSecondsPerDecisionMean, 1)} s for the web-only calls.`,
  );
  return out;
}

export function renderMarkdown(r: Results): string {
  const L: string[] = [];
  const clean = r.scenarios.clean!, inj = r.scenarios.injected!;
  const A = pol(r, "clean", "A").metrics, B = pol(r, "clean", "B").metrics, Ai = pol(r, "injected", "A").metrics, Bi = pol(r, "injected", "B").metrics;

  L.push("# Ballast with and without Telegraph", "");
  L.push(
    `Question from the organisers: what changes in accuracy, completeness, capabilities, cost and execution time when an agent is tested with and without Telegraph. This is Ballast's answer on ${r.window.hours} real ERCOT hours (${r.window.firstHour} to ${r.window.lastHour}, node ${r.window.node}), one policy that reads one unchecked price (A) against Ballast's own planner with provider answers, public cross-checks, holds, a spend cap and receipts (B). This version includes three fixes made after the first comparison (commit e2f949b); the section \"What changed since e2f949b\" has the before and after.`,
    "",
    "Reproduce with `npm run compare` (reads `compare/data/`, no network, no Telegraph call, nothing paid). Everything below is generated by that script into `results.md` and `results.json`.",
    "",
    "## Where each number comes from",
    "",
    table([
      ["Label", "What it is"],
      ["public data", `ERCOT HB_WEST settlement prices (real-time 15-minute ${r.fetchedAt.ercotRealTime.slice(0, 16)}Z, day-ahead hourly ${r.fetchedAt.ercotDayAhead.slice(0, 16)}Z) read through Assize's keyless ERCOT archive endpoint, and a daily hashprice from mempool.space (${r.fetchedAt.mempool.slice(0, 16)}Z). The ground truth for every score.`],
      ["recorded Telegraph answer", "Only the two answers bought on 2026-11-19 (Gauge hashprice and Pecos real-time price, receipts below). No other Telegraph answer exists in this study."],
      ["stand-in", "For every other hour, B's provider answers are built from the same public data and returned in the shapes the live miners use. They carry `fixture:` receipts, not Telegraph ones. B's code is real; the answers are replayed."],
      ["modelled", "Policy A is a model of a Mind with generic web tools, not an observed Mind. Its assumptions are listed under Policies."],
      ["synthetic injection", "The 24 bad-input hours in the injected scenario. They never happened."],
    ]),
    "",
    "## Policies",
    "",
    "- **A, web-only (modelled).** One price per hour from one source (the latest 15-minute real-time interval, which is the best case for a web-only Mind), one hashprice from one page, no staleness, interval, node or market check, no cross-check, no receipt, never holds. If the hashprice page fails it silently reuses the last value. It uses Ballast's own margin arithmetic and thresholds, so any difference comes from input handling, not from different math. Assumed evidence: it can name the page it read, but scraped values carry no as-of time and there is no receipt.",
    "- **B, with Telegraph (Ballast).** `planSite` and `decideHour` unchanged: buy hashprice and the real-time price from named miners, reject an answer that is stale, for another node, another market or another interval, or that disagrees with the free public archive beyond tolerance, fall back to the day-ahead price when real-time is unusable, hold when no usable input remains, and record provider, time and receipt per input. Since the fixes: a hashprice accepted earlier stands in (labelled carried, original provider, time and receipt) for up to 12 h when the fresh one is missing by outage; a wrong-market or wrong-interval answer is recovered by asking once more and then by the public archive for that exact interval (labelled public); the current hour is priced from the intervals already published rather than the latest alone. Decisions run at H:16 UTC.",
    "- **B-prev, Ballast as at e2f949b.** The same planner with the three fixes switched off by site config. It reproduces every e2f949b number exactly (checked against `compare/data/baseline-e2f949b.json`), which is what makes the before column in this file a measurement and not a claim.",
    "- **Oracle.** Knows ERCOT's settled hourly price (mean of the four 15-minute intervals) and the true daily hashprice, and applies Ballast's thresholds (RUN at margin of $8/MWh or more, THROTTLE 50% between $0 and $8, CURTAIL below $0). A decision is correct when its action equals the oracle's.",
    `- **Site.** ${r.site.fleetMw} MW fleet (500,000 TH/s at 21 J/TH), $${r.site.adderUsdPerMwh}/MWh adder, real-time power exposure, heat limits removed (November, and A has no weather check to compare).`,
    "- **A HOLD** is counted as the site sitting idle that hour. Its opportunity cost is reported separately so it cannot hide.",
    "",
    `Real prices in the window: hourly settled real-time between ${usd(r.truthSummary.rtHourMin)} and ${usd(r.truthSummary.rtHourMax)}/MWh, hashprice ${usd(r.truthSummary.hashpriceRange[0]!)} to ${usd(r.truthSummary.hashpriceRange[1]!)}/PH/day, ${r.truthSummary.hoursOracleNotRun} of ${r.window.hours} hours where the oracle does not plain-RUN.`,
    "",
  );

  const row = (label: string, f: (m: Policy["metrics"]) => string) => [label, f(A), f(B), f(Ai), f(Bi)];
  L.push(
    "## Headline",
    "",
    table([
      ["Metric (whole window)", "A clean", "B clean", "A injected", "B injected"],
      row("Decisions correct vs oracle", (m) => `${m.correct}/${m.decisions} (${m.correctPct}%)`),
      row("Wrong actions (not HOLD)", (m) => String(m.wrongActions)),
      row("Realized margin", (m) => usd(m.realizedUsd, 0)),
      row("Hindsight-best margin", (m) => usd(m.hindsightBestUsd, 0)),
      row("Lost to wrong decisions", (m) => usd(m.lostOnWrongActionsUsd, 0)),
      row("Given up by HOLDs", (m) => usd(m.lostToHoldsUsd, 0)),
      row("HOLDs raised (justified / unjustified)", (m) => `${m.holds} (${m.holdsJustified} / ${m.holdsUnjustified})`),
      row("Bad inputs caught / injected", (m) => (m.badInputHours ? `${m.badInputsCaught}/${m.badInputHours}` : "n/a")),
      row("Bad inputs used silently", (m) => (m.badInputHours ? String(m.badInputsUsedSilently) : "n/a")),
      row("False alarms on clean hours", (m) => String(m.falseAlarms)),
      row("Decisions priced from a day-ahead number (A: unknowingly)", (m) => String(m.fallbackToDayAhead)),
      row("Mean price error vs ERCOT settled hour ($/MWh)", (m) => m.meanAbsPriceErrorUsdPerMwh.toFixed(2)),
      row("Evidence completeness (provider, time, receipt)", (m) => (m.evidenceCompletenessPct === null ? "n/a" : `${m.evidenceCompletenessPct.toFixed(1)}%`)),
      row("Telegraph cost, window total", (m) => usd(m.telegraphCostUsd, 2)),
      row("Telegraph cost per decision", (m) => usd(m.telegraphCostPerDecisionUsd, 3)),
      row("Realized margin net of that cost", (m) => usd(m.netOfIntelligenceCostUsd, 2)),
      row("Ballast code time per decision (measured)", (m) => `${m.codeMsMean.toFixed(3)} ms`),
      row("Live time per decision (modelled, s)", (m) => range(m.liveSecondsPerDecisionMean, 1)),
    ]),
    "",
    "Cost is $0.01 per answered Telegraph ask (the live run paid $0.02 for two answers); A's Telegraph cost is $0, but its own model tokens are not measured here and neither are B's. Live time for B is the free public calls (median measured latency) plus the answers it buys one after another at 8 to 15 s each, from the 2026-11-19 run; the code time is the replayed Ballast code on whichever machine ran `npm run compare` (machine-dependent, well under a millisecond either way; it excludes the network and the paid answers).",
    "",
    `Clean means ERCOT's published prices untouched. Injected means the same hours with ${r.injection.hours.length} synthetic failures (below). The injected figures are bounds, not expected rates: ${r.injection.rule}.`,
    "",
    "### Other web-only variants (clean window only)",
    "",
    table([
      ["Policy", "Correct", "Realized", "Mean price error $/MWh", "Origin"],
      ...clean.policies.map((p) => [p.title, `${p.metrics.correct}/${p.metrics.decisions}`, usd(p.metrics.realizedUsd, 0), p.metrics.meanAbsPriceErrorUsdPerMwh.toFixed(2), p.origin]),
    ]),
    "",
    ...changedSection(r),
    "## The six injected failures (SYNTHETIC)",
    "",
    "Each hits the same hours for both policies. Where the failure is a bad provider answer, the free public archive stays correct, which is exactly what B's cross-check uses.",
    "",
    table([
      ["Failure", "Hours", "What was injected", "A correct", "A lost", "B correct", "B held", "B carried hashprice", "B recovered price", "B fell back to DA", "B lost"],
      ...r.perKind.map((k) => [k.kind, String(k.hours.length), k.description, `${k.A.correct}/${k.hours.length}`, usd(k.A.shortfallUsd, 0), `${k.B.correct}/${k.hours.length}`, String(k.B.holds), String(k.B.carried), String(k.B.recovered), String(k.B.fellBackToDayAhead), usd(k.B.shortfallUsd, 0)]),
    ]),
    "",
    "\"Lost\" is shortfall against the hindsight-best profit on those hours (it includes the throttle band's conservatism). Hour by hour:",
    "",
    table([
      ["Failure", "Hour (UTC)", "ERCOT settled", "A used", "A action", "B used", "B action", "Oracle"],
      ...r.perKind.flatMap((k) => k.hours.map((h) => {
        const a = pol(r, "injected", "A").rows.find((x) => x.hour === h)!, b = pol(r, "injected", "B").rows.find((x) => x.hour === h)!;
        const p = (x: number | null) => (x === null ? "-" : x.toFixed(2));
        return [k.kind, h.slice(5, 16).replace("T", " "), p(a.truePrice), p(a.priceUsed), a.action, `${p(b.priceUsed)}${b.basis === "day-ahead" ? " DA" : ""}${b.recovered ? " (archive)" : ""}${b.carried ? " (hashprice carried)" : ""}`, b.action, a.oracleAction];
      })),
    ]),
    "",
    "## Live anchor: the 2026-11-19 paid run (live paid answer, 2026-11-19)",
    "",
    `Replaying the two recorded answers through Ballast's planner gives ${r.anchor.action} ${Math.round(r.anchor.runFraction * 100)}% at margin ${usd(r.anchor.marginUsdPerMwh ?? 0)}/MWh for ${usd(r.anchor.costUsd, 2)}, ${r.anchor.reproducesLiveDecision ? "matching" : "NOT matching"} the live run (${r.anchor.recordedLive.action} ${Math.round(r.anchor.recordedLive.runFraction * 100)}%, ${usd(r.anchor.recordedLive.marginUsdPerMwh)}). The saved ERCOT archive gives ${usd(r.anchor.publicCrossCheckLmp17_45 ?? NaN)}/MWh for the 17:45Z interval that Pecos answered, and Gauge's hashprice was ${r.anchor.gaugeVsPublicHashpricePct}% from the public reference recorded at 17:50Z, inside the 5% tolerance.`,
    "",
    table([["Input", "Provider", "Answered (UTC)", "Receipt"], ...r.anchor.receipts.map((x) => [x.check, x.provider, "about 18:14 (run time; per-answer time was not saved)", `\`${x.receipt}\``])]),
    "",
    "## Capabilities",
    "",
    table([
      ["Capability", "Without Telegraph (modelled web-only Mind)", "With Telegraph (Ballast)"],
      ["Named provider per input", "A page it can cite", "Miner id and name per answer (Pecos 7310042, Gauge 4283)"],
      ["Receipt for each input", "None", "Escrow receipt hash per answer (2 real ones in the anchor)"],
      ["Interval, node and market checks", "None; takes a number", "Rejects wrong interval, node or market"],
      ["Second opinion", "None", "Free public ERCOT archive and mempool.space (public, not Telegraph). Telegraph itself has one ERCOT price miner, so no second Telegraph opinion exists"],
      ["Fail closed", "Never holds; reuses last values", "HOLD with the gap named; no prices bought when there is no hashprice at all. An accepted hashprice stands in only inside the site's window (12 h), only after an outage, and says \"carried from <time>\""],
      ["Recovery from a wrong answer", "None; takes the number", "Asks the provider once more, then reads the public archive for that exact interval, labelled public; holds or falls back if neither is valid"],
      ["Spend control", "Not applicable", "Cap per plan; stops buying and holds the rest"],
      ["Per-decision audit record", "Whatever the chat log kept", "Evidence table with provider, time, cost, receipt, accepted or rejected and why"],
      ["Day-ahead vs real-time", "Whichever page it opened", "Native `/price` call with `market`, because the generic intent has no market parameter"],
      ["Weather", "Not compared here", "Weather miner 76001 returned 503 on 2026-11-19; the plan flagged it. Not part of this comparison"],
    ]),
    "",
    "## Findings",
    "",
    ...findings(r).map((f) => `- ${f}`),
    "",
    "## Failures, shared",
    "",
    "- **Weather miner 76001 returned HTTP 503** in the 2026-11-19 paid run (recorded). The plan flagged the missing check; it could not have changed the RUN because the day was cold (forecast under 20 C).",
    "- **x402 `exact` settlement has been down** since 2026-11-17 (bounty #214), so paid runs use the escrow path. The first escrow attempt was refused until validity bounds were sent as strings (commit d718dcd).",
    "- **Telegraph adds no second ERCOT opinion.** Pecos is the only ERCOT price miner and it is ours, so the paid-vs-public agreement is two routes to the same ERCOT data, not independent confirmation, and the 2026-11-19 payment was our wallet paying our miner.",
    "- **The generic power intent cannot say which market.** `market` is an answer field, so Ballast bypasses the intent with Pecos's native call.",
    "- **Gauge returned no USD hashprice** (only sats per PH/day), so Ballast converts with a public BTC price; its figure was 4% above the public reference on the day, inside tolerance but not equal.",
    `- **Ballast's own proxy is still imperfect.** At :16 it gets ${B.wrongActions} of ${B.decisions} clean hours wrong against ERCOT's settled hour, because three of the four intervals are not published yet. Deciding at :14, as the live run did, gets ${pol(r, "clean", "B@14").metrics.wrongActions} wrong and is now labelled provisional. That error is shared with A and is the main source of loss on clean data.`,
    "- **Fixed after this study, and what is still open.** The wrong-market recovery and the hashprice memory are in. Still open: a wrong-node or disagreeing answer still falls back to day-ahead (recovery covers wrong market and wrong interval only); a price recovered from the public archive has no receipt and no second opinion; the hashprice memory lives in a state file (`--state`) or in one server process, not in a shared store.",
    "- **B only catches crisp mismatches.** A wrong value that is correctly labelled and within the cross-check tolerance, or a wrong value served by both the provider and the public archive, goes through unflagged. The injections here are all crisp.",
    "",
    "## What this shows, and what it does not",
    "",
    "- It shows that Ballast's checks (interval, node, market, cross-check, hold, spend cap, receipts) turn silent bad inputs into named, costed gaps, and what that costs in dollars and seconds on identical failures.",
    "- It does not show that Telegraph's data is more accurate than free ERCOT data. In B the provider answers are stand-ins built from that same data, and in the only two live answers Telegraph's miner agreed with the public archive.",
    "- The six failures are synthetic and placed at their worst-case hours; the real window had none of them. Failure rates in production are unknown.",
    "- Policy A is a model. A Mind with better prompts, a cross-check habit or its own logging would close part of the gap; the receipts and the fail-closed behaviour are the parts it cannot get from a page.",
    "- Hashprice is a daily number from mempool.space (the same source A reads), so the hashprice input is not stress-tested beyond the missing-answer case. The recorded Gauge answer is the only independent hashprice.",
    "- Pecos is our own miner and the only ERCOT price miner; there is one node (HB_WEST), one site, one window of a few days, no demand charges or ramp costs.",
    "- Latency of paid answers is one run's 8 to 15 s per answer; live B timing is modelled from that, not measured per decision.",
    "- Token and model costs of either Mind are not measured.",
    "- The three fixes were written after the injected results of e2f949b were seen. The injected improvement is therefore partly in-sample. Less biased: the clean-window score (unchanged at :16 by design) and the per-minute timing table, where nothing was injected and the rule was chosen on principle, then checked on both halves of the window.",
    "- The 12 h carry window is justified on four days of mempool.space data (two of three day-to-day moves were over the 5% the site accepts as agreement); a longer or calmer history could justify a different window, which is why it is a site field.",
    "",
    "## Files",
    "",
    "`compare/data/` raw data with fetch timestamps (`fetch-data.ts`, `fetch-extra.ts` refetch it from free public sources), `compare/compare.ts` the replay, `compare/world.ts` truth and injections, `compare/policies.ts` the two policies, `compare/results.json` all numbers, `test/compare.test.ts` the checks.",
    "",
  );
  void inj;
  return L.join("\n");
}

const fmt = (n: number | null, d = 2) => (n === null ? "n/a" : n.toFixed(d));

/** Before (e2f949b) and after for the three fixes, plus the studies that justify the rules. */
function changedSection(r: Results): string[] {
  const L: string[] = [];
  const unit = (label: string, v: number) => (/\(\$\)/.test(label) ? usd(v, Math.abs(v) < 10 ? 2 : 0) : /\(%\)/.test(label) ? `${v.toFixed(1)}%` : /\$\/MWh/.test(label) ? v.toFixed(2) : String(v));
  const delta = (label: string, v: number) => (v === 0 ? "0" : `${v > 0 ? "+" : "-"}${unit(label, Math.abs(v)).replace(/^-/, "")}`);
  L.push(
    "## What changed since e2f949b",
    "",
    `The first comparison (commit ${r.beforeAfter.baselineCommit}) exposed three weaknesses in Ballast. This version changes each, and this section is the before and after on the same 89 hours. "Before" is the e2f949b numbers saved in \`compare/data/baseline-e2f949b.json\`; the current code with the three fixes switched off by site config reproduces them exactly (clean: ${r.beforeAfter.switchedOffReproducesBaseline.clean}, injected: ${r.beforeAfter.switchedOffReproducesBaseline.injected}), so the comparison is like for like.`,
    "",
    `1. **A hashprice Ballast already accepted can stand in for a missing one.** Plan mode takes a remembered hashprice (the state file of --state, or the server memory) and uses it when the fresh answer failed by outage, it is inside the site window (intelligence.maxAgeMin.hashpriceCarry, default ${r.fixes.carryWindowMin} min) and it is still within the site tolerance of the free public reference. The decision, the evidence table and the plan header say "carried from <time>" and keep the original provider, answer time and receipt. Monitor mode applies the same test from the same code. Older than the window, none, a disagreement instead of an outage, or a change of mode (demo to paid): HOLD as before.`,
    "2. **A wrong-market or wrong-interval answer is recovered, not just flagged.** Ballast asks the provider once more (inside the spend cap), then reads the public ERCOT archive for that exact interval, labelled public (no receipt, no second opinion). The first answer stays in the evidence as rejected, the recovery item says which answer it recovers, and the decision reasons say what was done. If neither gives a valid answer it falls back or holds as before. Wrong-node and disagreement are not recovered.",
    "3. **The current hour is priced from the intervals already published.** ERCOT settles an hour as the mean of four 15-minute prices. Ballast uses the published intervals of the hour as they are (from the free archive, or bought, by site setting) and repeats the latest for the rest. Before any interval of the hour is out (:00 to :15) the price is the previous hour last interval and the decision is labelled provisional with the time to decide again. The offline study below is why day-ahead is not used for the rest.",
    "",
    "### Before and after, injected window (SYNTHETIC failures)",
    "",
    table([["Metric", "B at e2f949b", "B now", "Change"], ...r.beforeAfter.injected.map((m) => [m.metric, unit(m.metric, m.before), unit(m.metric, m.after), delta(m.metric, m.change)])]),
    "",
    "Per failure kind, B only:",
    "",
    table([
      ["Failure", "Correct before", "Correct now", "Held before", "Held now", "Fell back to DA before", "Fell back now", "Lost before", "Lost now"],
      ...r.beforeAfter.perKind.map((k) => [k.kind, `${k.before.correct}/4`, `${k.after.correct}/4`, String(k.before.holds), String(k.after.holds), String(k.before.fellBackToDayAhead), String(k.after.fellBackToDayAhead), usd(k.before.lostUsd, 0), usd(k.after.lostUsd, 0)]),
    ]),
    "",
    "Evidence completeness falls because the hours recovered from the public archive carry a provider and a time but no receipt: the archive is public data, not a Telegraph answer, and the table says so.",
    "",
    "### Before and after, clean window",
    "",
    table([["Metric", "B at e2f949b", "B now", "Change"], ...r.beforeAfter.clean.map((m) => [m.metric, unit(m.metric, m.before), unit(m.metric, m.after), delta(m.metric, m.change)])]),
    "",
    "Nothing changes on clean data at :16, as intended: none of the three fixes has anything to act on there (no failure, and the first interval of the hour is the only one published).",
    "",
    "### Decision timing on clean data (the less biased check)",
    "",
    "Ballast before and after, deciding at each minute past the hour on all 89 clean hours. \"Wrong\" is hours whose action differs from the oracle's; \"below best\" is dollars against the hindsight-best margin; the last columns split the wrong count by the first and second half of the window (before to now), to show it is not one stretch of prices.",
    "",
    table([
      ["Decision minute", "Wrong before", "Wrong now", "Below best before", "Below best now", "Mean price error before", "Mean price error now", "Provisional hours now", "Wrong, first half", "Wrong, second half"],
      ...r.timing.map((t) => [`:${String(t.minute).padStart(2, "0")}`, String(t.before.wrong), String(t.after.wrong), usd(t.before.shortfallUsd, 0), usd(t.after.shortfallUsd, 0), t.before.meanAbsPriceErrorUsdPerMwh.toFixed(2), t.after.meanAbsPriceErrorUsdPerMwh.toFixed(2), `${t.after.provisionalHours}/${r.window.hours}`, `${t.before.firstHalf.wrong} to ${t.after.firstHalf.wrong}`, `${t.before.secondHalf.wrong} to ${t.after.secondHalf.wrong}`]),
    ]),
    "",
    "Reading it: the wrong count never rises at any minute. At :16 nothing changes (one interval is published, so the estimate is that interval). At :01 and :14 the count is the same because no information about the hour exists yet; what changes is that the plan says so. At :31 the count improves but the dollars slip, because the errors that remain sit closer to the thresholds (a count of wrong actions and dollars are different measures); at :46 both improve.",
    "",
    "### Why not day-ahead for the unpublished intervals (offline study, same 89 hours)",
    "",
    "Wrong clean-hour decisions by estimator and decision minute, using Ballast's own decision function. Day-ahead is a much worse stand-in for the unpublished intervals than the latest interval was, so the planner does not use it.",
    "",
    table([
      ["Estimator", ...r.studies.estimators[0]!.byMinute.map((m) => `:${String(m.minute).padStart(2, "0")} wrong (first/second half)`)],
      ...r.studies.estimators.map((e) => [e.title, ...e.byMinute.map((m) => `${m.all.wrong} (${m.firstHalf.wrong}/${m.secondHalf.wrong})`)]),
    ]),
    "",
    "### Why 12 hours for the hashprice window (saved mempool.space data, 2026-11-16 to 19)",
    "",
    `Day to day, the daily mean hashprice moved ${r.studies.hashpriceDayToDay.map((d) => `${d.changePct > 0 ? "+" : ""}${d.changePct}% (${d.from.slice(5)} to ${d.to.slice(5)})`).join(", ")}: two of three above the 5% the site accepts as agreement between sources, so reusing a day-old value would use a number the site would not itself accept as fresh. Inside one day the fine series moved at most ${fmt(r.studies.hashpriceCarry.find((x) => x.ageHours === 12)!.sameDayPairs.maxPct)}% over 12 hours. The table is the hashprice from N hours before, used at :16 in place of the current one:`,
    "",
    table([
      ["Age of the hashprice used", "Hours whose action changes", "Dollars lost by carrying it", "Dollars lost by HOLDing instead", "Median move, same-day pairs", "90th percentile, same-day pairs", "Max move, same-day pairs", "Max move, any pairs in the window"],
      ...r.studies.hashpriceCarry.map((x) => [`${x.ageHours} h`, `${x.actionFlips}/${x.hoursCompared}`, usd(x.carryLossUsd, 0), usd(x.holdLossUsd, 0), x.sameDayPairs.n ? `${fmt(x.sameDayPairs.medianPct)}%` : "n/a", x.sameDayPairs.n ? `${fmt(x.sameDayPairs.p90Pct)}%` : "n/a", x.sameDayPairs.n ? `${fmt(x.sameDayPairs.maxPct)}%` : "n/a", x.anyPairs.n ? `${fmt(x.anyPairs.maxPct)}%` : "n/a"]),
    ]),
    "",
    "Carrying an old hashprice is always cheaper than holding in dollars on this data, even at 48 hours, because a changed action costs a fraction of the hour and a HOLD costs all of it. The window is shorter than that anyway because the point of freshness is not to let a number drift past what the site would accept: the number of changed actions grows from a handful at a few hours to a quarter of the hours at a day. 12 hours keeps the same-day move under the 5% tolerance and covers an overnight provider outage. The window is a site field, not a constant.",
    "",
    `**In-sample caveat.** ${r.fixes.inSampleNote}`,
    "",
  );
  return L;
}
