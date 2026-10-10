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
//   kind    volcano: a cone rising to `value` metres (built over what is there)
//           raise: add `value` metres, fading to nothing at the edge
//           scale: multiply heights above sea level by `value`, fading to 1 at the edge
//   at      a place key (its point or the middle of its shape), a POINT in the globe's longitude
//           and latitude, or "EARTH POINT (lon lat)" for a point on Earth, remapped
//   radius  in km on the globe
//   note    why

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { geoCentroid, geoDistance } from 'd3-geo';
import { parseCsv } from './csv.mjs';
import { wktToGeometry, cellToFeatureCollection } from './geometry.mjs';
import { makeRemap } from './globe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'terrain');
const SOURCE = 'Terrain Tiles (Mapzen/Tilezen, AWS Open Data: SRTM, GMTED2010, ETOPO1, EU-DEM and others), remapped';
const TOP = 4500;   // heights are coded up to this, in metres

// The images: the whole globe coarsely, each detailed area finely. `zoom` is the Terrain Tiles
// level read, a little finer than the image; `exaggerate` lifts hillshade where cells are wide.
const WORLD = { name: 'world', step: 0.15, zoom: 4, exaggerate: 6 };
const DETAIL = { step: 0.01, zoom: 8, exaggerate: 1.5 };

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
const RIVER_KM2 = [[15000, 3], [2000, 2], [400, 1]];
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

// Where each edit is: a place's geometry, a globe POINT, or an EARTH POINT.
const place = parseCsv(fs.readFileSync(path.join(dir, 'data', 'place.csv'), 'utf8'));
const gcol = place[0].indexOf('geometry');
const placeAt = new Map(place.slice(1).filter(r => r[gcol]).map(r => {
  const fc = cellToFeatureCollection(r[gcol]);
  const g = fc.features[0].geometry;
  return [r[0], g.type === 'Point' ? g.coordinates : geoCentroid(fc)];
}));
const editsFile = path.join(dir, 'terrain.csv');
const rows = fs.existsSync(editsFile) ? parseCsv(fs.readFileSync(editsFile, 'utf8')) : [['kind']];
const col = n => rows[0].indexOf(n);
const edits = rows.slice(1).filter(r => r[0]).map((r, i) => {
  const at = r[col('at')].trim(), where = `terrain.csv row ${i + 2}`;
  const centre = /^EARTH\s+/i.test(at) ? remap.toGlobe(wktToGeometry(at.replace(/^EARTH\s+/i, '')).coordinates)
    : /^[A-Z]+\s*\(/.test(at) ? wktToGeometry(at).coordinates : placeAt.get(at);
  if (!centre) throw new Error(`${where}: no place "${at}" with a location`);
  if (!['volcano', 'raise', 'scale'].includes(r[col('kind')])) throw new Error(`${where}: unknown kind "${r[col('kind')]}"`);
  return { kind: r[col('kind')], centre, radius: Number(r[col('radius')]), value: Number(r[col('value')]) };
});

function height(zoom, p) {
  let h = elevation(zoom, remap.toEarth(p));
  for (const e of edits) {
    const r = geoDistance(p, e.centre) * 6371 / e.radius;
    if (r >= 1) continue;
    const fade = 0.5 * (1 + Math.cos(Math.PI * r));
    if (e.kind === 'volcano') h = Math.max(h, e.value * (1 - r) ** 1.6);
    else if (e.kind === 'raise') h += e.value * fade;
    else if (h > 0) h *= 1 + (e.value - 1) * fade;
  }
  return h;
}

// One image: heights on a grid in the globe's longitude and latitude, hillshaded.
async function bake({ name, step, zoom, exaggerate }, [x0, y0, x1, y1]) {
  const w = Math.round((x1 - x0) / step) + 1, hgt = Math.round((y1 - y0) / step) + 1;
  const hs = new Float64Array(w * hgt);
  for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) hs[j * w + i] = height(zoom, [x0 + i * step, y1 - j * step]);
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
  const { image, heights } = await bake({ ...DETAIL, name: map }, bbox);
  images.push({ ...image, name: map });
  const found = rivers(heights, image.width, image.height, bbox, DETAIL.step);
  for (const [w, lines] of found) riverFeatures.push({ type: 'Feature', bbox, properties: { kind: 'river-detail', map, w, source: `Found from ${SOURCE}` }, geometry: { type: 'MultiLineString', coordinates: lines } });
  console.log(`${map}: ${[...found.values()].reduce((n, l) => n + l.length, 0)} river stretches`);
}
fs.writeFileSync(path.join(dir, 'rivers.json'), JSON.stringify({ type: 'FeatureCollection', features: riverFeatures }));

fs.writeFileSync(path.join(dir, 'relief.json'), JSON.stringify({ kind: 'relief', source: SOURCE, top: TOP, edits: edits.length, images }, null, 1));
console.log(`layers/${key}/relief.json: ${images.length} image(s), ${edits.length} edit(s)`);
