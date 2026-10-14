// Maps. In CIDOC-CRM only a place has a geometry (P168 place is defined by, an E94 Space
// Primitive); everything else is somewhere by way of a place: an event took place at one (P7), a
// thing has a location (P55), a person or group a residence (P74). So an entry's map is found
// from the ontology, never from field names: its own geometry if it is a place, else the places
// it links to by any property whose other end is a Place, else the places of the events it took
// part in. A place with no geometry of its own is drawn as the nearest place it falls within that
// has one, marked as approximate.

import { geoOrthographic, geoPath, geoGraticule, geoCentroid, geoDistance, geoBounds, geoArea } from 'd3-geo';
import { ancestors, CRM } from '../src/lenses.mjs';
import { reliefLayer } from './relief-gl.mjs';

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
  // Three layers: the sea, land and graticule (an SVG); relief (WebGL, relief-gl.mjs); and the
  // entry's places, routes and labels (an SVG, which also takes the drags and clicks).
  const box = h('div', { class: cls });
  const baseSvg = svg('svg', { class: 'base', 'aria-hidden': 'true' });
  const canvas = h('canvas', { class: 'relief', 'aria-hidden': 'true' });
  const el = svg('svg', { role: 'img', 'aria-label': label });
  const tools = h('div', { class: 'geotools' });
  box.append(baseSvg, canvas, el, tools);

  // No adaptive resampling: the geometry is fine-grained enough without it, and it was most of the
  // cost of turning the globe.
  const projection = geoOrthographic().clipAngle(90).precision(0);
  const path = geoPath(projection);
  let W = 0, H = 0, base = 1, home = null;
  // The least span to show, in degrees: `minSpan` for points alone, so one shows its surroundings,
  // unless they lie within a smaller shape (a palace in its quarter), whose own span then serves;
  // and none to speak of for a shape, which shows itself (a city a few km across, not its province).
  const spanOf = g => { const [[x0, y0], [x1, y1]] = geoBounds(g); return Math.max(x1 - x0, y1 - y0); };
  const pointsOnly = fitTo.features.every(f => f.geometry.type === 'Point');
  const around = items.filter(x => x.role === 'context' && x.geom.features.some(f => f.geometry.type !== 'Point')).map(x => spanOf(x.geom)).filter(v => v > 0);
  const least = pointsOnly ? Math.min(minSpan, ...around) : Math.min(minSpan, 0.01);
  // Fit: turn the globe to face the items' middle, then scale to show them all (at least `least`
  // degrees across, at most the whole hemisphere).
  const fit = () => {
    const [[x0, y0], [x1, y1]] = geoBounds(fitTo);
    const mid = !fitTo.features.length ? [0, 20] : x0 <= x1 && x1 - x0 < 180 ? [(x0 + x1) / 2, (y0 + y1) / 2] : geoCentroid(fitTo);
    projection.rotate([-mid[0], -mid[1]]).translate([W / 2, H / 2]);
    const pad = 28;
    const reach = Math.max(least / 2 * Math.PI / 180, ...fitTo.features.flatMap(f => coords(f.geometry)).map(c => geoDistance(mid, c)));
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
  baseSvg.append(svg('defs', {}, mask), gSea, gLand, gDetail, gGrat);
  // Water over the relief: lakes, then rivers (the coarse ones masked out of detailed areas, where
  // the rivers found from the finer heights are drawn instead).
  const gWater = svg('g', { class: 'water' }), gRiversCoarse = svg('g', { mask: `url(#${id}-m)` }), gRiversDetail = svg('g', {});
  gWater.append(gRiversCoarse, gRiversDetail);
  // A city's streets, buildings and water (city.json, from its .osm), under the water and places.
  const gCity = svg('g', { class: 'city' });
  el.append(gCity, gWater, gShapes, gLines, gPoints, gLabels);
  const KINDS = { land: 'land', unnamed: 'land unnamed' };
  let coarse = [], holes = [], details = [], water = [], city = [], relief = null, loadCity = null, cityAsked = false;
  // Cities: each class's areas and lines, kept as parts with their bounds, in the order given;
  // fetched the first time this map comes close enough to draw them.
  const askCity = () => {
    if (cityAsked || !loadCity) return;
    cityAsked = true;
    loadCity().then(c => {
      for (const f of c?.features ?? []) {
        if (f.properties.kind !== 'city') continue;
        const area = f.properties.area, node = svg('path', { class: `${f.properties.class} ${area ? 'area' : 'line'}` });
        gCity.append(node);
        city.push({ node, type: area ? 'MultiPolygon' : 'MultiLineString', heavy: f.geometry.coordinates.length > 2000, polys: f.geometry.coordinates.map(cc => ({ c: cc, b: geoBounds({ type: area ? 'Polygon' : 'LineString', coordinates: cc }) })) });
      }
      schedule();
    });
  };
  basemap?.then(b => {
    if (b?.relief?.images?.length) {
      try { relief = reliefLayer(canvas, b.relief); } catch (err) { console.warn('relief:', err); relief = null; }
      if (relief) relief.onLoad = () => schedule();
    }
    const fs = b?.features ?? [];
    // Each kind of land kept as its separate polygons with their bounds, so a map zoomed in draws only
    // those near the view.
    coarse = Object.entries(KINDS).map(([k, cls]) => {
      const g = fs.find(f => f.properties.kind === k)?.geometry;
      const polys = !g ? [] : (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(c => ({ c, b: geoBounds({ type: 'Polygon', coordinates: c }) }));
      return { geom: g, polys, node: svg('path', { class: cls }) };
    }).filter(c => c.geom);
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
        boxes.set(key, { box, bbox: f.bbox, hole: svg('path', { fill: 'black' }) });
      }
      const node = svg('path', { class: KINDS[f.properties.kind.replace(/-detail$/, '')] ?? 'land' });
      gDetail.append(node);
      details.push({ geom: f.geometry, node });
    }
    holes = [...boxes.values()];
    // Lakes and rivers, each line or lake kept apart with its bounds so only those in view are drawn.
    const parts = (g, kind) => (kind === 'lake' ? (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(c => ({ c, b: geoBounds({ type: 'Polygon', coordinates: c }), a: geoArea({ type: 'Polygon', coordinates: c }) }))
      : (g.type === 'LineString' ? [g.coordinates] : g.coordinates).map(c => ({ c, b: geoBounds({ type: 'LineString', coordinates: c }) })));
    const lakeF = fs.find(f => f.properties.kind === 'lake');
    if (lakeF) { const node = svg('path', { class: 'lake' }); gWater.prepend(node); water.push({ node, polys: parts(lakeF.geometry, 'lake'), type: 'MultiPolygon' }); }
    for (const f of fs.filter(f => f.properties.kind === 'river' || f.properties.kind === 'river-detail')) {
      const node = svg('path', { class: `river w${f.properties.w}` });
      (f.properties.kind === 'river' ? gRiversCoarse : gRiversDetail).append(node);
      water.push({ node, polys: parts(f.geometry, 'river'), type: 'MultiLineString', w: f.properties.w });
    }
    loadCity = b?.city ?? null;
    put(mask, svg('rect', { x: -1e4, y: -1e4, width: 2e4, height: 2e4, fill: 'white' }), holes.map(x => x.hole));
    schedule();
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
        // Fill and outline apart: the outline is drawn from the rings as lines, so where the globe's
        // horizon cuts a shape, the cut is not stroked as if it were a border.
        const fill = svg('path', { class: 'fill' }), edge = svg('path', { class: 'edge' });
        const node = svg('a', { href: route(x.e), class: `shape ${roleCls}` }, fill, edge, t);
        // A line (a wall, a road) is only its outline.
        const t2 = f.geometry.type, line = t2 === 'LineString' || t2 === 'MultiLineString';
        const rings = t2 === 'Polygon' ? f.geometry.coordinates : t2 === 'MultiPolygon' ? f.geometry.coordinates.flat() : t2 === 'LineString' ? [f.geometry.coordinates] : t2 === 'MultiLineString' ? f.geometry.coordinates : [];
        shapes.push({ fill, edge, g: line ? null : f.geometry, lines: { type: 'MultiLineString', coordinates: rings } }); gShapes.append(node);
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
  // At most one redraw a frame, however many drags and loads ask for one.
  let queued = false;
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
  function draw() {
    if (!W) return;
    gSea.setAttribute('d', path({ type: 'Sphere' }));
    const span = 180 / Math.PI * (W / 2) / projection.scale();   // degrees across half the width, roughly
    const step = span > 40 ? 15 : span > 12 ? 5 : span > 4 ? 1 : 0.5;
    // The graticule only around the view: a fine one over the whole globe is thousands of lines.
    const [gx, gy] = [-projection.rotate()[0], -projection.rotate()[1]];
    const gdy = Math.min(90, span * 1.6), gdx = span > 40 ? 180 : Math.min(180, gdy / Math.max(0.1, Math.cos(Math.min(89, Math.abs(gy) + gdy) * Math.PI / 180)));
    const snap = v => Math.floor(v / step) * step;
    gGrat.setAttribute('d', path(geoGraticule().step([step, step]).extent(gdx >= 180 ? [[-180, -90 + 1e-6], [180, 90 - 1e-6]] : [[snap(gx - gdx), Math.max(-90, snap(gy - gdy))], [snap(gx + gdx) + step, Math.min(90, snap(gy + gdy) + step)]])()));
    // Zoomed in, only the land polygons whose bounds come near the view (a box around its centre,
    // widened for longitude's narrowing towards the poles).
    const [cx, cy] = [-projection.rotate()[0], -projection.rotate()[1]];
    const near = span > 40 ? null : (() => {
      const dy = span * 1.6, dx = Math.min(180, dy / Math.max(0.1, Math.cos(Math.min(89, Math.abs(cy) + dy) * Math.PI / 180)));
      return ({ b: [[x0, y0], [x1, y1]] }) => {
        if (y0 > cy + dy || y1 < cy - dy) return false;
        if (x0 > x1 || dx >= 180) return true;   // crosses 180, or the view is wide: keep
        const d = lon => Math.abs(((lon - cx) % 360 + 540) % 360 - 180);
        return (cx >= x0 && cx <= x1) || d(x0) <= dx || d(x1) <= dx;
      };
    })();
    // Inside a detailed area the coarse coast is masked out, so it need not be drawn at all.
    const inDetail = holes.some(({ bbox: [x0, y0, x1, y1] }) => cx - span * 1.3 > x0 && cx + span * 1.3 < x1 && cy - span > y0 && cy + span < y1);
    for (const c of coarse) c.node.setAttribute('d', inDetail ? '' : path(near ? { type: 'MultiPolygon', coordinates: c.polys.filter(near).map(p => p.c) } : c.geom) ?? '');
    for (const c of details) c.node.setAttribute('d', path(c.geom) ?? '');
    // Detail by zoom: the whole globe shows only the greatest lakes, no rivers; a continent its
    // greatest rivers; a region more; and closer in, all of them.
    const minW = span > 40 ? Infinity : span > 20 ? 3 : span > 8 ? 2 : 1, minLake = span > 40 ? 2e-5 : span > 20 ? 4e-6 : 0;
    // Turning a wide view, water waits until the drag ends: it is detail the eye does not follow.
    const still = !(moved && drag) || span <= 20;
    gWater.style.display = still ? '' : 'none';
    for (const x of still ? water : []) {
      const show = x.type === 'MultiPolygon' ? x.polys.filter(p => p.a >= minLake) : x.w >= minW ? x.polys : [];
      x.node.setAttribute('d', show.length ? path({ type: x.type, coordinates: (near ? show.filter(near) : show).map(p => p.c) }) ?? '' : '');
    }
    // A city only close in: half the view under about 0.4 degrees (some 40 km), so a city's own
    // page, framed on it, shows it.
    const inCity = span < 0.4;
    if (inCity) askCity();
    gCity.style.display = inCity ? '' : 'none';
    // A city's thousands of buildings are not redrawn while a drag turns the view (so close in, a
    // turn is a shift): they move with it, and are drawn afresh when it ends.
    const centre = [-projection.rotate()[0], -projection.rotate()[1]];
    for (const x of city) {
      if (inCity && moved && drag && x.heavy && x.at) {
        const [a, b] = projection(x.at);
        x.node.setAttribute('transform', `translate(${(a - x.xy[0]).toFixed(1)},${(b - x.xy[1]).toFixed(1)})`);
        continue;
      }
      x.node.setAttribute('d', inCity ? path({ type: x.type, coordinates: x.polys.filter(near).map(p => p.c) }) ?? '' : '');
      x.node.removeAttribute('transform');
      x.at = centre; x.xy = projection(centre);
    }
    relief?.render(projection, W, H, { centre: [-projection.rotate()[0], -projection.rotate()[1]], span });
    for (const x of holes) x.hole.setAttribute('d', path(x.box) ?? '');
    for (const s of shapes) { s.fill.setAttribute('d', (s.g && path(s.g)) ?? ''); s.edge.setAttribute('d', path(s.lines) ?? ''); }
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
    schedule();
  });
  const end = () => { const was = moved && drag; drag = null; if (was) schedule(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('click', ev => { if (moved) { ev.preventDefault(); ev.stopPropagation(); moved = false; } }, true);
  const zoom = f => () => { projection.scale(Math.max(base / 4, Math.min(base * 64, projection.scale() * f))); schedule(); };
  const button = (name, text, onclick) => h('button', { type: 'button', title: text, 'aria-label': text, onclick }, ctx.icon(name));
  tools.append(button('plus', 'Zoom in', zoom(1.6)), button('minus', 'Zoom out', zoom(1 / 1.6)),
    button('locate-fixed', 'Back to fit', () => { projection.rotate(home).scale(base); schedule(); }));

  // Drawn at the box's real size, and again whenever that changes.
  new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    if (!r.width || (Math.round(r.width) === W && Math.round(r.height) === H)) return;
    const first = !W;
    W = Math.round(r.width); H = Math.round(r.height);
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    baseSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (first) fit(); else projection.translate([W / 2, H / 2]);
    // Paths cut to the box (with a margin for strokes), so zoomed in they stay small.
    projection.clipExtent([[-20, -20], [W + 20, H + 20]]);
    draw();
  }).observe(el);
  // What the map shows, as a longitude and latitude box ([west, south, east, north]), for a filter
  // to use: from points across the box that land on the globe. Null if the view crosses 180° or a
  // pole, or shows too much of the globe for a box to say.
  box.viewBounds = () => {
    if (!W) return null;
    const pts = [];
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
      const p = projection.invert([W * i / 12, H * j / 12]);
      if (p && visible(p)) pts.push(p);
    }
    if (pts.length < 4) return null;
    const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    const b = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    return b[2] - b[0] > 180 || b[3] > 89 || b[1] < -89 ? null : b.map(v => Math.round(v * 1000) / 1000);
  };
  return box;
}

// Every position in a geometry.
function coords(g) {
  const walk = c => (typeof c[0] === 'number' ? [c] : c.flatMap(walk));
  return g ? walk(g.coordinates) : [];
}
