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
import { fileURLToPath } from 'node:url';
import * as A from 'alizarin/inline-full';
import { parseCsv, toCsv } from './csv.mjs';
import { renderSite, renderViewIndex } from './render.mjs';
import { buildExplorer } from './build-explorer.mjs';
import { readEntities } from './world-read.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const LAYERS_DIR = path.join(ROOT, 'layers');
const CHECK_ONLY = process.argv.includes('--check');
const INCLUDE_UNPUBLISHED = process.argv.includes('--all');

const RDM_NAMESPACE = 'http://cairn-world.example/rdm/';
const CRM = 'http://www.cidoc-crm.org/cidoc-crm/';
const CAIRN = 'http://cairn-world.example/ns/';
// Ontologies interleaved with CIDOC-CRM. Unprefixed names are CRM; full URIs pass through.
const PREFIXES = {
  cairn: CAIRN,
  rel: 'http://purl.org/vocab/relationship/',
  skos: 'http://www.w3.org/2004/02/skos/core#',
};
const NODE_COLS = ['alias', 'name', 'datatype', 'cardinality', 'ontology_class',
  'parent_property', 'parent_alias', 'collection_name', 'graphs', 'description'];
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
const expand = s => {
  if (!s || /^https?:/.test(s)) return s;
  const m = /^([a-z]+):(.+)$/.exec(s);
  return m && PREFIXES[m[1]] ? PREFIXES[m[1]] + m[2] : CRM + s;
};

// Deterministic UUID from a string, for the per-layer tile namespaces.
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
    // Alizarin flags non-CRM properties; the ones from our own prefixes are deliberate.
    else if (!Object.values(PREFIXES).some(ns => d.message.includes(ns))) console.warn(`warning: ${msg}`);
  }
}

// Data tables in a folder; rules/vocab.csv holds vocabularies, not entries.
const listCsv = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.csv') && f !== 'vocab.csv').sort() : []);
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

// Vocabularies: model/vocab.csv (hand-written) plus rules/vocab.csv (generated from the rules'
// tables). An optional `match` column maps a concept to a term in another ontology
// (skos:exactMatch); Alizarin's collections CSV has no such column, so the build keeps the
// matches itself and publishes them with each view.
const vocabRows = [], vocabMatches = {};
for (const f of [path.join(ROOT, 'model/vocab.csv'), path.join(ROOT, 'rules/vocab.csv')].filter(f => fs.existsSync(f))) {
  for (const r of readTable(f).rows) {
    const { collection_name: c, concept_label: l, match } = r.get;
    if (vocabRows.some(([c2, l2]) => c2 === c && l2 === l)) { problem(`${rel(f)}:${r.line} "${l}" is already in vocabulary "${c}"`); continue; }
    vocabRows.push([c, l]);
    if (match) (vocabMatches[c] ??= {})[l] = expand(match);
  }
}
const vocabCsv = toCsv([['collection_name', 'concept_label'], ...vocabRows]);
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
  // Authors name link targets by model alias (target_model); Alizarin's `graphs` column wants
  // model names, from which it derives each target's graph id.
  const cell = (n, c) => (c === 'ontology_class' || c === 'parent_property') ? expand(n[c])
    : c === 'graphs' ? n.targets.map(t => modelByAlias[t]?.name ?? t).join('|')
    // A field can cite the rule that defines it (model CSV column `rule`); it travels in the
    // graph as the node's description, so the model itself says where its fields come from.
    : c === 'description' ? (n.description || (n.rule ? `Defined by Cairn rule "${n.rule}"` : ''))
    : n[c];
  const nodesCsv = toCsv([NODE_COLS, ...m.nodes.map(n => NODE_COLS.map(c => cell(n, c)))]);
  report(rel(m.file), A.validateModelCsvs(graphCsv, nodesCsv, vocabCsv));
  try {
    m.built = A.buildGraphFromModelCsvs(graphCsv, nodesCsv, RDM_NAMESPACE, vocabCsv);
  } catch (e) {
    problem(`${rel(m.file)} build failed: ${e?.message ?? JSON.stringify(e)}`);
  }
}
if (problems.length) bail();

// Alizarin derives each link's target graph id from the model name; check it agrees with the
// graph ids it actually built, so a renamed model can't leave links pointing nowhere.
for (const m of models) for (const n of m.nodes) {
  if (!LINK_TYPES.has(n.datatype)) continue;
  const got = (m.built.graph.nodes.find(x => x.alias === n.alias).config?.graphs ?? []).map(g => g.graphid).sort();
  const want = n.targets.map(t => modelByAlias[t].built.graph.graphid).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) problem(`${rel(m.file)}:${n.line} link "${n.alias}" targets graph ids ${got.join(', ') || 'none'}, expected ${want.join(', ')}`);
}
if (problems.length) bail();

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
  for (const t of Object.values(tables[key])) {
    for (const r of t.rows) r.cells = t.header.map(c => r.get[c] ?? '');
    // Alizarin wants a resource's rows together; authors may add a repeat row anywhere.
    const order = [...new Set(t.rows.map(r => r.cells[0]))];
    t.rows = order.flatMap(k => t.rows.filter(r => r.cells[0] === k));
  }
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
  // layers/<key>/layer.json may hold a password gate for the explorer (see src/set-password.mjs).
  const settingsFile = path.join(LAYERS_DIR, key, 'layer.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  if (settings.gate && !(/^[0-9a-f]{64}$/.test(settings.gate.sha256 ?? '') && settings.gate.salt)) problem(`${rel(settingsFile)} gate needs "salt" and a hex "sha256"`);
  layers[key] = {
    key, kind, name: row.get.name || key, published: row.get.published === 'true', row, gate: settings.gate ?? null,
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
    // A ResourceID may take several rows, each adding an entry to repeatable (cardinality n)
    // fields such as a group of ties. Single-valued fields must not disagree between rows.
    const first = new Map();
    for (const r of t.rows) {
      const k = r.cells[0];
      if (!first.has(k)) { first.set(k, r); continue; }
      for (const [j, col] of t.header.entries()) {
        const n = m.nodes.find(x => x.alias === col);
        if (j === 0 || !n || n.cardinality !== '1' || n.parent_alias) continue;
        const a = first.get(k).cells[j], b = r.cells[j];
        if (b && a !== b) problem(`${rel(r.file)}:${r.line} "${k}" repeats with a different ${col} ("${b}" vs "${a}" on line ${first.get(k).line}); leave it blank on repeat rows`);
      }
    }
    const keep = t.header.map((c, j) => (j === 0 || !isLinkCol(m, c) ? j : -1)).filter(j => j >= 0);
    const out = buildResources(m, toCsv([keep.map(j => t.header[j]), ...t.rows.map(r => keep.map(j => r.cells[j]))]), key, t.rows);
    out?.forEach(res => {
      const k = res.resourceinstance.legacyid;
      const p = ((present[alias] ??= new Map()).get(k) ?? { id: res.resourceinstance.resourceinstanceid, layers: new Set() });
      p.layers.add(key);
      present[alias].set(k, p);
    });
  }
}
if (problems.length) bail();

// Field rule citations must name a General rule.
for (const m of models) for (const n of m.nodes) {
  if (n.rule && !present.rule?.get(n.rule)?.layers.has(GENERAL)) problem(`${rel(m.file)}:${n.line} rule "${n.rule}" is not a rule in General`);
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

// ---- 6. Compose each view's stack with Alizarin ----------------------------------------

const viewKeys = Object.values(layers).filter(l => l.kind !== 'general' && (l.published || INCLUDE_UNPUBLISHED)).map(l => l.key);
const views = {};   // key -> { model -> { resources, entries } , overrides: [...] }

// What the upper layers do to an entry, by field: replace a single-valued group, add to a
// multi-valued one, or set one the lower layers left empty. `list` is topmost-first.
function layerChanges(m, list) {
  const g = m.built.graph;
  const card = new Map(g.nodegroups.map(ng => [ng.nodegroupid, ng.cardinality]));
  const alias = ng => g.nodes.find(n => n.nodeid === ng)?.alias ?? g.nodes.find(n => n.nodegroup_id === ng)?.alias ?? ng;
  const groups = res => new Set(res.tiles.map(t => t.nodegroup_id));
  const below = new Set(list.slice(1).flatMap(x => [...groups(x.res)]));
  const overrides = [], adds = [], sets = [];
  for (const { res } of list.slice(0, -1)) for (const ng of groups(res)) {
    if (card.get(ng) === 'n') adds.push(alias(ng));
    else if (below.has(ng)) overrides.push(alias(ng));
    else sets.push(alias(ng));
  }
  return { overrides, adds, sets };
}
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
        for (const w of out.warnings) console.warn(`warning: ${v}: ${m.alias}/${keyOfId.get(id)}: ${w}`);
        res = out.resource;
        view.overrides.push({ model: m.alias, key: keyOfId.get(id), layers: list.map(x => x.layer).reverse(), ...layerChanges(m, list) });
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
  const what = [o.overrides.length && `overrides ${o.overrides.join(', ')}`, o.adds.length && `adds to ${o.adds.join(', ')}`, o.sets.length && `sets ${o.sets.join(', ')}`].filter(Boolean).join('; ');
  console.log(`  ${v}: ${o.model}/${o.key} (${o.layers.join(' > ')}): ${what}`);
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

const describe = l => ({ key: l.key, kind: l.kind, name: l.name, stack: l.stack, ...(l.gate ? { gate: l.gate } : {}) });
const open = viewKeys.filter(v => !layers[v].gate);
write('views.json', {
  default: open.find(v => layers[v].kind === 'campaign') ?? open[0] ?? viewKeys[0] ?? null,
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
      nodes: m.nodes.map(n => ({
        alias: n.alias, name: n.name, datatype: n.datatype, cardinality: n.cardinality, parent: n.parent_alias || null,
        targets: n.targets, collection: n.collection_name || null,
        rule: n.rule ? { key: n.rule, id: present.rule?.get(n.rule)?.id ?? null } : null,
      })),
      matches: Object.fromEntries(m.nodes.filter(n => vocabMatches[n.collection_name]).map(n => [n.collection_name, vocabMatches[n.collection_name]])),
      entries: vm.entries,
    });
  }
  write(`views/${v}/index.json`, index);
  write(`views/${v}/manifest.json`, manifest);
}

// ---- 8. Read each view back through the ORM, and render -------------------------------
// The same resource id carries different data in different views, so each view gets its own
// GraphManager and StaticStore. Vocabularies (RDM) are shared and identical across views.

const viewsMeta = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'views.json'), 'utf8'));
const dataPath = f => path.join(DIST, 'data', f);
for (const v of viewKeys) {
  const index = JSON.parse(fs.readFileSync(dataPath(`views/${v}/index.json`), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(dataPath(`views/${v}/manifest.json`), 'utf8'));
  const client = new A.client.ArchesClientLocal({
    allGraphFile: () => dataPath('graphs.json'),
    graphIdToGraphFile: id => dataPath(`graphs/${id}.json`),
    graphIdToResourcesFiles: id => (index[id] ?? []).map(dataPath),
    resourceIdToFile: id => dataPath(`views/${v}/resources/${id}.json`),
    collectionIdToFile: id => dataPath(`collections/${id}.json`),
  });
  const store = new A.StaticStore();
  store.archesClient = client;
  A.RDM.archesClient = client;
  const gm = new A.GraphManager(client, store);
  await gm.initialize();
  const entities = await readEntities(gm, manifest);
  // A gated view gets no plain pages: they would sit, unasked-for, next to the open ones.
  if (!layers[v].gate) renderSite({ view: v, viewsMeta, models: manifest.models, entities, outDir: path.join(DIST, 'pages', v) });
}
renderViewIndex({ viewsMeta, outDir: path.join(DIST, 'pages') });
await buildExplorer(ROOT, DIST);
console.log(`wrote ${rel(DIST)}/: explorer, plain pages and tile store for ${viewKeys.length} view(s)`);
