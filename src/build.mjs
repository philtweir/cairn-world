// Build the Cairn world: CSV models + layered CSV data -> Alizarin graphs/resources -> static site.
//
//   npm run check            validate and build in memory, write nothing
//   npm run build            write dist/ for published views only
//   npm run build -- --all   also include unpublished universes/campaigns (local preview only)
//
// Layers (see README.md):
//   General   model/ + rules/ (+ layers/general/), the base of every stack
//   Universe  layers/<key>/ containing exactly one Universe row with ResourceID <key>
//   Era       layers/<key>/ containing exactly one Era row with ResourceID <key>
//   Campaign  layers/<key>/ containing exactly one Campaign row with ResourceID <key>
// A layer's stack is read from its root entity: a Universe sits on General; an Era on the
// universe its `universe` field links to; a Campaign on the universes or eras its `universes`
// field links to (an era bringing its universe). Links may only target entities visible in the
// linking layer's stack. Each Universe/Era/Campaign is a *view*: its stack composed with
// Alizarin's composeResourceLayers (topmost layer wins per single-valued group).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as A from 'alizarin/inline-full';
import { parseCsv, toCsv } from './csv.mjs';
import { buildExplorer } from './build-explorer.mjs';
import { buildSearch } from './search-index.mjs';
import { writeTables } from './tables.mjs';
import { readAccess, resolveAccess } from './access.mjs';
import { readEdtf } from './edtf.mjs';
import { readEntities } from './world-read.mjs';
import { loadOntology, checkField } from './ontology.mjs';
import { makeResolver, REF } from './refs.mjs';
import { validateGeojson } from '@alizarin/geo';
import { cellToFeatureCollection } from './geometry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const LAYERS_DIR = path.join(ROOT, 'layers');
const CHECK_ONLY = process.argv.includes('--check');
const INCLUDE_UNPUBLISHED = process.argv.includes('--all');

const RDM_NAMESPACE = 'http://cairn-world.example/rdm/';
const CRM = 'http://www.cidoc-crm.org/cidoc-crm/';
const CAIRN = 'http://cairn-world.example/ns/';
// Ontologies interleaved with CIDOC-CRM, declared in ontology/prefixes.csv. Unprefixed names
// are CRM; full URIs pass through.
const PREFIXES = Object.fromEntries(parseCsv(fs.readFileSync(path.join(ROOT, 'ontology/prefixes.csv'), 'utf8')).slice(1));
if (PREFIXES.cairn !== CAIRN) throw new Error('ontology/prefixes.csv must map cairn: to ' + CAIRN);
const NODE_COLS = ['alias', 'name', 'datatype', 'cardinality', 'ontology_class',
  'parent_property', 'parent_alias', 'collection_name', 'graphs', 'description'];
const LINK_TYPES = new Set(['resource-instance', 'resource-instance-list']);
const ROOT_MODELS = ['universe', 'era', 'campaign'];
const GENERAL = 'general';

const EDTF_WIDGET = '10000000-0000-0000-0000-000000000010';   // Arches' edtf-widget
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
const index_of = m => path.join(layerModelDir(m.definedIn), 'models.csv');
for (const a of ROOT_MODELS) if (modelByAlias[a]?.definedIn !== GENERAL) problem(`model/models.csv must define "${a}"`);

// Every model must be expressible in the ontology: known classes and properties, and each field's
// property must accept the class it hangs from and the class (or linked models) it points to.
const ontology = loadOntology(ROOT, expand);
for (const msg of ontology.problems) problem(msg);
for (const m of models) {
  if (!ontology.classes[m.ontology]) problem(`${rel(index_of(m))} model "${m.alias}": class ${m.ontology} is not in CIDOC-CRM 7.1.3 or ontology/extensions.csv`);
  for (const n of m.nodes) {
    n.targets = (n.target_model || '').split('|').filter(Boolean);
    const parent = n.parent_alias ? m.nodes.find(x => x.alias === n.parent_alias) : null;
    for (const msg of checkField(ontology, {
      parentClass: parent ? expand(parent.ontology_class) : m.ontology, cls: expand(n.ontology_class), property: expand(n.parent_property),
      targetClasses: n.targets.map(t => modelByAlias[t]?.ontology).filter(Boolean),
    })) problem(`${rel(m.file)}:${n.line} "${n.alias}": ${msg}`);
  }
}
if (problems.length) bail();

for (const m of models) {
  for (const n of m.nodes) {
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
    // Alizarin's model CSVs have no EDTF datatype, though its graphs and values do: such a field
    // is built as a plain string and made EDTF below.
    : c === 'datatype' && n.datatype === 'edtf' ? 'non-localized-string'
    : n[c];
  const nodesCsv = toCsv([NODE_COLS, ...m.nodes.map(n => NODE_COLS.map(c => cell(n, c)))]);
  report(rel(m.file), A.validateModelCsvs(graphCsv, nodesCsv, vocabCsv));
  try {
    m.built = A.buildGraphFromModelCsvs(graphCsv, nodesCsv, RDM_NAMESPACE, vocabCsv);
    // EDTF fields (Extended Date/Time Format: `-0400~`, `0812-21`, `-1188/-0188`), as Arches
    // builds them: the edtf datatype and its widget.
    for (const n of m.nodes.filter(x => x.datatype === 'edtf')) {
      const node = m.built.graph.nodes.find(x => x.alias === n.alias);
      Object.assign(node, { datatype: 'edtf', config: {} });
      for (const w of m.built.graph.cards_x_nodes_x_widgets ?? []) if (w.node_id === node.nodeid) Object.assign(w, { widget_id: EDTF_WIDGET, config: { placeholder: 'Enter EDTF date' } });
    }
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
      const into = (tables[key][alias] ??= { alias, header: ['ResourceID'], rows: [] });
      for (const c of t.header.slice(1)) {
        if (!m.nodes.some(n => n.alias === c)) problem(`${rel(t.file)} unknown column "${c}" (not in ${rel(m.file)})`);
        else if (!into.header.includes(c)) into.header.push(c);
      }
      into.rows.push(...t.rows);
    }
  }
  for (const t of Object.values(tables[key])) {
    for (const r of t.rows) r.cells = t.header.map(c => r.get[c] ?? '');
    // Geometry cells may be WKT; Alizarin takes a GeoJSON FeatureCollection, checked by
    // @alizarin/geo (its CSV loader parses GeoJSON but does not check coordinates or rings).
    const m = modelByAlias[t.alias];
    for (const [j, col] of t.header.entries()) {
      if (m.nodes.find(n => n.alias === col)?.datatype !== 'geojson-feature-collection') continue;
      for (const r of t.rows) {
        if (!r.cells[j]) continue;
        try {
          const fc = cellToFeatureCollection(r.cells[j]);
          const v = validateGeojson(fc);
          if (!v.valid) throw new Error(v.errors.join('; '));
          r.cells[j] = JSON.stringify(fc);
        } catch (e) { problem(`${rel(r.file)}:${r.line} "${col}" is not a geometry: ${e.message}`); }
      }
    }
    // Alizarin wants a resource's rows together; authors may add a repeat row anywhere.
    const order = [...new Set(t.rows.map(r => r.cells[0]))];
    t.rows = order.flatMap(k => t.rows.filter(r => r.cells[0] === k));
  }
}
if (problems.length) bail();

// ---- 4. Layer structure, read from each layer's root entity --------------------------

// layers/<key>/layer.json: the layer's rights (required: every layer carries its copyright
// attribution), an optional password gate (src/set-password.mjs), and an optional `test` note.
function readSettings(key) {
  const file = path.join(LAYERS_DIR, key, 'layer.json');
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const r = settings.rights;
  if (!r?.holder || !r?.statement) problem(`${rel(file)} needs "rights" with a "holder" and a "statement" (who owns this layer's content, and what it is)`);
  if (r?.licence && !(r.licence.name && r.licence.url)) problem(`${rel(file)} rights.licence needs a "name" and a "url" (or leave it out: all rights reserved)`);
  if (settings.gate && !(/^[0-9a-f]{64}$/.test(settings.gate.sha256 ?? '') && settings.gate.salt)) problem(`${rel(file)} gate needs "salt" and a hex "sha256"`);
  // Who may see what of this layer's view (src/access.mjs): closed, and whom to view it as by default.
  if (settings.access && (typeof settings.access !== 'object' || Object.keys(settings.access).some(k => !['closed', 'default'].includes(k)))) problem(`${rel(file)} access takes "closed" and "default"`);
  // How the world numbers its years (src/edtf.mjs): the marks after a year from its epoch on, and
  // before it, and what they stand for.
  if (settings.calendar && !(settings.calendar.after && settings.calendar.name)) problem(`${rel(file)} calendar needs a "name" and an "after" mark (and optionally "before", "gloss", "epoch")`);
  if (settings.gate?.principal && !settings.access?.closed) problem(`${rel(file)} gate.principal only applies to a closed view ("access": { "closed": true })`);
  // A basemap (src/globe.mjs writes one) is the land, rivers and lakes the explorer draws under this
  // layer's maps; rivers.json (src/terrain.mjs) the rivers found in its detailed areas.
  const drawing = name => {
    const f = path.join(LAYERS_DIR, key, name);
    if (!fs.existsSync(f)) return null;
    const fc = JSON.parse(fs.readFileSync(f, 'utf8'));
    // Checked like a geometry value, except for @alizarin/geo's cap on coordinates per value:
    // these are published files, not values stored in a tile.
    const errors = validateGeojson(fc).errors.filter(e => !/coordinates \(limit is \d+\)/.test(e));
    if (errors.length) problem(`${rel(f)} is not a valid FeatureCollection: ${errors.join('; ')}`);
    return fc;
  };
  // Relief (src/terrain.mjs): images of shaded relief, and relief.json saying where they lie.
  const reliefFile = path.join(LAYERS_DIR, key, 'relief.json');
  let relief = null;
  if (fs.existsSync(reliefFile)) {
    relief = JSON.parse(fs.readFileSync(reliefFile, 'utf8'));
    for (const img of relief.images ?? []) {
      if (!fs.existsSync(path.join(LAYERS_DIR, key, img.file))) problem(`${rel(reliefFile)} names ${img.file}, which is missing (run npm run terrain -- ${key})`);
      if (!(Array.isArray(img.bbox) && img.bbox.length === 4)) problem(`${rel(reliefFile)}: ${img.file} needs a bbox`);
    }
  }
  return { rights: r ?? null, gate: settings.gate ?? null, access: settings.access ?? null, calendar: settings.calendar ?? null, grants: readAccess(LAYERS_DIR, key, problem), test: settings.test ?? null, basemap: drawing('basemap.json'), rivers: drawing('rivers.json'), relief };
}

const layers = {};   // key -> { key, kind, name, published, parents, stack, rights, gate, test }
layers[GENERAL] = { key: GENERAL, kind: 'general', name: 'General', published: true, parents: [], stack: [GENERAL], ...readSettings(GENERAL) };
for (const a of ROOT_MODELS) for (const r of tables[GENERAL][a]?.rows ?? []) problem(`${rel(r.file)}:${r.line} a ${a} belongs in its own layers/<key>/ folder, not General`);

for (const key of layerKeys.filter(k => k !== GENERAL)) {
  const roots = ROOT_MODELS.flatMap(a => (tables[key][a]?.rows ?? []).map(r => ({ kind: a, row: r })));
  for (const { kind, row } of roots) {
    if (row.cells[0] !== key) problem(`${rel(row.file)}:${row.line} layers/${key}/ may only hold its own root; found ${kind} "${row.cells[0]}"`);
  }
  const own = roots.filter(x => x.row.cells[0] === key);
  if (own.length !== 1) { problem(`layers/${key}/ needs exactly one Universe, Era or Campaign row with ResourceID "${key}" (found ${own.length})`); continue; }
  const { kind, row } = own[0];
  layers[key] = {
    key, kind, name: row.get.name || key, published: row.get.published === 'true', row, ...readSettings(key),
    // A universe sits on General; an era on its universe; a campaign on the universes or eras it
    // is set in.
    parents: kind === 'universe' ? [GENERAL] : [GENERAL, ...splitKeys(kind === 'era' ? row.get.universe : row.get.universes)],
  };
}
for (const l of Object.values(layers)) {
  if (l.kind === 'era' && (l.parents.length !== 2 || layers[l.parents[1]]?.kind !== 'universe')) problem(`${rel(l.row.file)}:${l.row.line} era "${l.key}" needs one universe, a universe layer (got "${l.parents.slice(1).join(', ')}")`);
  if (l.kind !== 'campaign') continue;
  for (const u of l.parents.slice(1)) {
    if (!['universe', 'era'].includes(layers[u]?.kind)) problem(`${rel(l.row.file)}:${l.row.line} campaign "${l.key}" is set in "${u}", which is not a universe or era layer`);
  }
}
if (problems.length) bail();
// Stacks are bottom-to-top: each parent's stack, then the layer. A campaign set in an era stands on
// General, the era's universe, the era, then itself.
const stackOf = l => (l.stack ??= [...new Set([...l.parents.flatMap(p => (p === GENERAL ? [GENERAL] : stackOf(layers[p]))), l.key])]);
for (const l of Object.values(layers)) stackOf(l);

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

// [[References]] in text must name something the layer can see (like links, they point down). A
// name is resolved here, against the layer's own stack, and written out exact, as
// [[model/key|label]], so readers never resolve names (and need not load every entry to follow
// one), and a campaign's entries cannot change what a universe's text means. A name that matches
// nothing, or several things, stops the build.
{
  const named = {};   // layer -> [{ model, key, name }]
  for (const key of layerKeys) named[key] = Object.entries(tables[key]).flatMap(([alias, t]) =>
    [...new Map(t.rows.filter(r => r.get.name).map(r => [r.cells[0], { model: alias, key: r.cells[0], name: r.get.name }])).values()]);
  for (const key of layerKeys) {
    const resolve = makeResolver([...new Map(layers[key].stack.flatMap(l => named[l]).map(c => [`${c.model}/${c.key}`, c])).values()]);
    for (const [, t] of Object.entries(tables[key])) for (const r of t.rows) for (const [j] of t.header.entries()) {
      if (!r.cells[j]?.includes('[[')) continue;
      r.cells[j] = r.cells[j].replace(REF, (raw, target, label) => {
        const got = resolve(target);
        if (got.hit) return `[[${got.hit.model}/${got.hit.key}|${label ?? (target.includes('/') ? got.hit.name : target)}]]`;
        if (got.ambiguous) problem(`${rel(r.file)}:${r.line} ${raw} could be ${got.ambiguous.map(c => `${c.model}/${c.key}`).join(' or ')}; write [[${got.ambiguous[0].model}/${got.ambiguous[0].key}|${label ?? target}]]`);
        else problem(`${rel(r.file)}:${r.line} ${raw} matches nothing layer "${key}" can see`);
        return raw;
      });
    }
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
      // Alizarin stores an EDTF value as written; this is the check that it is one (src/edtf.mjs).
      if (j > 0 && r.cells[j] && m.nodes.find(n => n.alias === col)?.datatype === 'edtf' && !readEdtf(r.cells[j])) problem(`${rel(r.file)}:${r.line} "${col}": "${r.cells[j]}" is not an EDTF date (e.g. 0812, -0400~, 0812-21, -1188/-0188)`);
      if (j === 0 || !isLinkCol(m, col)) return r.cells[j];
      const node = m.nodes.find(n => n.alias === col);
      const keys = splitKeys(r.cells[j]);
      // A `resource-instance` field holds one link; a `resource-instance-list` holds several per entry.
      if (node.datatype === 'resource-instance' && keys.length > 1) problem(`${rel(r.file)}:${r.line} "${col}" takes one link, got ${keys.length}`);
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

// A closed view's grants, from every layer in its stack, resolved to its entries (src/access.mjs).
for (const v of viewKeys) {
  if (!layers[v].access?.closed) continue;
  const stack = layers[v].stack;
  const ms = models.filter(m => views[v].models[m.alias]);
  views[v].access = resolveAccess({
    view: v, stack, problem,
    access: Object.fromEntries(stack.map(k => [k, layers[k].grants])),
    models: ms.map(m => ({ alias: m.alias, nodes: m.built.graph.nodes.filter(n => n.alias).map(n => ({ alias: n.alias, nodegroup_id: n.nodegroup_id })) })),
    entries: ms.flatMap(m => views[v].models[m.alias].entries.map(e => ({ ...e, model: m.alias }))),
    settings: layers[v].access, gate: layers[v].gate,
  });
}
if (problems.length) bail();

const totalOwn = layerKeys.reduce((n, k) => n + Object.values(built[k]).reduce((x, l) => x + l.length, 0), 0);
console.log(`ok: ${models.length} models, ${layerKeys.length} layers, ${totalOwn} layer entries, ${viewKeys.length} view(s): ${viewKeys.join(', ') || 'none'}`);
for (const v of viewKeys) for (const o of views[v].overrides) {
  const what = [o.overrides.length && `overrides ${o.overrides.join(', ')}`, o.adds.length && `adds to ${o.adds.join(', ')}`, o.sets.length && `sets ${o.sets.join(', ')}`].filter(Boolean).join('; ');
  console.log(`  ${v}: ${o.model}/${o.key} (${o.layers.join(' > ')}): ${what}`);
}
for (const v of viewKeys) {
  const a = views[v].access;
  if (a) console.log(`  ${v}: closed; ${a.principals.length} principal(s), ${a.grants.length} grant(s) to epoch ${a.epochs.length}${a.held ? `, ${a.held} held back for later epochs` : ''}`);
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
// The ontology the interface reads: class hierarchy, labels, property domains, ranges, inverses.
write('ontology.json', { classes: ontology.classes, properties: ontology.properties });

// Raw, uncomposed layers: for hosts that want to compose themselves.
for (const l of shippedLayers) for (const m of usedModels) {
  const list = built[l][m.alias];
  if (list?.length) write(`layers/${l}/${m.built.graph.graphid}.json`, { business_data: { resources: list } });
}

for (const l of shippedLayers) for (const k of ['basemap', 'rivers', 'relief']) if (layers[l][k]) write(`layers/${l}/${k}.json`, layers[l][k]);
for (const l of shippedLayers) for (const img of layers[l].relief?.images ?? []) fs.copyFileSync(path.join(LAYERS_DIR, l, img.file), path.join(DIST, 'data', 'layers', l, img.file));
const describe = l => ({ key: l.key, kind: l.kind, name: l.name, stack: l.stack, rights: l.rights, ...(l.kind === 'era' ? { when: l.row.get.when || null, sequence: Number(l.row.get.sequence) || 0, dates: l.row.get.dates || null } : {}), ...(l.test ? { test: l.test } : {}), ...(l.gate ? { gate: l.gate } : {}), ...(l.calendar ? { calendar: l.calendar } : {}),
  ...Object.fromEntries(['basemap', 'rivers', 'relief'].filter(k => l[k]).map(k => [k, `layers/${l.key}/${k}.json`])) });
const open = viewKeys.filter(v => !layers[v].gate);
write('views.json', {
  default: open.find(v => layers[v].kind === 'campaign') ?? open[0] ?? viewKeys[0] ?? null,
  views: viewKeys.map(v => ({ ...describe(layers[v]), ...(views[v].access ? { access: { default: views[v].access.default, epochs: views[v].access.epochs, principals: views[v].access.principals } } : {}) })),
  layers: Object.fromEntries(shippedLayers.map(l => [l, describe(layers[l])])),
});

// Each view's manifest as built, with every entry's id, key and layers. Published without those
// lists, which grow with the world (the explorer reads them from views/<view>/tables/ instead).
const fullManifest = {};
for (const v of viewKeys) {
  const index = {};
  // `overrides` is the layer audit (what each upper layer changes), for the view's home page.
  const manifest = fullManifest[v] = { view: v, models: [], overrides: views[v].overrides };
  for (const m of usedModels) {
    const vm = views[v].models[m.alias];
    if (!vm) continue;
    const gid = m.built.graph.graphid;
    // Arches' resource descriptors: the name, which Rós Madair's tiles carry as descriptor_name.
    for (const r of vm.resources) r.resourceinstance.descriptors = { name: r.resourceinstance.name };
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
        property: expand(n.parent_property), class: expand(n.ontology_class),
        rule: n.rule ? { key: n.rule, id: present.rule?.get(n.rule)?.id ?? null } : null,
      })),
      matches: Object.fromEntries(m.nodes.filter(n => vocabMatches[n.collection_name]).map(n => [n.collection_name, vocabMatches[n.collection_name]])),
      entries: vm.entries,
    });
  }
  write(`views/${v}/index.json`, index);
  write(`views/${v}/manifest.json`, { ...manifest, models: manifest.models.map(({ entries, ...m }) => m) });
}

// ---- 8. Read each view back through the ORM ----------------------------------------------
// A check, not output: every view must load in Alizarin exactly as the explorer will load it. The
// same resource id carries different data in different views, so each view gets its own
// GraphManager and StaticStore. Vocabularies (RDM) are shared and identical across views.

const dataPath = f => path.join(DIST, 'data', f);
const generalOnly = {};   // view -> ids of the entries only General has
for (const v of viewKeys) {
  const index = JSON.parse(fs.readFileSync(dataPath(`views/${v}/index.json`), 'utf8'));
  const manifest = fullManifest[v];
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
  const expected = manifest.models.reduce((n, m) => n + m.entries.length, 0);
  if (entities.length !== expected) { console.error(`error: view ${v} read back ${entities.length} entries through the ORM, expected ${expected}`); process.exit(1); }
  // The view's tables (src/tables.mjs): its entries, and the links its [[references]] make.
  const graphOf = Object.fromEntries(manifest.models.map(m => [m.alias, m.graphid]));
  await writeTables(dataPath(`views/${v}/tables`), {
    resources: entities.map(e => ({ resource_id: e.id, model: e.model, graph_id: graphOf[e.model], key: e.key, name: String(e.fields.find(f => f.alias === 'name')?.value ?? e.key), layers: e.layers, general: e.layers.length === 1 && e.layers[0] === GENERAL })),
    mentions: entities.flatMap(e => (e.fields.find(f => f.derived)?.value ?? []).map(t => ({ src_resource: e.id, src_node: 'mentions', src_nodegroup: 'mentions', src_tile: null, target_resource: t }))),
    access: views[v].access?.grants ?? null,
  });
  generalOnly[v] = new Set(entities.filter(e => e.layers.length === 1 && e.layers[0] === GENERAL).map(e => e.id));
}
// Every view's Rós Madair substrate, which the explorer reads everything from, and, for an open
// view, its Pagefind index (src/search-index.mjs).
{
  const search = await buildSearch(ROOT, DIST, viewKeys.map(v => ({
    key: v,
    models: usedModels.filter(m => views[v].models[m.alias]).map(m => ({ alias: m.alias, graphid: m.built.graph.graphid })),
    resources: usedModels.flatMap(m => views[v].models[m.alias]?.resources ?? []),
    text: !layers[v].gate && !views[v].access,
    general: generalOnly[v],
  })));
  const meta = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'views.json'), 'utf8'));
  for (const d of meta.views) if (search[d.key]) d.search = search[d.key];
  write('views.json', meta);
}

// A content hash of this build's data. The explorer fetches views.json fresh and asks for every
// other file with ?v=<build>, so a browser (Pages lets it cache for 10 minutes) never mixes a
// cached model from one deploy with resources from the next.
{
  const hash = crypto.createHash('sha1');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(f => {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (p !== path.join(DIST, 'data', 'views.json')) hash.update(path.relative(DIST, p)).update(fs.readFileSync(p));
  });
  walk(path.join(DIST, 'data'));
  const views = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'views.json'), 'utf8'));
  write('views.json', { build: hash.digest('hex').slice(0, 12), ...views });
}

await buildExplorer(ROOT, DIST, JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'views.json'), 'utf8')).build);
console.log(`wrote ${rel(DIST)}/: explorer and tile store for ${viewKeys.length} view(s), each read back through the ORM`);
