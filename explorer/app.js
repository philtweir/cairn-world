// Cairn World explorer: loads the tile store with Alizarin in the browser, reads every entry
// through its ORM, and renders a searchable list, detail pages and a 1-hop relationship graph.
// Everything user-visible is built with DOM text nodes; data never goes through innerHTML.

import * as A from 'alizarin';
import { readEntities, backlinks } from '../src/world-read.mjs';

const DATA = new URL('./data', import.meta.url).href;
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

const state = { models: [], entities: [], byId: new Map(), byRoute: new Map(), back: new Map(), modelOf: {}, filter: new Set(), rules: false, q: '' };

const title = e => e.fields.find(f => f.alias === 'name')?.value ?? e.key;
const text = e => e.fields.map(f => (typeof f.value === 'string' ? f.value : '')).join(' ').toLowerCase();
const route = e => `#/${e.model}/${e.key}`;
const status = (msg, error = false) => { const s = $('status'); s.textContent = msg; s.className = error ? 'error' : ''; s.hidden = !msg; };

// ---- Load -----------------------------------------------------------------------------------

async function load() {
  const [manifest, index] = await Promise.all([
    fetch(`${DATA}/manifest.json`).then(r => r.json()),
    fetch(`${DATA}/index.json`).then(r => r.json()),
  ]);
  await A.wasmReady;
  const archesClient = new A.client.ArchesClientRemoteStatic(DATA, {
    allGraphFile: () => 'graphs.json',
    graphToGraphFile: meta => `graphs/${meta.graphid}.json`,
    graphIdToGraphFile: id => `graphs/${id}.json`,
    graphIdToResourcesFiles: id => index[id] ?? [],
    resourceIdToFile: id => `resources/${id}.json`,
    collectionIdToFile: id => `collections/${id}.json`,
  });
  A.graphManager.archesClient = archesClient;
  A.staticStore.archesClient = archesClient;
  A.RDM.archesClient = archesClient;
  await A.graphManager.initialize();

  state.models = manifest.models;
  state.modelOf = Object.fromEntries(manifest.models.map(m => [m.alias, m]));
  state.entities = await readEntities(A.graphManager, manifest, (m, n) => status(`Reading ${m.name}… (${n} entries)`));
  for (const e of state.entities) { state.byId.set(e.id, e); state.byRoute.set(`${e.model}/${e.key}`, e); }
  state.back = backlinks(state.entities);
}

// ---- Sidebar --------------------------------------------------------------------------------

const visible = e => state.rules || e.origin !== 'rules';
const matches = e => {
  if (state.filter.size && !state.filter.has(e.model)) return false;
  return !state.q || title(e).toLowerCase().includes(state.q) || text(e).includes(state.q);
};

function renderSide(currentId) {
  const counts = {};
  for (const e of state.entities) if (visible(e)) counts[e.model] = (counts[e.model] ?? 0) + 1;
  put($('chips'), state.models.filter(m => counts[m.alias]).map(m =>
    h('button', {
      class: 'chip', type: 'button', 'aria-pressed': state.filter.has(m.alias),
      onclick: () => { state.filter.has(m.alias) ? state.filter.delete(m.alias) : state.filter.add(m.alias); renderSide(currentId); },
    }, m.name, h('small', {}, counts[m.alias]))));

  const nRules = state.entities.filter(e => e.origin === 'rules').length;
  $('rules-count').textContent = `(${nRules})`;

  const rows = state.entities.filter(e => visible(e) && matches(e))
    .sort((a, b) => title(a).localeCompare(title(b)));
  const shown = rows.slice(0, LIST_LIMIT);
  put($('list'), [
    ...shown.map(e => h('li', {}, h('a', { href: route(e), 'aria-current': e.id === currentId }, title(e), h('span', { class: 'm' }, state.modelOf[e.model].name)))),
    rows.length > shown.length && h('li', { class: 'more' }, `${rows.length - shown.length} more — narrow with search or a filter.`),
    !rows.length && h('li', { class: 'more' }, 'Nothing matches.'),
  ]);
}

// ---- Detail ---------------------------------------------------------------------------------

function linkTo(e) {
  return [h('a', { href: route(e) }, title(e)), h('span', { class: 'm' }, state.modelOf[e.model].name)];
}

function renderDetail(e) {
  const model = state.modelOf[e.model];
  const description = e.fields.find(f => f.alias === 'description')?.value;
  const present = e.fields.filter(f => f.alias !== 'name' && f.alias !== 'description' && f.value != null && !(Array.isArray(f.value) && !f.value.length));

  const stats = present.filter(f => f.datatype === 'number');
  const rest = present.filter(f => f.datatype !== 'number');

  const rows = rest.map(f => {
    let value;
    if (f.targets.length) {
      value = f.value.map(id => state.byId.get(id)).filter(Boolean).flatMap((t, i) => [i ? ', ' : '', ...linkTo(t)]);
    } else value = Array.isArray(f.value) ? f.value.join(', ') : f.value;
    return [h('dt', {}, f.label), h('dd', {}, value)];
  });

  // Incoming links grouped by the model they come from.
  const incoming = state.back.get(e.id) ?? [];
  const groups = new Map();
  for (const b of incoming) {
    const g = groups.get(b.from.model) ?? [];
    g.push(b);
    groups.set(b.from.model, g);
  }
  const incomingEls = [...groups].map(([alias, list]) => [
    h('div', { class: 'group' }, `${state.modelOf[alias].name} (${list.length})`),
    h('ul', { class: 'rel' }, list.sort((a, b) => title(a.from).localeCompare(title(b.from))).slice(0, 60).map(b =>
      h('li', {}, h('a', { href: route(b.from) }, title(b.from)), h('span', { class: 'm' }, b.via)))),
  ]);

  put($('detail'), 
    h('a', { class: 'back', href: '#/' }, '← All entries'),
    h('div', { class: 'kind' }, `${model.name}${e.origin === 'rules' ? ' · rules reference' : ''}`),
    h('h1', {}, title(e)),
    description && h('p', {}, description),
    stats.length > 0 && h('div', { class: 'stats' }, stats.map(f => h('span', { class: 'stat' }, f.label, h('b', {}, String(f.value))))),
    rows.length > 0 && h('dl', {}, rows),
    incoming.length ? [h('h2', {}, 'Linked from'), incomingEls] : null,
    h('h2', {}, 'Relationships'),
    graph(e),
    h('div', { class: 'legend' }, 'Filled = campaign entry · ring = type · click a node to open it'),
  );
  document.title = `${title(e)} · Cairn World`;
}

// 1-hop neighbourhood: outgoing links plus incoming ones, one node per neighbour.
function graph(e) {
  const nb = new Map();
  const add = (other, label) => { const x = nb.get(other.id) ?? { e: other, labels: [] }; x.labels.push(label); nb.set(other.id, x); };
  for (const f of e.fields) if (f.targets.length && f.value) for (const id of f.value) { const t = state.byId.get(id); if (t) add(t, `${f.label} →`); }
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

function show() {
  const m = /^#\/([^/]+)\/(.+)$/.exec(location.hash);
  const e = m && state.byRoute.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
  // A link to a rules entry must open even while rules are hidden in the list.
  if (e && e.origin === 'rules' && !state.rules) { state.rules = true; $('rules').checked = true; }
  document.body.dataset.view = e || (m && !e) ? 'detail' : 'list';
  if (e) renderDetail(e);
  else if (m) put($('detail'), h('p', { class: 'empty' }, 'No such entry.'), h('a', { href: '#/' }, 'Back to the list'));
  else {
    put($('detail'), h('h1', {}, 'Cairn World'),
      h('p', { class: 'empty' }, `${state.entities.filter(visible).length} entries across ${state.models.length} models. Pick one on the left, or search.`));
    document.title = 'Cairn World Explorer';
  }
  renderSide(e?.id);
  if (e) document.querySelector('#list [aria-current=true]')?.scrollIntoView({ block: 'nearest' });
}

try {
  await load();
  status('');
  $('app').hidden = false;
  $('q').addEventListener('input', ev => { state.q = ev.target.value.trim().toLowerCase(); renderSide(); });
  $('rules').addEventListener('change', ev => { state.rules = ev.target.checked; show(); });
  addEventListener('hashchange', show);
  addEventListener('keydown', ev => { if (ev.key === '/' && document.activeElement !== $('q')) { ev.preventDefault(); $('q').focus(); } });
  show();
} catch (err) {
  console.error(err);
  status(`Could not load the world: ${err?.message ?? err}`, true);
}
