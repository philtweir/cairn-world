// What the explorer knows of a view, read as it is needed rather than all at once: the view's
// tables and Rós Madair substrate (through the query engine, query-engine.mjs) for lists, counts
// and links, and Alizarin for an entry's fields, hydrated from its tiles in the substrate (the
// Parquet is Alizarin's tile store: `getResource` is answered from it). So a view of any size
// opens with a few queries, and a page reads only the entries it shows.
//
// Entries go into `state.byId` as they are met: in brief (`light`: id, model, key, layers, name,
// from the resources table) or in full (every field, through Alizarin). `state.back` holds the
// links into an entry, once asked for (backOf).
//
// Edits made here (explorer/drafts.mjs) are a layer over the view: each edited entry is its
// rows built by Alizarin's CSV loader (as the build builds a layer) and composed over the
// published entry by Alizarin's layer composition, then put where both readers look: Alizarin's
// resource registry, and the query engine's overlay (so lists, counts, links and filters see it).
//
// A closed view (src/access.mjs) is read through a window, one principal's grants up to an epoch
// (setWindow): the engine's views hold only what it lets through, so everything here does too.
// An entry it names but lets nothing of be read is known by its name only (`nameOnly`).

import { readOne, withMentions, links } from '../src/world-read.mjs';
import { makeResolver, normName, refsIn, REF } from '../src/refs.mjs';
import { toCsv } from '../src/csv.mjs';
import { resourceId, uuid5 } from './uuid.mjs';

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const inList = ids => ids.map(q).join(', ');
// The box round a field's GeoJSON, as the substrate's tiles carry it.
function bbox(values) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = c => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  for (const v of values) for (const f of v?.features ?? []) if (f.geometry?.coordinates) walk(f.geometry.coordinates);
  return w <= e ? { geo_min_lng: w, geo_min_lat: s, geo_max_lng: e, geo_max_lat: n } : {};
}
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// engine: query-engine.mjs's; A: Alizarin; client: an Alizarin ArchesClient set up for the
// view's graphs and collections (its resource methods are replaced here); manifest: the view's;
// graphs: graph id -> the model's Arches graph; collection: id -> a vocabulary (a promise).
export function makeStore({ engine, A, client, manifest, state, graphs = {}, collection = null }) {
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
  const asResource = (r, tiles) => ({
    metadata: {},
    resourceinstance: { descriptors: { name: r.name }, graph_id: r.graph_id, legacyid: r.key, name: r.name, resourceinstanceid: r.resource_id },
    tiles: tiles.map(t => ({ tileid: t.tileid, nodegroup_id: t.nodegroup_id, parenttile_id: t.parenttile_id ?? null, sortorder: Number(t.sortorder ?? 0), resourceinstance_id: r.resource_id, data: JSON.parse(t.data) })),
    tiles_loaded: true,
  });
  async function resource(id) {
    if (edited.has(id)) return new A.staticTypes.StaticResource(edited.get(id).res);
    const [r] = rowOf.has(id) ? [rowOf.get(id)] : remember(await engine.rows(`SELECT * FROM resources WHERE resource_id = ${q(id)}`));
    if (!r) throw new Error(`no entry ${id} in this view`);
    return new A.staticTypes.StaticResource(asResource(r, tilesOf.get(id) ?? await engine.tiles(r.graph_id, [id])));
  }
  // An entry as published (null if it is not), whatever the edits.
  async function published(id) {
    const [r] = await engine.rows(`SELECT * FROM read_parquet('resources.parquet') WHERE resource_id = ${q(id)}`);
    return r ? { row: r, res: asResource(r, await engine.tiles(r.graph_id, [id])) } : null;
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
        for (const id of want) { const r = rowOf.get(id); if (r && !edited.has(id)) (byGraph.get(r.graph_id) ?? byGraph.set(r.graph_id, []).get(r.graph_id)).push(id); }
        // Every model's tiles fetched at once, rather than one model after another.
        await engine.prefetch?.([...byGraph.keys()]);
        for (const [gid, list] of byGraph) for (const part of chunks(list, 200)) {
          const ts = await engine.tiles(gid, part);
          for (const id of part) tilesOf.set(id, ts.filter(t => t.resource_id === id));
        }
        for (const id of want) {
          const r = rowOf.get(id);
          if (!r) continue;
          if (nameOnly?.has(id)) { state.byId.set(id, { ...light(r), light: false, full: true, nameOnly: true }); continue; }
          const e = withMentions(await readOne(A.graphManager, manifest, r.model, id, { key: r.key, layers: r.layers ?? [] }), refId);
          // A window may let some fields be read and not the name's: the name is known all the same.
          const name = e.fields.find(f => f.alias === 'name');
          if (name && name.value == null) name.value = r.name;
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

  // ---- The edit layer ----------------------------------------------------------------------
  const edited = new Map();   // id -> { entry, res (composed), name }
  const modelOf = alias => manifest.models.find(m => m.alias === alias);
  const nodeOf = (alias, field) => modelOf(alias)?.nodes.find(n => n.alias === field);
  const NS = uuid5('1a79f1c8-9505-4bea-a18e-28a053f725ca', `cairn-world:edits:${state.view}`);
  const vocabularies = new Map();
  const vocabulariesOf = gid => vocabularies.get(gid) ?? vocabularies.set(gid, Promise.all([...new Set(graphs[gid].nodes.map(n => n.config?.rdmCollection).filter(Boolean))].map(collection))).get(gid);
  const splitKeys = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

  // Link cells name entries by slug; Alizarin's loader takes ids. A slug is looked up among the
  // field's target models (in this view, or made by the edits), as the build does.
  async function linkIds(entry, field, cell, made) {
    const n = nodeOf(entry.model, field), keys = splitKeys(cell);
    if (!keys.length) return '';
    const found = await engine.rows(`SELECT model, key FROM resources WHERE key IN (${inList(keys)}) AND model IN (${inList(n.targets)})`);
    return keys.map(k => {
      const hits = [...new Set([...found.filter(r => r.key === k).map(r => r.model), ...made.filter(e => e.key === k && n.targets.includes(e.model)).map(e => e.model)])];
      if (hits.length > 1) throw new Error(`${n.name}: "${k}" could be ${hits.join(' or ')}`);
      if (!hits.length) throw new Error(`${n.name}: no ${n.targets.join(' or ')} "${k}" in this view`);
      return resourceId(graphOf[hits[0]], k);
    }).join(',');
  }

  // An edit composed over its entry as published: { id, res, name }. Throws, with the loader's
  // message, if a cell does not fit its field.
  async function compose(entry, made = []) {
    const m = modelOf(entry.model), gid = m.graphid, graph = graphs[gid];
    const rows = [entry.cells, ...entry.rows].filter((r, i) => i || Object.keys(r).length || !entry.rows.length);
    const header = ['ResourceID', ...new Set(rows.flatMap(Object.keys))];
    for (const f of header.slice(1)) if (!nodeOf(entry.model, f)) throw new Error(`${m.name} has no field "${f}"`);
    const cells = await Promise.all(rows.map(r => Promise.all(header.map(async f => (f === 'ResourceID' ? entry.key
      : nodeOf(entry.model, f).targets.length ? linkIds(entry, f, r[f], made) : (r[f] ?? ''))))));
    let draft;
    try {
      [draft] = A.buildResourcesFromBusinessCsv(toCsv([header, ...cells]), graph, await vocabulariesOf(gid), 'en', true, NS).business_data.resources;
    } catch (err) {
      throw new Error(String(err?.message ?? err).replace(/^\[ERROR\]\s*/, '').replace(/business_data\.csv:\d+:\s*/g, '').trim());
    }
    const id = draft.resourceinstance.resourceinstanceid;
    const was = await published(id);
    if (!was && !entry.created) throw new Error(`${m.name} "${entry.key}" is not in this view`);
    const res = was ? A.composeResourceLayers([draft, was.res], graph, [], false).resource : draft;
    const name = entry.cells.name || was?.row.name || entry.key;
    Object.assign(res.resourceinstance, { name, legacyid: entry.key, descriptors: { name } });
    return { id, res, name, was: was?.row ?? null };
  }

  // The rows an edited entry puts in the engine's overlay: as Rós Madair's emitter melts tiles.
  function overlayRows(entry, c, out) {
    const gid = graphOf[entry.model], nodes = new Map(graphs[gid].nodes.map(n => [n.nodeid, n]));
    out.resources.push({ resource_id: c.id, model: entry.model, graph_id: gid, key: entry.key, name: c.name, layers: [...new Set([...(c.was?.layers ?? []), state.view])], general: false });
    const mentioned = new Set();
    for (const t of c.res.tiles) {
      const box = bbox(Object.entries(t.data).filter(([nid]) => nodes.get(nid)?.datatype === 'geojson-feature-collection').map(([, v]) => v));
      out.tiles.push({ graph_id: gid, resource_id: c.id, descriptor_name: c.name, nodegroup_id: t.nodegroup_id, tileid: t.tileid, parenttile_id: t.parenttile_id ?? null, sortorder: t.sortorder ?? 0, data: JSON.stringify(t.data), ...box });
      for (const [nid, v] of Object.entries(t.data)) {
        const n = nodes.get(nid);
        if (v == null || !n) continue;
        const at = { resource_id: c.id, tile_id: t.tileid, nodegroup_id: t.nodegroup_id, node_id: nid };
        if (n.datatype.startsWith('concept')) for (const x of [].concat(v)) out.concepts.push({ ...at, concept_id: x });
        else if (n.datatype === 'number') out.ordered.push({ ...at, q_ordered: Math.round(Number(v) * 10 ** Math.min(18, n.config?.decimals ?? 6)) });
        else if (n.datatype.startsWith('resource-instance')) for (const x of [].concat(v)) out.edges.push({ src_resource: c.id, src_node: nid, src_nodegroup: t.nodegroup_id, src_tile: t.tileid, target_resource: x.resourceId });
        else if (n.datatype === 'string') for (const s of Object.values(v)) for (const r of refsIn(s?.value)) { const to = refId(r.target); if (to && to !== c.id) mentioned.add(to); }
      }
    }
    for (const to of mentioned) out.edges.push({ src_resource: c.id, src_node: 'mentions', src_nodegroup: 'mentions', src_tile: null, target_resource: to });
  }

  // Every edit, composed and put in place. Returns the edits that could not be (model/key -> why).
  async function applyEdits(drafts) {
    const before = new Set(edited.keys()), problems = new Map();
    const out = { resources: [], tiles: [], concepts: [], ordered: [], edges: [] };
    edited.clear();
    const made = drafts.list().filter(e => e.created);
    for (const entry of drafts.list()) {
      try {
        const c = await compose(entry, made);
        edited.set(c.id, { entry, ...c });
        overlayRows(entry, c, out);
      } catch (err) { problems.set(`${entry.model}/${entry.key}`, err?.message ?? String(err)); }
    }
    await engine.overlay(out);
    const registry = (A.graphManager.staticStore ?? A.staticStore).registry;
    for (const id of new Set([...before, ...edited.keys()])) {
      const res = edited.get(id)?.res ?? (await published(id))?.res;
      if (res) registry.mergeFromResources([new A.staticTypes.StaticResource(res)], true, true);
      state.byId.delete(id);
      rowOf.delete(id);
    }
    state.back.clear();
    return problems;
  }

  // [[Name]] references written exact, [[model/key|Name]], against this view, as the build
  // writes them; { text, problems }.
  async function exactRefs(text) {
    const targets = [...new Set(refsIn(text).map(r => r.target.trim()))];
    if (!targets.length) return { text, problems: [] };
    const like = targets.filter(t => !t.includes('/')).map(t => `lower(name) LIKE ${q(`%${normName(t).replace(/[%_]/g, '')}%`)} OR key = ${q(t)}`);
    const exact = targets.filter(t => t.includes('/')).map(t => { const [m, k] = t.split('/'); return `(model = ${q(m)} AND key = ${q(k)})`; });
    const rs = await engine.rows(`SELECT model, key, name FROM resources WHERE ${[...like, ...exact].join(' OR ')}`);
    const resolve = makeResolver(rs);
    const problems = [];
    const out = text.replace(REF, (raw, target, label) => {
      const got = resolve(target);
      if (got.hit) return `[[${got.hit.model}/${got.hit.key}|${label ?? (target.includes('/') ? got.hit.name : target)}]]`;
      problems.push(got.ambiguous ? `${raw} could be ${got.ambiguous.map(c => `${c.model}/${c.key}`).join(' or ')}` : `${raw} matches nothing in this view`);
      return raw;
    });
    return { text: out, problems };
  }

  // ---- What a campaign uses --------------------------------------------------------------
  // A campaign's view holds its whole world: every place, faction and person its universe knows.
  // Its scope is narrower: the campaign's own entries (its layer, edits included), what they link
  // to or mention, and what those in turn link to: outgoing only, two steps. The second step
  // follows link fields, not [[mentions]] (a remark about a remark is too far out), and never goes
  // on through a universe's own entry (which mentions the whole world). A table in the engine, so
  // lists, counts and lenses filter on it; remade when the edits change.
  let scopeOn = false, scopeIds = null;
  // The window (a closed view's): what is known of the view, and what only by name.
  let visibleIds = null, nameOnly = null;
  async function setWindow(spec) {
    await engine.window(spec);
    visibleIds = spec ? new Set((await engine.rows('SELECT DISTINCT resource_id FROM win')).map(r => r.resource_id)) : null;
    nameOnly = spec ? new Set((await engine.rows(`SELECT resource_id FROM win GROUP BY resource_id HAVING count(*) FILTER (WHERE permission = 'read') = 0`)).map(r => r.resource_id)) : null;
    // What was read before was read through another window.
    rowOf.clear(); tilesOf.clear(); state.byId.clear(); state.back.clear();
    if (scopeIds) await rescope();
  }
  async function rescope() {
    const seed = `SELECT resource_id FROM resources WHERE list_contains(layers, ${q(state.view)})`;
    const one = `SELECT target_resource AS resource_id FROM edges WHERE src_resource IN (${seed}) UNION ${seed}`;
    const two = `SELECT target_resource AS resource_id FROM edges WHERE src_node <> 'mentions' AND src_resource IN (SELECT resource_id FROM (${one}) WHERE resource_id NOT IN (SELECT resource_id FROM resources WHERE model = 'universe')) UNION ${one}`;
    await engine.rows(`CREATE OR REPLACE TABLE scope AS SELECT DISTINCT resource_id FROM (${two})`);
    scopeIds = new Set((await engine.rows('SELECT resource_id FROM scope')).map(r => r.resource_id));
  }
  const scoped = () => (scopeOn ? 'resource_id IN (SELECT resource_id FROM scope)' : null);

  return {
    know, full, refId, compose, exactRefs, setWindow,
    // Whether the window (if there is one) shows an entry at all, and whether only by its name.
    visible: id => !visibleIds || visibleIds.has(id),
    nameOnly: id => !!nameOnly?.has(id),
    async applyEdits(drafts) { const problems = await applyEdits(drafts); if (scopeIds) await rescope(); return problems; },
    // Only what the campaign uses, or everything in its world.
    async setScope(on) { if (on && !scopeIds) await rescope(); scopeOn = on; },
    inScope: id => !scopeOn || !!scopeIds?.has(id),
    edited: id => edited.get(id)?.entry ?? null,
    // Edited entries whose name the edit changes: model/key -> the name as published.
    renamed: () => Object.fromEntries([...edited.values()].filter(c => c.was && c.entry.cells.name && c.entry.cells.name !== c.was.name).map(c => [`${c.entry.model}/${c.entry.key}`, c.was.name])),
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
      const where = [`model IN (${inList(models)})`, general ? null : 'NOT general', ids ? `resource_id IN (${inList(ids)})` : null, scoped()].filter(Boolean).join(' AND ');
      const rs = remember(await engine.rows(`SELECT * FROM resources WHERE ${where} ORDER BY list_position([${inList(models)}], model), lower(name), key LIMIT ${limit} OFFSET ${offset}`));
      return rs.map(r => state.byId.get(r.resource_id));
    },

    // How many entries each model has (in scope, if it is on): all, General-only, and this view's
    // own (its layer has it); and `world`, how many not General-only it has in scope or not.
    async counts(view) {
      const used = scoped() ?? 'true';
      const rs = await engine.rows(`SELECT model, count(*) FILTER (WHERE ${used}) AS n, count(*) FILTER (WHERE general AND ${used}) AS general,
        count(*) FILTER (WHERE list_contains(layers, ${q(view)}) AND ${used}) AS own, count(*) FILTER (WHERE NOT general) AS world FROM resources GROUP BY model`);
      return Object.fromEntries(rs.map(r => [r.model, r]));
    },

    // Names containing some text (for a view without a text index).
    async named(text, { models, general, limit = 200 }) {
      const where = [`lower(name) LIKE ${q(`%${text.toLowerCase().replace(/[%_]/g, '')}%`)}`, models ? `model IN (${inList(models)})` : null, general ? null : 'NOT general', scoped()].filter(Boolean).join(' AND ');
      return remember(await engine.rows(`SELECT * FROM resources WHERE ${where} ORDER BY lower(name) LIMIT ${limit}`)).map(r => state.byId.get(r.resource_id));
    },
  };
}
