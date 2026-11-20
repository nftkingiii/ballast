// npm run monitor -- --site sites/west-texas.json [--timeline fixtures/monitor-demo.json] [--cap 0.5] [--log out.json] [--json]
// Demo (default): replays a timeline quickly, no waiting, no network, nothing paid.
// Live: --live --paid --cap <usd> [--every 15] [--ticks n] buys real answers on a cadence. Not for tests or demos.
import { readFileSync } from "node:fs";
import { parseSite } from "./config.ts";
import { DEFAULT_MONITOR_CAP_USD, DEFAULT_TIMELINE, DemoMonitor, demoTimelineNames } from "./monitor-demo.ts";
import { renderHeader, renderSummary, renderTick } from "./monitor-render.ts";
import { runLive } from "./monitor.ts";
import { loadTimeline } from "./timeline.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const USAGE = `ballast monitor [--site sites/west-texas.json] [--timeline fixtures/monitor-demo.json] [--cap <usd>] [--log <file.json>] [--json]

Default is DEMO: replays a recorded/SYNTHETIC timeline (${demoTimelineNames().join(", ")}) one tick per cadence step,
with no real waiting, no network and no payment. --cap is the whole-session spend cap.
--live --paid --cap <usd> [--every <min>] [--ticks <n>] runs against real providers every <min> minutes (default 15) and
stops at the session cap; credentials come from the environment (ANJOMAN_API_KEY or BALLAST_SIGNER_MODULE).`;

if (flag("help") || args[0] === "help") {
  console.log(USAGE);
  process.exit(0);
}

try {
  const site = parseSite(JSON.parse(readFileSync(value("site") ?? "sites/west-texas.json", "utf8")));
  const log = value("log");
  const json = flag("json");
  const cap = value("cap") === undefined ? undefined : Number(value("cap"));
  if (cap !== undefined && !(Number.isFinite(cap) && cap >= 0)) throw new Error("--cap must be a number of USD");

  if (flag("live")) {
    if (flag("timeline")) throw new Error("--live cannot be combined with --timeline");
    const session = await runLive({
      site, paid: flag("paid"), capUsd: cap ?? NaN, cadenceMin: Number(value("every") ?? 15), maxTicks: value("ticks") ? Number(value("ticks")) : undefined,
      onTick: (r, s) => {
        if (!json) console.log(`${r.tick === 0 ? `${renderHeader(s)}\n` : ""}${renderTick(r)}\n`);
        if (log) s.writeLog(log);
      },
    });
    if (json) console.log(JSON.stringify(session, null, 2));
    else console.log(renderSummary(session));
  } else {
    if (flag("paid")) throw new Error("--paid only applies with --live; the demo never buys anything");
    const timeline = loadTimeline(value("timeline") ?? DEFAULT_TIMELINE);
    const demo = new DemoMonitor(site, timeline, undefined, cap ?? timeline.sessionCapUsd ?? DEFAULT_MONITOR_CAP_USD);
    if (!json) console.log(renderHeader(demo.session, [`Cadence: ${timeline.cadenceMin} min (ERCOT real-time intervals), ${demo.total} ticks, replayed without waiting.`]));
    await demo.runAll((r) => {
      if (!json) console.log(`${renderTick(r, demo.total)}\n`);
      if (log) demo.session.writeLog(log);
    });
    if (json) console.log(JSON.stringify(demo.session, null, 2));
    else console.log(renderSummary(demo.session));
  }
} catch (error) {
  console.error(`ballast monitor: ${(error as Error).message}`);
  process.exit(1);
}
