// Builds cues.json (16:9) and cues-v.json (9:16) from shot-local cue times. Cue time = visual contact - 0.03 s.
import { writeFileSync } from 'node:fs';
const FROM = { s01: 0, s02: 4.8, s03: 12.0, s04: 31.2, s05: 48.0, s06: 67.2, s07: 86.4, s08: 100.8, s09: 112.8 };
const c = (t, type, vol = .4, pitch = 1) => ({ t, type, vol, pitch });
const sh = {
  s01: [...Array.from({ length: 16 }, (_, i) => c(.35 + i * .25 + (i % 3) * .03, 'type', .3, .9 + (i % 4) * .12)), c(4.57, 'pop', .45)],
  s02: [c(-.03, 'thump', .6), c(1.17, 'whoosh', .35), ...[0, 1, 2, 3].map(i => c(1.67 + i * .14, 'tick', .25, 1 + i * .08)), ...[0, 1, 2, 3].map(i => c(3.87 + i * .22, 'tick', .3, 1.1 + i * .06)), c(5.17, 'pop', .3)],
  s03: [c(-.03, 'swish', .35), ...[0, 1, 2, 3, 4].map(i => c(.3 + i * .28, 'tick', .2, .9 + i * .05)), c(1.75, 'whoosh', .25), c(7.17, 'chime', .4), c(9.77, 'pop', .25), ...Array.from({ length: 8 }, (_, i) => c(10.07 + i * .28, 'tick', .25, 1 + i * .04)), c(12.77, 'tick', .3)],
  s04: [c(-.03, 'whoosh', .35), c(.87, 'click', .4), c(4.67, 'click', .4), c(5.67, 'tick', .3, 1.3), c(8.47, 'click', .4), ...Array.from({ length: 7 }, (_, i) => c(8.77 + i * .42, 'tick', .3, 1 + i * .05)), c(12.67, 'click', .4), c(13.7, 'success', .35)],
  s05: [c(-.03, 'thump', .5), c(3.77, 'error', .3), c(7.57, 'error', .35), c(11.57, 'error', .35), c(14.57, 'click', .35), c(16.97, 'success', .35)],
  s06: [c(.27, 'type', .25), c(.87, 'type', .25), c(1.37, 'type', .25), c(1.87, 'type', .25), c(2.17, 'type', .25), c(2.57, 'click', .3), c(3.57, 'type', .25), c(3.97, 'error', .3), c(4.57, 'type', .25), c(5.07, 'type', .25), c(5.57, 'type', .25), c(7.0, 'riser', .35), c(8.77, 'thump', .5), c(9.57, 'thump', .5), c(10.0, 'tick', .3), c(10.8, 'tick', .3), c(11.6, 'tick', .3)],
  s07: [c(.17, 'type', .25), c(.57, 'type', .25), c(.87, 'type', .25), c(1.37, 'type', .25), c(2.37, 'type', .25), c(2.97, 'type', .25), c(3.87, 'type', .25), c(4.17, 'click', .4), c(4.87, 'type', .25), c(5.77, 'type', .25), c(7.37, 'type', .25), c(7.97, 'type', .25), c(8.57, 'type', .25), c(9.17, 'error', .35), c(9.57, 'type', .25), c(10.47, 'type', .25)],
  s08: [c(.17, 'pop', .35), c(.97, 'whoosh', .3), c(1.57, 'pop', .35), c(2.37, 'whoosh', .3), c(2.97, 'pop', .35), c(3.77, 'tick', .3), c(4.07, 'tick', .3), c(4.37, 'tick', .3), c(6.77, 'chime', .4)],
  s09: [c(.57, 'sparkle', .3), c(1.77, 'success', .45)],
};
const bars = []; for (let t = 4.8; t < 118; t += 2.4) bars.push(c(+t.toFixed(2), 'thump', .16));
const flat = Object.entries(sh).flatMap(([k, a]) => a.map(x => ({ ...x, t: +(FROM[k] + x.t).toFixed(3) })));
const all = [...flat, ...bars].filter(x => x.t >= 0).sort((a, b) => a.t - b.t);
writeFileSync('cues.json', JSON.stringify(all, null, 1));
// 9:16: segments [shot, from, to]
const VSEG = [['s01', 0, 4.8], ['s03', 0, 14.0], ['s04', 0, 8.4], ['s09', 2.8, 7.2]];
let off = 0; const v = [];
for (const [id, f, to] of VSEG) { for (const x of sh[id]) if (x.t >= f && x.t < to) v.push({ ...x, t: +(off + x.t - f).toFixed(3) }); off += to - f; }
for (let t = 0; t < off; t += 2.4) v.push(c(+t.toFixed(2), 'thump', .16));
writeFileSync('cues-v.json', JSON.stringify(v.filter(x => x.t >= 0).sort((a, b) => a.t - b.t), null, 1));
console.log(all.length, v.length, 'cues; vertical dur', off);
