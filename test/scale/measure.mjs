// What each page of the explorer reads, for one built world (test/scale/README.md): the real
// explorer in Chromium; its query engine in a process of its own (test/scale/engine-server.mjs)
// traced with strace, so every byte DuckDB reads from the view's Parquet is counted; the static
// server here counting every other file the browser fetches.
//
//   NODE_PATH=$(npm root -g) node test/scale/measure.mjs <dist dir> <out.json> [view]
//
// Per page: engine bytes (the union of the byte ranges read; and every read, re-reads included),
// files opened, and requests (reads
// merged where they are within 16 KB of each other, roughly what an HTTP range reader would
// ask for); and the browser's own fetches (JSON, the Pagefind index), as bytes and requests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(process.env.NODE_PATH ?? '', 'x'));
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [distArg, outArg, view = 'scale'] = process.argv.slice(2);
const dist = path.resolve(distArg), viewsDir = path.join(dist, 'data', 'views');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-scale-'));
const trace = path.join(work, 'trace.txt'), markDir = path.join(work, 'marks');

// ---- The static site, counting what it serves per page ----------------------------------------
let label = 'boot';
const served = {};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const site = http.createServer((req, res) => {
  const p = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
  const body = fs.readFileSync(f);
  (served[label] ??= { bytes: 0, requests: 0, files: {} });
  served[label].bytes += body.length; served[label].requests++;
  const rel = path.relative(dist, f); served[label].files[rel] = (served[label].files[rel] ?? 0) + body.length;
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }).end(body);
});
await new Promise(r => site.listen(0, r));
const sitePort = site.address().port;

// ---- The engine, traced -----------------------------------------------------------------------
const enginePort = sitePort + 1;
const traced = spawn('strace', ['-f', '-qq', '-e', 'trace=openat,pread64,read,close', '-o', trace, 'node', path.join(HERE, 'engine-server.mjs'), viewsDir, String(enginePort), markDir],
  { stdio: ['ignore', 'pipe', 'inherit'], cwd: path.resolve(HERE, '../..') });
await new Promise((resolve, reject) => { traced.stdout.on('data', d => /engine on/.test(d) && resolve()); traced.on('exit', c => reject(new Error(`engine exited ${c}`))); });
let inflight = 0, last = Date.now();
const engine = async (route, body) => {
  inflight++;
  try { return await (await fetch(`http://127.0.0.1:${enginePort}/${route}`, { method: 'POST', body: JSON.stringify(body) })).text(); }
  finally { inflight--; last = Date.now(); }
};
const mark = async name => { label = name; await engine('mark', { name }); };

// ---- The explorer -----------------------------------------------------------------------------
const browser = await chromium.launch();
const results = {};
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => console.error('page error:', String(e)));
  await page.route('**/query-engine.*.js', r => r.fulfill({ contentType: 'text/javascript', body: `
    const post = (route, body) => fetch('/__engine/' + route, { method: 'POST', body: JSON.stringify(body) }).then(async r => { const j = await r.json(); if (j && j.error) throw new Error(j.error); return j; });
    export async function openEngine({ graphs }) {
      const view = location.hash.split('/')[1];
      await post('open', { view, graphs });
      return { rows: sql => post('rows', { view, sql }), tiles: (graphid, ids) => post('tiles', { view, graphid, ids }), select: (graphid, where) => post('select', { view, graphid, where }),
        overlay: drafts => post('overlay', { view, drafts }), window: spec => post('window', { view, spec }), prefetch: async () => {} };
    }` }));
  await page.route('**/__engine/*', async r => r.fulfill({ contentType: 'application/json', body: await engine(new URL(r.request().url()).pathname.split('/').pop(), JSON.parse(r.request().postData() || '{}')) }));
  return page;
}
// Wait for the page, then for the engine to fall quiet.
async function settle(page) {
  await page.waitForSelector('#detail h1, #detail .empty', { timeout: 300000 });
  while (inflight > 0 || Date.now() - last < 1500) await new Promise(r => setTimeout(r, 200));
}
const at = hash => `http://127.0.0.1:${sitePort}/${hash}`;
const plan = [
  ['open', p => p.goto(at(`#/${view}/`))],
  ['lens-places', p => p.evaluate(h => { location.hash = h; }, `#/${view}/@places`)],
  ['lens-time', p => p.evaluate(h => { location.hash = h; }, `#/${view}/@time`)],
  ['lens-actors', p => p.evaluate(h => { location.hash = h; }, `#/${view}/@actors`)],
  ['entry-npc', p => p.evaluate(h => { location.hash = h; }, `#/${view}/npc/npc-17`)],
  ['entry-event', p => p.evaluate(h => { location.hash = h; }, `#/${view}/event/event-23`)],
  ['entry-place', p => p.evaluate(h => { location.hash = h; }, `#/${view}/place/place-5`)],
  ['entry-hub', p => p.evaluate(h => { location.hash = h; }, `#/${view}/place/the-world`)],
  ['search', async p => { await p.fill('#q', 'ka'); }],
];
const page = await newPage();
for (const [name, go] of plan) {
  console.error(`… ${name}`);
  await mark(name);
  const t0 = Date.now();
  await go(page);
  await settle(page);
  results[name] = { ms: Date.now() - t0 - 1500 };
}
// A cold start straight onto an entry: a fresh engine and a fresh page.
await engine('reset', {});
const cold = await newPage();
await mark('cold-entry-npc');
{ const t0 = Date.now(); await cold.goto(at(`#/${view}/npc/npc-17`)); await settle(cold); results['cold-entry-npc'] = { ms: Date.now() - t0 - 1500 }; }
await mark('end');
await browser.close();
// The engine exits, and strace with it (it does not answer SIGINT here).
const done = new Promise(r => traced.on('exit', r));
await engine('quit', {}).catch(() => {});
await done;
site.close();

// ---- The trace, cut per page ------------------------------------------------------------------
const fds = new Map(), pending = new Map();
const reads = {};   // label -> path -> [[from, to]]
const opened = {};  // label -> Set of paths
let cut = 'boot';
for (let line of fs.readFileSync(trace, 'utf8').split('\n')) {
  const pid = line.match(/^(\d+)\s+/)?.[1];
  if (!pid) continue;
  line = line.slice(pid.length).trim();
  if (line.endsWith('<unfinished ...>')) { pending.set(pid, line.replace(/\s*<unfinished \.\.\.>$/, '')); continue; }
  const resumed = line.match(/^<\.\.\. \w+ resumed>(.*)$/);
  if (resumed) { line = (pending.get(pid) ?? '') + resumed[1]; pending.delete(pid); }
  let m;
  if ((m = line.match(/^openat\(AT_FDCWD, "([^"]+)", [^)]*\)\s*= (\d+)/))) {
    const [, p, fd] = m;
    if (p.startsWith(markDir)) { cut = path.basename(p); continue; }
    fds.set(fd, p);
    if (p.startsWith(viewsDir) && p.endsWith('.parquet')) (opened[cut] ??= new Set()).add(path.relative(viewsDir, p));
  } else if ((m = line.match(/^close\((\d+)\)/))) fds.delete(m[1]);
  else if ((m = line.match(/^pread64\((\d+), .*, (\d+), (\d+)\)\s*= (\d+)$/))) {
    const [, fd, , off, got] = m, p = fds.get(fd);
    if (!p?.startsWith(viewsDir) || !p.endsWith('.parquet') || !Number(got)) continue;
    ((reads[cut] ??= {})[path.relative(viewsDir, p)] ??= []).push([Number(off), Number(off) + Number(got)]);
  }
}
const GAP = 16 * 1024;
for (const name of Object.keys(results)) {
  let bytes = 0, requests = 0, read = 0;
  const perFile = [];
  for (const [f, ranges] of Object.entries(reads[name] ?? {})) {
    read += ranges.reduce((n, [a, b]) => n + b - a, 0);
    ranges.sort((a, b) => a[0] - b[0]);
    let cur = null;
    const merged = [];
    for (const [a, b] of ranges) {
      if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
      else { if (cur) merged.push(cur); cur = [a, b]; }
    }
    if (cur) merged.push(cur);
    const distinct = merged.reduce((n, [a, b]) => n + b - a, 0);
    bytes += distinct; perFile.push([f, distinct]);
    let run = null;
    for (const [a, b] of merged) { if (run && a - run <= GAP) run = b; else { requests++; run = b; } }
  }
  const s = served[name] ?? { bytes: 0, requests: 0, files: {} };
  // bytes: distinct bytes (each byte once, as a cache would fetch it); read: every read, re-reads
  // included; biggest: the files with the most distinct bytes read.
  results[name] = { ...results[name], engine: { bytes, read, requests, files: opened[name]?.size ?? 0 }, http: { bytes: s.bytes, requests: s.requests },
    biggest: perFile.sort((a, b) => b[1] - a[1]).slice(0, 3) };
}
fs.writeFileSync(outArg, JSON.stringify({ dist, view, pages: results }, null, 1) + '\n');
fs.rmSync(work, { recursive: true, force: true });
for (const [name, r] of Object.entries(results)) console.log(name.padEnd(16), `engine ${String(r.engine.bytes).padStart(9)} B ${String(r.engine.requests).padStart(4)} req ${String(r.engine.files).padStart(3)} files`, `| http ${String(r.http.bytes).padStart(8)} B ${String(r.http.requests).padStart(3)} req`, `| ${r.ms} ms`);
