// The explorer's query engine (explorer/query-engine.mjs), stood in for by DuckDB's native build
// in a process of its own, so that test/scale/measure.cjs can trace exactly what it reads. Same
// SQL (explorer/engine-sql.mjs), same files, same Rós Madair compiler; DuckDB native has Parquet
// built in, which the browser's needs to download (and this sandbox cannot).
//
//   node test/scale/engine-server.mjs <dist/data/views dir> <port> <marker dir>
//
// POST /open { view, graphs }, /rows { view, sql }, /tiles { view, graphid, ids },
// /select { view, graphid, where }, /overlay { view, drafts }, /window { view, spec }, and
// /mark { name }, which opens <marker dir>/<name> so a trace of this process can be cut per page; /reset forgets
// every engine, for a cold start.
//
// Every file is read by range, as the browser reads any file too large to fetch whole: what a
// world of any size costs. One thread, so a trace reads in order.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DuckDBInstance } from '@duckdb/node-api';
import { initSync, Compiler } from 'ros-madair';
import { draftTablesSql, viewsSql, tilesViewSql, overlaySql, windowSql, readable } from '../../explorer/engine-sql.mjs';

const [viewsDir, port, markDir] = process.argv.slice(2);
initSync({ module: fs.readFileSync(new URL('../../node_modules/ros-madair/ros_madair_wasm_bg.wasm', import.meta.url)) });
fs.mkdirSync(markDir, { recursive: true });

async function engine(viewDir) {
  const db = await DuckDBInstance.create(':memory:', { threads: '1' });
  const c = await db.connect();
  await c.run('SET parquet_metadata_cache = true');
  const sub = path.join(viewDir, 'substrate'), tab = path.join(viewDir, 'tables');
  const files = JSON.parse(fs.readFileSync(path.join(sub, 'manifest.json'), 'utf8')).artifacts.map(a => a.path).filter(p => p.endsWith('.parquet'));
  const own = JSON.parse(fs.readFileSync(path.join(tab, 'manifest.json'), 'utf8')).artifacts.map(a => a.path);
  const file = f => `'${own.includes(f) ? path.join(tab, f) : path.join(sub, f)}'`;
  const all = p => `[${files.filter(f => f.startsWith(`${p}_`)).map(file).join(', ')}]`;
  for (const sql of draftTablesSql()) await c.run(sql);
  let edited = false, windowed = false;
  const views = async () => { for (const sql of viewsSql({ file, all, edited, windowed })) await c.run(sql); };
  await views();
  const plain = v => (typeof v === 'bigint' ? Number(v) : v && typeof v === 'object' && Array.isArray(v.items) ? v.items.map(plain) : v);
  // The explorer names files as it registers them; here they are paths.
  const rows = async sql => (await c.runAndReadAll(sql.replace(/read_parquet\('([^'/]+\.parquet)'\)/g, (_, f) => `read_parquet(${file(f)})`)))
    .getRowObjectsJS().map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, plain(v)])));
  return {
    rows,
    tiles: (gid, ids) => rows(`SELECT resource_id, tileid, nodegroup_id, parenttile_id, sortorder, data FROM read_parquet('tiles_${gid}.parquet') WHERE resource_id IN (${ids.map(i => `'${i}'`).join(', ')})${windowed ? ` AND ${readable('resource_id', 'nodegroup_id')}` : ''} ORDER BY resource_id, nodegroup_id, sortorder`),
    async select(gid, sql) { await c.run(tilesViewSql({ file, graphid: gid, edited, windowed })); return (await rows(sql)).map(r => r.resource_id); },
    async window(spec) { if (spec) await c.run(windowSql(spec).replace(/read_parquet\('access\.parquet'\)/, `read_parquet(${file('access.parquet')})`)); windowed = !!spec; await views(); },
    async overlay(d) { for (const sql of overlaySql(d)) await c.run(sql); edited = (d.resources ?? []).length > 0; await views(); },
  };
}

const engines = new Map(), compilers = new Map();
const eng = v => engines.get(v) ?? engines.set(v, engine(path.join(viewsDir, v))).get(v);
let queue = Promise.resolve();
const serial = f => { const p = queue.then(f); queue = p.catch(() => {}); return p; };
const routes = {
  open: async b => { if (!compilers.has(b.view)) compilers.set(b.view, new Compiler(`[${b.graphs.join(',')}]`)); await eng(b.view); return {}; },
  rows: async b => (await eng(b.view)).rows(b.sql),
  tiles: async b => (await eng(b.view)).tiles(b.graphid, b.ids),
  select: async b => {
    const sql = compilers.get(b.view).compile(JSON.stringify({ model: b.graphid, measures: ['select_ids'], ...(b.where ? { where: b.where } : {}) }), false, true, true, true, false);
    return (await eng(b.view)).select(b.graphid, sql);
  },
  overlay: async b => { await (await eng(b.view)).overlay(b.drafts); return {}; },
  window: async b => { await (await eng(b.view)).window(b.spec); return {}; },
  mark: async b => { fs.closeSync(fs.openSync(path.join(markDir, b.name), 'w')); return {}; },
  // Forget every view's engine (and so DuckDB's caches), to measure a cold start.
  reset: async () => { engines.clear(); return {}; },
  quit: async () => { setTimeout(() => process.exit(0), 50); return {}; },
};
http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => serial(async () => {
    try {
      const out = await routes[req.url.replace(/^\//, '')](JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  }));
}).listen(Number(port), () => console.log(`engine on ${port}`));
