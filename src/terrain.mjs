// Relief for a universe's globe: `npm run terrain -- <layer>`.
//
// Real elevation, read through the globe's remap (src/globe.mjs) and then changed by the layer's
// story edits, for each regional map's detailed area (the `land-detail` boxes of basemap.json).
// Writes layers/<layer>/relief.json: elevation bands (contours, as GeoJSON in the globe's
// longitude and latitude) that the explorer draws over the land.
//
// Elevation comes from the Terrain Tiles open dataset (Mapzen/Tilezen on AWS: SRTM, GMTED2010,
// ETOPO1 and others; attribution in README), fetched once into .cache/terrain/. Heights are
// Earth's: the remap squeezes ground distances (about 0.85 by 0.58 here) but not heights, so
// slopes come out a little steeper than on Earth.
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
import { contours } from 'd3-contour';
import { geoArea, geoCentroid, geoDistance } from 'd3-geo';
import { parseCsv } from './csv.mjs';
import { wktToGeometry, cellToFeatureCollection } from './geometry.mjs';
import { makeRemap } from './globe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'terrain');
const ZOOM = 8;                 // about 450 m a pixel here: finer than the grid below
const STEP = 0.01;              // grid spacing in the globe's degrees (about 1 km)
const TOLERANCE = 0.008;         // contour simplification, degrees (about 0.8 km)
const BANDS = [250, 600, 1000, 1500, 2000, 2500, 3000, 3500];
const SOURCE = 'Terrain Tiles (Mapzen/Tilezen, AWS Open Data: SRTM, GMTED2010, ETOPO1 and others), remapped';

// ---- Earth's elevation from Terrarium tiles (web Mercator PNGs: h = R*256 + G + B/256 - 32768) ----
const tiles = new Map();
function tile(x, y) {
  const key = `${x}/${y}`;
  if (tiles.has(key)) return tiles.get(key);
  const file = path.join(CACHE, String(ZOOM), `${x}`, `${y}.png`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync('curl', ['-sfL', '--retry', '3', '-o', file, `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${ZOOM}/${x}/${y}.png`]);
  }
  const png = PNG.sync.read(fs.readFileSync(file));
  tiles.set(key, png);
  return png;
}
function elevation([lon, lat]) {
  const n = 2 ** ZOOM, s = Math.sin(lat * Math.PI / 180);
  const px = (lon + 180) / 360 * n * 256 - 0.5, py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256 - 0.5;
  const at = (X, Y) => {
    const tx = ((Math.floor(X / 256) % n) + n) % n, ty = Math.min(n - 1, Math.max(0, Math.floor(Y / 256)));
    const t = tile(tx, ty), i = ((Y - ty * 256 + 256) % 256) * 256 + ((X % 256) + 256) % 256;
    const d = t.data;
    return d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  };
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

// Douglas-Peucker in degrees: drop points within `tol` of the line they sit on. A closed ring
// starts and ends on the same point, so it is split at the point farthest from its start and
// each half simplified.
function simplifyLine(pts, tol) {
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let far = -1, dmax = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const d = len ? Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > dmax) { dmax = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplify(ring, tol) {
  let far = 0, dmax = -1;
  for (let i = 1; i < ring.length - 1; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > dmax) { dmax = d; far = i; } }
  const out = [...simplifyLine(ring.slice(0, far + 1), tol), ...simplifyLine(ring.slice(far), tol).slice(1)];
  return out.length >= 4 ? out : ring;
}

// ---- main ------------------------------------------------------------------------------------

const key = process.argv[2];
if (!key) { console.error('usage: npm run terrain -- <layer>'); process.exit(1); }
const dir = path.join(ROOT, 'layers', key);
const settings = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
const remap = makeRemap(settings.globe.remap);
const basemap = JSON.parse(fs.readFileSync(path.join(dir, 'basemap.json'), 'utf8'));
const boxes = [...new Map(basemap.features.filter(f => f.properties.kind.endsWith('-detail')).map(f => [f.bbox.join(','), { bbox: f.bbox, map: f.properties.map }])).values()];

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

const features = [];
for (const { bbox, map } of boxes) {
  const [x0, y0, x1, y1] = bbox;
  const nx = Math.round((x1 - x0) / STEP) + 1, ny = Math.round((y1 - y0) / STEP) + 1;
  const values = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = [x0 + i * STEP, y1 - j * STEP];
    let h = elevation(remap.toEarth(p));
    for (const e of edits) {
      const r = geoDistance(p, e.centre) * 6371 / e.radius;
      if (r >= 1) continue;
      const fade = 0.5 * (1 + Math.cos(Math.PI * r));
      if (e.kind === 'volcano') h = Math.max(h, e.value * (1 - r) ** 1.6 * (r < 0.04 ? 0.94 : 1));
      else if (e.kind === 'raise') h += e.value * fade;
      else if (h > 0) h *= 1 + (e.value - 1) * fade;
    }
    values[j * nx + i] = h;
  }
  // Bands as polygons on the globe; d3-geo wants each ring clockwise around its inside.
  for (const c of contours().size([nx, ny]).thresholds(BANDS)(values)) {
    const coordinates = c.coordinates.map(poly => poly.map(ring => simplify(ring.map(([x, y]) => [x0 + x * STEP, y1 - y * STEP]), TOLERANCE).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])))
      .map(poly => { const g = { type: 'Polygon', coordinates: poly }; return geoArea(g) > 2 * Math.PI ? poly.map(r => r.reverse()) : poly; })
      .filter(poly => geoArea({ type: 'Polygon', coordinates: poly }) > 3e-7);
    if (coordinates.length) features.push({ type: 'Feature', bbox, properties: { kind: 'relief', map, min: c.value, source: SOURCE }, geometry: { type: 'MultiPolygon', coordinates } });
  }
  let max = -Infinity; for (const v of values) max = Math.max(max, v);
  console.log(`${map}: ${nx} x ${ny} grid, highest ${Math.round(max)} m, ${edits.length} edit(s)`);
}
fs.writeFileSync(path.join(dir, 'relief.json'), JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`layers/${key}/relief.json: ${features.length} bands, ${(fs.statSync(path.join(dir, 'relief.json')).size / 1024).toFixed(0)} KB`);
