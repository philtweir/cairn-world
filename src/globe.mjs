// Place a universe on its globe: `npm run globe -- <layer>`.
//
// A universe can be Earth remapped: its globe is real geography turned to a new pole and seam,
// then stretched. layers/<layer>/layer.json `globe.remap` gives that remap; this script repeats it
// (the same steps as the universe's own globe page) and writes, in that globe's longitude and
// latitude:
//
//   - the `geometry` column of layers/<layer>/data/place.csv, for every place listed in
//     layers/<layer>/globe.csv, from what it is on Earth (countries, or a point) or where it is on
//     one of the layer's regional maps (`globe.maps`, each pinned to the globe at one point);
//   - layers/<layer>/basemap.json, the globe's land, which the explorer draws under its maps: the
//     places' Earth shapes together, and nothing else, so the world is only its named lands.
//
// globe.csv columns: ResourceID, earth (Natural Earth country names joined by "|", each with an
// optional band of longitude, "Russia@24:60", for a realm that is part of a country; or WKT in
// Earth's longitude and latitude), map ("<map> POINT (x y)" in that map's units, x east and y
// south), note. A place with neither keeps no geometry. Natural Earth data is public domain;
// it comes from the world-atlas package (a dev dependency: the site never needs it).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoProjection, geoRotation, geoDistance, geoArea, geoIdentity } from 'd3-geo';
import { geoProject } from 'd3-geo-projection';
import { feature } from 'topojson-client';
import polygonClipping from 'polygon-clipping';
import { parseCsv, toCsv } from './csv.mjs';
import { wktToGeometry } from './geometry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const atlas = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/world-atlas', name), 'utf8'));
const deg = Math.PI / 180;

// The globe's remap, as a d3 projection whose output is the globe's [longitude, -latitude].
// Earth is turned so `pole` becomes the globe's north pole and `seam` lies on its 180th meridian,
// drawn in Mercator, scaled to fill the Earth's land extent, then squeezed: longitudes by
// `eastWest`, southern latitudes by `south`. d3 cuts geometry along the seam, so nothing that
// crosses it is drawn the long way round.
export function makeRemap({ pole, seam, south, eastWest }) {
  const rotate = solveRotation(pole, seam);
  const mercator = geoProjection((l, p) => [l, Math.log(Math.tan(Math.PI / 4 + p / 2))]).rotate(rotate).scale(100).translate([0, 0]);
  // The land's extent in that Mercator sets the scale (as the globe page measures it).
  const land = feature(atlas('countries-110m.json'), atlas('countries-110m.json').objects.countries);
  const sing = geoRotation(rotate).invert([0, 90]);
  let xmin = Infinity, xmax = -Infinity, ymax = 0;
  for (const f of land.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const ring of polys.flat()) for (const pt of ring) {
      if (geoDistance(pt, sing) < 2 * deg) continue;
      const [x, y] = mercator(pt);
      if (!isFinite(x) || !isFinite(y)) continue;
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymax = Math.max(ymax, Math.abs(y));
    }
  }
  const RX = (xmax - xmin) / 2 / Math.PI, RY = ymax / Math.log(Math.tan(Math.PI / 4 + 85 * deg / 2));
  // Rotated Earth (radians) -> globe (radians).
  const raw = (l, p) => {
    const x = 100 * l, y = -100 * Math.log(Math.tan(Math.PI / 4 + p / 2));
    const lon = ((((x / RX) / deg) + 540) % 360 - 180) * eastWest;
    let lat = (2 * Math.atan(Math.exp(-y / RY)) - Math.PI / 2) / deg;
    if (lat < 0) lat *= south;
    return [lon * deg, lat * deg];
  };
  const projection = geoProjection(raw).rotate(rotate).scale(1 / deg).translate([0, 0]).precision(0);
  const toGlobe = ([lon, lat]) => { const [x, y] = projection([lon, lat]); return [x, -y]; };
  // A GeoJSON object in Earth's coordinates -> the same in the globe's.
  const project = obj => flipY(geoProject(obj, projection));
  return { rotate, toGlobe, project };
}

// The rotation that takes `pole` to the north pole and `seam` to longitude 180.
function solveRotation([pl, pa], [sl, sa]) {
  const ang = (a, b) => geoDistance(a, b) / deg;
  const cost = r => { const rot = geoRotation(r); return ang(rot.invert([0, 90]), [pl, pa]) + Math.abs(180 - Math.abs(rot([sl, sa])[0])); };
  // A coarse grid of starting points, then a pattern search from the best few.
  const starts = [];
  for (let a = -180; a < 180; a += 30) for (let b = -180; b < 180; b += 30) for (let c = -180; c < 180; c += 30) starts.push([a, b, c]);
  let x = null, fx = Infinity;
  for (let y of starts.sort((p, q) => cost(p) - cost(q)).slice(0, 8)) {
    let fy = cost(y), step = 15;
    for (let it = 0; it < 20000 && step > 1e-10; it++) {
      let better = false;
      for (let i = 0; i < 3; i++) for (const d of [step, -step]) { const z = y.slice(); z[i] += d; const fz = cost(z); if (fz < fy) { y = z; fy = fz; better = true; } }
      if (!better) step /= 2;
    }
    if (fy < fx) { x = y; fx = fy; }
  }
  if (fx > 1e-6) throw new Error(`could not solve the globe's rotation (residual ${fx})`);
  return x;
}

// d3 projections put y downwards; the globe's latitude is upwards.
function flipY(obj) {
  const walk = c => (typeof c[0] === 'number' ? [c[0], -c[1]] : c.map(walk));
  if (obj.type === 'FeatureCollection') return { ...obj, features: obj.features.map(flipY) };
  if (obj.type === 'Feature') return { ...obj, geometry: obj.geometry && flipY(obj.geometry) };
  return { ...obj, coordinates: walk(obj.coordinates) };
}

// Round coordinates (and drop repeated positions it creates) to keep files small.
function round(geom, places) {
  const k = 10 ** places, r = v => Math.round(v * k) / k;
  const line = ps => ps.map(p => [r(p[0]), r(p[1])]).filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  switch (geom.type) {
    case 'Point': return { type: 'Point', coordinates: geom.coordinates.map(r) };
    case 'MultiPoint': case 'LineString': return { ...geom, coordinates: line(geom.coordinates) };
    case 'Polygon': case 'MultiLineString': return { ...geom, coordinates: geom.coordinates.map(line).filter(x => x.length >= 4 || geom.type !== 'Polygon') };
    case 'MultiPolygon': return { ...geom, coordinates: geom.coordinates.map(p => p.map(line).filter(x => x.length >= 4)).filter(p => p.length) };
    default: return geom;
  }
}
// Only polygons above a minimum area (steradians) survive: specks of islands are noise at this scale.
function dropSpecks(geom, min) {
  if (geom.type === 'Polygon') return geoArea(geom) >= min ? geom : null;
  if (geom.type !== 'MultiPolygon') return geom;
  const keep = geom.coordinates.filter(p => geoArea({ type: 'Polygon', coordinates: p }) >= min);
  return keep.length ? { type: 'MultiPolygon', coordinates: keep } : null;
}

const wkt = g => {
  const pos = p => `${p[0]} ${p[1]}`;
  const list = (c, d) => (d === 0 ? pos(c) : `(${c.map(x => list(x, d - 1)).join(', ')})`);
  const depth = { Point: 0, LineString: 1, MultiPoint: 1, Polygon: 2, MultiLineString: 2, MultiPolygon: 3 }[g.type];
  return `${g.type.toUpperCase()} ${depth === 0 ? `(${pos(g.coordinates)})` : list(g.coordinates, depth)}`;
};

// A point on a regional map -> the globe: the map is drawn north-up, `kmPerUnit` to a unit, with
// `anchor.at` (map units) at `anchor.earth` (Earth's coordinates, remapped like everything else).
function mapToGlobe(map, remap, [x, y]) {
  const [lon0, lat0] = remap.toGlobe(map.anchor.earth);
  const km = 6371 * deg;   // per degree of latitude
  const east = (x - map.anchor.at[0]) * map.kmPerUnit, north = -(y - map.anchor.at[1]) * map.kmPerUnit;
  return [lon0 + east / (km * Math.cos(lat0 * deg)), lat0 + north / km];
}

// A realm's shape on Earth, from Natural Earth countries: "France|Italy", or "Russia@24:60" for the
// part of a country between two longitudes (east of 180 continues past it: "Russia@105:200").
// Unioned into one outline (planar, in degrees: fine away from the poles). Returns MultiPolygon
// coordinates wound as GeoJSON has them (outer rings anticlockwise).
function earthShape(topo, spec, where) {
  const byName = new Map(topo.objects.countries.geometries.map(g => [g.properties.name, g]));
  const parts = spec.split('|').map(s => s.trim()).map(part => {
    const m = /^(.+?)(?:@(-?[\d.]+):(-?[\d.]+))?$/.exec(part);
    const g = byName.get(m[1]);
    if (!g) throw new Error(`${where}: no country "${m[1]}" in Natural Earth (world-atlas)`);
    // A ring that crosses the 180th meridian (Russia's, through Chukotka) jumps from +180 to
    // -180: nothing on the sphere, but an edge right across the plane. Unwrap it first, so its
    // longitudes run on past 180 (Chukotka is 180 to 190); bands are written that way too.
    const unwrap = ring => (Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])) > 180 ? ring.map(([x, y]) => [x < 0 ? x + 360 : x, y]) : ring);
    const geom = feature(topo, g).geometry;
    const coords = (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).map(poly => poly.map(unwrap));
    if (m[2] === undefined) return coords;
    const [x0, x1] = [Number(m[2]), Number(m[3])];
    return polygonClipping.intersection(coords, [[[x0, -90], [x1, -90], [x1, 90], [x0, 90], [x0, -90]]]);
  });
  const out = polygonClipping.union(...parts);
  if (!out.length) throw new Error(`${where}: "${spec}" is empty`);
  return out;
}
// d3-geo takes a ring's inside to be on its right (outer rings clockwise): the reverse of GeoJSON.
const forD3 = mp => ({ type: 'MultiPolygon', coordinates: mp.map(poly => poly.map(ring => [...ring].reverse())) });

// ---- main --------------------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const key = process.argv[2];
  if (!key) { console.error('usage: npm run globe -- <layer>'); process.exit(1); }
  const dir = path.join(ROOT, 'layers', key);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
  if (!settings.globe?.remap) { console.error(`layers/${key}/layer.json has no globe.remap`); process.exit(1); }
  const remap = makeRemap(settings.globe.remap);
  const maps = settings.globe.maps ?? {};

  const countries = atlas('countries-110m.json'), countriesDetail = atlas('countries-50m.json');

  // What each place is: Earth's countries or a WKT shape, or a point on a regional map.
  const rows = parseCsv(fs.readFileSync(path.join(dir, 'globe.csv'), 'utf8'));
  const head = rows[0], col = n => head.indexOf(n);
  const geometryOf = new Map();
  for (const r of rows.slice(1).filter(r => r[0])) {
    const [id, earth, onMap] = [r[0], r[col('earth')] ?? '', r[col('map')] ?? ''];
    let g = null;
    if (onMap) {
      const m = /^(\S+)\s+(.*)$/.exec(onMap);
      const map = m && maps[m[1]];
      if (!map) throw new Error(`globe.csv ${id}: no map "${m?.[1]}" in globe.maps`);
      const pt = wktToGeometry(m[2]);
      if (pt.type !== 'Point') throw new Error(`globe.csv ${id}: a map position is a POINT`);
      g = round({ type: 'Point', coordinates: mapToGlobe(map, remap, pt.coordinates) }, 3);
    } else if (/^[A-Z]+\s*\(/.test(earth)) {
      g = round(remap.project(wktToGeometry(earth)), 3);
    } else if (earth) {
      g = round(dropSpecks(remap.project(forD3(earthShape(countries, earth, `globe.csv ${id}`))), 2e-6), 2);
    }
    if (g) geometryOf.set(id, g);
  }

  // Write the geometry column, leaving every other cell as it is.
  const placeFile = path.join(dir, 'data', 'place.csv');
  const place = parseCsv(fs.readFileSync(placeFile, 'utf8'));
  let gcol = place[0].indexOf('geometry');
  if (gcol < 0) { gcol = place[0].length; place[0].push('geometry'); }
  const known = new Set(place.slice(1).map(r => r[0]));
  for (const id of geometryOf.keys()) if (!known.has(id)) throw new Error(`globe.csv lists "${id}", which is not in ${path.relative(ROOT, placeFile)}`);
  for (const r of place.slice(1)) { while (r.length < place[0].length) r.push(''); r[gcol] = geometryOf.has(r[0]) ? wkt(geometryOf.get(r[0])) : ''; }
  fs.writeFileSync(placeFile, toCsv(place));

  // The globe's land, for the explorer to draw under its maps: every place's Earth shape together,
  // and nothing more, so the land is the world's named lands. Natural Earth 1:110m for the whole
  // globe, and 1:50m around each regional map (3 degrees beyond its places), which the explorer
  // draws there instead.
  const specs = rows.slice(1).filter(r => r[0] && r[col('earth')] && !/^[A-Z]+\s*\(/.test(r[col('earth')])).map(r => r[col('earth')]).join('|');
  const landAt = topo => forD3(earthShape(topo, specs, 'basemap'));
  const source = scale => `Natural Earth 1:${scale} countries (public domain): the named lands only, remapped`;
  const features = [{ type: 'Feature', properties: { kind: 'land', source: source('110m') },
    geometry: dropSpecks(round(remap.project(landAt(countries)), 2), 2e-6) }];
  const detailed = remap.project(landAt(countriesDetail));
  const geomOf = x => (x.type === 'FeatureCollection' ? x.features[0]?.geometry : x.type === 'Feature' ? x.geometry : x);
  for (const [name] of Object.entries(maps)) {
    const pts = rows.slice(1).filter(r => (r[col('map')] ?? '').startsWith(`${name} `)).map(r => geometryOf.get(r[0]).coordinates);
    if (!pts.length) continue;
    const bbox = [Math.min(...pts.map(p => p[0])) - 3, Math.min(...pts.map(p => p[1])) - 3, Math.max(...pts.map(p => p[0])) + 3, Math.max(...pts.map(p => p[1])) + 3].map(v => Math.round(v * 100) / 100);
    // A plain rectangle in longitude and latitude: small enough here to clip as if flat.
    const clipped = flipY(geoProject(flipY(detailed), geoIdentity().reflectY(false).clipExtent([[bbox[0], -bbox[3]], [bbox[2], -bbox[1]]])));
    features.push({ type: 'Feature', bbox, properties: { kind: 'land-detail', map: name, source: source('50m') }, geometry: round(geomOf(clipped), 3) });
  }
  fs.writeFileSync(path.join(dir, 'basemap.json'), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`layers/${key}: ${geometryOf.size} place geometries; basemap ${(fs.statSync(path.join(dir, 'basemap.json')).size / 1024).toFixed(0)} KB`);
}
