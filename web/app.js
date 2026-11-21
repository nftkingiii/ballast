"use strict";
// Ballast public page. Plain DOM, no framework. Text from the server is always set with textContent.
const $ = (id) => document.getElementById(id);
const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // CSSOM, so the page's CSP can forbid inline style attributes
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const usd = (n, d = 2) => (n == null ? "-" : `$${Number(n).toFixed(d)}`);
const hourLabel = (iso) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
const SEPOLIA_TX = "https://sepolia.etherscan.io/tx/";
const SIGNAL = "https://devnode.telegraphprotocol.com/engine/v1/signal/";

/* ---------- tabs ---------- */
const TABS = ["run", "recorded", "compare", "how"];
const loaded = {};
function showTab(name) {
  if (!TABS.includes(name)) name = "run";
  for (const t of TABS) {
    $(`panel-${t}`).hidden = t !== name;
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`tab-${t}`).tabIndex = t === name ? 0 : -1;
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  if (name === "recorded" && !loaded.recorded) (loaded.recorded = true), loadRecorded();
  if (name === "compare" && !loaded.compare) (loaded.compare = true), loadCompare();
  if (name === "how") setupVideo();
}
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(document.activeElement?.dataset?.tab);
  if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  showTab(next);
  $(`tab-${next}`).focus();
});
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

/* ---------- run tab ---------- */
let sites = [];
let running = false;
let lastStatus = null;

async function getJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}

async function refreshStatus() {
  try {
    lastStatus = await getJson("/public/status");
  } catch {
    lastStatus = null;
  }
  const live = lastStatus?.live;
  $("cap").textContent = usd(live?.perRunCapUsd ?? 0.4);
  const q = $("quota");
  if (!live) q.textContent = "Could not read the live run status. The demo run still works.";
  else if (!live.available) q.textContent = live.reason;
  else q.textContent = `Live runs left today (UTC): ${live.remainingToday} of ${live.dailyMax}. Yours: ${live.remainingForYou} of ${live.perIpMax}.${live.busy ? " One is running now." : ""}`;
  $("btn-live").disabled = running || !live || !live.available;
  $("btn-demo").disabled = running;
}

function showSite() {
  const s = sites.find((x) => x.id === $("site").value);
  $("site-facts").textContent = s ? `${s.node} · ${s.location} · ${s.fleet} · next ${s.hours} hours` : "";
}

function notice(message, offerDemo) {
  const box = $("notice");
  box.replaceChildren(h("p", {}, message));
  if (offerDemo) box.append(h("button", { class: "btn", type: "button", onclick: () => run("demo") }, "Run the demo instead"));
  box.hidden = false;
}

function addProgress(e) {
  const list = $("progress");
  const id = `ask-${e.n}`;
  let li = $(id);
  if (!li) {
    li = h("li", { id }, h("span", { class: "dot" }), h("span", { class: "what" }), h("span", { class: "cost" }));
    list.append(li);
  }
  const what = li.querySelector(".what");
  const name = `${e.check} · ${e.provider}${e.subject ? ` · ${e.subject.replace("T", " ")}` : ""}`;
  if (e.type === "ask") {
    what.replaceChildren(name, h("small", {}, "asking..."));
  } else if (e.type === "answer") {
    li.className = "ok";
    what.replaceChildren(name, h("small", {}, `${e.receipt ? `receipt ${e.receipt}` : "no receipt id"} · ${(e.ms / 1000).toFixed(1)}s`));
    li.querySelector(".cost").textContent = usd(e.costUsd, 2);
  } else {
    li.className = "bad";
    what.replaceChildren(name, h("small", {}, `failed: ${e.message}`));
  }
}

async function run(mode) {
  if (running) return;
  running = true;
  $("btn-live").disabled = $("btn-demo").disabled = true;
  $("notice").hidden = true;
  $("result").hidden = true;
  const prog = $("progress");
  prog.replaceChildren();
  prog.hidden = false;
  prog.append(h("li", { id: "starting" }, h("span", { class: "dot" }), h("span", { class: "what" }, mode === "live" ? "Starting a live run (checking limits and the escrow balance)" : "Starting the demo run"), h("span")));
  let finished = false;
  try {
    const res = await fetch("/public/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ site: $("site").value, mode }) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      prog.hidden = true;
      notice(body.message || `The server answered ${res.status}.`, mode === "live" && body.offerDemo !== false);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const e = JSON.parse(line);
        if (e.type === "start") $("starting")?.remove();
        else if (["ask", "answer", "failed"].includes(e.type)) addProgress(e);
        else if (e.type === "result") {
          finished = true;
          prog.hidden = true;
          renderResult(e);
        } else if (e.type === "error") {
          finished = true;
          prog.hidden = true;
          notice(e.message, mode === "live");
        }
      }
    }
    if (!finished) {
      prog.hidden = true;
      notice("The connection ended before the run finished. If it was a live run, calls made so far may have been paid for. No result is shown.", mode === "live");
    }
  } catch (error) {
    prog.hidden = true;
    notice(`The request failed: ${error.message}. Nothing is shown as a result.`, mode === "live");
  } finally {
    running = false;
    await refreshStatus();
    if (mode === "live") loadRecent();
  }
}

function receiptCell(e) {
  const r = e.receipt || {};
  const id = r.receiptHash || r.jobId || r.signalHash;
  if (!id) return h("span", { class: "muted" }, "-");
  const cell = h("div", { class: "rcpt" });
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(id);
  // Sepolia link only where the receipt is a transaction hash: not for the escrow rail, whose receipts are Telegraph ids.
  if (isHash && r.rail && r.rail !== "escrow") cell.append(h("a", { href: SEPOLIA_TX + id, rel: "noopener" }, id));
  else cell.append(id);
  if (r.signalHash && /^0x[0-9a-fA-F]{64}$/.test(r.signalHash)) cell.append(" ", h("a", { href: SIGNAL + r.signalHash, rel: "noopener" }, "signal"));
  return cell;
}

function renderResult(e) {
  const plan = e.plan;
  const live = e.mode === "live";
  const counts = {};
  for (const d of plan.decisions) counts[d.action] = (counts[d.action] || 0) + 1;
  const countText = Object.entries(counts).map(([a, n]) => `${n} ${a}`).join(" · ");
  const maxMargin = Math.max(1, ...plan.decisions.map((d) => Math.abs(d.marginUsdPerMwh ?? 0)));

  const banner = h("div", { class: `banner ${live ? "live" : "demo"}` },
    h("span", { class: "chip" }, live ? "LIVE" : "DEMO"),
    h("span", { class: "t" }, live ? e.label : "Recorded stand-in answers. No Telegraph calls were made and nothing was paid. Receipts starting fixture: are not Telegraph receipts."));

  const stats = h("div", { class: "stats" },
    stat(live ? usd(plan.intelligenceCostUsd) : "$0.00", live ? `total cost, cap ${usd(plan.spendCapUsd)}` : `DEMO cost; a live run of this plan costs about ${usd(plan.projectedPaidCostUsd)}`),
    stat(String(plan.telegraphCalls), live ? "Telegraph calls" : "Telegraph calls replayed (DEMO)"),
    stat(countText || "-", "hours"),
    stat(plan.hashpriceUsdPerPhDay == null ? "none" : usd(plan.hashpriceUsdPerPhDay), "hashprice, per PH/day"));

  const strip = h("div", { class: "strip", "aria-label": "Hourly actions" },
    plan.decisions.map((d) => h("div", { class: `cell ${d.action}`, title: d.action }, h("b", {}, d.hour.slice(11, 13) + ":00"), d.action === "HOLD" ? "HOLD" : `${d.action} ${Math.round(d.runFraction * 100)}%`)));

  const rows = [];
  for (const d of plan.decisions) {
    const why = h("tr", { class: "why", hidden: true }, h("td", { colspan: "6" },
      h("ul", {}, [...(d.revisitAt ? [h("li", {}, `Provisional: decide again after ${d.revisitAt.slice(11, 16)}Z`)] : []), ...d.reasons.map((r) => h("li", {}, r)), ...d.gaps.map((g) => h("li", { class: "rej" }, `missing ${g.check}: ${g.reason}`))])));
    const m = d.marginUsdPerMwh;
    const row = h("tr", { class: "hour", tabindex: "0", title: "Show the reasons", onclick: () => (why.hidden = !why.hidden), onkeydown: (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), (why.hidden = !why.hidden)) },
      h("td", { class: "mono" }, hourLabel(d.hour)),
      h("td", {}, h("span", { class: `tag ${d.action}` }, d.action)),
      h("td", { class: "num hide-sm" }, d.action === "HOLD" ? "-" : `${Math.round(d.runFraction * 100)}%`),
      h("td", { class: "num" }, d.powerPriceUsdPerMwh == null ? "-" : `${usd(d.powerPriceUsdPerMwh)} ${d.basis === "real-time" ? "RT" : "DA"}`),
      h("td", { class: "num" }, m == null ? "-" : usd(m), m != null && h("span", { class: `mbar${m < 0 ? " neg" : ""}`, style: `width:${Math.max(2, Math.round((Math.abs(m) / maxMargin) * 70))}px` })),
      h("td", { class: "muted small hide-sm" }, d.revisitAt ? `provisional, decide again after ${d.revisitAt.slice(11, 16)}Z` : ""));
    rows.push(row, why);
  }
  const hours = h("div", { class: "tablewrap" }, h("table", {},
    h("caption", {}, `${live ? "Live" : "DEMO"} plan for ${plan.site}, hours in UTC. RT is real-time, DA day-ahead. Select a row for its reasons.`),
    h("thead", {}, h("tr", {}, h("th", {}, "Hour"), h("th", {}, "Action"), h("th", { class: "num hide-sm" }, "Run"), h("th", { class: "num" }, "Power $/MWh"), h("th", { class: "num" }, "Margin $/MWh"), h("th", { class: "hide-sm" }, ""))),
    h("tbody", {}, rows)));

  const ev = evidenceBlock(plan, live);

  const missing = plan.missingChecks.length
    ? h("div", { class: "missing" }, h("b", {}, "Missing or conflicting checks"), h("ul", {}, plan.missingChecks.map((g) => h("li", {}, `[${g.check}] ${g.subject}: ${g.reason}`))))
    : h("div", { class: "missing none" }, "Missing checks: none");

  const foot = h("p", { class: "muted small", style: "margin-top:14px" }, plan.budgetBreached ? "Spend cap reached: no further intelligence was bought and unpriced hours are on HOLD. " : "", "Sepolia explorer links appear only where a receipt is a transaction hash; escrow receipts are shown as ids. Recommendations only. No miner is switched.");

  $("result").replaceChildren(banner, h("div", { class: "result-body" }, stats, strip, hours, ev, missing, foot));
  $("result").hidden = false;
  $("result").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}
function evidenceBlock(plan, live) {
  const groups = new Map();
  for (const x of plan.evidence) {
    const k = x.check + "|" + x.subject;
    if (!groups.has(k)) groups.set(k, { provs: [], pubs: [] });
    groups.get(k)[x.source.kind === "public" ? "pubs" : "provs"].push(x);
  }
  const rows = [];
  const usedCell = (x) => h("td", { class: x.accepted ? "small" : "small rej" }, x.accepted ? (x.carried ? "yes, carried" : x.recovery ? "yes, recovery" : "yes") : `no: ${x.reason || ""}`);
  const row = (prov, pubs, ref) => rows.push(h("tr", {},
    h("td", {}, ref.check),
    h("td", { class: "mono small" }, ref.subject),
    h("td", { class: "small" }, prov ? `${prov.source.id} ${prov.source.name}` : h("span", { class: "muted" }, "-")),
    h("td", { class: "mono small" }, (prov || ref).answeredAt.slice(0, 19).replace("T", " ")),
    h("td", { class: "num" }, prov ? usd(prov.costUsd, 3) : "-"),
    h("td", {}, prov ? receiptCell(prov) : h("span", { class: "muted" }, "-")),
    h("td", { class: "small" }, pubs.length ? pubs.map((p) => p.source.name.replace(/^(.*?)s*/, "")).join("; ") : h("span", { class: "muted" }, "-")),
    usedCell(prov || ref)));
  for (const { provs, pubs } of groups.values()) {
    const cross = pubs.filter((p) => !p.recovery);
    const recovered = pubs.filter((p) => p.recovery);
    if (!provs.length) for (const p of pubs) row(null, [p], p);
    else {
      provs.forEach((p, i) => row(p, i === 0 ? cross : [], p));
      for (const p of recovered) row(null, [p], p);
    }
  }
  const answers = plan.evidence.filter((x) => x.source.kind !== "public").length;
  const rejected = plan.evidence.filter((x) => !x.accepted).length;
  const summary = `Evidence: ${rows.length} checks · ${answers} ${live ? "provider answers" : "provider answers (DEMO stand-ins)"} · ${rejected ? rejected + " rejected" : "all used"}`;
  return h("details", { class: "evidence" }, h("summary", {}, summary),
    h("div", { class: "tablewrap" }, h("table", {},
      h("caption", {}, live ? "Each row is one check: the provider's answer with its receipt, and the free public data it was compared with." : "DEMO: providers are recorded stand-in answers and receipts start with fixture:, so none of this was bought."),
      h("thead", {}, h("tr", {}, ["Check", "Subject", "Provider", "Answered (UTC)", "Cost", "Receipt", "Public cross-check", "Used"].map((t, i) => h("th", { class: i === 4 ? "num" : "" }, t)))),
      h("tbody", {}, rows))));
}
const stat = (value, label) => h("div", { class: "stat" }, h("b", {}, value), h("span", {}, label));

async function loadRecent() {
  const box = $("recent");
  try {
    const { runs } = await getJson("/public/runs");
    if (!runs.length) return box.replaceChildren(h("div", { class: "empty" }, "No live runs since the last restart."));
    box.replaceChildren(...runs.map((r) => h("button", { type: "button", onclick: async () => {
      try { renderResult(await getJson(`/public/runs/${r.id}`)); } catch (error) { notice(error.message, false); }
    } },
      h("span", {}, `${r.site} · ${Object.entries(r.actions).map(([a, n]) => `${n} ${a}`).join(", ")}`),
      h("span", { class: "mono" }, `${usd(r.costUsd)} · ${r.calls} calls`),
      h("span", { class: "mono" }, r.at.slice(5, 16).replace("T", " ") + "Z"))));
  } catch {
    box.replaceChildren(h("div", { class: "empty" }, "Could not load recent runs."));
  }
}

/* ---------- recorded ---------- */
async function loadRecorded() {
  const box = $("recorded");
  try {
    const d = await getJson("/public/recorded");
    const max = Math.max(...d.hours.map((x) => x.margin));
    box.replaceChildren(
      h("div", { class: "chips" }, h("span", { class: "tag" }, d.label), h("span", { class: "tag" }, `plan ${d.planId}`), h("span", { class: "tag" }, `generated ${d.generatedAt}`), h("span", { class: "tag" }, `window ${d.window}`)),
      h("div", { class: "stats" },
        stat(d.summary.hours, "every hour"),
        stat(`${d.summary.marginFirst} to ${d.summary.marginLast}`, "margin per MWh, first to last hour"),
        stat(`${d.summary.calls} calls · ${d.summary.cost}`, `Telegraph spend, cap ${d.summary.cap}, no breach`),
        stat(d.summary.revenue, "revenue per MWh"),
        stat(d.summary.missing, "missing checks")),
      h("div", { class: "strip" }, d.hours.map((x) => h("div", { class: `cell ${x.action}` }, h("b", {}, x.hour), x.action))),
      h("div", { class: "tablewrap" }, h("table", {},
        h("caption", {}, "Margin per hour, as the Mind reported it."),
        h("thead", {}, h("tr", {}, h("th", {}, "Hour (UTC)"), h("th", {}, "Action"), h("th", { class: "num" }, "Margin $/MWh"), h("th", {}, ""))),
        h("tbody", {}, d.hours.map((x) => h("tr", {}, h("td", { class: "mono" }, x.hour), h("td", {}, h("span", { class: `tag ${x.action}` }, x.action)),
          h("td", { class: "num" }, usd(x.margin), h("span", { class: "mbar", style: `width:${Math.round((x.margin / max) * 70)}px` })), h("td", { class: "muted small" }, x.note || ""))))),
      ),
      h("h3", { class: "sub" }, "Receipts"),
      h("div", { class: "tablewrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Check", "Provider", "What it said", "Cost", "Receipt"].map((t, i) => h("th", { class: i === 3 ? "num" : "" }, t)))),
        h("tbody", {}, d.receipts.map((r) => h("tr", {}, h("td", {}, r.check), h("td", { class: "mono small" }, r.provider), h("td", { class: "small" }, r.detail), h("td", { class: "num" }, usd(r.cost)), h("td", { class: "rcpt" }, r.receipt || "-")))))),
      h("p", { class: "note" }, d.receiptsNote),
      h("h3", { class: "sub" }, "Two earlier runs that held, and what fixed them"),
      h("p", { class: "muted" }, d.holds.intro),
      h("div", {}, [...d.holds.items.map((i) => h("div", { class: "fix" }, h("b", {}, i.problem), h("span", { class: "muted small" }, i.detail), h("span", { class: "small" }, "Fix: ", i.fix, " ", h("span", { class: "code" }, i.commit)))),
        h("div", { class: "fix" }, h("b", {}, d.holds.mismatch.problem), h("span", { class: "muted small" }, d.holds.mismatch.detail), h("span", { class: "small" }, "Fix: ", h("span", { class: "code" }, d.holds.mismatch.commit)))]),
      h("p", { class: "muted small" }, d.source),
      ...d.notes.map((n) => h("p", { class: "note" }, n)));
  } catch (error) {
    box.replaceChildren(h("div", { class: "empty" }, `Could not load the recorded run: ${error.message}`));
  }
}

/* ---------- compare ---------- */
async function loadCompare() {
  const box = $("compare");
  try {
    const c = await getJson("/public/compare");
    const row = (name) => c.headline.rows.find((r) => r[0].startsWith(name));
    const num = (s) => Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
    const lost = row("Lost to wrong decisions");
    const correct = row("Decisions correct");
    const caught = row("Bad inputs caught");
    const cost = row("Telegraph cost, window total");
    const barPair = (title, a, b, fmt, goodLow) => {
      const m = Math.max(num(a), num(b), 1);
      const mk = (label, v, cls) => h("div", { class: `bar ${cls}` }, h("span", {}, label), h("div", { class: "track" }, h("div", { class: "fill", style: `width:${Math.max(2, (num(v) / m) * 100)}%` }), h("span", { class: `v${(num(v) / m) < 0.18 ? " out" : ""}`, style: (num(v) / m) < 0.18 ? `left:calc(${Math.max(2, (num(v) / m) * 100)}% + 8px)` : "" }, fmt(v))));
      return h("div", {}, h("h3", {}, title), mk("Web-only (A)", a, goodLow ? "bad" : "a"), mk("With Telegraph (B)", b, "b"));
    };
    box.replaceChildren(
      h("div", { class: "chips" },
        h("span", { class: "tag syn" }, "SYNTHETIC bad inputs"), h("span", { class: "tag" }, "offline replay"), h("span", { class: "tag" }, "mostly stand-in Telegraph answers"), h("span", { class: "tag" }, `${c.window.hours} real ERCOT hours, ${c.window.node}`)),
      h("div", { class: "bars" },
        barPair("Lost to wrong decisions, injected window", lost[3], lost[4], (v) => v, true),
        barPair("Decisions correct vs oracle, injected window (of 89)", correct[3], correct[4], (v) => v.split(" ")[0], false)),
      h("div", { class: "stats", style: "margin-top:22px" },
        stat(`${caught[3]} vs ${caught[4]}`, "bad inputs caught: web-only vs Ballast"),
        stat(`${correct[1].split(" ")[0]} both`, "correct on clean data: Telegraph does not change a clean day"),
        stat(cost[4], "Telegraph cost over the injected window, at $0.01 an answer")),
      h("div", { class: "note" }, "The injections are synthetic: 24 failures placed where they hurt a trusting policy most, so the injected figures are bounds, not expected rates. Policy A is a model of a Mind with generic web tools, not an observed Mind. Only two Telegraph answers (a hashprice and a real-time price from 2026-11-19) are recorded; the rest are public-data stand-ins in the miners' shapes with fixture: receipts. Ballast's code is real; the answers are replayed."),
      h("h3", { class: "sub" }, "Whole window"),
      table(c.headline, "Clean is ERCOT's published prices untouched. Injected adds the 24 SYNTHETIC failures."),
      h("h3", { class: "sub" }, "The six injected failures (SYNTHETIC)"),
      table({ header: c.injectedKinds.header.filter((_, i) => i !== 7 && i !== 8), rows: c.injectedKinds.rows.map((r) => r.filter((_, i) => i !== 7 && i !== 8)) }, "Each failure hits the same hours for both policies. DA is day-ahead."),
      h("p", { class: "note" }, "In-sample caveat: three of Ballast's fixes were written after an earlier version of the injected results had been seen, so the injected improvement is partly in-sample. The clean-window result is the less biased check."),
      h("p", { class: "muted small" }, "Reproduce with npm run compare (reads saved data, no network, nothing paid). Figures are read from compare/results.md in the repository."));
  } catch (error) {
    box.replaceChildren(h("div", { class: "empty" }, `Could not load the comparison: ${error.message}`));
  }
}
function table(t, caption) {
  return h("div", { class: "tablewrap" }, h("table", {}, h("caption", {}, caption),
    h("thead", {}, h("tr", {}, t.header.map((x, i) => h("th", { class: i > 0 && /^[\$0-9-]/.test(t.rows[0]?.[i] || "") && t.rows[0][i].length < 24 ? "num" : "" }, x)))),
    h("tbody", {}, t.rows.map((r) => h("tr", {}, r.map((x, i) => h("td", { class: i > 0 && /^[\$0-9-]/.test(x) && x.length < 24 ? "num" : "small" }, x)))))));
}

/* ---------- how it works ---------- */
function setupVideo() {
  const slot = $("video");
  const src = slot.dataset.src;
  if (!src || slot.dataset.ready) return;
  slot.dataset.ready = "1";
  const yt = /youtu(?:\.be\/|be\.com\/(?:watch\?v=|embed\/))([\w-]{6,})/.exec(src);
  if (yt) slot.replaceChildren(h("iframe", { src: `https://www.youtube-nocookie.com/embed/${yt[1]}`, title: "Ballast demo video", allowfullscreen: true, loading: "lazy", referrerpolicy: "strict-origin-when-cross-origin" }));
  else if (/\.(mp4|webm)(\?|$)/.test(src)) slot.replaceChildren(h("video", { src, controls: true, preload: "metadata" }));
  else if (/^https:\/\/player\.vimeo\.com\//.test(src)) slot.replaceChildren(h("iframe", { src, title: "Ballast demo video", allowfullscreen: true, loading: "lazy", referrerpolicy: "strict-origin-when-cross-origin" }));
}

/* ---------- start ---------- */
async function init() {
  $("btn-live").addEventListener("click", () => run("live"));
  $("btn-demo").addEventListener("click", () => run("demo"));
  $("site").addEventListener("change", showSite);
  showTab(location.hash.slice(1));
  try {
    sites = (await getJson("/public/sites")).sites;
    $("site").replaceChildren(...sites.map((s) => h("option", { value: s.id }, s.name)));
    showSite();
  } catch {
    $("site").replaceChildren(h("option", {}, "Could not load sites"));
    $("btn-demo").disabled = $("btn-live").disabled = true;
  }
  await refreshStatus();
  loadRecent();
  setInterval(() => !running && refreshStatus(), 30000);
}
init();
