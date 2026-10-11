// The query engine's SQL (explorer/query-engine.mjs), apart from DuckDB itself: the views every
// query reads, and the edit layer's tables under them.
//
// Edits made in this browser (explorer/drafts.mjs) are one more layer: their entries, already
// composed over the published ones, sit in tables of the published shape (draft_*), and each view
// reads the published rows of entries without edits plus the edited rows. With no edits, the
// views read the Parquet alone.

export const sqlString = s => `'${String(s).replace(/'/g, "''")}'`;
const sqlValue = v => (v == null ? 'NULL' : Array.isArray(v) ? `[${v.map(sqlValue).join(', ')}]` : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : typeof v === 'boolean' ? String(v) : sqlString(v));

// The edit layer's tables: the published tables' columns (Rós Madair's substrate and resources).
export const DRAFT_TABLES = {
  resources: 'resource_id VARCHAR, model VARCHAR, graph_id VARCHAR, key VARCHAR, name VARCHAR, layers VARCHAR[], general BOOLEAN',
  tiles: 'graph_id VARCHAR, resource_id VARCHAR, descriptor_name VARCHAR, nodegroup_id VARCHAR, tileid VARCHAR, parenttile_id VARCHAR, sortorder INTEGER, geo_min_lng DOUBLE, geo_min_lat DOUBLE, geo_max_lng DOUBLE, geo_max_lat DOUBLE, data VARCHAR',
  concepts: 'resource_id VARCHAR, tile_id VARCHAR, nodegroup_id VARCHAR, node_id VARCHAR, concept_id VARCHAR',
  ordered: 'resource_id VARCHAR, tile_id VARCHAR, nodegroup_id VARCHAR, node_id VARCHAR, q_ordered BIGINT',
  edges: 'src_resource VARCHAR, src_node VARCHAR, src_nodegroup VARCHAR, src_tile VARCHAR, target_resource VARCHAR',
};
export const draftTablesSql = () => Object.entries(DRAFT_TABLES).map(([t, cols]) => `CREATE TABLE draft_${t} (${cols})`);

// file(name): a file's name as read_parquet takes it; all(prefix): every substrate file of a kind.
const over = (sql, id, draft, edited) => (!edited ? sql
  : `SELECT * FROM (${sql}) WHERE ${id} NOT IN (SELECT resource_id FROM draft_resources) UNION ALL BY NAME SELECT * FROM ${draft}`);
export function viewsSql({ file, all, edited }) {
  return [
    `CREATE OR REPLACE VIEW resources AS ${over(`SELECT * FROM read_parquet(${file('resources.parquet')})`, 'resource_id', 'draft_resources', edited)}`,
    `CREATE OR REPLACE VIEW edges AS ${over(`SELECT src_resource, src_node, src_nodegroup, src_tile, target_resource FROM read_parquet(${all('edges')})
      UNION ALL SELECT src_resource, src_node, src_nodegroup, src_tile, target_resource FROM read_parquet(${file('mentions.parquet')})`, 'src_resource', 'draft_edges', edited)}`,
    `CREATE OR REPLACE VIEW concept_index AS ${over(`SELECT resource_id, tile_id, nodegroup_id, node_id, concept_id FROM read_parquet(${all('concepts')})`, 'resource_id', 'draft_concepts', edited)}`,
    `CREATE OR REPLACE VIEW ordered_index AS ${over(`SELECT resource_id, tile_id, nodegroup_id, node_id, q_ordered FROM read_parquet(${all('ordered')})`, 'resource_id', 'draft_ordered', edited)}`,
  ];
}
// The compiler's `tiles`: one model's (its SQL does not name the model).
export const tilesViewSql = ({ file, graphid, edited }) => `CREATE OR REPLACE VIEW tiles AS ${over(`SELECT * FROM read_parquet(${file(`tiles_${graphid}.parquet`)})`, 'resource_id',
  `(SELECT * EXCLUDE (graph_id) FROM draft_tiles WHERE graph_id = ${sqlString(graphid)})`, edited)}`;

// The edit layer's rows ({ resources: [...], tiles: [...], ... }, columns as in DRAFT_TABLES), in
// place of those there were.
export function overlaySql(drafts) {
  const out = [];
  for (const [t, decl] of Object.entries(DRAFT_TABLES)) {
    out.push(`DELETE FROM draft_${t}`);
    const rs = drafts[t] ?? [], cols = decl.split(', ').map(c => c.split(' ')[0]);
    for (let i = 0; i < rs.length; i += 200) {
      out.push(`INSERT INTO draft_${t} (${cols.join(', ')}) VALUES ${rs.slice(i, i + 200).map(r => `(${cols.map(c => sqlValue(r[c])).join(', ')})`).join(', ')}`);
    }
  }
  return out;
}
