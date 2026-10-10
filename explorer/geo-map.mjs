// Maps. In CIDOC-CRM only a place has a geometry (P168 place is defined by, an E94 Space
// Primitive); everything else is somewhere by way of a place: an event took place at one (P7), a
// thing has a location (P55), a person or group a residence (P74). So an entry's map is found
// from the ontology, never from field names: its own geometry if it is a place, else the places
// it links to by any property whose other end is a Place, else the places of the events it took
// part in. A place with no geometry of its own is drawn as the nearest place it falls within that
// has one, marked as approximate.

import { geoOrthographic, geoPath, geoGraticule, geoCentroid, geoDistance, geoBounds, geoArea } from 'd3-geo';
import { ancestors, CRM } from '../src/lenses.mjs';

const E53 = `${CRM}E53_Place`;
const GEO = 'geojson-feature-collection';

export const geometryOf = e => e.fields.find(f => f.datatype === GEO && f.value?.features?.length)?.value ?? null;

const isPlaceClass = (ontology, cls) => !!cls && ancestors(ontology, cls).has(E53);
// The property the places lens is built on (P89 falls within): a place's parent.
const withinProp = state => state.lenses.find(l => l.layout === 'places')?.anchor;

// Where an entry is: { items: [{ e: place, geom, role, how, approx }], lines, missing }. Role 'focus' is
// where it is, 'context' what that lies within (or, for a region, what lies within it); `how`
// says why. A place drawn between two others (a route) also gets the line between them.
export function locate(ctx, e) {
  const { state, ontology } = ctx;
  const P = withinProp(state);
  const isPlace = x => isPlaceClass(ontology, state.modelOf[x.model]?.ontology);
  const spatial = (prop, end) => isPlaceClass(ontology, ontology.properties[prop]?.[end]);
  const parentOf = p => ctx.links(p).filter(l => l.property === P).map(l => state.byId.get(l.id)).find(Boolean);
  // The nearest geometry up the within-chain, and the chain itself.
  const placed = p => { const seen = new Set(); let q = p; while (q && !seen.has(q.id)) { seen.add(q.id); const g = geometryOf(q); if (g) return { e: q, geom: g, approx: q !== p }; q = parentOf(q); } return null; };

  const direct = [];   // { e: place, how }
  for (const l of ctx.links(e)) {
    const t = state.byId.get(l.id);
    if (l.derived || !t || t === e || !isPlace(t) || !spatial(l.property, 'range')) continue;
    if (isPlace(e) && l.property === P) continue;   // its parent: context, below
    direct.push({ e: t, how: l.label });
  }
  // A place is located by what it links to; another place pointing at it (a route ending there)
  // does not say where it is. Anything else can be located from a place's side (P53i).
  for (const b of isPlace(e) ? [] : state.back.get(e.id) ?? []) {
    if (b.derived || b.from === e || !isPlace(b.from) || !spatial(b.property, 'domain') || b.property === P) continue;
    direct.push({ e: b.from, how: b.via });
  }
  // And where the events it took part in happened (not for an event: its neighbours in time are
  // other events, not where it was).
  if (!isPlace(e) && state.lensOf[e.model] !== 'time') {
    const near = [...ctx.links(e).filter(l => !l.derived).map(l => state.byId.get(l.id)), ...(state.back.get(e.id) ?? []).filter(b => !b.derived).map(b => b.from)];
    for (const n of new Set(near.filter(Boolean))) {
      if (state.lensOf[n.model] !== 'time') continue;
      for (const l of ctx.links(n)) { const t = state.byId.get(l.id); if (!l.derived && t && isPlace(t) && spatial(l.property, 'range')) direct.push({ e: t, how: ctx.title(n) }); }
    }
  }

  const out = [], seen = new Set();
  // `at`: for an approximate item, the place actually named, which has no geometry of its own.
  const add = (x, role, how, approx = false, at = null) => { if (!x || seen.has(x.e.id)) return; seen.add(x.e.id); out.push({ e: x.e, geom: x.geom, role, how, approx: approx || x.approx, at }); };
  const own = geometryOf(e);
  if (own) add({ e, geom: own }, 'focus', 'Here');
  for (const d of direct) { const p = placed(d.e); if (p) add(p, 'focus', d.how, false, p.approx ? d.e : null); }
  const ends = direct.map(d => placed(d.e)).filter(Boolean);
  const lines = isPlace(e) && !own && direct.length === 2 && ends.length === 2 ? [{ e, a: ends[0].geom, b: ends[1].geom }] : [];
  // Context: for a place, what it lies within; and, for one without a geometry, what lies within it.
  if (isPlace(e)) {
    for (let q = parentOf(e), n = 0; q && n < 6; q = parentOf(q), n++) { const g = geometryOf(q); if (g) add({ e: q, geom: g }, own || out.length ? 'context' : 'focus', 'Within', !own && !out.length); }
    if (!out.some(x => x.role === 'focus' && !x.approx)) {
      for (const b of state.back.get(e.id) ?? []) if (b.property === P) { const g = geometryOf(b.from); if (g) add({ e: b.from, geom: g }, 'focus', 'Within it'); }
    } else {
      for (const b of state.back.get(e.id) ?? []) if (b.property === P) { const g = geometryOf(b.from); if (g) add({ e: b.from, geom: g }, 'context', 'Within it'); }
    }
  }
  // Places it is linked to that have no location anywhere up their chain: worth saying.
  const missing = direct.filter(d => !placed(d.e));
  return { items: out, lines, missing };
}

// ---- Drawing ----------------------------------------------------------------------------------
// items: [{ e, geom, role, approx }]; lines: [{ e, a, b }] drawn between two places' geometries.
// A globe turned to face the items, fitted to the focus items, with a minimum span so a single
// point shows its surroundings. Drag to turn it; the buttons zoom.

let maps = 0;   // for unique mask ids
const put = (el, ...kids) => el.replaceChildren(...kids.flat());
const centreOf = g => (g.features.length === 1 && g.features[0].geometry.type === 'Point' ? g.features[0].geometry.coordinates : geoCentroid(g));

export function geoMap(ctx, { items, lines = [], basemap, cls = 'geomap', label = 'Map', minSpan = 1.2 }) {
  const { h, svg, route, title } = ctx;
  const focus = items.filter(x => x.role === 'focus');
  const fitTo = { type: 'FeatureCollection', features: [
    ...(focus.length ? focus : items).flatMap(x => x.geom.features),
    ...lines.flatMap(l => [l.a, l.b].flatMap(g => g.features)) ] };
  const box = h('div', { class: cls });
  const el = svg('svg', { role: 'img', 'aria-label': label });
  const tools = h('div', { class: 'geotools' });
  box.append(el, tools);

  const projection = geoOrthographic().clipAngle(90).precision(0.3);
  const path = geoPath(projection);
  let W = 0, H = 0, base = 1, home = null;
  // Fit: turn the globe to face the items' middle, then scale to show them all (at least minSpan
  // degrees across, at most the whole hemisphere).
  const fit = () => {
    const [[x0, y0], [x1, y1]] = geoBounds(fitTo);
    const mid = !fitTo.features.length ? [0, 20] : x0 <= x1 && x1 - x0 < 180 ? [(x0 + x1) / 2, (y0 + y1) / 2] : geoCentroid(fitTo);
    projection.rotate([-mid[0], -mid[1]]).translate([W / 2, H / 2]);
    const pad = 28;
    const reach = Math.max(minSpan / 2 * Math.PI / 180, ...fitTo.features.flatMap(f => coords(f.geometry)).map(c => geoDistance(mid, c)));
    const k = Math.min((W / 2 - pad) / Math.sin(Math.min(reach, Math.PI / 2)), (H / 2 - pad) / Math.sin(Math.min(reach, Math.PI / 2)));
    base = Math.max(10, k);
    projection.scale(base);
    home = projection.rotate();
  };

  // Land, in two kinds: the named lands (`land`) and the rest of the world's land, which no place
  // claims (`unnamed`), drawn fainter. Each is the whole-globe coast, with each detailed area masked
  // out of it and its own detailed coast drawn there instead, so the two meet without a seam.
  const id = `geo${++maps}`;
  const gSea = svg('path', { class: 'sea' }), gGrat = svg('path', { class: 'graticule' });
  const mask = svg('mask', { id: `${id}-m`, maskUnits: 'userSpaceOnUse' });
  const gLand = svg('g', { mask: `url(#${id}-m)` }), gDetail = svg('g', {});
  const gShapes = svg('g', {}), gLines = svg('g', {}), gPoints = svg('g', {}), gLabels = svg('g', { class: 'labels' });
  el.append(svg('defs', {}, mask), gSea, gLand, gDetail, gGrat, gShapes, gLines, gPoints, gLabels);
  const KINDS = { land: 'land', unnamed: 'land unnamed' };
  let coarse = [], holes = [], details = [];
  basemap?.then(b => {
    const fs = b?.features ?? [];
    coarse = Object.entries(KINDS).map(([k, cls]) => ({ geom: fs.find(f => f.properties.kind === k)?.geometry, node: svg('path', { class: cls }) })).filter(c => c.geom);
    put(gLand, coarse.map(c => c.node));
    const boxes = new Map();
    for (const f of fs.filter(f => f.bbox && f.properties.kind.endsWith('-detail'))) {
      const key = f.bbox.join(',');
      if (!boxes.has(key)) {
        const [x0, y0, x1, y1] = f.bbox, n = 16, ring = [];
        for (let i = 0; i <= n; i++) ring.push([x0 + (x1 - x0) * i / n, y0]);
        for (let i = 0; i <= n; i++) ring.push([x1, y0 + (y1 - y0) * i / n]);
        for (let i = n; i >= 0; i--) ring.push([x0 + (x1 - x0) * i / n, y1]);
        for (let i = n; i >= 0; i--) ring.push([x0, y0 + (y1 - y0) * i / n]);
        // d3 takes the smaller side of a ring as its inside only when wound clockwise.
        const box = { type: 'Polygon', coordinates: [ring] };
        if (geoArea(box) > 2 * Math.PI) ring.reverse();
        boxes.set(key, { box, hole: svg('path', { fill: 'black' }) });
      }
      const node = svg('path', { class: KINDS[f.properties.kind.replace(/-detail$/, '')] ?? 'land' });
      gDetail.append(node);
      details.push({ geom: f.geometry, node });
    }
    holes = [...boxes.values()];
    put(mask, svg('rect', { x: -1e4, y: -1e4, width: 2e4, height: 2e4, fill: 'white' }), holes.map(x => x.hole));
    draw();
  });

  const go = e => () => { location.hash = route(e); };
  const shapes = [], points = [], labels = [], routes = [];
  for (const x of [...items].sort((a, b) => (a.role === 'focus') - (b.role === 'focus'))) {
    const roleCls = `${x.role}${x.approx ? ' approx' : ''}`;
    for (const f of x.geom.features) {
      const t = svg('title', {}, `${title(x.e)}${x.how && x.how !== 'Here' ? ` (${x.how})` : ''}${x.approx ? ', roughly' : ''}`);
      if (f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint') {
        for (const c of f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates) {
          const node = svg('a', { href: route(x.e), class: `pt ${roleCls}` }, svg('circle', { r: x.role === 'focus' ? 5 : 3.2 }), t.cloneNode(true));
          points.push({ node, c }); gPoints.append(node);
        }
      } else {
        const node = svg('a', { href: route(x.e), class: `shape ${roleCls}` }, svg('path', {}), t);
        shapes.push({ node, g: f.geometry }); gShapes.append(node);
      }
    }
    const node = svg('text', { class: `lbl ${x.role}` }, title(x.e));
    labels.push({ node, at: centreOf(x.geom), focus: x.role === 'focus', n: title(x.e).length });
    gLabels.append(node);
  }
  for (const l of lines) {
    const g = { type: 'LineString', coordinates: [centreOf(l.a), centreOf(l.b)] };
    const node = svg('a', { href: route(l.e), class: 'route' }, svg('path', {}), svg('title', {}, title(l.e)));
    routes.push({ node, g }); gLines.append(node);
  }

  const visible = c => geoDistance(c, [-projection.rotate()[0], -projection.rotate()[1]]) < Math.PI / 2 - 1e-6;
  function draw() {
    if (!W) return;
    gSea.setAttribute('d', path({ type: 'Sphere' }));
    const span = 180 / Math.PI * (W / 2) / projection.scale();   // degrees across half the width, roughly
    const step = span > 40 ? 15 : span > 12 ? 5 : span > 4 ? 1 : 0.5;
    gGrat.setAttribute('d', path(geoGraticule().step([step, step])()));
    for (const c of [...coarse, ...details]) c.node.setAttribute('d', path(c.geom) ?? '');
    for (const x of holes) x.hole.setAttribute('d', path(x.box) ?? '');
    for (const s of shapes) s.node.firstChild.setAttribute('d', path(s.g) ?? '');
    for (const r of routes) r.node.firstChild.setAttribute('d', path(r.g) ?? '');
    for (const p of points) {
      const on = visible(p.c), xy = projection(p.c);
      p.node.style.display = on ? '' : 'none';
      if (on) p.node.setAttribute('transform', `translate(${xy[0].toFixed(1)},${xy[1].toFixed(1)})`);
    }
    // Labels: focus first, then context; one is dropped if it would overlap one already placed.
    const placed = [];
    for (const l of [...labels].sort((a, b) => b.focus - a.focus)) {
      const xy = visible(l.at) && projection(l.at);
      const w = l.n * 6.4 + 6, box = xy && { x0: xy[0] + 7, y0: xy[1] - 9, x1: xy[0] + 7 + w, y1: xy[1] + 5 };
      const ok = box && box.x1 < W + 40 && box.x0 > -40 && !placed.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1);
      l.node.style.display = ok ? '' : 'none';
      if (ok) { placed.push(box); l.node.setAttribute('x', box.x0.toFixed(1)); l.node.setAttribute('y', (xy[1] + 4).toFixed(1)); }
    }
  }

  // Drag turns the globe; a drag is not a click on what it started over.
  let drag = null, moved = false;
  el.addEventListener('pointerdown', ev => { drag = { x: ev.clientX, y: ev.clientY, r: projection.rotate() }; moved = false; });
  el.addEventListener('pointermove', ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) el.setPointerCapture(ev.pointerId);
    moved = true;
    const k = 180 / Math.PI / projection.scale();
    projection.rotate([drag.r[0] + dx * k, Math.max(-90, Math.min(90, drag.r[1] - dy * k)), drag.r[2]]);
    draw();
  });
  const end = () => { drag = null; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('click', ev => { if (moved) { ev.preventDefault(); ev.stopPropagation(); moved = false; } }, true);
  const zoom = f => () => { projection.scale(Math.max(base / 4, Math.min(base * 64, projection.scale() * f))); draw(); };
  const button = (name, text, onclick) => h('button', { type: 'button', title: text, 'aria-label': text, onclick }, ctx.icon(name));
  tools.append(button('plus', 'Zoom in', zoom(1.6)), button('minus', 'Zoom out', zoom(1 / 1.6)),
    button('locate-fixed', 'Back to fit', () => { projection.rotate(home).scale(base); draw(); }));

  // Drawn at the box's real size, and again whenever that changes.
  new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    if (!r.width || (Math.round(r.width) === W && Math.round(r.height) === H)) return;
    const first = !W;
    W = Math.round(r.width); H = Math.round(r.height);
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (first) fit(); else projection.translate([W / 2, H / 2]);
    draw();
  }).observe(el);
  return box;
}

// Every position in a geometry.
function coords(g) {
  const walk = c => (typeof c[0] === 'number' ? [c] : c.flatMap(walk));
  return g ? walk(g.coordinates) : [];
}
