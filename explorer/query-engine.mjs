// The explorer's database, bundled on its own (dist/query-engine.<hash>.js): duckdb-wasm over the
// view's Rós Madair substrate and its own tables (src/search-index.mjs, src/tables.mjs), which it
// range-reads, fetching only the row groups a query needs; and Rós Madair's compiler (the
// `ros-madair` npm package, the same IR -> SQL lowering its native reader runs) for filters.
//
// Views, for SQL here and for the compiler's:
//   resources      one row per entry: resource_id, model, graph_id, key, name, layers, general
//   edges          every link: the substrate's (one row per link target) and the [[reference]]
//                  mentions (src_node 'mentions'), in the same columns
//   concept_index, ordered_index   the substrate's melted concept and ordered (date, number) stores
//   tiles          the compiler's; pointed at the queried model's own file before each filter,
//                  because its SQL does not name the model, and with no filter (or a `not`) it
//                  would read every model's resources
// A model's tiles are also read directly (tiles_<graph id>.parquet), for Alizarin to hydrate.
//
// Edits made in this browser are a layer over all of these: see engine-sql.mjs.

import * as duckdb from '@duckdb/duckdb-wasm';
import initCompiler, { Compiler } from 'ros-madair';
import { sqlString, draftTablesSql, viewsSql, tilesViewSql, overlaySql, windowSql, readable } from './engine-sql.mjs';

// duckdb: the directory of duckdb-wasm's files; compiler: the compiler's WASM; substrate and
// tables: the view's directories; graphs: the view's Arches model documents (JSON text); suffix:
// the build's ?v= cache key, for the data only.
// extensions: { version, repository } where the site serves DuckDB's extensions, if it does.
export async function openEngine({ duckdb: duckdbDir, compiler: compilerWasm, extensions = null, substrate, tables, graphs, suffix = '' }) {
  const [manifest, tableManifest] = await Promise.all([
    fetch(`${substrate}manifest.json${suffix}`).then(r => { if (!r.ok) throw new Error(`substrate manifest: HTTP ${r.status}`); return r.json(); }),
    // The view's own tables list their sizes as the substrate's manifest does (an older build has none).
    fetch(`${tables}manifest.json${suffix}`).then(r => (r.ok ? r.json() : { artifacts: [] })).catch(() => ({ artifacts: [] })),
    initCompiler({ module_or_path: compilerWasm }),
  ]);
  const compiler = new Compiler(`[${graphs.join(',')}]`);

  // The exception-handling build only: every current browser has it.
  const worker = new Worker(`${duckdbDir}duckdb-browser-eh.worker.js`);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(`${duckdbDir}duckdb-eh.wasm`);
  const conn = await db.connect();
  const url = (dir, f) => new URL(`${f}${suffix}`, new URL(dir, location.href)).href;
  const files = manifest.artifacts.map(a => a.path).filter(p => p.endsWith('.parquet'));
  // The view's own tables (a closed view's grants among them, access.parquet).
  const own = tableManifest.artifacts.length ? tableManifest.artifacts.map(a => a.path) : ['resources.parquet', 'mentions.parquet'];
  const where = f => (own.includes(f) ? tables : substrate);
  // How each file is read. DuckDB in the browser reads a file over HTTP a piece at a time, one
  // request after another (its size, its footer, then the row groups a query needs), and a query
  // over a view opens every file behind it: for a small world, dozens of round trips a page. So a
  // small file is fetched whole, side by side with the others, and read from memory: the views'
  // files when the engine opens, a model's tiles the first time they are asked for. A large one,
  // or any past the budget, is range-read as before, so a world of any size still opens.
  const size = new Map([...manifest.artifacts, ...tableManifest.artifacts].map(a => [a.path, a.bytes]));
  const SMALL = 512 * 1024;
  let budget = 8 * 1024 * 1024;
  const whole = new Map();   // file -> promise of it in memory
  const ranged = new Set();
  const byRange = async f => { ranged.add(f); await db.registerFileURL(f, url(where(f), f), duckdb.DuckDBDataProtocol.HTTP, false); };
  const inMemory = f => whole.get(f) ?? whole.set(f, fetch(url(where(f), f))
    .then(r => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.arrayBuffer(); })
    .then(b => db.registerFileBuffer(f, new Uint8Array(b)))
    .catch(() => byRange(f))).get(f);   // a whole fetch that fails falls back to reading by range
  const small = f => size.has(f) && size.get(f) <= SMALL && (budget -= size.get(f)) >= 0;
  const viewsFiles = [...files.filter(f => !f.startsWith('tiles_')), ...own];
  const lazy = new Set();
  for (const f of [...viewsFiles, ...files.filter(f => f.startsWith('tiles_'))]) {
    if (!small(f)) await byRange(f);
    else if (f.startsWith('tiles_')) lazy.add(f);
  }
  await Promise.all(viewsFiles.filter(f => !ranged.has(f)).map(inMemory));
  // A model's tiles, ready to read (fetched whole the first time, if it is a small file).
  const ready = gids => Promise.all(gids.map(g => `tiles_${g}.parquet`).filter(f => lazy.has(f)).map(inMemory));
  const all = prefix => `[${files.filter(f => f.startsWith(`${prefix}_`)).map(f => `'${f}'`).join(', ')}]`;
  // The first read_parquet loads DuckDB's Parquet reader, an extension: from the site when it
  // serves one for this DuckDB, else (or if that fails) from extensions.duckdb.org.
  const repo = async r => {
    for (const k of ['custom_extension_repository', 'autoinstall_extension_repository']) await conn.query(r ? `SET ${k} = '${r}'` : `RESET ${k}`);
  };
  const ours = extensions && (await conn.query('SELECT version() AS v')).toArray()[0]?.v === extensions.version;
  const first = `CREATE OR REPLACE VIEW resources AS SELECT * FROM read_parquet('resources.parquet')`;
  try {
    if (ours) await repo(extensions.repository);
    await conn.query(first);
  } catch (err) {
    try {
      if (!ours) throw err;
      await repo(null);
      await conn.query(first);
    } catch (err2) {
      throw new Error(`DuckDB could not load its Parquet reader (${err2?.message ?? err2})`);
    }
  }
  // Parquet footers, once read, kept (the setting comes with the Parquet reader, now loaded).
  await conn.query('SET parquet_metadata_cache = true').catch(() => {});
  for (const sql of draftTablesSql()) await conn.query(sql);
  let edited = false;   // whether the edit layer has anything in it
  let windowed = false; // whether a closed view's window is on (engine-sql.mjs)
  const file = f => `'${f}'`;
  const views = async () => { for (const sql of viewsSql({ file, all, edited, windowed })) await conn.query(sql); };
  await views();
  const has = prefix => files.some(f => f.startsWith(`${prefix}_`));
  const caps = [files.includes('concept_catalog.parquet'), has('edges'), has('concepts'), has('ordered'), false];

  // One statement at a time (a filter points `tiles` at its model first). Rows as plain objects,
  // with DuckDB's 64-bit integers as numbers and its lists as arrays.
  let queue = Promise.resolve();
  const serial = run => { const p = queue.then(run); queue = p.catch(() => {}); return p; };
  const plain = v => (typeof v === 'bigint' ? Number(v) : v && typeof v.toArray === 'function' ? [...v.toArray()].map(plain) : v);
  const rows = sql => serial(async () => (await conn.query(sql)).toArray().map(r => Object.fromEntries(Object.entries(r.toJSON()).map(([k, v]) => [k, plain(v)]))));
  return {
    rows,
    // The ids of a model's entries that match `where` (Rós Madair's query IR), or all of them.
    async select(graphid, where) {
      await ready([graphid]);
      return serial(async () => {
        const sql = compiler.compile(JSON.stringify({ model: graphid, measures: ['select_ids'], ...(where ? { where } : {}) }), ...caps);
        await conn.query(tilesViewSql({ file, graphid, edited, windowed }));
        return (await conn.query(sql)).toArray().map(r => r.resource_id);
      });
    },
    // Models' tiles fetched ahead, side by side, for a page about to read several.
    prefetch: ready,
    // The edited entries, as rows of each draft table ({ resources: [...], tiles: [...], ... },
    // columns as in DRAFT_TABLES), replacing those there were.
    overlay: drafts => serial(async () => {
      for (const sql of overlaySql(drafts)) await conn.query(sql);
      edited = (drafts.resources ?? []).length > 0;
      await views();
    }),
    // A closed view's window: what one principal (and its groups) may see up to an epoch
    // ({ principals, epoch }), or null for everything.
    window: spec => serial(async () => {
      if (spec) await conn.query(windowSql(spec));
      windowed = !!spec;
      await views();
    }),
    // A model's tiles for some of its entries, as published (and as far as the window lets them
    // be read), for Alizarin.
    async tiles(graphid, ids) {
      await ready([graphid]);
      return rows(`SELECT resource_id, tileid, nodegroup_id, parenttile_id, sortorder, data FROM read_parquet('tiles_${graphid}.parquet')
        WHERE resource_id IN (${ids.map(sqlString).join(', ')})${windowed ? ` AND ${readable('resource_id', 'nodegroup_id')}` : ''} ORDER BY resource_id, nodegroup_id, sortorder`);
    },
  };
}

export { sqlString };
