// Relief for a universe's globe: `npm run terrain -- <layer>`.
//
// Real elevation, read through the globe's remap (src/globe.mjs) and then changed by the layer's
// story edits, baked into shaded-relief images in the globe's own longitude and latitude
// (equirectangular): one for the whole globe, and a finer one for each regional map's detailed
// area (the `land-detail` boxes of basemap.json). The explorer draws them on its globe with a
// small WebGL shader, so the cost of a map does not grow with the detail of its relief.
//
// Also finds the rivers of each detailed area from its heights, into layers/<layer>/rivers.json.
//
// Writes layers/<layer>/relief.json (what the images are and where they lie) and the images,
// relief-<name>.webp (lossy, with alpha; sharp encodes it): grey is hillshade (light from the north-west of the globe's own map), alpha
// is height (0 at or below sea level, then 1 to 255 rising with the square root of the height up
// to 4,500 m), so the explorer can tint by height and leave the sea alone.
//
// Elevation comes from the Terrain Tiles open dataset (Mapzen/Tilezen on AWS: SRTM, GMTED2010,
// ETOPO1 and others; attribution in README), fetched once into .cache/terrain/. Heights are
// Earth's: the remap squeezes ground distances (about 0.85 by 0.58 on the globe's northern half)
// but not heights, so slopes come out a little steeper than on Earth.
//
// layers/<layer>/terrain.csv, the story edits, applied in order:
//   kind    scale: multiply heights above sea level by `value`, fading to 1 at the edge
//           raise: add `value` metres, fading to nothing at the edge
//           mountains: ridged fractal ranges up to `value` metres over what is there (a POINT and
//             its radius, or a POLYGON with `radius` km of ragged fade outside it)
//           volcano: a stratovolcano rising to `value` metres over `radius` km, its flanks cut by
//             wandering gullies
//           plain: lowland levelled towards `value` metres, gently rolling
// Every edit leaves the sea as it is, and the coast where Earth has it (see `ashore`).
//           dunes: a plain of hummocks
//           river: a valley carved along a LINESTRING, drawn downstream: a floor `radius` km to
//             each side, `value` metres under the lowest ground near it and always falling (so
//             the rivers found from the heights follow it), and walls up to the ground about it
//   at      a place key (its point or the middle of its shape), a POINT in the globe's longitude
//           and latitude, "EARTH POINT (lon lat)" for a point on Earth, remapped, or a shape on
//           one of the layer's regional maps, in its units: "dells POLYGON ((x y, ...))"
//   radius  in km on the globe
//   note    why
// The shapes are noise (seeded, so a bake is repeatable), as fine as the image being baked holds.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { geoCentroid, geoContains } from 'd3-geo';
import { parseCsv } from './csv.mjs';
import { wktToGeometry, cellToFeatureCollection } from './geometry.mjs';
import { makeRemap, mapToGlobe } from './globe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'terrain');
const SOURCE = 'Terrain Tiles (Mapzen/Tilezen, AWS Open Data: SRTM, GMTED2010, ETOPO1, EU-DEM and others), remapped';
const TOP = 4500;   // heights are coded up to this, in metres

// The images: the whole globe coarsely, each detailed area finely, and each regional map with an
// `extent` (its drawn area, in its units) more finely still, with a quarter of its size around it.
// `zoom` is the Terrain Tiles level read, a little finer than the image; `exaggerate` lifts
// hillshade where cells are wide.
const WORLD = { name: 'world', step: 0.15, zoom: 4, exaggerate: 6 };
const DETAIL = { step: 0.01, zoom: 8, exaggerate: 1.5 };
const FINE = { step: 0.0025, zoom: 10, exaggerate: 1.2, margin: 0.25 };

// ---- Earth's elevation from Terrarium tiles (web Mercator PNGs: h = R*256 + G + B/256 - 32768) ----
const tiles = new Map();
function tile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tiles.has(key)) return tiles.get(key);
  const file = path.join(CACHE, String(z), `${x}`, `${y}.png`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync('curl', ['-sfL', '--retry', '3', '-o', file, `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`]);
  }
  const png = PNG.sync.read(fs.readFileSync(file));
  tiles.set(key, png);
  return png;
}
function elevation(z, [lon, lat]) {
  const n = 2 ** z, s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
  const px = (lon + 180) / 360 * n * 256 - 0.5, py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256 - 0.5;
  const at = (X, Y) => {
    const tx = ((Math.floor(X / 256) % n) + n) % n, ty = Math.min(n - 1, Math.max(0, Math.floor(Y / 256)));
    const t = tile(z, tx, ty), i = (Math.min(255, Math.max(0, Y - ty * 256))) * 256 + ((X % 256) + 256) % 256;
    const d = t.data;
    return d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  };
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

// ---- Rivers, found from the heights ------------------------------------------------------------
// Where water runs, on a grid of heights (row 0 at the north): pits are filled so that every cell
// drains to the sea or the edge (priority-flood, with a hair of slope across flats), each cell
// drains to its steepest lower neighbour, and the land draining through each cell is added up. A
// river is where that passes RIVER_KM2; its width class grows with it. Returns Map(w -> lines).
const RIVER_KM2 = [[15000, 3], [2000, 2], [150, 1]];
function rivers(hs, w, h, [x0, , , y1], step) {
  const n = w * h, filled = Float64Array.from(hs), closed = new Uint8Array(n), order = new Int32Array(n);
  // A binary heap of cells by filled height.
  const heap = [], push = c => { heap.push(c); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (filled[heap[p]] <= filled[c]) break; heap[i] = heap[p]; i = p; } heap[i] = c; };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let i = 0; for (;;) { let m = 2 * i + 1; if (m >= heap.length) break; if (m + 1 < heap.length && filled[heap[m + 1]] < filled[heap[m]]) m++; if (filled[heap[m]] >= filled[last]) break; heap[i] = heap[m]; i = m; } heap[i] = last; } return top; };
  const sea = c => hs[c] <= 0;
  for (let c = 0; c < n; c++) { const i = c % w, j = (c / w) | 0; if (sea(c) || i === 0 || j === 0 || i === w - 1 || j === h - 1) { closed[c] = 1; push(c); } }
  const nb = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  let k = 0;
  while (heap.length) {
    const c = pop(); order[k++] = c;
    const i = c % w, j = (c / w) | 0;
    for (const [di, dj] of nb) {
      const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= w || b >= h) continue;
      const m = b * w + a; if (closed[m]) continue;
      closed[m] = 1; filled[m] = Math.max(filled[m], filled[c] + 1e-3); push(m);
    }
  }
  // Each land cell's receiver: its steepest lower neighbour, by ground distance.
  const km = 6371 * Math.PI / 180 * step, recv = new Int32Array(n).fill(-1), area = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    const i = c % w, j = (c / w) | 0, lat = y1 - j * step, dx = km * Math.cos(lat * Math.PI / 180);
    area[c] = sea(c) ? 0 : dx * km;
    if (sea(c) || i === 0 || j === 0 || i === w - 1 || j === h - 1) continue;
    let best = -1, drop = 0;
    for (const [di, dj] of nb) {
      const m = (j + dj) * w + (i + di), d = (filled[c] - filled[m]) / Math.hypot(di * dx, dj * km);
      if (d > drop) { drop = d; best = m; }
    }
    recv[c] = best;
  }
  // Down from the highest: the flood's order reversed has every cell before the one it drains to.
  for (let t = n - 1; t >= 0; t--) { const c = order[t]; if (recv[c] >= 0) area[recv[c]] += area[c]; }
  const cls = c => { for (const [a, wcls] of RIVER_KM2) if (area[c] >= a) return wcls; return 0; };
  // Trace from each river's head downstream, splitting where the width changes and stopping where
  // a stretch already traced is reached (so tributaries end at the junction).
  const up = new Uint8Array(n);
  for (let c = 0; c < n; c++) if (cls(c) && recv[c] >= 0) up[recv[c]] = 1;
  const seen = new Uint8Array(n), out = new Map();
  const at = c => [x0 + (c % w) * step, y1 - ((c / w) | 0) * step];
  const emit = (wc, cells) => { if (cells.length < 2) return; const line = smooth(cells.map(at)); (out.get(wc) ?? out.set(wc, []).get(wc)).push(line); };
  for (let c = 0; c < n; c++) {
    if (!cls(c) || up[c] || seen[c]) continue;
    let cur = c, wc = cls(c), cells = [];
    while (cur >= 0) {
      const cc = cls(cur) || wc;
      if (cc !== wc) { cells.push(cur); emit(wc, cells); cells = []; wc = cc; }
      cells.push(cur);
      if (seen[cur]) break;
      seen[cur] = 1;
      cur = recv[cur];
    }
    emit(wc, cells);
  }
  return out;
}
// Chaikin smoothing, twice, keeping the ends; then simplified (about 300 m) and rounded (100 m).
function smooth(pts) {
  for (let it = 0; it < 2; it++) {
    const o = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) { const [a, b] = [pts[i], pts[i + 1]]; o.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]); }
    o.push(pts[pts.length - 1]); pts = o;
  }
  return simplifyLine(pts, 0.003).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}
// Douglas-Peucker on an open line, in degrees.
function simplifyLine(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let far = -1, dmax = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) { const d = len ? Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - ay); if (d > dmax) { dmax = d; far = i; } }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---- main ------------------------------------------------------------------------------------

const key = process.argv[2];
if (!key) { console.error('usage: npm run terrain -- <layer>'); process.exit(1); }
const dir = path.join(ROOT, 'layers', key);
const settings = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
const remap = makeRemap(settings.globe.remap);
const basemap = JSON.parse(fs.readFileSync(path.join(dir, 'basemap.json'), 'utf8'));
// A regional map with the fine coast (`coast` "10m" in globe.maps) takes its sea from that drawn
// coast, not from where Earth's heights reach 0: at that scale the heights blur a lough or a
// harbour into land, and the relief would shade it under the drawn water.
const seaOf = name => {
  if (settings.globe.maps?.[name]?.coast !== '10m') return null;
  const land = basemap.features.filter(f => f.properties.map === name && /^(land|unnamed)-detail$/.test(f.properties.kind));
  return p => !land.some(f => geoContains(f, p));
};

// ---- Noise: Perlin's gradient noise, seeded, and sums of it ------------------------------------
function gradientNoise(seed) {
  let s = seed * 2654435761 >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const perm = new Uint8Array(512), p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y) => { const a = h * Math.PI / 128; return Math.cos(a) * x + Math.sin(a) * y; };
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const X = Math.floor(x), Y = Math.floor(y), fx = x - X, fy = y - Y, xi = X & 255, yi = Y & 255;
    const u = fade(fx), v = fade(fy);
    const n00 = grad(perm[xi + perm[yi]], fx, fy), n10 = grad(perm[xi + 1 + perm[yi]], fx - 1, fy);
    const n01 = grad(perm[xi + perm[yi + 1]], fx, fy - 1), n11 = grad(perm[xi + 1 + perm[yi + 1]], fx - 1, fy - 1);
    return 1.4 * ((n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v);   // about -1..1
  };
}
// Octaves from `wave` km down to twice the cell of the image being baked (finer would only alias).
let finest = 2;
const octaves = wave => Math.max(1, Math.floor(Math.log2(wave / finest)) + 1);
function fbm(noise, x, y, wave) {
  let sum = 0, amp = 1, norm = 0, f = 1 / wave;
  for (let o = octaves(wave); o > 0; o--) { sum += amp * noise(x * f + 17.3 * o, y * f - 9.1 * o); norm += amp; amp *= 0.5; f *= 2; }
  return sum / norm;
}
// Ridged multifractal: sharp crests, with finer ridges strongest on the high ground. 0..1.
function ridged(noise, x, y, wave) {
  let sum = 0, amp = 1, norm = 0, f = 1 / wave, weight = 1;
  for (let o = octaves(wave); o > 0; o--) {
    let r = 1 - Math.abs(noise(x * f + 31.7 * o, y * f + 5.3 * o)); r *= r * weight;
    weight = Math.min(1, r * 2);
    sum += amp * r; norm += amp; amp *= 0.5; f *= 2.1;
  }
  return sum / norm;
}
const smoothstep = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// A max without a crease where two surfaces cross (k metres of blend).
// The coast is Earth's: no edit makes land of the sea (or sea of the land), so the relief, the
// rivers found from it and the globe's drawn coast (basemap.json, from Natural Earth) agree. An edit
// that lifts the ground eases in over the last COAST_KM before the sea, so a range or a volcano
// that reaches the shore comes down to it rather than standing in it as a sea cliff. The distance
// to the sea is Earth's, unedited, on a 2 km grid over each detailed area (seaDistance, below);
// elsewhere edits are not eased.
const COAST_KM = 5;
let coastKm = () => Infinity;
const ashore = p => smoothstep(coastKm(p) / COAST_KM);
const smoothMax = (a, b, k) => { const h = Math.max(0, k - Math.abs(a - b)) / k; return Math.max(a, b) + h * h * k / 4; };

// ---- The edits ---------------------------------------------------------------------------------
// Each works in its own flat km frame around its middle (its shapes span at most a few hundred
// km), and is skipped at once outside its box.
const KM = 6371 * Math.PI / 180;
// A valley's walls rise WALL metres a km at the floor, steepening (half as much again per km out),
// so a valley cut 2 km deep reaches about 5 km out from its floor; RIVER_REACH km is as far as they go.
const WALL = 120, RIVER_REACH = 12;
function makeEdit(kind, g, radius, value, index) {
  const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.coordinates[0];
  const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2, lat0 = (Math.min(...lats) + Math.max(...lats)) / 2, cos0 = Math.cos(lat0 * Math.PI / 180);
  const km = ([lon, lat]) => [(lon - lon0) * KM * cos0, (lat - lat0) * KM];
  const toGlobe = ([x, y]) => [lon0 + x / (KM * cos0), lat0 + y / KM];
  // km beyond the shape that an edit can touch: its ragged edge, or a river's valley walls.
  const reach = kind === 'river' ? radius + RIVER_REACH : radius * 1.5;
  const box = [Math.min(...lons) - reach / (KM * cos0), Math.min(...lats) - reach / KM, Math.max(...lons) + reach / (KM * cos0), Math.max(...lats) + reach / KM];
  const noise = gradientNoise(index + 1), warp = gradientNoise(index + 101);
  const e = { kind, value, radius, reach, box, km, toGlobe, noise, line: g.type === 'LineString' ? pts.map(km) : null, centre: km(g.coordinates.length === 2 && typeof g.coordinates[0] === 'number' ? g.coordinates : [lon0, lat0]) };
  if (g.type === 'Polygon') e.ring = pts.map(km);
  // How far inside the shape (1 deep inside, 0 outside), with an edge made ragged by noise.
  e.inside = (x, y) => {
    const ragged = fbm(warp, x, y, 45) * radius * 1.2;
    if (e.ring) return smoothstep(0.5 - (signedDistance(e.ring, x, y) + ragged) / radius);
    const r = Math.hypot(x - e.centre[0], y - e.centre[1]) + ragged;
    return 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, r / radius))));
  };
  return e;
}
// Distance to a ring's edge in km, negative inside it.
function signedDistance(ring, x, y) {
  let d = Infinity, inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return inside ? -d : d;
}
// The nearest point of a line: its distance, and how far along the line it is (km).
function alongLine(line, x, y) {
  let best = Infinity, at = 0, run = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (len * len || 1)));
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < best) { best = d; at = run + t * len; }
    run += len;
  }
  return [best, at];
}

// Where each edit is: a place's geometry, a globe POINT, an EARTH POINT, or a shape on a map.
const place = parseCsv(fs.readFileSync(path.join(dir, 'data', 'place.csv'), 'utf8'));
const gcol = place[0].indexOf('geometry');
const placeAt = new Map(place.slice(1).filter(r => r[gcol]).map(r => {
  const fc = cellToFeatureCollection(r[gcol]);
  const g = fc.features[0].geometry;
  return [r[0], g.type === 'Point' ? g : { type: 'Point', coordinates: geoCentroid(fc) }];
}));
const maps = settings.globe.maps ?? {};
const mapCoords = (map, c) => (typeof c[0] === 'number' ? mapToGlobe(map, remap, c) : c.map(x => mapCoords(map, x)));
const KINDS = ['scale', 'raise', 'mountains', 'volcano', 'plain', 'dunes', 'river'];
const SHAPES = { scale: ['Point'], raise: ['Point'], volcano: ['Point'], mountains: ['Point', 'Polygon'], plain: ['Polygon'], dunes: ['Polygon'], river: ['LineString'] };
const editsFile = path.join(dir, 'terrain.csv');
const rows = fs.existsSync(editsFile) ? parseCsv(fs.readFileSync(editsFile, 'utf8')) : [['kind']];
const col = n => rows[0].indexOf(n);
const edits = rows.slice(1).filter(r => r[0]).map((r, i) => {
  const at = r[col('at')].trim(), where = `terrain.csv row ${i + 2}`, kind = r[col('kind')];
  const onMap = /^([\w-]+)\s+([A-Z]+\s*\(.*)$/s.exec(at);
  let g;
  if (/^EARTH\s+/i.test(at)) g = { type: 'Point', coordinates: remap.toGlobe(wktToGeometry(at.replace(/^EARTH\s+/i, '')).coordinates) };
  else if (onMap && maps[onMap[1]]) { const w = wktToGeometry(onMap[2]); g = { type: w.type, coordinates: mapCoords(maps[onMap[1]], w.coordinates) }; }
  else if (/^[A-Z]+\s*\(/.test(at)) g = wktToGeometry(at);
  else g = placeAt.get(at);
  if (!g) throw new Error(`${where}: no place or map "${at.split(/\s/)[0]}" with a location`);
  if (!KINDS.includes(kind)) throw new Error(`${where}: unknown kind "${kind}"`);
  if (!SHAPES[kind].includes(g.type)) throw new Error(`${where}: a ${kind} is at a ${SHAPES[kind].join(' or ')}, not a ${g.type}`);
  return makeEdit(kind, g, Number(r[col('radius')]), Number(r[col('value')]), i);
});

function applyEdit(e, h, p) {
  if (p[0] < e.box[0] || p[0] > e.box[2] || p[1] < e.box[1] || p[1] > e.box[3]) return h;
  const [x, y] = e.km(p);
  switch (e.kind) {
    case 'scale': case 'raise': {
      const r = Math.hypot(x - e.centre[0], y - e.centre[1]) / e.radius;
      if (r >= 1) return h;
      const fade = 0.5 * (1 + Math.cos(Math.PI * r));
      if (h <= 0) return h;
      return e.kind === 'raise' ? Math.max(1, h + e.value * fade * ashore(p)) : h * (1 + (e.value - 1) * fade);
    }
    case 'mountains': {
      const m = e.inside(x, y);
      if (m <= 0 || h <= 0) return h;
      // Ranges about 25 km apart, with their spurs, running north and south on the globe's map as
      // the Balkan ranges around the Dells do there; the mask lifts the whole range towards its
      // middle so the foothills are lower than the crests.
      const r = ridged(e.noise, x * 1.5, y * 0.7, 28);
      return h + (smoothMax(h, e.value * m * (0.3 + 0.7 * r) * (0.6 + 0.4 * m), 120) - h) * ashore(p);
    }
    case 'volcano': {
      const dx = x - e.centre[0], dy = y - e.centre[1], a = Math.atan2(dy, dx), d = Math.hypot(dx, dy);
      // A cone, not round (its radius wanders by noise round the compass), concave like a
      // stratovolcano, with a crater.
      const lobes = 1 + 0.2 * fbm(e.noise, Math.cos(a) * 4, Math.sin(a) * 4, 3);
      const r = d / (e.radius * lobes);
      if (r >= 1 || h <= 0) return h;
      const cone = (1 - r) ** 2 * 0.6 + (1 - r) ** 7 * 0.4;   // a broad base, a steep summit cone
      // Gullies down its flanks: noise sampled round a circle (so each runs straight downhill and
      // there is no seam), drifting slowly with distance so they wander; finer sets, more of them,
      // take over lower down as the flank widens. Each is cut where its noise crosses zero.
      const ring = (R, k) => {
        const n = e.noise(Math.cos(a) * R + d / 7 + 7 * k, Math.sin(a) * R - d / 9 - 3 * k);
        const depth = 0.5 + 0.5 * e.noise(Math.cos(a) * R * 0.5 + 40, Math.sin(a) * R * 0.5 + d / 15);
        return depth * (1 - Math.min(1, Math.abs(n) * 2)) ** 2;
      };
      const lower = smoothstep((d / e.radius - 0.25) / 0.35);
      const cut = wave => (1 - lower) * ring(2.2 * 4 / wave, 0) + lower * ring(5 * 4 / wave, 1);
      // Deepest mid-flank, where the gullies have gathered water; none at the summit or the foot.
      const flank = smoothstep((r - 0.1) / 0.3) * (1 - smoothstep((r - 0.6) / 0.35));
      const rough = 0.12 * smoothstep(r / 0.3) * ridged(e.noise, x, y, 8) + 0.03 * smoothstep(r / 0.08) * fbm(e.noise, x + 70, y, 4);
      const scored = cone * (0.92 + rough) - flank * (0.09 * cut(4) + 0.045 * cut(2));
      const crater = 0.09 * (1 - smoothstep(r / 0.045)) - 0.015 * Math.exp(-(((r - 0.05) / 0.02) ** 2));   // and its rim
      return h + (smoothMax(h, e.value * (scored - crater), 200) - h) * ashore(p);
    }
    case 'plain': case 'dunes': {
      if (h <= 0) return h;
      const m = e.inside(x, y);
      if (m <= 0) return h;
      const rolling = e.kind === 'dunes'
        ? e.value * (1 + 0.5 * Math.abs(fbm(e.noise, x * 1.6, y, 5)) - 0.15)   // hummocks, longer east-west
        : e.value * (1 + 0.5 * fbm(e.noise, x, y, 15) + 0.2 * fbm(e.noise, x - 60, y + 60, 4));
      // Levelled, not erased: what was there is kept at a sixth of its relief.
      const target = Math.max(2, rolling);
      return Math.max(1, target + (h - target) * (1 - 0.85 * m));
    }
    case 'river': {
      // Meandering: the distance is measured from a point nudged by noise at two scales.
      const wx = x + 2.4 * fbm(e.noise, x, y, 14) + 0.7 * fbm(e.noise, x - 90, y, 4);
      const wy = y + 2.4 * fbm(e.noise, x + 40, y - 40, 14) + 0.7 * fbm(e.noise, x, y + 90, 4);
      const [d, s] = alongLine(e.line, wx, wy);
      if (d >= e.reach) return h;
      const bed = e.bedAt(s);
      if (h <= bed) return h;
      // A floor `radius` km to each side, then walls whose steepness wanders by noise and
      // steepens with height: a valley widens where it cuts deep, as a river's does.
      const k = Math.max(0, d - e.radius), steep = WALL * (1 + 0.6 * fbm(e.noise, x + 200, y, 6));
      return Math.min(h, bed + steep * k + 0.5 * steep * k * k);
    }
  }
  return h;
}

function height(zoom, p, upTo = edits.length) {
  let h = elevation(zoom, remap.toEarth(p));
  for (let k = 0; k < upTo; k++) h = applyEdit(edits[k], h, p);
  return h;
}
// Each river's bed: the lowest ground within 3 km of its line (as the edits before it left it), every
// half km, so the valley is the low ground there and water does not leave it, less
// its depth, never rising downstream, and coming down to its mouth: the bed of the river it joins
// (carved before it), or else the sea.
// Distance to Earth's sea (km) over each detailed area: its sea cells (unedited elevation at or
// below 0, or off a fine-coast map's drawn land) on a 2 km grid, spread by a two-pass chamfer
// transform. Read by `ashore`.
{
  const STEP = 0.02, grids = [];
  const boxesOf = [...new Map(basemap.features.filter(f => f.properties.kind.endsWith('-detail')).map(f => [f.bbox.join(','), { bbox: f.bbox, sea: seaOf(f.properties.map) }])).values()];
  for (const { bbox: [x0, y0, x1, y1], sea } of boxesOf) {
    const w = Math.round((x1 - x0) / STEP) + 1, h = Math.round((y1 - y0) / STEP) + 1;
    const dx = STEP * KM * Math.cos(((y0 + y1) / 2) * Math.PI / 180), dy = STEP * KM, dd = Math.hypot(dx, dy);
    const d = new Float64Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) d[j * w + i] = elevation(DETAIL.zoom, remap.toEarth([x0 + i * STEP, y0 + j * STEP])) <= 0 || sea?.([x0 + i * STEP, y0 + j * STEP]) ? 0 : Infinity;
    const relax = (i, j, a, b, c) => { const k = j * w + i, n = (j + b) * w + (i + a); if (i + a >= 0 && i + a < w && j + b >= 0 && j + b < h && d[n] + c < d[k]) d[k] = d[n] + c; };
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { relax(i, j, -1, 0, dx); relax(i, j, 0, -1, dy); relax(i, j, -1, -1, dd); relax(i, j, 1, -1, dd); }
    for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) { relax(i, j, 1, 0, dx); relax(i, j, 0, 1, dy); relax(i, j, 1, 1, dd); relax(i, j, -1, 1, dd); }
    grids.push({ x0, y0, x1, y1, w, h, d });
  }
  coastKm = ([lon, lat]) => {
    const g = grids.find(b => lon >= b.x0 && lon <= b.x1 && lat >= b.y0 && lat <= b.y1);
    return g ? g.d[Math.round((lat - g.y0) / STEP) * g.w + Math.round((lon - g.x0) / STEP)] : Infinity;
  };
}

edits.forEach((e, k) => {
  if (e.kind !== 'river') return;
  const samples = [];
  let run = 0;
  for (let i = 0; i < e.line.length - 1; i++) {
    const [a, b] = [e.line[i], e.line[i + 1]], len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / 0.5));
    const [nx, ny] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    for (let j = i ? 1 : 0; j <= n; j++) {
      const [x, y] = [a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n];
      const ground = Math.min(...[-3, -1.5, 0, 1.5, 3].map(o => height(DETAIL.zoom, e.toGlobe([x + nx * o, y + ny * o]), k)));
      samples.push([run + len * j / n, ground]);
    }
    run += len;
  }
  const end = e.toGlobe(e.line[e.line.length - 1]);
  const joins = edits.slice(0, k).find(r => r.kind === 'river' && alongLine(r.line, ...r.km(end))[0] < r.radius + 2);
  const mouth = joins ? Math.max(1, joins.bedAt(alongLine(joins.line, ...joins.km(end))[1])) : 1;
  let low = Infinity;
  const beds = samples.map(([s, ground]) => { low = Math.min(low, ground - e.value); return [s, ground > 0 ? Math.max(mouth, low) : Math.min(ground, low)]; });
  e.bedAt = s => {
    let lo = 0, hi = beds.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beds[m][0] <= s) lo = m; else hi = m; }
    const [[s0, b0], [s1, b1]] = [beds[lo], beds[hi]];
    return s1 > s0 ? b0 + (b1 - b0) * Math.max(0, Math.min(1, (s - s0) / (s1 - s0))) : b0;
  };
});

// One image: heights on a grid in the globe's longitude and latitude, hillshaded.
async function bake({ name, step, zoom, exaggerate }, [x0, y0, x1, y1], sea = null) {
  finest = 2 * step * KM;
  const w = Math.round((x1 - x0) / step) + 1, hgt = Math.round((y1 - y0) / step) + 1;
  const hs = new Float64Array(w * hgt);
  for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) hs[j * w + i] = height(zoom, [x0 + i * step, y1 - j * step]);
  if (sea) for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) if (sea([x0 + i * step, y1 - j * step])) hs[j * w + i] = Math.min(hs[j * w + i], 0);
  const png = { data: Buffer.alloc(w * hgt * 4) };
  // Light from azimuth 315 (the north-west of the globe's map), 45 degrees up; cells are metres
  // apart by the globe's own degrees (the world it describes, not Earth).
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180, m = 6371000 * Math.PI / 180 * step;
  let top = -Infinity;
  for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) {
    const at = (a, b) => hs[Math.min(hgt - 1, Math.max(0, b)) * w + Math.min(w - 1, Math.max(0, a))];
    const dx = m * Math.max(0.2, Math.cos((y1 - j * step) * Math.PI / 180));
    const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * dx) * exaggerate, gy = (at(i, j - 1) - at(i, j + 1)) / (2 * m) * exaggerate;
    const slope = Math.atan(Math.hypot(gx, gy)), aspect = Math.atan2(gy, -gx);
    const shade = Math.max(0, Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(az - Math.PI / 2 - aspect));
    const h = hs[j * w + i], k = (j * w + i) * 4, g = Math.round(shade * 255);
    top = Math.max(top, h);
    png.data[k] = png.data[k + 1] = png.data[k + 2] = g;
    png.data[k + 3] = h <= 0 ? 0 : 1 + Math.round(Math.sqrt(Math.min(h, TOP) / TOP) * 254);
  }
  const file = `relief-${name}.webp`;
  fs.writeFileSync(path.join(dir, file), await sharp(png.data, { raw: { width: w, height: hgt, channels: 4 } }).webp({ quality: 75, alphaQuality: 80, effort: 6 }).toBuffer());
  console.log(`${file}: ${w} x ${hgt}, highest ${Math.round(top)} m, ${(fs.statSync(path.join(dir, file)).size / 1024).toFixed(0)} KB`);
  return { image: { file, bbox: [x0, y0, x1, y1], width: w, height: hgt, step }, heights: hs };
}

// The whole globe: what the remap fills (longitudes squeezed to 180 x eastWest; southern
// latitudes squeezed by `south`).
const ew = 180 * settings.globe.remap.eastWest, south = -90 * settings.globe.remap.south;
for (const f of fs.readdirSync(dir).filter(f => /^relief-.*\.(png|webp)$/.test(f))) fs.rmSync(path.join(dir, f));
const images = [{ ...(await bake(WORLD, [-Math.ceil(ew), Math.floor(south), Math.ceil(ew), 90])).image, name: 'world' }];
const riverFeatures = [];
const boxes = [...new Map(basemap.features.filter(f => f.properties.kind.endsWith('-detail')).map(f => [f.bbox.join(','), { bbox: f.bbox, map: f.properties.map }])).values()];
for (const { bbox, map } of boxes) {
  const { image, heights } = await bake({ ...DETAIL, name: map }, bbox, seaOf(map));
  images.push({ ...image, name: map });
  const found = rivers(heights, image.width, image.height, bbox, DETAIL.step);
  for (const [w, lines] of found) riverFeatures.push({ type: 'Feature', bbox, properties: { kind: 'river-detail', map, w, source: `Found from ${SOURCE}` }, geometry: { type: 'MultiLineString', coordinates: lines } });
  console.log(`${map}: ${[...found.values()].reduce((n, l) => n + l.length, 0)} river stretches`);
}
// A map can ask for a finer image of its extent (`fine` in globe.maps: { step, zoom, exaggerate }),
// as a city's map does, whose knolls and harbours are smaller than FINE's cells.
for (const [name, map] of Object.entries(maps).filter(([, m]) => m.extent)) {
  const fine = { ...FINE, ...(map.fine ?? {}) };
  const [a, b, c, d] = map.extent, mx = (c - a) * fine.margin, my = (d - b) * fine.margin;
  const corners = [[a - mx, b - my], [c + mx, b - my], [a - mx, d + my], [c + mx, d + my]].map(p => mapToGlobe(map, remap, p));
  const snap = (v, up) => (up ? Math.ceil(v / fine.step) : Math.floor(v / fine.step)) * fine.step;
  const bbox = [snap(Math.min(...corners.map(p => p[0]))), snap(Math.min(...corners.map(p => p[1]))), snap(Math.max(...corners.map(p => p[0])), true), snap(Math.max(...corners.map(p => p[1])), true)].map(v => Math.round(v * 1e4) / 1e4);
  const { image } = await bake({ ...fine, name: `${name}-fine` }, bbox, seaOf(name));
  images.push({ ...image, name: `${name}-fine` });
}
fs.writeFileSync(path.join(dir, 'rivers.json'), JSON.stringify({ type: 'FeatureCollection', features: riverFeatures }));

fs.writeFileSync(path.join(dir, 'relief.json'), JSON.stringify({ kind: 'relief', source: SOURCE, top: TOP, edits: edits.length, images }, null, 1));
console.log(`layers/${key}/relief.json: ${images.length} image(s), ${edits.length} edit(s)`);
