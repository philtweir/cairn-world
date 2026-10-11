// The query engine for filters, bundled on its own (dist/query-engine.js) and loaded only when a
// filter is first used: Rós Madair's compiler (the `ros-madair` npm package, the same IR -> SQL
// lowering its native reader runs) and duckdb-wasm, which runs that SQL over the view's substrate
// (src/search-index.mjs), range-reading only the row groups a query needs.
//
// The compiler's SQL reads five logical tables. `edges`, `concept_index` and `ordered_index` are
// every model's files together (their rows are keyed by node, so models do not mix); `tiles` is
// pointed at the queried model's own file before each query, because SQL with no filter (or a
// `not`) reads every resource in `tiles`, which would otherwise be every model's.

import * as duckdb from '@duckdb/duckdb-wasm';
import initCompiler, { Compiler } from 'ros-madair';

// duckdb: the directory of duckdb-wasm's files; compiler: the compiler's WASM; substrate: the view's
// substrate directory (with its manifest.json); graphs: the view's Arches model documents (JSON
// text); suffix: the build's ?v= cache key, for the data only.
export async function openEngine({ duckdb: duckdbDir, compiler: compilerWasm, substrate, graphs, suffix = '' }) {
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
  const files = manifest.artifacts.map(a => a.path).filter(p => p.endsWith('.parquet'));
  for (const f of files) await db.registerFileURL(f, new URL(`${f}${suffix}`, new URL(substrate, location.href)).href, duckdb.DuckDBDataProtocol.HTTP, false);
  const all = prefix => `[${files.filter(f => f.startsWith(`${prefix}_`)).map(f => `'${f}'`).join(', ')}]`;
  // The first read_parquet loads DuckDB's Parquet reader, an extension it fetches from
  // extensions.duckdb.org; without it (offline, or blocked) nothing can be filtered.
  try {
    await conn.query(`CREATE VIEW edges AS SELECT * FROM read_parquet(${all('edges')})`);
  } catch (err) {
    throw new Error(`DuckDB could not load its Parquet reader from extensions.duckdb.org (${err?.message ?? err})`);
  }
  await conn.query(`CREATE VIEW concept_index AS SELECT * FROM read_parquet(${all('concepts')})`);
  await conn.query(`CREATE VIEW ordered_index AS SELECT * FROM read_parquet(${all('ordered')})`);
  const has = prefix => files.some(f => f.startsWith(`${prefix}_`));
  const caps = [files.includes('concept_catalog.parquet'), has('edges'), has('concepts'), has('ordered'), false];

  // One query at a time: each points `tiles` at its own model first.
  let queue = Promise.resolve();
  return {
    // The ids of a model's entries that match `where` (Rós Madair's query IR), or all of them.
    select(graphid, where) {
      const run = async () => {
        const sql = compiler.compile(JSON.stringify({ model: graphid, measures: ['select_ids'], ...(where ? { where } : {}) }), ...caps);
        await conn.query(`CREATE OR REPLACE VIEW tiles AS SELECT * FROM read_parquet('tiles_${graphid}.parquet')`);
        return (await conn.query(sql)).toArray().map(r => r.resource_id);
      };
      const p = queue.then(run);
      queue = p.catch(() => {});
      return p;
    },
  };
}
