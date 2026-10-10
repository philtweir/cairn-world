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
// optional box of longitude and latitude, "Russia@24:60" or "Norway@-20:40/74:85", for a realm
// that is part of a country; or WKT in
// Earth's longitude and latitude), map ("<map> POINT (x y)" in that map's units, x east and y
// south), note. A place with neither keeps no geometry. Natural Earth data is public domain;
// it comes from the world-atlas package (a dev dependency: the site never needs it).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { geoProjection, geoMercator, geoRotation, geoDistance, geoArea, geoIdentity } from 'd3-geo';
import { geoProject } from 'd3-geo-projection';
import { feature, merge } from 'topojson-client';
import polygonClipping from 'polygon-clipping';
import { topology } from 'topojson-server';
import { presimplify, quantile, simplify } from 'topojson-simplify';
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
  const mercator = geoMercator().rotate(rotate).scale(100).translate([0, 0]);
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
    // d3 cuts geometry at the seam in the rotated frame (exactly 180 degrees), which this scale
    // puts a hair past 180 (100 / RX is about 1.0005). Clamp that sliver onto the seam, as the
    // globe page clips it; wrapping it round would throw cut edges right across the globe.
    const lon = Math.max(-180, Math.min(180, (x / RX) / deg)) * eastWest;
    let lat = (2 * Math.atan(Math.exp(-y / RY)) - Math.PI / 2) / deg;
    if (lat < 0) lat *= south;
    return [lon * deg, lat * deg];
  };
  const projection = geoProjection(raw).rotate(rotate).scale(1 / deg).translate([0, 0]).precision(0);
  const toGlobe = ([lon, lat]) => { const [x, y] = projection([lon, lat]); return [x, -y]; };
  // The globe -> Earth: undo the squeezes, re-read as Mercator, and turn back.
  const toEarth = ([lon, lat]) => {
    const l = lon / eastWest * deg, p = (lat < 0 ? lat / south : lat) * deg;
    const x = l * RX, y = -RY * Math.log(Math.tan(Math.PI / 4 + p / 2));
    return mercator.invert([x, y]);
  };
  // A GeoJSON object in Earth's coordinates -> the same in the globe's.
  const project = obj => flipY(geoProject(obj, projection));
  return { rotate, toGlobe, toEarth, project };
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
// A polygon over half the sphere is one read inside out (a near-zero crumb whose winding d3 cannot
// tell), so it goes too.
function dropSpecks(geom, min) {
  const ok = coordinates => { const a = geoArea({ type: 'Polygon', coordinates }); return a >= min && a < 2 * Math.PI; };
  if (geom.type === 'Polygon') return ok(geom.coordinates) ? geom : null;
  if (geom.type !== 'MultiPolygon') return geom;
  const keep = geom.coordinates.filter(ok);
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
// part of a country between two longitudes (east of 180 continues past it: "Russia@105:200"), and
// optionally two latitudes: "Norway@-20:40/74:85" is Svalbard.
// Unioned into one outline (planar, in degrees: fine away from the poles). Returns MultiPolygon
// coordinates wound as GeoJSON has them (outer rings anticlockwise).
const unwrapRing = ring => (Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])) > 180 ? ring.map(([x, y]) => [x < 0 ? x + 360 : x, y]) : ring);
const polysOf = geom => (geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : []);

function earthShape(topo, spec, where) {
  const byName = new Map(topo.objects.countries.geometries.map(g => [g.properties.name, g]));
  const parts = spec.split('|').map(s => s.trim()).map(part => {
    const m = /^([^@#]+?)(?:@(-?[\d.]+):(-?[\d.]+)(?:\/(-?[\d.]+):(-?[\d.]+))?|#(.+))?$/.exec(part);
    if (!m) throw new Error(`${where}: cannot read "${part}"`);
    const g = byName.get(m[1]);
    if (!g) throw new Error(`${where}: no country "${m[1]}" in Natural Earth (world-atlas)`);
    // A ring that crosses the 180th meridian (Russia's, through Chukotka) jumps from +180 to
    // -180: nothing on the sphere, but an edge right across the plane. Unwrap it first, so its
    // longitudes run on past 180 (Chukotka is 180 to 190); bands are written that way too.
    const coords = polysOf(feature(topo, g).geometry).map(poly => poly.map(unwrapRing));
    if (m[6] !== undefined) return regionsOf(topo, m[1], coords.map(poly => poly.map(snapRing)), m[6], where);
    if (m[2] === undefined) return coords;
    const [x0, x1] = [Number(m[2]), Number(m[3])], [y0, y1] = m[4] === undefined ? [-90, 90] : [Number(m[4]), Number(m[5])];
    return polygonClipping.intersection(coords, [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]);
  });
  const out = polygonClipping.union(...parts);
  if (!out.length) throw new Error(`${where}: "${spec}" is empty`);
  return out;
}

// A country's first-level regions (states, provinces, Russia's federal subjects), from Natural
// Earth 1:10m admin-1, used to divide the country's own outline at this scale: its coast stays the
// country's, only the borders inside it come from the regions. The regions are made a topology and
// simplified together (so neighbours keep one shared border) and dissolved per selection; where the
// two datasets disagree along a coast, each leftover sliver goes to the nearest region.
// "Russia#Urals+Siberian-Buryat" is the regions named, by federal district (`region`) or by name,
// less those after "-".
const ADMIN1 = 'ne_10m_admin_1_states_provinces.geojson';
let admin1 = null;
const partitions = new Map();
function regionsOf(topo, country, coords, select, where) {
  const key = `${topo.arcs.length}:${country}`;
  if (!partitions.has(key)) {
    if (!admin1) {
      const file = path.join(ROOT, '.cache', 'natural-earth', ADMIN1);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        execFileSync('curl', ['-sfL', '--retry', '3', '-o', file, `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${ADMIN1}`]);
      }
      admin1 = JSON.parse(fs.readFileSync(file, 'utf8')).features;
    }
    const units = admin1.filter(f => f.properties.admin === country);
    if (!units.length) throw new Error(`${where}: no admin-1 regions for "${country}"`);
    let t = topology({ units: { type: 'FeatureCollection', features: units } }, 1e6);
    t = presimplify(t);
    t = simplify(t, quantile(t, 0.02));   // keep the most significant 2% of points: borders to a few km
    const geoms = t.objects.units.geometries;
    // A dissolved selection as plane coordinates, unwrapped across 180 like the country.
    const plane = gs => snapPolys(polysOf(merge(t, gs)).map(poly => poly.map(unwrapRing)));
    const all = plane(geoms);
    // Slivers of the country that no region covers, each with the region nearest to it.
    const near = geoms.map(g => ({ g, pts: polysOf(merge(t, [g])).flat(2).map(p => [p[0] < -90 ? p[0] + 360 : p[0], p[1]]).filter((_, i) => i % 4 === 0) }));
    const slivers = polygonClipping.difference(coords, all).map(poly => {
      const c = poly[0][Math.floor(poly[0].length / 2)];
      let best = null, bd = Infinity;
      for (const { g, pts } of near) for (const p of pts) { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2; if (d < bd) { bd = d; best = g; } }
      return { poly, unit: best.properties.name };
    });
    partitions.set(key, { geoms, plane, slivers });
  }
  const { geoms, plane, slivers } = partitions.get(key);
  const [inc, ...exc] = select.split('-');
  const match = n => { const hit = geoms.filter(g => g.properties.region === n || g.properties.name === n); if (!hit.length) throw new Error(`${where}: no region or district "${n}" in ${country}`); return hit; };
  const chosen = new Set(inc.split('+').flatMap(n => match(n.trim())));
  for (const n of exc) for (const g of match(n.trim())) chosen.delete(g);
  const names = new Set([...chosen].map(g => g.properties.name));
  return polygonClipping.union(polygonClipping.intersection(coords, plane([...chosen])), ...slivers.filter(x => names.has(x.unit)).map(x => [x.poly]));
}
const snapPolys = polys => polys.map(poly => poly.map(snapRing).filter(r => r.length >= 4)).filter(poly => poly.length);
// Coordinates snapped to a 1e-4 degree grid, with the repeats that makes dropped and the ring
// closed: polygon-clipping fails on near-coincident points otherwise.
function snapRing(ring) {
  const out = [];
  for (const [x, y] of ring) { const p = [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]; const q = out[out.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p); }
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
  return out;
}
// d3-geo takes a ring's inside to be on its right (outer rings clockwise): the reverse of GeoJSON.
const forD3 = mp => ({ type: 'MultiPolygon', coordinates: mp.map(poly => poly.map(ring => [...ring].reverse())) });

// The land no place claims: every country no spec names at all (dissolved by topojson, which
// works on the sphere), and what is left of a country only parts of which are named (Russia once
// its realms are cut out). Returns d3-wound geometries in Earth's coordinates.
function unnamedLand(topo, spec) {
  const parts = spec.split('|').map(s => s.trim()).map(part => /^([^@#]+?)(?:[@#](.*))?$/.exec(part));
  const whole = new Set(parts.filter(m => m[2] === undefined).map(m => m[1]));
  const banded = new Set(parts.filter(m => m[2] !== undefined).map(m => m[1]).filter(n => !whole.has(n)));
  const all = topo.objects.countries.geometries;
  const out = [merge(topo, all.filter(g => !whole.has(g.properties.name) && !banded.has(g.properties.name)))];
  for (const name of banded) {
    const own = parts.filter(m => m[1] === name).map(m => m[0]).join('|');
    // Crumbs where the parts' borders and the country's disagree by a hair are not land.
    const planar = poly => Math.abs(poly[0].reduce((a, p, i, r) => (i ? a + (r[i - 1][0] * p[1] - p[0] * r[i - 1][1]) : a), 0)) / 2;
    const rest = polygonClipping.difference(earthShape(topo, name, 'unnamed land'), earthShape(topo, own, 'unnamed land')).filter(poly => planar(poly) > 0.01);
    if (rest.length) out.push(forD3(rest));
  }
  return out;
}
// Several (Multi)Polygons as one MultiPolygon.
const asMulti = geoms => ({ type: 'MultiPolygon', coordinates: geoms.filter(Boolean).flatMap(g => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [])) });

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

  // The globe's land, for the explorer to draw under its maps, in two kinds: `land`, every place's
  // Earth shape together (the world's named lands), and `unnamed`, the rest of Earth's land, which
  // no place claims and which the explorer draws fainter, so nothing is lost and nothing needs a
  // name. Natural Earth 1:110m for the whole globe, and 1:50m around each regional map (3 degrees
  // beyond its places), which the explorer draws there instead.
  const specs = rows.slice(1).filter(r => r[0] && r[col('earth')] && !/^[A-Z]+\s*\(/.test(r[col('earth')])).map(r => r[col('earth')]).join('|');
  const geomOf = x => (x.type === 'FeatureCollection' ? x.features[0]?.geometry : x.type === 'Feature' ? x.geometry : x);
  const named = topo => remap.project(forD3(earthShape(topo, specs, 'basemap')));
  const unnamed = topo => asMulti(unnamedLand(topo, specs).map(g => geomOf(remap.project(g))));
  const source = (scale, which) => `Natural Earth 1:${scale} countries (public domain), remapped: ${which}`;
  const features = [
    { type: 'Feature', properties: { kind: 'land', source: source('110m', 'the named lands') }, geometry: dropSpecks(round(geomOf(named(countries)), 2), 2e-6) },
    { type: 'Feature', properties: { kind: 'unnamed', source: source('110m', 'land no place claims') }, geometry: dropSpecks(round(unnamed(countries), 2), 2e-6) },
  ];
  const detailed = { land: named(countriesDetail), unnamed: unnamed(countriesDetail) };
  for (const [name] of Object.entries(maps)) {
    const pts = rows.slice(1).filter(r => (r[col('map')] ?? '').startsWith(`${name} `)).map(r => geometryOf.get(r[0]).coordinates);
    if (!pts.length) continue;
    const bbox = [Math.min(...pts.map(p => p[0])) - 3, Math.min(...pts.map(p => p[1])) - 3, Math.max(...pts.map(p => p[0])) + 3, Math.max(...pts.map(p => p[1])) + 3].map(v => Math.round(v * 100) / 100);
    for (const [kind, g] of Object.entries(detailed)) {
      // A plain rectangle in longitude and latitude: small enough here to clip as if flat.
      // (Nothing of a kind inside the box comes back as null.)
      const cut = geoProject(flipY(g), geoIdentity().reflectY(false).clipExtent([[bbox[0], -bbox[3]], [bbox[2], -bbox[1]]]));
      const clipped = cut && geomOf(flipY(cut));
      const geometry = clipped && dropSpecks(round(clipped, 3), 0);
      if (geometry) features.push({ type: 'Feature', bbox, properties: { kind: `${kind}-detail`, map: name, source: source('50m', kind === 'land' ? 'the named lands' : 'land no place claims') }, geometry });
    }
  }
  fs.writeFileSync(path.join(dir, 'basemap.json'), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`layers/${key}: ${geometryOf.size} place geometries; basemap ${(fs.statSync(path.join(dir, 'basemap.json')).size / 1024).toFixed(0)} KB`);
}
