// A view's own tables beside its Rós Madair substrate, in views/<view>/tables/, for what the
// substrate does not hold yet. The explorer reads them with the same DuckDB, by HTTP range.
//
//   resources.parquet  one row per entry: resource_id, model (alias), graph_id, key (the slug),
//     name, layers (the layers it comes from, bottom first), general (only General has it). Rós
//     Madair's tiles carry neither the slug nor the layers; this is the resource table it lacks,
//     to drop when it has one.
//   mentions.parquet   the links a [[reference]] in text makes (P67 refers to), in Rós Madair's
//     edge columns (src_resource, src_node, src_nodegroup, src_tile, target_resource), so the
//     explorer reads them with the substrate's edges: they are made from text, not stored in a
//     field, so the emitter cannot see them.
//
// Written with DuckDB (@duckdb/node-api), sorted, so the same data gives the same bytes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const lit = p => `'${p.replace(/'/g, "''")}'`;

export async function writeTables(dir, { resources, mentions }) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-tables-'));
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  try {
    const json = (name, rows) => { const f = path.join(tmp, `${name}.json`); fs.writeFileSync(f, JSON.stringify(rows)); return lit(f); };
    await c.run(`COPY (SELECT resource_id::VARCHAR AS resource_id, model::VARCHAR AS model, graph_id::VARCHAR AS graph_id, key::VARCHAR AS key, name::VARCHAR AS name, layers::VARCHAR[] AS layers, general::BOOLEAN AS general
        FROM read_json(${json('resources', resources)}, columns = {resource_id: 'VARCHAR', model: 'VARCHAR', graph_id: 'VARCHAR', key: 'VARCHAR', name: 'VARCHAR', layers: 'VARCHAR[]', general: 'BOOLEAN'})
        ORDER BY model, lower(name), key) TO ${lit(path.join(dir, 'resources.parquet'))} (FORMAT parquet, COMPRESSION zstd)`);
    await c.run(`COPY (SELECT src_resource, src_node, src_nodegroup, src_tile, target_resource
        FROM read_json(${json('mentions', mentions)}, columns = {src_resource: 'VARCHAR', src_node: 'VARCHAR', src_nodegroup: 'VARCHAR', src_tile: 'VARCHAR', target_resource: 'VARCHAR'})
        ORDER BY target_resource, src_resource) TO ${lit(path.join(dir, 'mentions.parquet'))} (FORMAT parquet, COMPRESSION zstd)`);
  } finally {
    c.closeSync?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
