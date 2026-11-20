// npm run compare: reproduces results.json and results.md from the data saved in compare/data/. No network, no Telegraph call, no payment.
import { writeFileSync } from "node:fs";
import { runAll } from "./compare.ts";
import { renderMarkdown } from "./render.ts";

const results = await runAll();
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
writeFileSync(new URL("./results.md", import.meta.url), renderMarkdown(results));
console.log(`compare: ${results.window.hours} hours in ${results.runtimeSeconds}s, wrote compare/results.json and compare/results.md`);
for (const sc of Object.values(results.scenarios)) {
  console.log(sc.title);
  for (const p of sc.policies) console.log(`  ${p.id.padEnd(5)} correct ${p.metrics.correct}/${p.metrics.decisions}  realized $${p.metrics.realizedUsd}  holds ${p.metrics.holds}  Telegraph cost $${p.metrics.telegraphCostUsd}`);
}
