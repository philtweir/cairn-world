// One drawing per lens layout (src/lenses.mjs). Each works from the lens's anchor property, the
// links between entries and lens membership: never from model or field names, so any model
// that falls into a lens draws the same way.

import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';
import { parentsOf } from '../src/lenses.mjs';

export function drawLens(ctx, lens, entries) {
  const draw = { network, places, timeline, things, tree, list }[lens.layout] ?? list;
  return draw(ctx, lens, entries);
}

const colour = (lens, e) => `c${Math.max(0, lens.models.indexOf(e.model)) % 8}`;
const short = (s, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function legend(ctx, lens, entries) {
  const used = lens.models.filter(m => entries.some(e => e.model === m));
  return ctx.h('div', { class: 'legend' }, used.map(m =>
    ctx.h('span', { class: 'key' }, ctx.h('i', { class: colour(lens, { model: m }) }), ctx.state.modelOf[m].name)));
}

// ---- Force-laid graph -------------------------------------------------------------------------
// nodes: entries; edges: { source, target, label, kind: 'part'|'link', via? } where `via` is an
// entry drawn as the edge itself (a route between two places).
function forceGraph(ctx, lens, nodes, edges) {
  const { h, svg, route, title } = ctx;
  if (!nodes.length) return h('p', { class: 'empty' }, 'Nothing here yet.');
  const degree = new Map();
  for (const x of edges) for (const id of [x.source, x.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const simNodes = nodes.map((e, i) => ({ id: e.id, e, index: i }));
  const simEdges = edges.map(x => ({ ...x }));
  const sim = forceSimulation(simNodes)
    .force('link', forceLink(simEdges).id(d => d.id).distance(x => (x.kind === 'part' ? 70 : 115)).strength(0.5))
    .force('charge', forceManyBody().strength(-380))
    .force('collide', forceCollide(44))
    .force('x', forceX(0).strength(0.05))
    .force('y', forceY(0).strength(0.08))
    .stop();
  for (let i = 0; i < 320; i++) sim.tick();
  const xs = simNodes.map(n => n.x), ys = simNodes.map(n => n.y);
  const pad = 50, minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const W = Math.max(...xs) - minX + pad, H = Math.max(...ys) - minY + pad + 14;
  // Drawn at its natural size at most, so labels never grow past their set size.
  const el = svg('svg', { class: 'lensgraph', viewBox: `${minX} ${minY} ${W} ${H}`, style: `max-width:${Math.round(W)}px`, role: 'group', 'aria-label': `${lens.label}: graph` });
  const go = e => () => { location.hash = route(e); };
  for (const x of simEdges) {
    const line = svg('line', { class: `edge ${x.kind}${x.via ? ' via' : ''}`, x1: x.source.x, y1: x.source.y, x2: x.target.x, y2: x.target.y },
      svg('title', {}, x.label));
    if (x.via) {
      // A connecting entry is drawn as its edge; it opens like a node.
      const g = svg('g', { class: 'connector', tabindex: '0', role: 'link', 'aria-label': title(x.via) }, line,
        svg('line', { class: 'hit', x1: x.source.x, y1: x.source.y, x2: x.target.x, y2: x.target.y }, svg('title', {}, x.label)));
      g.addEventListener('click', go(x.via));
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(x.via)(); });
      el.append(g);
    } else el.append(line);
  }
  for (const n of simNodes) {
    const r = 7 + Math.min(7, degree.get(n.id) ?? 0);
    const g = svg('g', { class: `node ${colour(lens, n.e)}${ctx.isGeneral(n.e) ? ' general' : ''}`, transform: `translate(${n.x} ${n.y})`, tabindex: '0', role: 'link', 'aria-label': title(n.e) },
      svg('title', {}, `${title(n.e)} · ${ctx.state.modelOf[n.e.model].name}`),
      svg('circle', { r }),
      svg('text', { y: r + 12, 'text-anchor': 'middle' }, short(title(n.e))));
    g.addEventListener('click', go(n.e));
    g.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(n.e)(); });
    el.append(g);
  }
  return el;
}

// Links between entries of the lens, one edge per pair and property direction.
function edgesWithin(ctx, lens, entries) {
  const ids = new Set(entries.map(e => e.id));
  const upward = lens.up === null ? null : lens.up ? lens.anchor : ctx.ontology.properties[lens.anchor]?.inverse;
  const out = [], seen = new Set();
  for (const e of entries) for (const l of ctx.links(e)) {
    if (!ids.has(l.id) || l.id === e.id) continue;
    const k = [e.id, l.id].sort().join('|') + l.label;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ source: e.id, target: l.id, label: `${ctx.title(e)} — ${l.label} → ${ctx.title(ctx.state.byId.get(l.id))}`, kind: l.property === upward || l.property === lens.anchor ? 'part' : 'link', property: l.property });
  }
  return out;
}

function network(ctx, lens, entries) {
  return [forceGraph(ctx, lens, entries, edgesWithin(ctx, lens, entries)), legend(ctx, lens, entries),
    ctx.h('p', { class: 'note' }, 'Dashed: membership. Solid: every other link between them (ties, alliances, enmities). Hover an edge for what it is.')];
}

// ---- Places: what lies within what, and how they connect ---------------------------------------

function places(ctx, lens, entries) {
  const { h } = ctx;
  const all = edgesWithin(ctx, lens, entries);
  const part = all.filter(x => x.kind === 'part');
  const rest = all.filter(x => x.kind !== 'part');
  // An entry that only joins two others (links to exactly two, nothing links to it, nothing lies
  // within it) is drawn as the edge between them: a route, a bridge, a passage.
  const outN = new Map(), inN = new Map();
  for (const x of rest) { outN.set(x.source, [...(outN.get(x.source) ?? []), x]); inN.set(x.target, (inN.get(x.target) ?? 0) + 1); }
  const hasParts = new Set(part.map(x => x.target));
  const connectors = new Map();
  for (const e of entries) {
    const o = outN.get(e.id) ?? [];
    if (o.length === 2 && !inN.get(e.id) && !hasParts.has(e.id)) connectors.set(e.id, o.map(x => x.target));
  }
  const edges = rest.filter(x => !connectors.has(x.source) && !connectors.has(x.target));
  for (const [id, [a, b]] of connectors) {
    const via = ctx.state.byId.get(id);
    edges.push({ source: a, target: b, label: ctx.title(via), kind: 'link', via });
  }
  // The graph shows what connects; places with no connections are in the tree only.
  const linked = new Set(edges.flatMap(x => [x.source, x.target]));
  const nodes = entries.filter(e => linked.has(e.id));
  return [
    h('h2', {}, 'Within'),
    hierarchy(ctx, lens, entries.filter(e => !connectors.has(e.id))),
    edges.length ? [h('h2', {}, 'Connections'), forceGraph(ctx, lens, nodes, edges), legend(ctx, lens, nodes),
      h('p', { class: 'note' }, 'Lines are entries that join two places (routes, passages); click one to open it.')] : null,
  ];
}

// ---- Timeline: ordered by time-span (the lens anchor, P4) --------------------------------------

function timeline(ctx, lens, entries) {
  const { h, route, title } = ctx;
  const spans = e => e.fields.filter(f => f.property === lens.anchor && f.value != null);
  const order = e => spans(e).find(f => typeof f.value === 'number');
  const groups = new Map();
  for (const e of entries) {
    const o = order(e);
    const key = o ? `${o.label} ${o.value}` : 'Undated';
    if (!groups.has(key)) groups.set(key, { n: o ? o.value : -Infinity, list: [] });
    groups.get(key).list.push(e);
  }
  const sorted = [...groups].sort((a, b) => a[1].n - b[1].n);
  return h('ol', { class: 'timeline' }, sorted.map(([label, g]) => h('li', {},
    h('div', { class: 'when' }, label === 'Undated' ? 'Outside play sessions' : label),
    h('ul', {}, beforeOrder(ctx, lens, g.list).map(e => h('li', { class: colour(lens, e) },
      h('a', { href: route(e) }, title(e)),
      spans(e).filter(f => typeof f.value === 'string').map(f => h('span', { class: 'm' }, f.value)),
      firstSentence(e) && h('div', { class: 'gist' }, firstSentence(e))))))));
}
// Order entries so that anything another entry says it comes before (P183 and kin, or their
// inverses) is listed first; ties and unrelated entries go alphabetically.
function beforeOrder(ctx, lens, list) {
  const ids = new Set(list.map(e => e.id));
  const props = ctx.ontology.properties;
  const fwd = new Set(lens.before ?? []), inv = new Set((lens.before ?? []).map(p => props[p]?.inverse).filter(Boolean));
  const after = new Map(list.map(e => [e.id, new Set()]));   // id -> ids that must come first
  for (const e of list) for (const l of ctx.links(e)) {
    if (!ids.has(l.id)) continue;
    if (fwd.has(l.property)) after.get(l.id).add(e.id);
    else if (inv.has(l.property)) after.get(e.id).add(l.id);
  }
  const out = [], done = new Set();
  const byTitle = (a, b) => ctx.title(a).localeCompare(ctx.title(b));
  while (out.length < list.length) {
    const ready = list.filter(e => !done.has(e.id) && [...after.get(e.id)].every(id => done.has(id))).sort(byTitle);
    const next = ready[0] ?? list.filter(e => !done.has(e.id)).sort(byTitle)[0];   // a cycle: break it
    out.push(next); done.add(next.id);
  }
  return out;
}

const firstSentence = e => {
  const d = e.fields.find(f => f.alias === 'description')?.value;
  return d ? (/^[^\n]*?[.!?](?=\s|$)/.exec(d.replace(/[*_]/g, '')) ?? [d.split('\n')[0]])[0] : '';
};

// ---- Things: where each is, or who has it ------------------------------------------------------

function things(ctx, lens, entries) {
  const { h, route, title, state } = ctx;
  const lensOf = e => state.lensOf[e.model];
  const placeOf = e => ctx.links(e).map(l => state.byId.get(l.id)).find(t => t && lensOf(t) === 'places');
  const holderOf = e => ctx.links(e).map(l => state.byId.get(l.id)).find(t => t && lensOf(t) === 'actors');
  const groups = new Map();
  for (const e of entries) {
    const p = placeOf(e), a = !p && holderOf(e);
    const key = p ? `p:${p.id}` : a ? `a:${a.id}` : 'none';
    if (!groups.has(key)) groups.set(key, { at: p ?? a ?? null, how: p ? 'At' : a ? 'With' : null, list: [] });
    groups.get(key).list.push(e);
  }
  const sorted = [...groups.values()].sort((a, b) => (a.at ? 0 : 1) - (b.at ? 0 : 1) || (a.at && b.at ? title(a.at).localeCompare(title(b.at)) : 0));
  return h('div', { class: 'cards' }, sorted.map(g => h('section', { class: 'card' },
    h('h3', {}, g.at ? [`${g.how} `, h('a', { href: route(g.at) }, title(g.at))] : 'Nowhere in particular'),
    h('ul', {}, g.list.sort((a, b) => title(a).localeCompare(title(b))).map(e => h('li', { class: colour(lens, e) },
      h('a', { href: route(e) }, title(e)), h('span', { class: 'm' }, state.modelOf[e.model].name)))))));
}

// ---- Trees: whole and part (P148) or broader and narrower (P127) --------------------------------

function hierarchy(ctx, lens, entries) {
  const { h, route, title, state, inOrder } = ctx;
  const ids = new Set(entries.map(e => e.id));
  const children = new Map(), hasParent = new Set();
  for (const e of entries) for (const p of parentsOf(ctx.ontology, lens, e, ctx.links, id => ids.has(id))) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(e);
    hasParent.add(e.id);
  }
  // How much of this view uses an entry: links in from entries that aren't General reference.
  const uses = e => (state.back.get(e.id) ?? []).filter(b => !ctx.isGeneral(b.from) && !ids.has(b.from.id)).length;
  const sortList = list => list.sort((a, b) => (ctx.isGeneral(a) ? 1 : 0) - (ctx.isGeneral(b) ? 1 : 0) || inOrder(a, b));
  const item = e => {
    const kids = children.get(e.id) ?? [];
    const n = uses(e);
    const head = [h('a', { href: route(e) }, title(e)), h('span', { class: 'm' }, state.modelOf[e.model].name), n ? h('span', { class: 'uses' }, `used by ${n}`) : null];
    if (!kids.length) return h('li', { class: colour(lens, e) }, head);
    // Children render on first open, so the 400-section rules tree stays cheap; a small tree
    // starts open.
    const d = h('details', {}, h('summary', {}, head, h('span', { class: 'm' }, `${kids.length}`)));
    const fill = () => { if (d.open && d.children.length === 1) d.append(h('ul', {}, sortList(kids).map(item))); };
    d.addEventListener('toggle', fill);
    if (entries.length <= 60) { d.open = true; fill(); }
    return h('li', { class: colour(lens, e) }, d);
  };
  const roots = entries.filter(e => !hasParent.has(e.id));
  // Top-level entries are grouped by model, so a long flat list of types stays navigable.
  const byModel = lens.models.map(m => [m, sortList(roots.filter(e => e.model === m))]).filter(([, l]) => l.length);
  return h('div', { class: 'tree' }, byModel.map(([m, list]) => h('section', {},
    byModel.length > 1 && h('h3', {}, `${state.modelOf[m].name} (${entries.filter(e => e.model === m).length})`),
    h('ul', {}, list.slice(0, 400).map(item)),
    list.length > 400 && h('p', { class: 'note' }, `${list.length - 400} more; use search.`))));
}

function tree(ctx, lens, entries) { return hierarchy(ctx, lens, entries); }

function list(ctx, lens, entries) {
  const { h, route, title } = ctx;
  return h('ul', { class: 'rel' }, entries.sort((a, b) => title(a).localeCompare(title(b))).map(e => h('li', {}, h('a', { href: route(e) }, title(e)))));
}
