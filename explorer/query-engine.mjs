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

import * as duckdb from '@duckdb/duckdb-wasm';
import initCompiler, { Compiler } from 'ros-madair';

// duckdb: the directory of duckdb-wasm's files; compiler: the compiler's WASM; substrate and
// tables: the view's directories; graphs: the view's Arches model documents (JSON text); suffix:
// the build's ?v= cache key, for the data only.
// extensions: { version, repository } where the site serves DuckDB's extensions, if it does.
export async function openEngine({ duckdb: duckdbDir, compiler: compilerWasm, extensions = null, substrate, tables, graphs, suffix = '' }) {
  const [manifest] = await Promise.all([
    fetch(`${substrate}manifest.json${suffix}`).then(r => { if (!r.ok) throw new Error(`substrate manifest: HTTP ${r.status}`); return r.json(); }),
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
  for (const f of files) await db.registerFileURL(f, url(substrate, f), duckdb.DuckDBDataProtocol.HTTP, false);
  for (const f of ['resources.parquet', 'mentions.parquet']) await db.registerFileURL(f, url(tables, f), duckdb.DuckDBDataProtocol.HTTP, false);
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
  await conn.query(`CREATE VIEW edges AS SELECT src_resource, src_node, src_nodegroup, src_tile, target_resource FROM read_parquet(${all('edges')})
    UNION ALL SELECT src_resource, src_node, src_nodegroup, src_tile, target_resource FROM read_parquet('mentions.parquet')`);
  await conn.query(`CREATE VIEW concept_index AS SELECT * FROM read_parquet(${all('concepts')})`);
  await conn.query(`CREATE VIEW ordered_index AS SELECT * FROM read_parquet(${all('ordered')})`);
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
    select: (graphid, where) => serial(async () => {
      const sql = compiler.compile(JSON.stringify({ model: graphid, measures: ['select_ids'], ...(where ? { where } : {}) }), ...caps);
      await conn.query(`CREATE OR REPLACE VIEW tiles AS SELECT * FROM read_parquet('tiles_${graphid}.parquet')`);
      return (await conn.query(sql)).toArray().map(r => r.resource_id);
    }),
    // A model's tiles for some of its entries, for Alizarin.
    tiles: (graphid, ids) => rows(`SELECT resource_id, tileid, nodegroup_id, parenttile_id, sortorder, data FROM read_parquet('tiles_${graphid}.parquet')
      WHERE resource_id IN (${ids.map(sqlString).join(', ')}) ORDER BY resource_id, nodegroup_id, sortorder`),
  };
}

export const sqlString = s => `'${String(s).replace(/'/g, "''")}'`;
