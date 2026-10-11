// What the explorer knows of a view, read as it is needed rather than all at once: the view's
// tables and Rós Madair substrate (through the query engine, query-engine.mjs) for lists, counts
// and links, and Alizarin for an entry's fields, hydrated from its tiles in the substrate (the
// Parquet is Alizarin's tile store: `getResource` is answered from it). So a view of any size
// opens with a few queries, and a page reads only the entries it shows.
//
// Entries go into `state.byId` as they are met: in brief (`light`: id, model, key, layers, name,
// from the resources table) or in full (every field, through Alizarin). `state.back` holds the
// links into an entry, once asked for (backOf).

import { readOne, withMentions, links } from '../src/world-read.mjs';
import { resourceId } from './uuid.mjs';

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const inList = ids => ids.map(q).join(', ');
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// engine: query-engine.mjs's; A: Alizarin; client: an Alizarin ArchesClient set up for the
// view's graphs and collections (its resource methods are replaced here); manifest: the view's.
export function makeStore({ engine, A, client, manifest, state }) {
  const graphOf = Object.fromEntries(manifest.models.map(m => [m.alias, m.graphid]));
  const rowOf = new Map();     // id -> resources row
  const tilesOf = new Map();   // id -> tiles, while it is being hydrated

  const light = r => ({
    model: r.model, id: r.resource_id, key: r.key, layers: r.layers ?? [], light: true,
    fields: [{ alias: 'name', label: 'Name', datatype: 'string', targets: [], collection: null, rule: null, property: null, value: r.name }],
  });
  const remember = rs => {
    for (const r of rs) {
      rowOf.set(r.resource_id, r);
      if (!state.byId.has(r.resource_id)) state.byId.set(r.resource_id, light(r));
    }
    return rs;
  };
  // The resources rows of some entries (those not yet known), so each is in state.byId.
  async function know(ids) {
    const want = [...new Set(ids)].filter(id => id && !rowOf.has(id));
    for (const part of chunks(want, 500)) remember(await engine.rows(`SELECT * FROM resources WHERE resource_id IN (${inList(part)})`));
    return ids.map(id => state.byId.get(id)).filter(Boolean);
  }

  // Alizarin's resources come from the substrate: a resource is its resources row and its tiles.
  async function resource(id) {
    const [r] = rowOf.has(id) ? [rowOf.get(id)] : remember(await engine.rows(`SELECT * FROM resources WHERE resource_id = ${q(id)}`));
    if (!r) throw new Error(`no entry ${id} in this view`);
    const tiles = tilesOf.get(id) ?? await engine.tiles(r.graph_id, [id]);
    return new A.staticTypes.StaticResource({
      metadata: {},
      resourceinstance: { descriptors: { name: r.name }, graph_id: r.graph_id, legacyid: r.key, name: r.name, resourceinstanceid: id },
      tiles: tiles.map(t => ({ tileid: t.tileid, nodegroup_id: t.nodegroup_id, parenttile_id: t.parenttile_id ?? null, sortorder: Number(t.sortorder ?? 0), resourceinstance_id: id, data: JSON.parse(t.data) })),
      tiles_loaded: true,
    });
  }
  client.getResource = resource;
  client.getResourceTiles = async id => (await resource(id)).tiles ?? [];
  // Nothing reads a whole model any more.
  client.getResources = async () => [];
  client.getResourceSummaries = async () => [];

  // A [[model/key]] reference's id, worked out from the slug (uuid.mjs), no lookup.
  const refId = target => { const [m, k] = target.split('/'); return graphOf[m] && k ? resourceId(graphOf[m], k) : null; };

  const hydrating = new Map();
  // Entries in full, read through Alizarin (their tiles in one query per model).
  async function full(ids) {
    const want = [...new Set(ids)].filter(id => id && !state.byId.get(id)?.full && !hydrating.has(id));
    if (want.length) {
      const job = (async () => {
        await know(want);
        const byGraph = new Map();
        for (const id of want) { const r = rowOf.get(id); if (r) (byGraph.get(r.graph_id) ?? byGraph.set(r.graph_id, []).get(r.graph_id)).push(id); }
        for (const [gid, list] of byGraph) for (const part of chunks(list, 200)) {
          const ts = await engine.tiles(gid, part);
          for (const id of part) tilesOf.set(id, ts.filter(t => t.resource_id === id));
        }
        for (const id of want) {
          const r = rowOf.get(id);
          if (!r) continue;
          const e = withMentions(await readOne(A.graphManager, manifest, r.model, id, { key: r.key, layers: r.layers ?? [] }), refId);
          e.full = true;
          state.byId.set(id, e);
          tilesOf.delete(id);
        }
      })();
      for (const id of want) hydrating.set(id, job);
      try { await job; } finally { for (const id of want) hydrating.delete(id); }
    }
    await Promise.all(ids.map(id => hydrating.get(id)).filter(Boolean));
    return ids.map(id => state.byId.get(id)).filter(Boolean);
  }

  return {
    know, full, refId,
    idOf: (model, key) => (graphOf[model] ? resourceId(graphOf[model], key) : null),

    // The links into an entry, in full (`limit` sources at most): state.back, as backlinks() makes it.
    async backOf(id, limit = 400) {
      if (state.back.has(id)) return state.back.get(id);
      const src = (await engine.rows(`SELECT DISTINCT src_resource FROM edges WHERE target_resource = ${q(id)} LIMIT ${limit}`)).map(r => r.src_resource);
      const from = await full(src);
      const back = from.flatMap(f => links(f).filter(l => l.id === id).map(l => ({ from: f, via: l.label, property: l.property, derived: l.derived })));
      state.back.set(id, back);
      return back;
    },

    // A page of entries in brief: of some models (in their order), General-only ones only if
    // `general`, optionally among `ids`, ordered by model then name.
    async page({ models, general, ids = null, limit = 200, offset = 0 }) {
      if (!models.length || (ids && !ids.length)) return [];
      const where = [`model IN (${inList(models)})`, general ? null : 'NOT general', ids ? `resource_id IN (${inList(ids)})` : null].filter(Boolean).join(' AND ');
      const rs = remember(await engine.rows(`SELECT * FROM resources WHERE ${where} ORDER BY list_position([${inList(models)}], model), lower(name), key LIMIT ${limit} OFFSET ${offset}`));
      return rs.map(r => state.byId.get(r.resource_id));
    },

    // How many entries each model has: all, General-only, and this view's own (its layer has it).
    async counts(view) {
      const rs = await engine.rows(`SELECT model, count(*) AS n, count(*) FILTER (WHERE general) AS general, count(*) FILTER (WHERE list_contains(layers, ${q(view)})) AS own FROM resources GROUP BY model`);
      return Object.fromEntries(rs.map(r => [r.model, r]));
    },

    // Names containing some text (for a view without a text index).
    async named(text, { models, general, limit = 200 }) {
      const where = [`lower(name) LIKE ${q(`%${text.toLowerCase().replace(/[%_]/g, '')}%`)}`, models ? `model IN (${inList(models)})` : null, general ? null : 'NOT general'].filter(Boolean).join(' AND ');
      return remember(await engine.rows(`SELECT * FROM resources WHERE ${where} ORDER BY lower(name) LIMIT ${limit}`)).map(r => state.byId.get(r.resource_id));
    },
  };
}
