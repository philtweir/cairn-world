// How each page's reads grow with the size of the world: test/scale/measure.mjs's results for
// worlds of different sizes, side by side, and each measure's growth exponent between the
// smallest and the largest (bytes ~ N^k: 0 is flat, 1 is linear). A page passes if no measure
// grows with an exponent above the limit (default 0.2).
//
//   node test/scale/report.mjs <N>=<measure.json> ... [--limit 0.2]

import fs from 'node:fs';

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf('--limit') + 1]) || 0.2;
const runs = args.filter(a => a.includes('=')).map(a => { const [n, f] = a.split('='); return { n: Number(n), pages: JSON.parse(fs.readFileSync(f, 'utf8')).pages }; }).sort((a, b) => a.n - b.n);
if (runs.length < 2) { console.error('usage: node test/scale/report.mjs <N>=<measure.json> <N>=<measure.json> ... [--limit 0.2]'); process.exit(1); }
const [lo, hi] = [runs[0], runs.at(-1)];
const k = (a, b) => (a > 0 && b > 0 ? Math.log(b / a) / Math.log(hi.n / lo.n) : b > a ? Infinity : 0);
const kb = b => `${(b / 1024).toFixed(0)}K`;
const measures = [['engine bytes', p => p.engine.bytes, kb], ['engine requests', p => p.engine.requests, String], ['browser bytes', p => p.http.bytes, kb]];
let failed = 0;
console.log(`${'page'.padEnd(16)}${'measure'.padEnd(17)}${runs.map(r => `N=${r.n}`.padStart(11)).join('')}   exponent`);
for (const page of Object.keys(hi.pages)) {
  for (const [name, get, fmt] of measures) {
    const e = k(get(lo.pages[page]), get(hi.pages[page]));
    const bad = e > limit;
    failed += bad;
    console.log(`${page.padEnd(16)}${name.padEnd(17)}${runs.map(r => fmt(get(r.pages[page])).padStart(11)).join('')}   ${e.toFixed(2).padStart(5)}${bad ? '  GROWS' : ''}`);
  }
}
console.log(failed ? `\n${failed} measure(s) grow with N faster than N^${limit}` : `\nnothing grows faster than N^${limit}`);
process.exit(failed ? 1 : 0);
