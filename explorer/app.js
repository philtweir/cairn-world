// Cairn World explorer: loads the tile store with Alizarin in the browser, reads every entry
// through its ORM, and shows it through lenses taken from the ontology (src/lenses.mjs): a home
// page for the view's root entry, one page per lens, detail pages and a 1-hop graph.
// Everything user-visible is built with DOM text nodes; data never goes through innerHTML.

import * as A from 'alizarin';
import { readEntities, backlinks, links, resolverFor, refRelation } from '../src/world-read.mjs';
import { blocks, inline, tableRows } from '../src/md.mjs';
import { assignLenses } from '../src/lenses.mjs';
import { drawLens } from './lens-views.mjs';
import { geoMap, locate } from './geo-map.mjs';
import { groupViews } from '../src/views.mjs';
import { makeFinder, excerptNodes } from './finder.mjs';

const DATA = new URL('./data', import.meta.url).href;
let V = '';   // ?v=<build>, set from views.json
const LIST_LIMIT = 200;
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
    const t = state.resolve?.(n.target);
    if (!href && !t) return md(n.c);
    if (!state.author || !t) return h('a', { href: href ?? route(t), class: 'ref' }, md(n.c));
    const rel = refRelation(textOf, t, state.back);
    return h('a', { href: href ?? route(t), class: `ref ${rel}`, title: REL_TITLE[rel] ?? false }, md(n.c));
  }
  return h(n.t, {}, md(n.c));
});
const field = (e, alias) => e.fields.find(f => f.alias === alias)?.value;
const section = e => field(e, 'section') ?? Infinity;
const inOrder = (a, b) => section(a) - section(b) || title(a).localeCompare(title(b));
const HIDDEN = new Set(['name', 'description', 'entries', 'columns', 'die', 'mentions']);

function rollTable(e) {
  const head = [field(e, 'die') || 'Roll', ...(field(e, 'columns') ? field(e, 'columns').split(' | ') : [])];
  const rows = tableRows(field(e, 'entries'));
  const width = Math.max(...rows.map(r => r.length));
  return h('div', { class: 'wrap' }, h('table', {},
    head.length === width ? h('thead', {}, h('tr', {}, head.map(c => h('th', {}, c))))
      : field(e, 'die') && h('caption', {}, `Roll ${field(e, 'die')}`),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map(c => h('td', {}, md(inline(c)))))))));
}

const state = { view: null, viewsMeta: null, models: [], entities: [], byId: new Map(), byRoute: new Map(), back: new Map(), modelOf: {}, filter: new Set(), rules: false, q: '', matches: {}, author: (() => { try { return localStorage.getItem('cairn-world:author') === '1'; } catch { return false; } })(), ontology: null, lenses: [], lensOf: {}, root: null, overrides: [], finder: { passes: () => true, canFilter: false, canSearch: false }, hits: null, filterScope: null };

const title = e => e.fields.find(f => f.alias === 'name')?.value ?? e.key;
const text = e => e.fields.map(f => (typeof f.value === 'string' ? f.value : '')).join(' ').toLowerCase();
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
  const [manifest, index, ontology] = await Promise.all([
    fetch(`${DATA}/views/${state.view}/manifest.json${V}`).then(r => r.json()),
    fetch(`${DATA}/views/${state.view}/index.json${V}`).then(r => r.json()),
    fetch(`${DATA}/ontology.json${V}`).then(r => r.json()),
  ]);
  state.ontology = ontology;
  await A.wasmReady;
  const archesClient = new A.client.ArchesClientRemoteStatic(DATA, {
    allGraphFile: () => `graphs.json${V}`,
    graphToGraphFile: meta => `graphs/${meta.graphid}.json${V}`,
    graphIdToGraphFile: id => `graphs/${id}.json${V}`,
    graphIdToResourcesFiles: id => (index[id] ?? []).map(f => f + V),
    resourceIdToFile: id => `views/${state.view}/resources/${id}.json${V}`,
    collectionIdToFile: id => `collections/${id}.json${V}`,
  });
  A.graphManager.archesClient = archesClient;
  A.staticStore.archesClient = archesClient;
  A.RDM.archesClient = archesClient;
  await A.graphManager.initialize();

  state.models = manifest.models;
  state.matches = Object.assign({}, ...manifest.models.map(m => m.matches ?? {}));
  state.modelOf = Object.fromEntries(manifest.models.map(m => [m.alias, m]));
  state.entities = await readEntities(A.graphManager, manifest, (m, n) => status(`Reading ${m.name}… (${n} entries)`));
  for (const e of state.entities) { state.byId.set(e.id, e); state.byRoute.set(`${e.model}/${e.key}`, e); }
  state.back = backlinks(state.entities);
  state.resolve = resolverFor(state.entities);
  ({ lenses: state.lenses, lensOf: state.lensOf } = assignLenses(ontology, manifest.models.map(m => ({ alias: m.alias, ontology: m.ontology }))));
  // The view's root is the entry its own layer is keyed by (the Universe or Campaign itself).
  state.root = state.entities.find(e => e.key === state.view && e.layers[0] === state.view) ?? null;
  state.overrides = manifest.overrides ?? [];
  state.finder = makeFinder({ data: DATA, suffix: V, view: state.viewsMeta.views.find(x => x.key === state.view), models: manifest.models, h, put, icon });
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
      `${v.kind === 'universe' ? `${v.name} (universe)` : v.name}${v.gate ? ' · locked' : ''}`)))));
  // Each view has its own ORM state (and maybe a gate), so switching reloads the page.
  $('view').onchange = ev => { location.hash = `#/${ev.target.value}/`; location.reload(); };
  document.querySelector('.brand').setAttribute('href', `#/${state.view}/`);
  const v = state.viewsMeta.views.find(x => x.key === state.view);
  const lock = $('lock');
  lock.hidden = !(v.gate && remembered(v));
  lock.onclick = () => { forget(v); location.reload(); };
}

// ---- Sidebar --------------------------------------------------------------------------------

const visible = e => (state.rules || !isGeneral(e)) && e !== state.root;
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
// A search runs on the view's text index when it has one (state.hits, the matches in rank order),
// else over the loaded text.
const matches = e => {
  if (state.filter.size && !state.filter.has(e.model)) return false;
  if (!state.finder.passes(e)) return false;
  if (!state.q) return true;
  if (state.hits) return state.hits.rank.has(e.id);
  return title(e).toLowerCase().includes(state.q) || text(e).includes(state.q);
};

// The list shows the current lens (or, on the home page, everything); a search looks everywhere.
function renderSide(currentId) {
  const scope = !state.q && state.scope ? lensById(state.scope) : null;
  const inScope = e => visible(e) && (!scope || inLens(scope, e));
  put($('scope'), state.q ? 'Search: everything' : scope ? scope.label : 'Everything');
  const counts = {};
  for (const e of state.entities) if (inScope(e)) counts[e.model] = (counts[e.model] ?? 0) + 1;
  put($('chips'), state.models.filter(m => counts[m.alias]).map(m =>
    h('button', {
      class: 'chip', type: 'button', 'aria-pressed': state.filter.has(m.alias),
      onclick: () => { state.filter.has(m.alias) ? state.filter.delete(m.alias) : state.filter.add(m.alias); renderSide(currentId); },
    }, m.name, h('small', {}, counts[m.alias]))));

  // The filter panel: for the models in the list. Moving to another lens starts it afresh.
  const filters = $('filters');
  filters.hidden = !state.finder.canFilter;
  const lens = state.scope ? lensById(state.scope) : null;
  const panelModels = state.models.filter(m => (lens ? lens.models.includes(m.alias) : true) && state.entities.some(e => e.model === m.alias && visible(e)));
  const scopeKey = panelModels.map(m => m.alias).join(' ');
  if (state.finder.canFilter && scopeKey !== state.filterScope) {
    state.filterScope = scopeKey;
    state.finder.clear();
    // A change of filter re-asks the search, whose best matches depend on it.
    put($('filter-panel'), state.finder.panel(panelModels, () => (state.q && state.finder.canSearch ? $('q').dispatchEvent(new Event('input')) : renderSide(currentId))));
  }

  const nRules = state.entities.filter(isGeneral).length;
  $('rules-count').textContent = `(${nRules})`;

  const rank = state.q && state.hits?.rank;
  const rows = state.entities.filter(e => inScope(e) && matches(e))
    .sort((a, b) => state.models.findIndex(m => m.alias === a.model) - state.models.findIndex(m => m.alias === b.model) || (rank ? rank.get(a.id) - rank.get(b.id) : title(a).localeCompare(title(b))));
  const shown = rows.slice(0, LIST_LIMIT);
  // Grouped by model, each entry marked with its model's colour.
  const items = [];
  shown.forEach((e, i) => {
    if (!i || shown[i - 1].model !== e.model) items.push(h('li', { class: 'grp' }, state.modelOf[e.model].name, h('small', {}, rows.filter(r => r.model === e.model).length)));
    const ex = rank && state.hits.excerpt.get(e.id);
    items.push(h('li', {}, h('a', { href: route(e), 'aria-current': e.id === currentId, class: colourOf(e.model) }, h('i', { class: 'dot' }), h('span', { class: 'nm' }, title(e)),
      ex && h('span', { class: 'ex' }, excerptNodes(h, ex)))));
  });
  put($('list'), [
    ...items,
    rows.length > shown.length && h('li', { class: 'more' }, `${rows.length - shown.length} more — narrow with search or a filter.`),
    rank && !state.hits.complete && h('li', { class: 'more' }, `The best ${LIST_LIMIT} text matches; add words to narrow the search.`),
    !rows.length && h('li', { class: 'more' }, 'Nothing matches.'),
  ]);
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
    put1(`${state.modelOf[c.e.model].name}s · ${via}`, chip(c.e, detail));
  }
  const mentionsOnly = order.filter(c => !c.out.length && !c.in.length && c.mention);
  const nConn = conns.size;

  const head = h('header', { class: `entry-head ${colourOf(e.model)}` },
    h('div', { class: 'avatar', 'aria-hidden': 'true' }, lens?.icon ? icon(lens.icon) : title(e).slice(0, 1)),
    h('div', {},
      h('div', { class: 'crumbs' }, lens && h('a', { href: `#/${state.view}/@${lens.id}` }, lens.label), lens && ' › ', h('span', { class: 'type' }, model.name)),
      h('h1', {}, title(e)),
      state.author && h('div', { class: 'kind' }, `${provenance(e)} · ${model.ontology.replace(/^.*\//, '').replace(/_/g, ' ')}`)));

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
    description && h('div', { class: 'text lead' }, md(blocks(description))),
    state.author && description && /\[\[/.test(description) && h('div', { class: 'reflegend' }, 'References: ', h('a', { class: 'ref rel' }, 'related'), ' · ',
      h('a', { class: 'ref rel-in' }, 'related the other way'), ' · ', h('a', { class: 'ref mention' }, 'mention only')),
    e.model === 'rolltable' && field(e, 'entries') && rollTable(e),
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

// ---- Routing --------------------------------------------------------------------------------

// Lens bar: Home, then one tab per lens with how many entries it holds.
function renderLensBar(active) {
  put($('lenses'),
    h('a', { href: `#/${state.view}/`, 'aria-current': active === 'home' ? 'page' : false }, 'Home'),
    state.lenses.map(l => {
      const n = state.entities.filter(e => visible(e) && inLens(l, e)).length;
      return n ? h('a', { href: `#/${state.view}/@${l.id}`, 'aria-current': active === l.id ? 'page' : false, title: `${l.crmLabel} (CIDOC-CRM): ${l.comment}` }, l.icon && icon(l.icon), l.label, h('small', {}, n)) : null;
    }));
}

function renderHome() {
  textOf = state.root;
  const v = state.viewsMeta.views.find(x => x.key === state.view);
  const r = state.root;
  const own = e => e.layers.includes(state.view);
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
      const all = state.entities.filter(e => e !== r && inLens(l, e));
      const here = all.filter(own).length, general = all.filter(isGeneral).length, inherited = all.length - here - general;
      if (!all.length) return null;
      return h('a', { class: 'lenscard', href: `#/${state.view}/@${l.id}` },
        l.icon && h('div', { class: 'cardicon', 'aria-hidden': 'true' }, icon(l.icon)),
        state.author && h('div', { class: 'kind' }, l.class.replace(/^.*\//, '').replace(/_/g, ' ')),
        h('h3', {}, l.label),
        l.summary && h('p', { class: 'summary' }, l.summary),
        h('p', {}, l.models.map(m => state.modelOf[m].name).join(', ')),
        h('p', { class: 'counts' }, [here && `${here} here`, inherited && `${inherited} inherited`, general && `${general} General`].filter(Boolean).join(' · ')));
    })),
    state.overrides.length ? [h('h2', {}, `Changed in ${v.name}`), h('ul', { class: 'rel' }, state.overrides.filter(o => o.layers.at(-1) === state.view).map(o => {
      const e = state.byRoute.get(`${o.model}/${o.key}`);
      const what = [o.overrides.length && `overrides ${o.overrides.join(', ')}`, o.adds.length && `adds to ${o.adds.join(', ')}`, o.sets.length && `sets ${o.sets.join(', ')}`].filter(Boolean).join('; ');
      return e ? h('li', {}, h('a', { href: route(e) }, title(e)), h('span', { class: 'm' }, `${state.modelOf[e.model].name} · ${what}`)) : null;
    }))] : null,
    state.author && h('p', { class: 'note' }, 'Lenses come from CIDOC-CRM: each is the class a layout is built on, and every model sits in the one nearest its own class.'));
  document.title = `${r ? title(r) : v.name} · Cairn World`;
}

function renderLens(lens) {
  const entries = state.entities.filter(e => visible(e) && inLens(lens, e));
  const anchor = state.ontology.properties[lens.anchor];
  put($('detail'),
    h('a', { class: 'back', href: `#/${state.view}/` }, '← Home'),
    h('div', { class: 'kind' }, `${lens.class.replace(/^.*\//, '').replace(/_/g, ' ')} · ${lens.models.map(m => state.modelOf[m].name).join(', ')}`),
    h('h1', {}, lens.label),
    lens.summary && h('p', {}, lens.summary),
    lens.comment && h('p', { class: 'scope' }, `CIDOC-CRM, ${lens.crmLabel}: ${lens.comment}`),
    anchor && h('p', { class: 'note' }, `Laid out by ${lens.anchor.replace(/^.*\//, '').replace(/_/g, ' ')}.`),
    drawLens(ctx(), lens, entries),
    !state.rules && state.entities.some(e => isGeneral(e) && inLens(lens, e)) && h('p', { class: 'note' }, 'General entries are hidden; tick "Include General" to add them.'));
  document.title = `${lens.label} · Cairn World`;
}

function show() {
  const [view, a, b] = hashParts();
  // The ORM's caches belong to one view, so moving to another view reloads the page.
  if (view && view !== state.view) { location.reload(); return; }
  const lens = a?.startsWith('@') ? lensById(a.slice(1)) : null;
  const e = !lens && a && b ? state.byRoute.get(`${a}/${b}`) : null;
  // A link to a General entry must open even while General is hidden in the list.
  if (e && isGeneral(e) && !state.rules) { state.rules = true; $('rules').checked = true; }
  state.scope = lens?.id ?? (e ? state.lensOf[e.model] : null);
  if (e) renderDetail(e);
  else if (lens) renderLens(lens);
  else if (a) put($('detail'), h('p', { class: 'empty' }, 'No such entry.'), h('a', { href: `#/${state.view}/` }, 'Back home'));
  else renderHome();
  renderLensBar(lens?.id ?? (e ? state.lensOf[e.model] : 'home'));
  renderSide(e?.id);
  if (e) document.querySelector('#list [aria-current=true]')?.scrollIntoView({ block: 'nearest' });
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
  // entries in view and through the filters); without one, the list matches the loaded text.
  let asked = 0;
  $('q').addEventListener('input', async ev => {
    state.q = ev.target.value.trim().toLowerCase();
    pane(state.q ? 'list' : 'detail');
    if (!state.q || !state.finder.canSearch) { state.hits = null; renderSide(); return; }
    const mine = ++asked, q = state.q;
    await new Promise(r => setTimeout(r, 150));
    if (mine !== asked) return;
    try {
      const ok = id => { const e = state.byId.get(id); return !!e && visible(e) && (!state.filter.size || state.filter.has(e.model)) && state.finder.passes(e); };
      const { hits, complete } = await state.finder.search(q, ok, LIST_LIMIT);
      if (mine !== asked) return;
      state.hits = { rank: new Map(hits.map((x, i) => [x.id, i])), excerpt: new Map(hits.map(x => [x.id, x.excerpt])), complete };
    } catch (err) {
      console.error(err);
      state.hits = null;   // the index could not be read: search the loaded text instead
    }
    renderSide();
  });
  $('rules').addEventListener('change', ev => { state.rules = ev.target.checked; show(); });
  const author = $('author');
  author.setAttribute('aria-pressed', state.author);
  author.addEventListener('click', () => {
    state.author = !state.author;
    try { localStorage.setItem('cairn-world:author', state.author ? '1' : '0'); } catch { /* not remembered */ }
    author.setAttribute('aria-pressed', state.author);
    show();
  });
  $('q').addEventListener('focus', () => { if (state.q) pane('list'); });
  $('list').addEventListener('click', ev => { if (ev.target.closest('a')) pane('detail'); });
  addEventListener('hashchange', () => { pane('detail'); show(); scrollTo(0, 0); });
  pane('detail');
  addEventListener('keydown', ev => { if (ev.key === '/' && document.activeElement !== $('q')) { ev.preventDefault(); $('q').focus(); } });
  show();
} catch (err) {
  console.error(err);
  status(`Could not load the world: ${err?.message ?? err}`, true);
}
