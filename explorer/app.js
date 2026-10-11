// Cairn World explorer: reads a view as it is needed (explorer/store.mjs: the view's Rós Madair
// substrate and tables through DuckDB, an entry's fields through Alizarin) and shows it through lenses taken from the ontology (src/lenses.mjs): a home
// page for the view's root entry, one page per lens, detail pages and a 1-hop graph.
// Everything user-visible is built with DOM text nodes; data never goes through innerHTML.

import * as A from 'alizarin';
import { links, refRelation } from '../src/world-read.mjs';
import { makeStore } from './store.mjs';
import { blocks, inline, tableRows } from '../src/md.mjs';
import { assignLenses } from '../src/lenses.mjs';
import { drawLens } from './lens-views.mjs';
import { geoMap, locate } from './geo-map.mjs';
import { groupViews } from '../src/views.mjs';
import { makeFinder, excerptNodes } from './finder.mjs';
import { openDrafts } from './drafts.mjs';
import { editForm } from './editor.mjs';

const DATA = new URL('./data', import.meta.url).href;
let V = '';   // ?v=<build>, set from views.json
const LIST_LIMIT = 200;
const LENS_LIMIT = 500;   // entries a lens lays out at most
const GRAPH_LIMIT = 14;

const $ = id => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
// Replace an element's children, flattening nested arrays and dropping false/null.
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
// A monochrome icon from the build's Lucide sprite (icons.svg); it takes the text colour.
const icon = (name, cls = '') => svg('svg', { class: `icon ${cls}`.trim(), 'aria-hidden': 'true' }, svg('use', { href: `icons.svg${V}#i-${name}` }));

// Markdown tree (src/md.mjs) to DOM, as text nodes only.
// A [[reference]] arrives exact, [[model/key|label]] (the build resolves names), so its link is
// its address: no entry has to be loaded to follow it. In the author's view its style says how the
// entry whose text it is (`textOf`) stands to the referent: related, related only the other way,
// or mentioned with no relationship (see refRelation).
let textOf = null;
const REL_TITLE = { 'rel-in': 'Related only from the other side', mention: 'Mentioned, but no relationship recorded' };
const md = nodes => nodes.map(n => {
  if (typeof n === 'string') return n;
  if (n.t === 'ref') {
    const href = n.target.includes('/') ? `#/${[state.view, ...n.target.split('/')].map(encodeURIComponent).join('/')}` : null;
    const t = state.byId.get(state.store?.refId(n.target));
    if (!href && !t) return md(n.c);
    if (!state.author || !t) return h('a', { href: href ?? route(t), class: 'ref' }, md(n.c));
    const rel = refRelation(textOf, t, state.back);
    return h('a', { href: href ?? route(t), class: `ref ${rel}`, title: REL_TITLE[rel] ?? false }, md(n.c));
  }
  return h(n.t, {}, md(n.c));
});
// A model's name in the plural: "Factions", "Strands of Magic".
const plural = name => name.replace(/^(.+?)( of .+)?$/, (_, head, tail = '') => `${head}s${tail}`);
const field = (e, alias) => e.fields.find(f => f.alias === alias)?.value;
const section = e => field(e, 'section') ?? Infinity;
const inOrder = (a, b) => section(a) - section(b) || title(a).localeCompare(title(b));
const HIDDEN = new Set(['name', 'description', 'entries', 'columns', 'die', 'mentions']);

// A table in `entries` (a Roll Table's, or any model's with that field): `columns` heads every
// column, or every one after the die.
function rollTable(e) {
  const rows = tableRows(field(e, 'entries'));
  const width = Math.max(...rows.map(r => r.length));
  const columns = field(e, 'columns') ? field(e, 'columns').split(' | ') : [];
  const head = columns.length === width ? columns : [field(e, 'die') || 'Roll', ...columns];
  return h('div', { class: 'wrap' }, h('table', {},
    head.length === width ? h('thead', {}, h('tr', {}, head.map(c => h('th', {}, c))))
      : field(e, 'die') && h('caption', {}, `Roll ${field(e, 'die')}`),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map(c => h('td', {}, md(inline(c)))))))));
}

const state = { view: null, viewsMeta: null, models: [], byId: new Map(), back: new Map(), modelOf: {}, filter: new Set(), rules: false, q: '', matches: {}, author: (() => { try { return localStorage.getItem('cairn-world:author') === '1'; } catch { return false; } })(), ontology: null, lenses: [], lensOf: {}, root: null, overrides: [], store: null, counts: {}, finder: { passes: () => true, canFilter: false, canSearch: false }, hits: null, filterScope: null };

const title = e => e.fields.find(f => f.alias === 'name')?.value ?? e.key;
const route = e => `#/${state.view}/${e.model}/${e.key}`;
// Entries that come only from General are the shared rules reference, hidden by default.
const isGeneral = e => e.layers.length === 1 && e.layers[0] === 'general';
const layerName = l => state.viewsMeta.layers[l]?.name ?? l;
const provenance = e => {
  const [first, ...rest] = e.layers;
  return first ? `Defined in ${layerName(first)}` + (rest.length ? ` · changed in ${rest.map(layerName).join(', ')}` : '') : '';
};
// The hash is #/<view>/ (home), #/<view>/@<lens>, or #/<view>/<model>/<key>.
const hashParts = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
const status = (msg, error = false) => { const s = $('status'); s.textContent = msg; s.className = error ? 'error' : ''; s.hidden = !msg; };

// ---- Load -----------------------------------------------------------------------------------

async function load() {
  // views.json is always fetched fresh; everything else carries its build (see src/build.mjs).
  state.viewsMeta = await fetch(`${DATA}/views.json`, { cache: 'no-store' }).then(r => r.json());
  V = `?v=${state.viewsMeta.build ?? ''}`;
  const keys = state.viewsMeta.views.map(v => v.key);
  if (!keys.length) throw new Error('this site has no published universe or campaign');
  const [first, ...rest] = hashParts();
  if (keys.includes(first)) state.view = first;
  else {
    // An old link without a view (#/faction/ferrymen) opens in the default view.
    state.view = state.viewsMeta.default ?? keys[0];
    history.replaceState(null, '', `#/${[state.view, ...(first ? [first, ...rest] : [])].map(encodeURIComponent).join('/')}`);
  }
  fillViews();
  const v = state.viewsMeta.views.find(x => x.key === state.view);
  if (v.gate) await unlock(v);
  const [manifest, ontology] = await Promise.all([
    fetch(`${DATA}/views/${state.view}/manifest.json${V}`).then(r => r.json()),
    fetch(`${DATA}/ontology.json${V}`).then(r => r.json()),
  ]);
  state.ontology = ontology;
  state.models = manifest.models;
  state.matches = Object.assign({}, ...manifest.models.map(m => m.matches ?? {}));
  state.modelOf = Object.fromEntries(manifest.models.map(m => [m.alias, m]));
  ({ lenses: state.lenses, lensOf: state.lensOf } = assignLenses(ontology, manifest.models.map(m => ({ alias: m.alias, ontology: m.ontology }))));
  state.overrides = manifest.overrides ?? [];

  // The database (DuckDB over the view's Parquet: explorer/query-engine.mjs, a bundle of its own
  // named by its version, so it stays cached across deploys) and Alizarin, side by side.
  status('Opening the world…');
  const graphs = await Promise.all(manifest.models.map(m => fetch(`${DATA}/graphs/${m.graphid}.json${V}`).then(r => r.text())));
  const vocabularies = new Map();
  const collection = id => vocabularies.get(id) ?? vocabularies.set(id, fetch(`${DATA}/collections/${id}.json${V}`).then(r => r.json())).get(id);
  const at = p => new URL(p, import.meta.url).href;
  const engine = import(at(__ENGINE__.js)).then(({ openEngine }) => openEngine({
    duckdb: at(__ENGINE__.duckdb), compiler: at(__ENGINE__.compiler),
    extensions: __ENGINE__.extensions ? { ...__ENGINE__.extensions, repository: at(__ENGINE__.extensions.repository) } : null,
    substrate: `${DATA}/${v.search.substrate}`, tables: `${DATA}/${v.search.tables}`, graphs, suffix: V,
  }));
  await A.wasmReady;
  // Alizarin reads graphs and vocabularies as static files; its resources come from the
  // substrate (the store answers getResource from the Parquet).
  const archesClient = new A.client.ArchesClientRemoteStatic(DATA, {
    allGraphFile: () => `graphs.json${V}`,
    graphToGraphFile: meta => `graphs/${meta.graphid}.json${V}`,
    graphIdToGraphFile: id => `graphs/${id}.json${V}`,
    collectionIdToFile: id => `collections/${id}.json${V}`,
  });
  A.graphManager.archesClient = archesClient;
  A.staticStore.archesClient = archesClient;
  A.RDM.archesClient = archesClient;
  state.engine = await engine;
  state.store = makeStore({ engine: state.engine, A, client: archesClient, manifest, state, collection,
    graphs: Object.fromEntries(graphs.map(g => JSON.parse(g).graph[0]).map(g => [g.graphid, g])) });
  await A.graphManager.initialize();
  // Edits made in this browser: a layer over the view, in place before anything is read.
  state.drafts = await openDrafts(state.view, state.viewsMeta.build);
  if (state.drafts.list().length) state.editProblems = await state.store.applyEdits(state.drafts);
  // A campaign shows what it uses (explorer/store.mjs, scope) unless asked for its whole world.
  state.campaign = v.kind === 'campaign';
  state.scoped = state.campaign && (() => { try { return localStorage.getItem('cairn-world:scoped') !== '0'; } catch { return true; } })();
  if (state.campaign) await state.store.setScope(state.scoped);
  state.counts = await state.store.counts(state.view);
  // A view with nothing of its own but its root (the Cairn 2e reference) is there for General: show it.
  if (Object.values(state.counts).reduce((n, c) => n + c.n - c.general, 0) <= 1) { state.rules = true; const box = $('rules'); if (box) box.checked = true; }
  // The view's root is the entry its own layer is keyed by (the Universe or Campaign itself).
  [state.root = null] = await state.store.full([state.store.idOf(v.kind, state.view)]);
  state.finder = makeFinder({ data: DATA, suffix: V, view: v, models: manifest.models, engine: state.engine, h, put, icon });
}

// ---- Password gate ----------------------------------------------------------------------------
// A campaign can ask for a password before it loads. This only keeps casual visitors (players!)
// out: the data is in the public repository and on the site for anyone who goes looking.
// The salted SHA-256 of the right password is remembered in this browser.

const gateKey = v => `cairn-world:gate:${v.key}`;
const remembered = v => { try { return localStorage.getItem(gateKey(v)) === v.gate.sha256; } catch { return false; } };
const remember = v => { try { localStorage.setItem(gateKey(v), v.gate.sha256); } catch { /* private mode: ask again next time */ } };
const forget = v => { try { localStorage.removeItem(gateKey(v)); } catch { /* nothing stored */ } };
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function unlock(v) {
  if (remembered(v)) return Promise.resolve();
  status('');
  const form = $('gate');
  put($('gate-title'), v.name);
  form.hidden = false;
  $('gate-pw').focus();
  return new Promise(resolve => {
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const ok = (await sha256(`${v.gate.salt}:${$('gate-pw').value}`)) === v.gate.sha256;
      if (!ok) { $('gate-msg').textContent = 'That is not the password.'; $('gate-pw').select(); return; }
      remember(v);
      form.hidden = true;
      $('lock').hidden = false;
      status('Loading…');
      resolve();
    });
  });
}

// The footer credits every layer in this view's stack (layers/<key>/layer.json rights).
function rightsLine(l) {
  const r = l.rights;
  if (!r) return null;
  return h('li', {}, h('b', {}, l.name), `: ${r.statement} © ${r.year ? `${r.year} ` : ''}${r.holder}. `,
    r.licence ? h('a', { href: r.licence.url }, r.licence.name) : 'All rights reserved',
    r.source ? [' · ', h('a', { href: r.source.url }, r.source.name)] : null,
    l.test ? h('span', { class: 'test' }, ` (${l.test})`) : null);
}

function fillViews() {
  const stack = state.viewsMeta.views.find(x => x.key === state.view)?.stack ?? [];
  put($('rights'), stack.map(k => state.viewsMeta.layers[k]).filter(Boolean).map(rightsLine));
  // Grouped by universe: the universe itself, then its campaigns.
  put($('view'), groupViews(state.viewsMeta).map(g => h('optgroup', { label: g.label },
    g.views.map(v => h('option', { value: v.key, selected: v.key === state.view },
      `${'\u2003'.repeat(v.depth ?? 0)}${v.kind === 'universe' ? `${v.name} (universe)` : v.kind === 'era' ? `${v.name} (era)` : v.name}${v.gate ? ' · locked' : ''}`)))));
  // Each view has its own ORM state (and maybe a gate), so switching reloads the page.
  $('view').onchange = ev => { location.hash = `#/${ev.target.value}/`; location.reload(); };
  document.querySelector('.brand').setAttribute('href', `#/${state.view}/`);
  const v = state.viewsMeta.views.find(x => x.key === state.view);
  const lock = $('lock');
  lock.hidden = !(v.gate && remembered(v));
  lock.onclick = () => { forget(v); location.reload(); };
}

// ---- Sidebar --------------------------------------------------------------------------------

const visible = e => (state.rules || !isGeneral(e)) && e.id !== state.root?.id;
const lensById = id => state.lenses.find(l => l.id === id);
const inLens = (lens, e) => state.lensOf[e.model] === lens.id;
// The land under maps, and its relief: from the topmost layer in this view's stack that has each,
// as one FeatureCollection.
const basemap = () => (state.basemap ??= (() => {
  const view = state.viewsMeta.views.find(v => v.key === state.view);
  const get = what => {
    const key = [...(view?.stack ?? [])].reverse().find(k => state.viewsMeta.layers[k]?.[what]);
    return key ? fetch(`${DATA}/${state.viewsMeta.layers[key][what]}${V}`).then(r => (r.ok ? r.json() : null)).catch(() => null) : null;
  };
  // Relief images sit beside relief.json; each gets its address here.
  const reliefDir = () => { const key = [...(view?.stack ?? [])].reverse().find(k => state.viewsMeta.layers[k]?.relief); return key && `${DATA}/${state.viewsMeta.layers[key].relief.replace(/[^/]*$/, '')}`; };
  return Promise.all([get('basemap'), get('rivers'), get('relief')]).then(([b, rv, r]) => (b ? {
    ...b, features: [...b.features, ...(rv?.features ?? [])],
    relief: r ? { ...r, images: r.images.map(i => ({ ...i, url: `${reliefDir()}${i.file}${V}` })) } : null,
  } : null));
})());
const ctx = () => ({ state, ontology: state.ontology, h, svg, put, route, title, links, md, inOrder, isGeneral, icon, basemap });
// How many entries a model shows (General-only ones only when asked for; never the root).
const shownCount = alias => { const c = state.counts[alias]; if (!c) return 0; return c.n - (state.rules ? 0 : c.general) - (state.root?.model === alias ? 1 : 0); };

// The list: the current lens's entries (or, on the home page, everything), a page at a time; a
// search (the view's text index, else names) or a filter narrows it. Read as it is drawn, so a
// later draw supersedes one still reading.
let sideDraws = 0;
async function renderSide(currentId) {
  const mine = ++sideDraws;
  const scope = !state.q && state.scope ? lensById(state.scope) : null;
  const scopeModels = state.models.filter(m => (!scope || state.lensOf[m.alias] === scope.id) && shownCount(m.alias));
  put($('scope'), state.q ? 'Search: everything' : scope ? scope.label : 'Everything');
  put($('chips'), scopeModels.map(m =>
    h('button', {
      class: 'chip', type: 'button', 'aria-pressed': state.filter.has(m.alias),
      onclick: () => { state.filter.has(m.alias) ? state.filter.delete(m.alias) : state.filter.add(m.alias); renderSide(currentId); },
    }, m.name, h('small', {}, shownCount(m.alias)))));

  // The filter panel: for the models in the lens. Moving to another lens starts it afresh.
  const filters = $('filters');
  filters.hidden = !state.finder.canFilter;
  const lens = state.scope ? lensById(state.scope) : null;
  const panelModels = state.models.filter(m => (lens ? lens.models.includes(m.alias) : true) && shownCount(m.alias));
  const scopeKey = panelModels.map(m => m.alias).join(' ');
  if (state.finder.canFilter && scopeKey !== state.filterScope) {
    state.filterScope = scopeKey;
    state.finder.clear();
    // A change of filter re-asks the search, whose best matches depend on it.
    put($('filter-panel'), state.finder.panel(panelModels, () => (state.q ? $('q').dispatchEvent(new Event('input')) : renderSide(currentId))));
  }
  $('rules-count').textContent = `(${Object.values(state.counts).reduce((n, c) => n + c.general, 0)})`;
  $('scope-wrap').hidden = !state.campaign;
  const used = Object.values(state.counts).reduce((n, c) => n + c.n - c.general, 0), world = Object.values(state.counts).reduce((n, c) => n + c.world, 0);
  $('scope-count').textContent = state.scoped ? `(${used} of ${world})` : `(${world})`;

  const chosen = scopeModels.filter(m => !state.filter.size || state.filter.has(m.alias)).map(m => m.alias);
  let rows, total = null;
  const rank = state.q && state.hits?.rank;
  if (state.q && state.hits) rows = state.hits.list;
  else if (state.q) rows = await state.store.named(state.q, { general: state.rules, limit: LIST_LIMIT });
  else if (state.finder.active()) {
    const ids = state.finder.ids(chosen);
    rows = await state.store.page({ models: chosen.filter(a => state.finder.filtered(a)), general: state.rules, ids, limit: LIST_LIMIT });
    total = ids.filter(state.store.inScope).length;
  } else {
    rows = await state.store.page({ models: chosen, general: state.rules, limit: LIST_LIMIT });
    total = chosen.reduce((n, a) => n + shownCount(a), 0);
  }
  if (mine !== sideDraws) return;
  rows = rows.filter(e => visible(e) && (!state.filter.size || state.filter.has(e.model)));
  if (rank) rows.sort((a, b) => state.models.findIndex(m => m.alias === a.model) - state.models.findIndex(m => m.alias === b.model) || rank.get(a.id) - rank.get(b.id));
  const perModel = alias => (total === null || state.finder.active() ? rows.filter(r => r.model === alias).length : shownCount(alias));
  // Grouped by model, each entry marked with its model's colour.
  const items = [];
  rows.forEach((e, i) => {
    if (!i || rows[i - 1].model !== e.model) items.push(h('li', { class: 'grp' }, state.modelOf[e.model].name, h('small', {}, perModel(e.model))));
    const ex = rank && state.hits.excerpt.get(e.id);
    items.push(h('li', {}, h('a', { href: route(e), 'aria-current': e.id === currentId, class: `${colourOf(e.model)}${state.store.edited(e.id) ? ' edited' : ''}`, title: state.store.edited(e.id) ? 'Edited in this browser' : false }, h('i', { class: 'dot' }), h('span', { class: 'nm' }, title(e)),
      ex && h('span', { class: 'ex' }, excerptNodes(h, ex)))));
  });
  put($('list'), [
    ...items,
    total !== null && total > rows.length && h('li', { class: 'more' }, `${total - rows.length} more — narrow with search or a filter.`),
    rank && !state.hits.complete && h('li', { class: 'more' }, `The best ${LIST_LIMIT} text matches; add words to narrow the search.`),
    !rows.length && h('li', { class: 'more' }, 'Nothing matches.'),
  ]);
  if (currentId) document.querySelector('#list [aria-current=true]')?.scrollIntoView({ block: 'nearest' });
}

// ---- Detail ---------------------------------------------------------------------------------

function linkTo(e) {
  return [h('a', { href: route(e) }, title(e)), h('span', { class: 'm' }, state.modelOf[e.model].name)];
}

// Colour of an entry: its model's place within its lens, as in the lens graphs and legends.
const colourOf = alias => { const l = lensById(state.lensOf[alias]); return `c${Math.max(0, l?.models.indexOf(alias) ?? 0) % 8}`; };
const has = f => f.value != null && !(Array.isArray(f.value) && !f.value.length);
const chip = (t, detail) => h('a', { class: `chip-link ${colourOf(t.model)}`, href: route(t), title: `${title(t)} · ${state.modelOf[t.model].name}` },
  h('i', { class: 'dot' }), h('span', { class: 'nm' }, title(t)), detail && h('small', {}, detail));
// Long lists show their first few chips and a button for the rest.
function chipRow(items, max = 10) {
  const row = h('div', { class: 'chips-row' }, items.slice(0, max));
  if (items.length > max) row.append(h('button', { type: 'button', class: 'more-btn', onclick: ev => { ev.target.replaceWith(...items.slice(max)); } }, `+${items.length - max} more`));
  return row;
}

// Before an entry's page: what it shows besides itself, read in full: everything it links to and
// everything that links to it (its connections and graph), the places of the events among them,
// and the places those lie within, up to six deep (its map); and the rules its fields cite.
async function neighbourhood(id) {
  const { store } = state;
  const [e] = await store.full([id]);
  if (!e) return null;
  const back = await store.backOf(id);
  const near = await store.full([...links(e).map(l => l.id), ...back.map(b => b.from.id)]);
  await store.full(near.filter(n => state.lensOf[n.model] === 'time').flatMap(n => links(n).map(l => l.id)));
  const P = state.lenses.find(l => l.layout === 'places')?.anchor;
  let up = [...state.byId.values()].filter(x => x.full);
  for (let depth = 0; depth < 6 && up.length; depth++) up = await store.full(up.flatMap(x => links(x).filter(l => l.property === P).map(l => l.id)).filter(t => !state.byId.get(t)?.full));
  await store.know(state.modelOf[e.model].nodes.map(n => n.rule?.id).filter(Boolean));
  return e;
}

function renderDetail(e) {
  textOf = e;
  const model = state.modelOf[e.model];
  const lens = lensById(state.lensOf[e.model]);
  const description = field(e, 'description');
  // A geometry is drawn as the map above the entry, not listed.
  const present = e.fields.filter(f => !HIDDEN.has(f.alias) && has(f) && f.datatype !== 'geojson-feature-collection');

  const term = f => v => { const uri = state.matches[f.collection]?.[v]; return uri ? h('a', { href: uri, title: uri, class: 'match' }, v) : v; };
  const plainValue = f => {
    if (Array.isArray(f.value)) return f.value.flatMap((v, i) => [i ? ', ' : '', term(f)(v)]);
    if (f.datatype === 'concept') return term(f)(f.value);
    if (typeof f.value === 'boolean') return f.value ? 'Yes' : 'No';
    return typeof f.value === 'string' ? md(inline(f.value)) : String(f.value);
  };
  // A field that cites its rule links its label to that rule.
  const label = f => {
    const r = f.rule?.id && state.byId.get(f.rule.id);
    return r ? h('a', { href: route(r), title: `Rule: ${title(r)}` }, f.label) : f.label;
  };

  // Facts: numbers as stat chips; short values (kinds, traits, yes/no) as tags; longer text as notes.
  const isLink = f => f.targets.length || (f.datatype === 'semantic' && f.value.some(i => i.fields.some(c => c.targets.length && has(c))));
  // A number with a "Max <label>" partner shows as one chip, "STR 9/14".
  const numbers = present.filter(f => f.datatype === 'number');
  const maxOf = f => numbers.find(g => g.label === `Max ${f.label}`);
  const isMax = f => numbers.some(g => f.label === `Max ${g.label}`);
  const stats = numbers.filter(f => !isMax(f));
  const short = f => ['concept', 'concept-list', 'boolean'].includes(f.datatype) || (f.datatype === 'string' && !/\n/.test(f.value) && f.value.length <= 48 && f.alias !== 'source');
  const tags = present.filter(f => !isLink(f) && f.datatype !== 'number' && f.datatype !== 'semantic' && short(f));
  const notes = present.filter(f => !isLink(f) && f.datatype !== 'number' && !tags.includes(f) && f.alias !== 'source');
  const source = field(e, 'source');

  // Connections: what this entry links to and what links to it, one chip per entry, grouped by
  // the relationship. Mentions in text count only where nothing stronger connects the two.
  const conns = new Map();
  const conn = id => { if (!conns.has(id)) conns.set(id, { e: state.byId.get(id), out: [], in: [], mention: false }); return conns.get(id); };
  for (const l of links(e)) if (l.id !== e.id && state.byId.has(l.id)) { if (l.derived) conn(l.id).mention = true; else conn(l.id).out.push(l.label); }
  for (const b of state.back.get(e.id) ?? []) if (b.from.id !== e.id) { if (b.derived) conn(b.from.id).mention = true; else conn(b.from.id).in.push(b.via); }
  const groups = new Map();   // title -> [chip]
  const put1 = (g, c) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); };
  const order = [...conns.values()].sort((a, b) => inOrder(a.e, b.e));
  for (const c of order.filter(c => c.out.length)) {
    const [g, detail] = c.out[0].split(': ');
    put1(g, chip(c.e, detail));
  }
  for (const c of order.filter(c => !c.out.length && c.in.length)) {
    const [via, detail] = c.in[0].split(': ');
    put1(`${plural(state.modelOf[c.e.model].name)} · ${via}`, chip(c.e, detail));
  }
  const mentionsOnly = order.filter(c => !c.out.length && !c.in.length && c.mention);
  const nConn = conns.size;

  const head = h('header', { class: `entry-head ${colourOf(e.model)}` },
    h('div', { class: 'avatar', 'aria-hidden': 'true' }, lens?.icon ? icon(lens.icon) : title(e).slice(0, 1)),
    h('div', {},
      h('div', { class: 'crumbs' }, lens && h('a', { href: `#/${state.view}/@${lens.id}` }, lens.label), lens && ' › ', h('span', { class: 'type' }, model.name)),
      h('h1', {}, title(e)),
      state.author && h('div', { class: 'kind' }, `${provenance(e)} · ${model.ontology.replace(/^.*\//, '').replace(/_/g, ' ')}`)),
    state.author && !isRoot(e) && h('a', { class: 'edit-btn', href: `${route(e)}/edit` }, icon('pencil'), 'Edit'));

  // Where it is, across the top: its own place on the map, or the places it links to.
  const where = locate(ctx(), e);
  // The caption says how each place was found: "Home: Hearth", "Home: Candlesham, somewhere in
  // Miurna" (Candlesham has no location of its own), "Within it: Godrastan, Cofrey".
  const said = new Map();
  for (const x of where.items.filter(x => x.role === 'focus' && x.how !== 'Here')) {
    const a = p => h('a', { href: route(p) }, title(p));
    const k = x.approx && !x.at ? 'Somewhere in' : x.how;
    said.set(k, [...(said.get(k) ?? []), x.at ? [a(x.at), ', somewhere in ', a(x.e)] : a(x.e)]);
  }
  for (const m of where.missing) said.set(m.how, [...(said.get(m.how) ?? []), [h('a', { href: route(m.e) }, title(m.e)), h('span', { class: 'nomap' }, ' (no location yet)')]]);
  const map = where.items.length ? h('figure', { class: 'where' },
    geoMap(ctx(), { items: where.items, lines: where.lines, basemap: basemap(), cls: 'geomap banner', label: `Where ${title(e)} is` }),
    said.size ? h('figcaption', {}, [...said].map(([k, v], i) => [i ? ' · ' : '', `${k}: `, v.map((x, j) => [j ? ', ' : '', x])])) : null) : null;

  put($('detail'),
    h('a', { class: 'back', href: lens ? `#/${state.view}/@${lens.id}` : `#/${state.view}/` }, `← ${lens?.label ?? 'All entries'}`),
    map,
    head,
    editedBanner(e),
    description && h('div', { class: 'text lead' }, md(blocks(description))),
    state.author && description && /\[\[/.test(description) && h('div', { class: 'reflegend' }, 'References: ', h('a', { class: 'ref rel' }, 'related'), ' · ',
      h('a', { class: 'ref rel-in' }, 'related the other way'), ' · ', h('a', { class: 'ref mention' }, 'mention only')),
    field(e, 'entries') && rollTable(e),
    (stats.length || tags.length) ? h('div', { class: 'facts' },
      stats.map(f => h('span', { class: 'stat' }, label(f), h('b', {}, String(f.value), maxOf(f) && maxOf(f).value !== f.value ? h('small', {}, `/${maxOf(f).value}`) : null))),
      tags.map(f => h('span', { class: 'tag' }, h('small', {}, label(f)), plainValue(f)))) : null,
    notes.map(f => h('section', { class: 'note-block' }, h('h3', {}, label(f)),
      f.datatype === 'semantic'
        ? h('ul', {}, f.value.map(item => h('li', {}, item.fields.filter(has).flatMap((c, i) => [i ? ' · ' : '', plainValue(c)]))))
        : h('div', { class: 'text' }, md(blocks(f.value))))),
    groups.size ? [h('h2', {}, `Connections`), h('div', { class: 'conn-groups' }, [...groups].map(([g, chips]) =>
      h('section', { class: 'conn' }, h('h3', {}, g), chipRow(chips))))] : null,
    mentionsOnly.length ? h('div', { class: `mentions${state.author ? ' author' : ''}` }, h('span', {}, state.author ? 'Mention only:' : 'Also mentioned:'),
      chipRow(mentionsOnly.map(c => chip(c.e)), 8)) : null,
    nConn ? h('details', { class: 'graphbox' }, h('summary', {}, `Map of connections (${nConn})`), graph(e),
      h('div', { class: 'legend' }, 'Filled = entry · ring = kind · click a node to open it')) : null,
    source && h('p', { class: 'source' }, md(inline(source))),
  );
  document.title = `${title(e)} · Cairn World`;
}

// 1-hop neighbourhood: outgoing links plus incoming ones, one node per neighbour.
function graph(e) {
  const nb = new Map();
  const add = (other, label) => { const x = nb.get(other.id) ?? { e: other, labels: [] }; x.labels.push(label); nb.set(other.id, x); };
  for (const { id, label } of links(e)) { const t = state.byId.get(id); if (t) add(t, `${label} →`); }
  for (const b of state.back.get(e.id) ?? []) add(b.from, `← ${b.via}`);
  const all = [...nb.values()];
  if (!all.length) return h('p', { class: 'empty' }, 'No links yet.');
  const shown = all.slice(0, GRAPH_LIMIT);

  const W = 420, H = 340, cx = W / 2, cy = H / 2, R = 125;
  const short = s => (s.length > 20 ? s.slice(0, 19) + '…' : s);
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `Relationships of ${title(e)}` });
  const nodeEls = [];
  shown.forEach((x, i) => {
    const a = (2 * Math.PI * i) / shown.length - Math.PI / 2;
    const px = cx + R * Math.cos(a) * 1.25, py = cy + R * Math.sin(a);
    el.append(svg('line', { class: 'edge', x1: cx, y1: cy, x2: px, y2: py }));
    nodeEls.push(node(x.e, px, py, 9, x.labels.join('; '), short));
  });
  el.append(...nodeEls, node(e, cx, cy, 13, '', short, true));
  if (all.length > shown.length) el.append(svg('text', { x: 8, y: H - 8 }, `+${all.length - shown.length} more (see Linked from)`));
  return el;
}

function node(e, x, y, r, tip, short, center = false) {
  const g = svg('g', {
    class: `n${state.modelOf[e.model].kind === 'type' ? ' type' : ''}${center ? ' center' : ''}`,
    transform: `translate(${x} ${y})`, tabindex: center ? '-1' : '0', role: 'link', 'aria-label': title(e),
  },
  svg('title', {}, tip ? `${title(e)} (${tip})` : title(e)),
  svg('circle', { r }),
  svg('text', { y: r + 13, 'text-anchor': 'middle' }, short(title(e))));
  if (!center) {
    const go = () => { location.hash = route(e); };
    g.addEventListener('click', go);
    g.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
  }
  return g;
}

// ---- Editing --------------------------------------------------------------------------------
// Edits are a layer over the view, kept in this browser (explorer/drafts.mjs) and composed over
// the published entries by Alizarin (explorer/store.mjs): an edited entry reads everywhere as it
// will once the edits are exported and merged into layers/<view>/data/ (src/merge-edits.mjs).

const isRoot = e => e.id === state.root?.id;
const layerFile = () => `layers/${state.view}/data/`;
const editsTitle = () => `${state.drafts.list().length} edit${state.drafts.list().length === 1 ? '' : 's'} in this browser`;

// After any change to the edits: compose them again, recount, redraw.
async function editsChanged() {
  state.editProblems = await state.store.applyEdits(state.drafts);
  state.counts = await state.store.counts(state.view);
  renderEditsBar();
}

function editedBanner(e) {
  const d = state.store.edited(e.id);
  if (!d) return null;
  return h('div', { class: 'edited-banner' }, icon('pencil'),
    h('span', {}, d.created ? 'Made in this browser' : 'Edited in this browser', `: not yet in ${layerFile()}.`),
    h('a', { href: `${route(e)}/edit` }, 'Edit'),
    h('button', { type: 'button', onclick: () => revert(d) }, d.created ? 'Discard' : 'Revert'));
}

async function revert(d) {
  await state.drafts.remove(d.model, d.key);
  await editsChanged();
  if (d.created) location.hash = `#/${state.view}/`; else show();
}

function renderEditor(e) {
  textOf = e;
  const model = state.modelOf[e.model];
  const before = state.store.edited(e.id);
  const form = editForm({ h, state, store: state.store, title, terms: state.finder.terms ?? (async () => []) }, e, before);
  const problems = h('ul', { class: 'eproblems', role: 'alert' });
  const save = async ev => {
    ev.preventDefault();
    const entry = form.read();
    const errs = [];
    // References are written exact, as the build writes them.
    for (const row of [entry.cells, ...entry.rows]) for (const [f, v] of Object.entries(row)) {
      if (!v.includes('[[')) continue;
      const got = await state.store.exactRefs(v);
      row[f] = got.text;
      errs.push(...got.problems.map(p => `${state.modelOf[e.model].nodes.find(n => n.alias === f)?.name ?? f}: ${p}`));
    }
    if (!entry.created && !Object.keys(entry.cells).length && !entry.rows.length) {
      if (before) await revert(before); else location.hash = route(e);
      return;
    }
    if (!errs.length) {
      try { await state.store.compose(entry, state.drafts.list().filter(d => d.created)); } catch (err) { errs.push(err?.message ?? String(err)); }
    }
    if (errs.length) { put(problems, errs.map(x => h('li', {}, x))); return; }
    await state.drafts.put(entry);
    await editsChanged();
    location.hash = route(e);
  };
  put($('detail'),
    h('a', { class: 'back', href: route(e) }, `← ${title(e)}`),
    h('div', { class: 'kind' }, `Editing · ${model.name}`),
    h('h1', {}, title(e)),
    h('p', { class: 'note' }, `An edit is a layer over ${layerName(state.view)}, kept in this browser until you export it. `,
      'A field you change replaces what the layers below give it; to a repeatable field you can only add (as a layer can). ',
      'Links name entries by slug; [[Name]] in text links to an entry by its name.'),
    h('form', { onsubmit: save }, form.el, problems,
      h('div', { class: 'eactions' }, h('button', { type: 'submit' }, 'Save edit'), h('a', { href: route(e) }, 'Cancel'),
        before && h('button', { type: 'button', onclick: () => revert(before) }, before.created ? 'Discard this entry' : 'Revert to published'))));
  document.title = `Editing ${title(e)} · Cairn World`;
}

// The edits, for review: what each one changes, and any that no longer fit the published world.
function renderEdits() {
  const list = state.drafts.list();
  put($('detail'),
    h('div', { class: 'kind' }, `Edits · layer ${state.view}`),
    h('h1', {}, editsTitle()),
    h('p', { class: 'note' }, `Export them, then run "npm run merge-edits -- <file>" in the repository: it writes them into ${layerFile()}, and the next build has them.`),
    list.length ? h('ul', { class: 'rel' }, list.map(d => {
      const e = state.byId.get(state.store.idOf(d.model, d.key));
      const why = state.editProblems?.get(`${d.model}/${d.key}`);
      const what = [Object.keys(d.cells).length && `sets ${Object.keys(d.cells).join(', ')}`, d.rows.length && `adds ${d.rows.length} group entr${d.rows.length === 1 ? 'y' : 'ies'}`].filter(Boolean).join('; ');
      return h('li', {}, e ? h('a', { href: route(e) }, title(e)) : `${d.model}/${d.key}`,
        h('span', { class: 'm' }, `${state.modelOf[d.model]?.name ?? d.model}${d.created ? ' · new' : ''} · ${what || 'no changes'}`),
        why && h('p', { class: 'eproblems' }, `Not applied: ${why}`));
    })) : h('p', { class: 'empty' }, 'No edits yet. Turn on Author and use Edit on an entry, or add a new one above.'));
  document.title = 'Edits · Cairn World';
}

// The bar of edit actions: shown to the author, and to anyone with edits.
function renderEditsBar() {
  const bar = $('edits');
  const n = state.drafts?.list().length ?? 0;
  bar.hidden = !state.drafts || (!state.author && !n);
  if (bar.hidden) return;
  const creatable = state.models.filter(m => !['universe', 'campaign'].includes(m.alias));
  const pick = h('select', { 'aria-label': 'Model of the new entry' }, creatable.map(m => h('option', { value: m.alias }, m.name)));
  const name = h('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Name of the new entry' });
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => importEdits(file.files[0]) });
  const bad = state.editProblems?.size ?? 0;
  put(bar,
    h('span', {}, icon('pencil'), ' ', n ? h('a', { href: `#/${state.view}/@edits` }, h('b', {}, editsTitle())) : 'No edits yet', bad ? h('span', { class: 'eproblems' }, ` (${bad} not applied)`) : null),
    n > 0 && h('button', { type: 'button', onclick: exportEdits }, icon('download'), ' Export'),
    h('button', { type: 'button', onclick: () => file.click() }, icon('upload'), ' Import'), file,
    n > 0 && h('button', { type: 'button', onclick: async () => { if (!confirm(`Discard ${editsTitle()}?`)) return; await state.drafts.clear(); await editsChanged(); show(); } }, icon('undo-2'), ' Discard all'),
    state.author && h('form', { class: 'new', onsubmit: ev => { ev.preventDefault(); newEntry(pick.value, name.value); } }, 'New:', pick, name, h('button', { type: 'submit' }, 'Add')));
}

function exportEdits() {
  const blob = new Blob([JSON.stringify(state.drafts.exported(state.store.renamed()), null, 2) + '\n'], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `cairn-edits-${state.view}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importEdits(f) {
  if (!f) return;
  try {
    const groupFields = alias => {
      const m = state.modelOf[alias];
      if (!m) return null;
      const repeatable = new Set(m.nodes.filter(n => n.datatype === 'semantic' && n.cardinality === 'n').map(n => n.alias));
      return new Set(m.nodes.filter(n => repeatable.has(n.parent)).map(n => n.alias));
    };
    await state.drafts.imported(JSON.parse(await f.text()), groupFields);
    await editsChanged();
    location.hash = `#/${state.view}/@edits`;
  } catch (err) { alert(`Could not import: ${err?.message ?? err}`); }
}

// A new entry: its slug from its name, unique in its model; then its form.
async function newEntry(model, name) {
  name = name.trim();
  if (!name) return;
  const base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'entry';
  let key = base;
  for (let i = 2; (await state.store.know([state.store.idOf(model, key)])).length || state.drafts.get(model, key); i++) key = `${base}-${i}`;
  await state.drafts.put({ model, key, created: true, cells: { name }, rows: [] });
  await editsChanged();
  location.hash = `#/${state.view}/${model}/${key}/edit`;
}

// Edited entries whose name has the text (the search index has only the published text).
async function editedMatching(q) {
  const es = await state.store.know(state.drafts.list().map(d => state.store.idOf(d.model, d.key)));
  return es.filter(e => title(e).toLowerCase().includes(q));
}

function backButton() {
  const [, a] = hashParts();
  $('back').disabled = (history.state?.depth ?? 0) === 0 && !a;
}

// ---- Routing --------------------------------------------------------------------------------

// Lens bar: Home, then one tab per lens with how many entries it holds.
function renderLensBar(active) {
  put($('lenses'),
    h('a', { href: `#/${state.view}/`, 'aria-current': active === 'home' ? 'page' : false }, 'Home'),
    state.lenses.map(l => {
      const n = l.models.reduce((k, m) => k + shownCount(m), 0);
      return n ? h('a', { href: `#/${state.view}/@${l.id}`, 'aria-current': active === l.id ? 'page' : false, title: `${l.crmLabel} (CIDOC-CRM): ${l.comment}` }, l.icon && icon(l.icon), l.label, h('small', {}, n)) : null;
    }));
}

function renderHome() {
  textOf = state.root;
  const v = state.viewsMeta.views.find(x => x.key === state.view);
  const r = state.root;
  const description = r?.fields.find(f => f.alias === 'description')?.value;
  put($('detail'),
    h('div', { class: 'kind' }, `${v.kind} · ${v.stack.map(layerName).join(' › ')}`),
    h('h1', {}, r ? title(r) : v.name),
    v.stack.map(k => state.viewsMeta.layers[k]).filter(l => l?.test).map(l => h('div', { class: 'testbanner' }, `${l.name}: ${l.test}`)),
    // A long introduction opens with its first paragraph; the rest is a click away.
    description && (() => {
      const bs = blocks(description);
      if (bs.length <= 2) return h('div', { class: 'text lead' }, md(bs));
      return h('div', { class: 'text lead' }, md(bs.slice(0, 1)), h('details', { class: 'readmore' }, h('summary', {}, 'Read more'), md(bs.slice(1))));
    })(),
    h('div', { class: 'lenscards' }, state.lenses.map(l => {
      const sum = k => l.models.reduce((n, m) => n + (state.counts[m]?.[k] ?? 0) - (k !== 'general' && r?.model === m ? 1 : 0), 0);
      const here = sum('own'), general = sum('general'), inherited = sum('n') - here - general;
      if (!sum('n')) return null;
      return h('a', { class: 'lenscard', href: `#/${state.view}/@${l.id}` },
        l.icon && h('div', { class: 'cardicon', 'aria-hidden': 'true' }, icon(l.icon)),
        state.author && h('div', { class: 'kind' }, l.class.replace(/^.*\//, '').replace(/_/g, ' ')),
        h('h3', {}, l.label),
        l.summary && h('p', { class: 'summary' }, l.summary),
        h('p', {}, l.models.map(m => state.modelOf[m].name).join(', ')),
        h('p', { class: 'counts' }, [here && `${here} here`, inherited && `${inherited} inherited`, general && `${general} General`].filter(Boolean).join(' · ')));
    })),
    state.overrides.length ? [h('h2', {}, `Changed in ${v.name}`), h('ul', { class: 'rel' }, state.overrides.filter(o => o.layers.at(-1) === state.view).map(o => {
      const e = state.byId.get(state.store.idOf(o.model, o.key));
      const what = [o.overrides.length && `overrides ${o.overrides.join(', ')}`, o.adds.length && `adds to ${o.adds.join(', ')}`, o.sets.length && `sets ${o.sets.join(', ')}`].filter(Boolean).join('; ');
      return e ? h('li', {}, h('a', { href: route(e) }, title(e)), h('span', { class: 'm' }, `${state.modelOf[e.model].name} · ${what}`)) : null;
    }))] : null,
    state.author && h('p', { class: 'note' }, 'Lenses come from CIDOC-CRM: each is the class a layout is built on, and every model sits in the one nearest its own class.'));
  document.title = `${r ? title(r) : v.name} · Cairn World`;
}

// A lens lays out its entries in full (at most LENS_LIMIT), with what they link to in brief.
async function lensEntries(lens) {
  const page = await state.store.page({ models: lens.models, general: state.rules, limit: LENS_LIMIT });
  const entries = (await state.store.full(page.map(e => e.id))).filter(visible);
  await state.store.know(entries.flatMap(e => links(e).map(l => l.id)));
  return entries;
}

function renderLens(lens, entries) {
  const total = lens.models.reduce((n, m) => n + shownCount(m), 0);
  const anchor = state.ontology.properties[lens.anchor];
  put($('detail'),
    h('a', { class: 'back', href: `#/${state.view}/` }, '← Home'),
    h('div', { class: 'kind' }, `${lens.class.replace(/^.*\//, '').replace(/_/g, ' ')} · ${lens.models.map(m => state.modelOf[m].name).join(', ')}`),
    h('h1', {}, lens.label),
    lens.summary && h('p', {}, lens.summary),
    lens.comment && h('p', { class: 'scope' }, `CIDOC-CRM, ${lens.crmLabel}: ${lens.comment}`),
    anchor && h('p', { class: 'note' }, `Laid out by ${lens.anchor.replace(/^.*\//, '').replace(/_/g, ' ')}.`),
    total > entries.length && h('p', { class: 'note' }, `Showing the first ${entries.length} of ${total} entries; the list finds the rest.`),
    state.scoped && lens.models.some(m => (state.counts[m]?.world ?? 0) > (state.counts[m]?.n ?? 0) - (state.counts[m]?.general ?? 0)) && h('p', { class: 'note' }, 'Showing what this campaign uses; untick "Only what this campaign uses" for everything its world holds.'),
    drawLens(ctx(), lens, entries),
    !state.rules && lens.models.some(m => state.counts[m]?.general) && h('p', { class: 'note' }, 'General entries are hidden; tick "Include General" to add them.'));
  document.title = `${lens.label} · Cairn World`;
}

// Each draw reads what it needs first; a later navigation supersedes one still reading.
let shows = 0;
async function show(again = false) {
  const mine = ++shows;
  const [view, a, b, c] = hashParts();
  // The ORM's caches belong to one view, so moving to another view reloads the page.
  if (view && view !== state.view) { location.reload(); return; }
  const lens = a?.startsWith('@') ? lensById(a.slice(1)) : null;
  backButton();
  const id = !lens && a && b ? state.store.idOf(a, b) : null;
  const [known] = id ? await state.store.know([id]) : [];
  // A link to a General entry must open even while General is hidden in the list.
  if (known && isGeneral(known) && !state.rules) { state.rules = true; $('rules').checked = true; }
  state.scope = lens?.id ?? (known ? state.lensOf[known.model] : null);
  renderLensBar(lens?.id ?? (known ? state.lensOf[known.model] : 'home'));
  renderSide(known?.id);
  const reading = setTimeout(() => { if (mine === shows) put($('detail'), h('p', { class: 'empty' }, 'Reading…')); }, 150);
  try {
    if (known && c === 'edit') { const e = await neighbourhood(known.id); if (mine === shows) renderEditor(e); }
    else if (known) { const e = await neighbourhood(known.id); if (mine === shows) renderDetail(e); }
    else if (a === '@edits') { await state.store.know(state.drafts.list().map(d => state.store.idOf(d.model, d.key))); if (mine === shows) renderEdits(); }
    else if (lens) { const entries = await lensEntries(lens); if (mine === shows) renderLens(lens, entries); }
    else if (a) put($('detail'), h('p', { class: 'empty' }, 'No such entry.'), h('a', { href: `#/${state.view}/` }, 'Back home'));
    else {
      await state.store.know(state.overrides.map(o => state.store.idOf(o.model, o.key)));
      if (mine === shows) renderHome();
    }
  } catch (err) {
    console.error(err);
    if (mine !== shows) return;
    // A page left open across a deploy reads files that have since been replaced: say so, and
    // offer the new version. Otherwise a dropped connection is worth one more try.
    const latest = await fetch(`${DATA}/views.json`, { cache: 'no-store' }).then(r => r.json()).catch(() => null);
    if (mine !== shows) return;
    if (latest?.build && latest.build !== state.viewsMeta.build) {
      put($('detail'), h('p', { class: 'empty' }, 'The world has been updated since this page was opened.'),
        h('button', { type: 'button', class: 'retry', onclick: () => location.reload() }, 'Reload'));
      return;
    }
    if (!again) { show(true); return; }
    put($('detail'), h('p', { class: 'empty' }, `Could not read this: ${err?.message ?? err}`),
      h('button', { type: 'button', class: 'retry', onclick: () => show() }, 'Try again'));
  } finally { clearTimeout(reading); }
}

try {
  await load();
  status('');
  $('app').hidden = false;
  // On a phone one pane shows at a time: the list while typing a search, else the page. Opening
  // anything (a result, even the one already open, or any link) shows the page; the query stays,
  // and focusing the search box brings its results back.
  const pane = v => { document.body.dataset.view = v; };
  // With a text index the search asks it (for the best matches the list can show, among the
  // entries in view and through the filters); without one, the list matches names.
  let asked = 0;
  $('q').addEventListener('input', async ev => {
    state.q = ev.target.value.trim().toLowerCase();
    pane(state.q ? 'list' : 'detail');
    if (!state.q || !state.finder.canSearch) { state.hits = null; renderSide(); return; }
    const mine = ++asked, q = state.q;
    await new Promise(r => setTimeout(r, 150));
    if (mine !== asked) return;
    try {
      // A match's record says what the list needs (id, model, slug, name, whether only General has
      // it), so no entry is read to list it.
      const ok = m => (state.rules || !m.general) && m.id !== state.root?.id && state.store.inScope(m.id) && (!state.filter.size || state.filter.has(m.model)) && state.finder.passes(m);
      const { hits, complete } = await state.finder.search(q, ok, LIST_LIMIT);
      if (mine !== asked) return;
      // The index is the published text: an edited entry is listed under its name now, and the
      // edits are searched by name besides.
      const seen = new Set(hits.map(x => x.id));
      const all = [...(await editedMatching(q)).filter(e => !seen.has(e.id) && ok({ ...e, general: isGeneral(e) })).map(e => ({ id: e.id })), ...hits];
      await state.store.know(all.filter(x => state.store.edited(x.id)).map(x => x.id));
      if (mine !== asked) return;
      for (const x of all) if (!state.byId.has(x.id)) state.byId.set(x.id, { model: x.meta.model, id: x.id, key: x.meta.key, layers: x.meta.general ? ['general'] : [], light: true,
        fields: [{ alias: 'name', label: 'Name', datatype: 'string', targets: [], collection: null, rule: null, property: null, value: x.meta.title }] });
      state.hits = { list: all.map(x => state.byId.get(x.id)), rank: new Map(all.map((x, i) => [x.id, i])), excerpt: new Map(all.filter(x => x.excerpt).map(x => [x.id, x.excerpt])), complete };
    } catch (err) {
      console.error(err);
      state.hits = null;   // the index could not be read: search names instead
    }
    renderSide();
  });
  $('rules').addEventListener('change', ev => { state.rules = ev.target.checked; show(); });
  $('scoped').checked = state.scoped;
  $('scoped').addEventListener('change', async ev => {
    state.scoped = ev.target.checked;
    try { localStorage.setItem('cairn-world:scoped', state.scoped ? '1' : '0'); } catch { /* not remembered */ }
    await state.store.setScope(state.scoped);
    state.counts = await state.store.counts(state.view);
    if (state.q) $('q').dispatchEvent(new Event('input'));
    show();
  });
  const author = $('author');
  author.setAttribute('aria-pressed', state.author);
  author.addEventListener('click', () => {
    state.author = !state.author;
    try { localStorage.setItem('cairn-world:author', state.author ? '1' : '0'); } catch { /* not remembered */ }
    author.setAttribute('aria-pressed', state.author);
    renderEditsBar();
    show();
  });
  $('q').addEventListener('focus', () => { if (state.q) pane('list'); });
  $('list').addEventListener('click', ev => { if (ev.target.closest('a')) pane('detail'); });
  // Back goes to the page before, within the explorer: each page it opens is numbered in the
  // history's state, so with nothing before, Back goes home instead of off the site.
  if (history.state?.depth == null) history.replaceState({ depth: 0 }, '');
  let depth = history.state.depth;
  addEventListener('hashchange', () => {
    if (history.state?.depth == null) history.replaceState({ depth: depth + 1 }, '');
    depth = history.state.depth;
    pane('detail'); show(); scrollTo(0, 0);
  });
  $('back').addEventListener('click', () => { if ((history.state?.depth ?? 0) > 0) history.back(); else location.hash = `#/${state.view}/`; });
  renderEditsBar();
  pane('detail');
  addEventListener('keydown', ev => { if (ev.key === '/' && document.activeElement !== $('q')) { ev.preventDefault(); $('q').focus(); } });
  show();
} catch (err) {
  console.error(err);
  status(`Could not load the world: ${err?.message ?? err}`, true);
}
