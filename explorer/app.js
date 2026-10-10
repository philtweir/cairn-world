// Cairn World explorer: loads the tile store with Alizarin in the browser, reads every entry
// through its ORM, and renders a searchable list, detail pages and a 1-hop relationship graph.
// Everything user-visible is built with DOM text nodes; data never goes through innerHTML.

import * as A from 'alizarin';
import { readEntities, backlinks } from '../src/world-read.mjs';
import { blocks, inline, tableRows } from '../src/md.mjs';

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

// Markdown tree (src/md.mjs) to DOM, as text nodes only.
const md = nodes => nodes.map(n => (typeof n === 'string' ? n : h(n.t, {}, md(n.c))));
const field = (e, alias) => e.fields.find(f => f.alias === alias)?.value;
const section = e => field(e, 'section') ?? Infinity;
const inOrder = (a, b) => section(a) - section(b) || title(a).localeCompare(title(b));
const HIDDEN = new Set(['name', 'description', 'entries', 'columns', 'die']);

function rollTable(e) {
  const head = [field(e, 'die') || 'Roll', ...(field(e, 'columns') ? field(e, 'columns').split(' | ') : [])];
  const rows = tableRows(field(e, 'entries'));
  const width = Math.max(...rows.map(r => r.length));
  return h('div', { class: 'wrap' }, h('table', {},
    head.length === width ? h('thead', {}, h('tr', {}, head.map(c => h('th', {}, c))))
      : field(e, 'die') && h('caption', {}, `Roll ${field(e, 'die')}`),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map(c => h('td', {}, md(inline(c)))))))));
}

const state = { view: null, viewsMeta: null, models: [], entities: [], byId: new Map(), byRoute: new Map(), back: new Map(), modelOf: {}, filter: new Set(), rules: false, q: '' };

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
// The hash is #/<view>/<model>/<key>; the view is the first segment.
const hashParts = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
const status = (msg, error = false) => { const s = $('status'); s.textContent = msg; s.className = error ? 'error' : ''; s.hidden = !msg; };

// ---- Load -----------------------------------------------------------------------------------

async function load() {
  state.viewsMeta = await fetch(`${DATA}/views.json`).then(r => r.json());
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
  const [manifest, index] = await Promise.all([
    fetch(`${DATA}/views/${state.view}/manifest.json`).then(r => r.json()),
    fetch(`${DATA}/views/${state.view}/index.json`).then(r => r.json()),
  ]);
  await A.wasmReady;
  const archesClient = new A.client.ArchesClientRemoteStatic(DATA, {
    allGraphFile: () => 'graphs.json',
    graphToGraphFile: meta => `graphs/${meta.graphid}.json`,
    graphIdToGraphFile: id => `graphs/${id}.json`,
    graphIdToResourcesFiles: id => index[id] ?? [],
    resourceIdToFile: id => `views/${state.view}/resources/${id}.json`,
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

function fillViews() {
  put($('view'), state.viewsMeta.views.map(v => h('option', { value: v.key, selected: v.key === state.view }, `${v.gate ? '🔒 ' : ''}${v.name} (${v.kind})`)));
  // Each view has its own ORM state (and maybe a gate), so switching reloads the page.
  $('view').onchange = ev => { location.hash = `#/${ev.target.value}/`; location.reload(); };
  document.querySelector('.brand').setAttribute('href', `#/${state.view}/`);
  const v = state.viewsMeta.views.find(x => x.key === state.view);
  const plain = document.querySelector('a.plain');
  plain.setAttribute('href', v.gate ? 'pages/index.html' : `pages/${state.view}/index.html`);
  const lock = $('lock');
  lock.hidden = !(v.gate && remembered(v));
  lock.onclick = () => { forget(v); location.reload(); };
}

// ---- Sidebar --------------------------------------------------------------------------------

const visible = e => state.rules || !isGeneral(e);
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

  const nRules = state.entities.filter(isGeneral).length;
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
  const present = e.fields.filter(f => !HIDDEN.has(f.alias) && f.value != null && !(Array.isArray(f.value) && !f.value.length));

  const stats = present.filter(f => f.datatype === 'number');
  const rest = present.filter(f => f.datatype !== 'number');

  const rows = rest.map(f => {
    let value;
    if (f.targets.length) {
      value = f.value.map(id => state.byId.get(id)).filter(Boolean).flatMap((t, i) => [i ? ', ' : '', ...linkTo(t)]);
    } else value = Array.isArray(f.value) ? f.value.join(', ') : typeof f.value === 'string' ? md(inline(f.value)) : f.value;
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
    h('ul', { class: 'rel' }, list.sort((a, b) => inOrder(a.from, b.from)).slice(0, 80).map(b =>
      h('li', {}, h('a', { href: route(b.from) }, title(b.from)), h('span', { class: 'm' }, b.via)))),
  ]);

  put($('detail'), 
    h('a', { class: 'back', href: `#/${state.view}/` }, '← All entries'),
    h('div', { class: 'kind' }, `${model.name} · ${provenance(e)}`),
    h('h1', {}, title(e)),
    description && h('div', { class: 'text' }, md(blocks(description))),
    e.model === 'rolltable' && field(e, 'entries') && rollTable(e),
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
  const [view, model, key] = hashParts();
  // The ORM's caches belong to one view, so moving to another view reloads the page.
  if (view && view !== state.view) { location.reload(); return; }
  const m = model && key ? [null, model, key] : null;
  const e = m && state.byRoute.get(`${m[1]}/${m[2]}`);
  // A link to a General entry must open even while General is hidden in the list.
  if (e && isGeneral(e) && !state.rules) { state.rules = true; $('rules').checked = true; }
  document.body.dataset.view = e || (m && !e) ? 'detail' : 'list';
  if (e) renderDetail(e);
  else if (m) put($('detail'), h('p', { class: 'empty' }, 'No such entry.'), h('a', { href: `#/${state.view}/` }, 'Back to the list'));
  else {
    const v = state.viewsMeta.views.find(x => x.key === state.view);
    put($('detail'), h('div', { class: 'kind' }, `${v.kind} · ${v.stack.map(layerName).join(' › ')}`), h('h1', {}, v.name),
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
