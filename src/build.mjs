// Build the Cairn world: CSV models + layered CSV data -> Alizarin graphs/resources -> static site.
//
//   npm run check            validate and build in memory, write nothing
//   npm run build            write dist/ for published views only
//   npm run build -- --all   also include unpublished universes/campaigns (local preview only)
//
// Layers (see README.md):
//   General   model/ + rules/ (+ layers/general/), the base of every stack
//   Universe  layers/<key>/ containing exactly one Universe row with ResourceID <key>
//   Campaign  layers/<key>/ containing exactly one Campaign row with ResourceID <key>
// A layer's stack is read from its root entity: a Universe sits on General; a Campaign sits on
// General plus the universes its `universes` field links to. Links may only target entities
// visible in the linking layer's stack. Each Universe/Campaign is a *view*: its stack composed
// with Alizarin's composeResourceLayers (topmost layer wins per single-valued group).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as A from 'alizarin/inline-full';
import { parseCsv, toCsv } from './csv.mjs';
import { renderSite, renderViewIndex } from './render.mjs';
import { buildExplorer } from './build-explorer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const LAYERS_DIR = path.join(ROOT, 'layers');
const CHECK_ONLY = process.argv.includes('--check');
const INCLUDE_UNPUBLISHED = process.argv.includes('--all');

const RDM_NAMESPACE = 'http://cairn-world.example/rdm/';
const CRM = 'http://www.cidoc-crm.org/cidoc-crm/';
const CAIRN = 'http://cairn-world.example/ns/';
const NODE_COLS = ['alias', 'name', 'datatype', 'cardinality', 'ontology_class',
  'parent_property', 'parent_alias', 'collection_name'];
const LINK_TYPES = new Set(['resource-instance', 'resource-instance-list']);
const ROOT_MODELS = ['universe', 'campaign'];
const GENERAL = 'general';

const problems = [];
const problem = msg => problems.push(msg);
const rel = f => path.relative(ROOT, f);
const bail = () => {
  console.error(problems.map(p => `error: ${p}`).join('\n'));
  console.error(`\n${problems.length} problem(s); nothing written.`);
  process.exit(1);
};

// "E21_Person" -> CIDOC-CRM URI, "cairn:allied_with" -> our namespace, URIs pass through.
const expand = s => (!s ? s : /^https?:/.test(s) ? s : s.startsWith('cairn:') ? CAIRN + s.slice(6) : CRM + s);

// Deterministic UUID from a string, for ids we mint ourselves (layer namespaces, pinned publications).
const stableUuid = seed => {
  const b = crypto.createHash('sha1').update(seed).digest();
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

function readTable(file) {
  const [header = [], ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  return {
    file,
    header,
    rows: rows.map((cells, i) => ({
      file, line: i + 2, cells,
      get: Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ''])),
    })),
  };
}

function report(file, diagnostics) {
  for (const d of diagnostics) {
    const msg = `${file}${d.line ? ':' + d.line : ''} ${d.message}`;
    if (d.level === 'Error') problem(msg);
    else if (!d.message.includes(CAIRN)) console.warn(`warning: ${msg}`);
  }
}

const listCsv = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort() : []);
const splitKeys = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);

await A.wasmReady;

// ---- 1. Layers on disk --------------------------------------------------------

const layerKeys = [GENERAL, ...(fs.existsSync(LAYERS_DIR)
  ? fs.readdirSync(LAYERS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== GENERAL).map(d => d.name).sort()
  : [])];
const layerDataDirs = key => (key === GENERAL
  ? [path.join(ROOT, 'rules'), path.join(LAYERS_DIR, GENERAL, 'data')]
  : [path.join(LAYERS_DIR, key, 'data')]);
const layerModelDir = key => (key === GENERAL ? path.join(ROOT, 'model') : path.join(LAYERS_DIR, key, 'model'));

// ---- 2. Models: General's, plus any a layer defines for itself ------------------

const vocabCsv = fs.readFileSync(path.join(ROOT, 'model/vocab.csv'), 'utf8');
const models = [];
for (const key of layerKeys) {
  const index = path.join(layerModelDir(key), 'models.csv');
  if (!fs.existsSync(index)) continue;
  for (const r of readTable(index).rows) {
    const file = path.join(layerModelDir(key), `${r.get.alias}.csv`);
    if (models.some(m => m.alias === r.get.alias)) { problem(`${rel(index)}:${r.line} model "${r.get.alias}" is already defined`); continue; }
    if (!fs.existsSync(file)) { problem(`${rel(index)}:${r.line} missing ${rel(file)}`); continue; }
    models.push({
      alias: r.get.alias, name: r.get.name, ontology: expand(r.get.ontology_class), definedIn: key, file,
      nodes: readTable(file).rows.map(n => ({ ...n.get, line: n.line })),
    });
  }
}
const modelByAlias = Object.fromEntries(models.map(m => [m.alias, m]));
for (const a of ROOT_MODELS) if (modelByAlias[a]?.definedIn !== GENERAL) problem(`model/models.csv must define "${a}"`);

for (const m of models) {
  for (const n of m.nodes) {
    n.targets = (n.target_model || '').split('|').filter(Boolean);
    if (LINK_TYPES.has(n.datatype) && !n.targets.length) problem(`${rel(m.file)}:${n.line} link node "${n.alias}" needs target_model`);
    for (const t of n.targets) if (!modelByAlias[t]) problem(`${rel(m.file)}:${n.line} unknown target_model "${t}"`);
  }
  const graphCsv = toCsv([['name', 'alias', 'ontology_class'], [m.name, m.alias, m.ontology]]);
  const nodesCsv = toCsv([NODE_COLS, ...m.nodes.map(n => NODE_COLS.map(c =>
    (c === 'ontology_class' || c === 'parent_property') ? expand(n[c]) : n[c]))]);
  report(rel(m.file), A.validateModelCsvs(graphCsv, nodesCsv, vocabCsv));
  try {
    m.built = A.buildGraphFromModelCsvs(graphCsv, nodesCsv, RDM_NAMESPACE, vocabCsv);
  } catch (e) {
    problem(`${rel(m.file)} build failed: ${e?.message ?? JSON.stringify(e)}`);
  }
}
if (problems.length) bail();

for (const m of models) {
  // Link nodes must declare which graphs they point at, or the ORM can't follow them.
  for (const n of m.nodes) {
    if (!LINK_TYPES.has(n.datatype)) continue;
    m.built.graph.nodes.find(x => x.alias === n.alias).config = {
      graphs: n.targets.map(t => ({
        graphid: modelByAlias[t].built.graph.graphid, name: modelByAlias[t].name,
        ontologyProperty: '', inverseOntologyProperty: '', relationshipType: '',
      })),
    };
  }
  // Alizarin stamps a random publication id and the current time; pin both so rebuilds are byte-identical.
  const pub = m.built.graph.publication;
  if (pub) { pub.publicationid = stableUuid(`publication:${m.built.graph.graphid}`); pub.published_time = '2000-01-01T00:00:00.000'; }
}

// ---- 3. Tables per layer and model -------------------------------------------------

const tables = {};   // layer -> model alias -> { header, rows }
for (const key of layerKeys) {
  tables[key] = {};
  for (const dir of layerDataDirs(key)) {
    for (const f of listCsv(dir)) {
      const alias = f.slice(0, -4);
      const t = readTable(path.join(dir, f));
      const m = modelByAlias[alias];
      if (!m) { problem(`${rel(t.file)} is not a model (no "${alias}" in any models.csv)`); continue; }
      if (t.header[0] !== 'ResourceID') problem(`${rel(t.file)} first column must be ResourceID`);
      const into = (tables[key][alias] ??= { header: ['ResourceID'], rows: [] });
      for (const c of t.header.slice(1)) {
        if (!m.nodes.some(n => n.alias === c)) problem(`${rel(t.file)} unknown column "${c}" (not in ${rel(m.file)})`);
        else if (!into.header.includes(c)) into.header.push(c);
      }
      into.rows.push(...t.rows);
    }
  }
  for (const t of Object.values(tables[key])) for (const r of t.rows) r.cells = t.header.map(c => r.get[c] ?? '');
}
if (problems.length) bail();

// ---- 4. Layer structure, read from each layer's root entity --------------------------

const layers = {};   // key -> { key, kind, name, published, parents, stack }
layers[GENERAL] = { key: GENERAL, kind: 'general', name: 'General', published: true, parents: [], stack: [GENERAL] };
for (const a of ROOT_MODELS) for (const r of tables[GENERAL][a]?.rows ?? []) problem(`${rel(r.file)}:${r.line} a ${a} belongs in its own layers/<key>/ folder, not General`);

for (const key of layerKeys.filter(k => k !== GENERAL)) {
  const roots = ROOT_MODELS.flatMap(a => (tables[key][a]?.rows ?? []).map(r => ({ kind: a, row: r })));
  for (const { kind, row } of roots) {
    if (row.cells[0] !== key) problem(`${rel(row.file)}:${row.line} layers/${key}/ may only hold its own root; found ${kind} "${row.cells[0]}"`);
  }
  const own = roots.filter(x => x.row.cells[0] === key);
  if (own.length !== 1) { problem(`layers/${key}/ needs exactly one Universe or Campaign row with ResourceID "${key}" (found ${own.length})`); continue; }
  const { kind, row } = own[0];
  layers[key] = {
    key, kind, name: row.get.name || key, published: row.get.published === 'true', row,
    parents: kind === 'universe' ? [GENERAL] : [GENERAL, ...splitKeys(row.get.universes)],
  };
}
for (const l of Object.values(layers)) {
  if (l.kind !== 'campaign') continue;
  for (const u of l.parents.slice(1)) {
    if (layers[u]?.kind !== 'universe') problem(`${rel(l.row.file)}:${l.row.line} campaign "${l.key}" lists universe "${u}", which is not a universe layer`);
  }
}
if (problems.length) bail();
// Stacks are bottom-to-top. Universes only sit on General, so a stack is never deeper than three tiers.
for (const l of Object.values(layers)) l.stack ??= [...new Set([...l.parents, l.key])];

// A model a layer defines itself is only usable inside that layer's descendants.
for (const key of layerKeys) {
  for (const alias of Object.keys(tables[key])) {
    const m = modelByAlias[alias];
    if (!layers[key].stack.includes(m.definedIn)) problem(`layers/${key}/ uses model "${alias}", defined in layer "${m.definedIn}", which is not in its stack`);
  }
}
if (problems.length) bail();

// ---- 5. Build each layer's resources -----------------------------------------------

const isLinkCol = (m, col) => LINK_TYPES.has(m.nodes.find(n => n.alias === col)?.datatype);
const layerNamespace = key => stableUuid(`cairn-world:layer:${key}`);

function buildResources(m, csv, layerKey, rows) {
  try {
    // A distinct tile namespace per layer: without it, the same field in two layers gets the same
    // tile id, and composition drops the lower layer's multi-valued entries as duplicates.
    return A.buildResourcesFromBusinessCsv(csv, m.built.graph, m.built.collections, 'en', true, layerNamespace(layerKey)).business_data.resources;
  } catch (e) {
    problem(String(e?.message ?? e).trim().replace(/business_data\.csv:(\d+)/g, (whole, n) => {
      const row = rows[Number(n) - 2];
      return row ? `${rel(row.file)}:${row.line}` : whole;
    }));
    return null;
  }
}

// Pass 1: build without link columns to learn every resource id and which layers hold it.
// Resource ids depend only on model + ResourceID, so the same key in two layers IS the same
// entity: the upper layer overrides or extends it.
const present = {};   // model -> key -> { id, layers: Set }
for (const key of layerKeys) {
  for (const [alias, t] of Object.entries(tables[key])) {
    const m = modelByAlias[alias];
    const seen = new Set();
    for (const r of t.rows) {
      if (seen.has(r.cells[0])) problem(`${rel(r.file)}:${r.line} duplicate ResourceID "${r.cells[0]}" in layer ${key}`);
      seen.add(r.cells[0]);
    }
    const keep = t.header.map((c, j) => (j === 0 || !isLinkCol(m, c) ? j : -1)).filter(j => j >= 0);
    const out = buildResources(m, toCsv([keep.map(j => t.header[j]), ...t.rows.map(r => keep.map(j => r.cells[j]))]), key, t.rows);
    out?.forEach((res, i) => {
      const k = t.rows[i].cells[0];
      const p = ((present[alias] ??= new Map()).get(k) ?? { id: res.resourceinstance.resourceinstanceid, layers: new Set() });
      p.layers.add(key);
      present[alias].set(k, p);
    });
  }
}
if (problems.length) bail();

// Pass 2: resolve link keys against what the layer can see, then build for real.
const built = {};   // layer -> model -> [resources]
for (const key of layerKeys) {
  const visible = new Set(layers[key].stack);
  built[key] = {};
  for (const [alias, t] of Object.entries(tables[key])) {
    const m = modelByAlias[alias];
    const csv = toCsv([t.header, ...t.rows.map(r => t.header.map((col, j) => {
      if (j === 0 || !isLinkCol(m, col)) return r.cells[j];
      const node = m.nodes.find(n => n.alias === col);
      const keys = splitKeys(r.cells[j]);
      if (node.cardinality === '1' && keys.length > 1) problem(`${rel(r.file)}:${r.line} "${col}" takes one link, got ${keys.length}`);
      return keys.map(k => {
        const anywhere = node.targets.filter(tm => present[tm]?.has(k));
        const hits = anywhere.filter(tm => [...present[tm].get(k).layers].some(l => visible.has(l)));
        if (hits.length === 1) return present[hits[0]].get(k).id;
        if (hits.length > 1) problem(`${rel(r.file)}:${r.line} "${col}" -> "${k}" is ambiguous between ${hits.join(', ')}`);
        else if (anywhere.length) {
          const where = anywhere.flatMap(tm => [...present[tm].get(k).layers]).join(', ');
          problem(`${rel(r.file)}:${r.line} "${col}" -> "${k}" exists only in layer(s) ${where}, which layer "${key}" cannot see (its stack: ${layers[key].stack.join(' > ')})`);
        } else problem(`${rel(r.file)}:${r.line} "${col}" -> "${k}" not found in ${node.targets.join('|')}`);
        return '';
      }).join(',');
    }))]);
    built[key][alias] = buildResources(m, csv, key, t.rows) ?? [];
  }
}
if (problems.length) bail();

// The CSV loader stores SKOS concept ids in concept tiles, but the ORM (like Arches itself)
// looks concepts up by value id. Translate, or every concept field reads back empty.
const valueIdOfConcept = new Map();
for (const m of models) for (const c of m.built.collections) {
  for (const [conceptId, concept] of Object.entries(c.__allConcepts ?? {})) valueIdOfConcept.set(conceptId, Object.values(concept.prefLabels)[0].id);
}
for (const key of layerKeys) for (const [alias, list] of Object.entries(built[key])) {
  const conceptNodes = modelByAlias[alias].built.graph.nodes.filter(n => n.datatype === 'concept' || n.datatype === 'concept-list').map(n => n.nodeid);
  for (const res of list) for (const tile of res.tiles) for (const nodeid of conceptNodes) {
    const v = tile.data?.[nodeid];
    if (v == null) continue;
    const swap = id => valueIdOfConcept.get(id) ?? id;
    tile.data[nodeid] = Array.isArray(v) ? v.map(swap) : swap(v);
  }
}

// ---- 6. Compose each view's stack with Alizarin ----------------------------------------

const viewKeys = Object.values(layers).filter(l => l.kind !== 'general' && (l.published || INCLUDE_UNPUBLISHED)).map(l => l.key);
const views = {};   // key -> { model -> { resources, entries } , overrides: [...] }
for (const v of viewKeys) {
  const stack = layers[v].stack;
  const view = { models: {}, overrides: [] };
  for (const m of models) {
    if (!stack.includes(m.definedIn)) continue;
    const copies = new Map();   // resource id -> [{ layer, res }] topmost-first
    for (const l of [...stack].reverse()) for (const res of built[l][m.alias] ?? []) {
      const id = res.resourceinstance.resourceinstanceid;
      if (!copies.has(id)) copies.set(id, []);
      copies.get(id).push({ layer: l, res });
    }
    const keyOfId = new Map([...(present[m.alias] ?? new Map())].map(([k, p]) => [p.id, k]));
    const resources = [], entries = [];
    for (const [id, list] of copies) {
      let res = list[0].res;
      if (list.length > 1) {
        const out = A.composeResourceLayers(list.map(x => x.res), m.built.graph, [], false);
        res = out.resource;
        view.overrides.push({ model: m.alias, key: keyOfId.get(id), layers: list.map(x => x.layer).reverse(), changes: out.warnings.length });
      }
      resources.push(res);
      entries.push({ id, key: keyOfId.get(id), layers: list.map(x => x.layer).reverse() });
    }
    const order = (a, b) => a.key.localeCompare(b.key);
    entries.sort(order);
    const rank = new Map(entries.map((e, i) => [e.id, i]));
    resources.sort((a, b) => rank.get(a.resourceinstance.resourceinstanceid) - rank.get(b.resourceinstance.resourceinstanceid));
    view.models[m.alias] = { resources, entries };
  }
  views[v] = view;
}

const totalOwn = layerKeys.reduce((n, k) => n + Object.values(built[k]).reduce((x, l) => x + l.length, 0), 0);
console.log(`ok: ${models.length} models, ${layerKeys.length} layers, ${totalOwn} layer entries, ${viewKeys.length} view(s): ${viewKeys.join(', ') || 'none'}`);
for (const v of viewKeys) for (const o of views[v].overrides) {
  console.log(`  ${v}: ${o.model}/${o.key} composed from ${o.layers.join(' > ')}${o.changes ? ` (${o.changes} single-valued override${o.changes > 1 ? 's' : ''})` : ''}`);
}
const hidden = Object.values(layers).filter(l => l.kind !== 'general' && !viewKeys.includes(l.key)).map(l => l.key);
if (hidden.length) console.log(`  not published (use --all to preview): ${hidden.join(', ')}`);
if (CHECK_ONLY) process.exit(0);

// ---- 7. Write the tile store -------------------------------------------------------------

fs.rmSync(DIST, { recursive: true, force: true });
const write = (f, obj) => {
  const p = path.join(DIST, 'data', f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
};

// Only layers some published view stands on are written, so unpublished data never ships.
const shippedLayers = [...new Set(viewKeys.flatMap(v => layers[v].stack))];
const usedModels = models.filter(m => shippedLayers.includes(m.definedIn));
const graphMeta = {}, seenCollections = new Set();
for (const m of usedModels) {
  const g = m.built.graph;
  const { nodes, edges, nodegroups, cards, cards_x_nodes_x_widgets, functions_x_graphs, root, publication, ...meta } = g;
  graphMeta[g.graphid] = meta;
  write(`graphs/${g.graphid}.json`, { graph: [g] });
  for (const c of m.built.collections) {
    if (seenCollections.has(c.id)) continue;
    seenCollections.add(c.id);
    write(`collections/${c.id}.json`, c);
  }
}
write('graphs.json', { models: graphMeta });

// Raw, uncomposed layers: for hosts that want to compose themselves.
for (const l of shippedLayers) for (const m of usedModels) {
  const list = built[l][m.alias];
  if (list?.length) write(`layers/${l}/${m.built.graph.graphid}.json`, { business_data: { resources: list } });
}

const describe = l => ({ key: l.key, kind: l.kind, name: l.name, stack: l.stack });
write('views.json', {
  default: viewKeys.find(v => layers[v].kind === 'campaign') ?? viewKeys[0] ?? null,
  views: viewKeys.map(v => describe(layers[v])),
  layers: Object.fromEntries(shippedLayers.map(l => [l, describe(layers[l])])),
});

for (const v of viewKeys) {
  const index = {};
  const manifest = { view: v, models: [] };
  for (const m of usedModels) {
    const vm = views[v].models[m.alias];
    if (!vm) continue;
    const gid = m.built.graph.graphid;
    index[gid] = [`views/${v}/bundles/${gid}.json`];
    write(`views/${v}/bundles/${gid}.json`, { business_data: { resources: vm.resources } });
    for (const r of vm.resources) write(`views/${v}/resources/${r.resourceinstance.resourceinstanceid}.json`, { business_data: { resources: [r] } });
    manifest.models.push({
      alias: m.alias, name: m.name, ontology: m.ontology, definedIn: m.definedIn,
      kind: m.ontology.endsWith('E55_Type') ? 'type' : 'instance',
      graphid: gid,
      nodes: m.nodes.map(n => ({ alias: n.alias, name: n.name, datatype: n.datatype, targets: n.targets, collection: n.collection_name || null })),
      entries: vm.entries,
    });
  }
  write(`views/${v}/index.json`, index);
  write(`views/${v}/manifest.json`, manifest);
}

// ---- 8. Read each view back through the ORM, and render -------------------------------
// One process per view: the ORM's caches are global, and the same resource id carries
// different data in different views.

const viewsMeta = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'views.json'), 'utf8'));
for (const v of viewKeys) {
  const out = path.join(DIST, `.entities-${v}.json`);
  execFileSync(process.execPath, [path.join(ROOT, 'src/read-view.mjs'), path.join(DIST, 'data'), v, out], {
    env: { ...process.env, NODE_OPTIONS: '--experimental-wasm-modules' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const { manifest, entities } = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(out);
  renderSite({ view: v, viewsMeta, models: manifest.models, entities, outDir: path.join(DIST, 'pages', v) });
}
renderViewIndex({ viewsMeta, outDir: path.join(DIST, 'pages') });
await buildExplorer(ROOT, DIST);
console.log(`wrote ${rel(DIST)}/: explorer, plain pages and tile store for ${viewKeys.length} view(s)`);
