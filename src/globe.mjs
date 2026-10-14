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
// south; or a LINESTRING or POLYGON in those units, for a road or a region), note. A place with
// neither keeps no geometry. `globe.dry` in layer.json lists places with no rivers or lakes (a
// desert, say): Natural Earth's rivers stop at their edge, and their lakes go. Natural Earth data
// is public domain; it comes from the world-atlas package (a dev dependency: the site never needs
// it). `globe.water` lists the places meant to be in the water (a sea, a lake, rocks off a coast):
// every other place given a position must be on the drawn land, or the script stops.
//
// A campaign layer's layer.json can say `globe.on: <universe>`: its places go on that universe's
// globe and regional maps (plus any `globe.maps` of its own), and only its place.csv is written.
//
// A layer can also hold cities drawn in OpenStreetMap's format, layers/<layer>/cities/*.osm (see
// src/osm.mjs): an element tagged cairn:id is that place's geometry, as if globe.csv gave it as an
// Earth shape, and the rest (streets, buildings, water) is written to layers/<layer>/city.json,
// remapped, for the explorer to draw under the places when a map is zoomed in close.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsm, osmFeatures, classify, CITY_CLASSES } from './osm.mjs';
import { fabric } from './fabric.mjs';
import { execFileSync } from 'node:child_process';
import { geoProjection, geoMercator, geoRotation, geoDistance, geoArea, geoIdentity, geoContains, geoCentroid, geoBounds } from 'd3-geo';
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
  const project = obj => { const g = geoProject(obj, projection); return g && flipY(g); };   // null if nothing is left after the seam cut
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
export function mapToGlobe(map, remap, [x, y]) {
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
// A Natural Earth GeoJSON file (public domain), fetched once into .cache/natural-earth/.
function naturalEarth(name) {
  const file = path.join(ROOT, '.cache', 'natural-earth', name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync('curl', ['-sfL', '--retry', '3', '-o', file, `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${name}`]);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const ADMIN1 = 'ne_10m_admin_1_states_provinces.geojson';
let admin1 = null;
const partitions = new Map();
function regionsOf(topo, country, coords, select, where) {
  const key = `${topo.arcs.length}:${country}`;
  if (!partitions.has(key)) {
    admin1 ??= naturalEarth(ADMIN1).features;
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
// A (Multi)Polygon in Earth's coordinates wound as d3 takes it, however it was drawn: each outline
// clockwise, so its inside is the smaller side, and each hole the other way.
function windForD3(g) {
  if (!/Polygon$/.test(g.type)) return g;
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(poly => poly.map((ring, i) => {
    const r = [...ring];
    return (geoArea({ type: 'Polygon', coordinates: [r] }) > 2 * Math.PI) !== (i > 0) ? r.reverse() : r;
  }));
  return g.type === 'Polygon' ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

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

// The places a layer puts on a map (or at an Earth point) that the drawn land does not hold: each
// is an error unless `globe.water` lists it (a sea, a lake). The drawn land is the basemap's 1:50m
// detail where a regional map has it, else its 1:110m land; the relief and rivers share its coast
// (src/terrain.mjs keeps Earth's), so a place on the land is on land in every drawing.
function offLand(features, positioned, water) {
  const detail = features.filter(f => /-detail$/.test(f.properties.kind) && /^(land|unnamed)/.test(f.properties.kind));
  const coarse = features.filter(f => f.properties.kind === 'land' || f.properties.kind === 'unnamed');
  const inBox = (b, [x, y]) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  const onLand = p => { const near = detail.filter(f => inBox(f.bbox, p)); return (near.length ? near : coarse).some(f => geoContains(f, p)); };
  const flat = c => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));
  return [...positioned].filter(([id]) => !water.includes(id)).flatMap(([id, g]) => {
    const off = flat(g.coordinates).filter(p => !onLand(p));
    return off.length ? [`${id}: ${off.length === 1 && g.type === 'Point' ? 'off the land' : `${off.length} of its ${flat(g.coordinates).length} points off the land`}`] : [];
  });
}
function checkLand(features, positioned, water, key) {
  const bad = offLand(features, positioned, water);
  if (!bad.length) return;
  console.error(`layers/${key}: places drawn in the sea (move them onto the land, or list a sea or lake in layer.json globe.water):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

// A shape small enough to keep: a geometry value may have at most 1,500 positions (@alizarin/geo's
// limit, which the build checks), so a larger one (a continent of many realms) is simplified, a
// little more each time, until it fits; rings that simplify away go.
const LIMIT = 1500;
function fitted(g) {
  const count = x => (typeof x[0] === 'number' ? 1 : x.reduce((n, y) => n + count(y), 0));
  if (!g || count(g.coordinates) <= LIMIT) return g;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (let tol = 0.02; ; tol *= 1.5) {
    const out = polys.map(poly => poly.map(r => simplifyLine(r, tol)).filter(r => r.length >= 4)).filter(poly => poly.length);
    if (count(out) <= LIMIT) return { type: 'MultiPolygon', coordinates: out };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const key = process.argv[2];
  if (!key) { console.error('usage: npm run globe -- <layer>'); process.exit(1); }
  const dir = path.join(ROOT, 'layers', key);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'layer.json'), 'utf8'));
  // A campaign set in a universe is placed on that universe's globe (`globe.on`), with its maps
  // (and any of its own): only its places' geometry is written, since the land is the universe's.
  const on = settings.globe?.on ?? null;
  const globe = on ? JSON.parse(fs.readFileSync(path.join(ROOT, 'layers', on, 'layer.json'), 'utf8')).globe : settings.globe;
  if (!globe?.remap) { console.error(on ? `layers/${on}/layer.json has no globe.remap` : `layers/${key}/layer.json has no globe.remap (or globe.on, the universe whose globe it is on)`); process.exit(1); }
  const remap = makeRemap(globe.remap);
  const maps = { ...(globe.maps ?? {}), ...(on ? settings.globe.maps ?? {} : {}) };

  const countries = atlas('countries-110m.json');

  // What each place is: Earth's countries or a WKT shape, or a point on a regional map.
  const readRows = file => {
    const [head, ...body] = parseCsv(fs.readFileSync(file, 'utf8'));
    return body.filter(r => r[0]).map(r => ({ id: r[0], earth: r[head.indexOf('earth')] ?? '', map: r[head.indexOf('map')] ?? '' }));
  };
  const rows = readRows(path.join(dir, 'globe.csv'));
  // The layer's cities: their places' shapes join the rows; the rest is drawing, for city.json.
  const cityDir = path.join(dir, 'cities'), cityDrawing = [], cityFeatures = new Map();
  for (const file of fs.existsSync(cityDir) ? fs.readdirSync(cityDir).filter(f => f.endsWith('.osm')).sort() : []) {
    const where = path.relative(ROOT, path.join(cityDir, file));
    const features = osmFeatures(parseOsm(fs.readFileSync(path.join(cityDir, file), 'utf8'), where), where);
    cityFeatures.set(file.replace(/\.osm$/, ''), features);
    for (const f of features) {
      const id = f.tags['cairn:id'];
      if (id) {
        if (rows.some(r => r.id === id)) throw new Error(`${where}: ${f.kind} ${f.id} is the shape of "${id}", which ${rows.find(r => r.id === id).osm ? 'another element' : 'globe.csv'} already gives`);
        rows.push({ id, earth: '', map: '', osm: f.geometry, where: `${where} ${f.kind} ${f.id}` });
      }
      // Drawn too if its tags say what it is (an entry that is also a building or a canal).
      if (f.geometry.type !== 'Point') {
        // A tagged node (a crane, a lock gate) is not drawn, only kept in the file.
        const cls = classify(f.tags, f.geometry.type);
        if (cls) cityDrawing.push({ cls, geometry: f.geometry });
      }
    }
  }
  const isWkt = earth => /^[A-Z]+\s*\(/.test(earth);
  const geometryOf = new Map(), positioned = new Map();
  const shapeOf = ({ id, earth, map: onMap, osm }) => {
    let g = null;
    if (onMap) {
      const m = /^(\S+)\s+(.*)$/.exec(onMap);
      const map = m && maps[m[1]];
      if (!map) throw new Error(`globe.csv ${id}: no map "${m?.[1]}" in globe.maps`);
      // A point on the map, or a shape (a forest, a road) drawn in the map's units.
      const shape = wktToGeometry(m[2]);
      const onGlobe = c => (typeof c[0] === 'number' ? mapToGlobe(map, remap, c) : c.map(onGlobe));
      // Rounded to about a tenth of the map's unit (a degree is about 111 km), and never coarser than 0.001 degrees: a city's
      // map (100 m a unit) keeps its canals' curves, where 0.001 degrees (about 100 m) would step them.
      g = round({ type: shape.type, coordinates: onGlobe(shape.coordinates) }, Math.max(3, Math.ceil(Math.log10(1113.2 / map.kmPerUnit))));
      // Wound as d3 (and the Earth shapes here) have it: an outline clockwise, a hole the other
      // way. However the map's ring was written, so its y running south does not matter.
      for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) {
        poly.forEach((ring, i) => { if ((geoArea({ type: 'Polygon', coordinates: [ring] }) > 2 * Math.PI) !== (i > 0)) ring.reverse(); });
      }
    } else if (osm || isWkt(earth)) {
      // Rounded to about a hundredth of its size, between 0.001 and 0.00001 degrees. A city's
      // outlines, drawn in JOSM, are wound however they were drawn: wound here as d3 has them.
      const w = remap.project(osm ? windForD3(osm) : wktToGeometry(earth));
      const [[x0, y0], [x1, y1]] = geoBounds(w), size = Math.max(x1 - x0, y1 - y0);
      g = round(w, size > 0 ? Math.min(5, Math.max(3, Math.ceil(Math.log10(100 / size)))) : 3);
    } else if (earth) {
      g = fitted(round(dropSpecks(remap.project(forD3(earthShape(countries, earth, `globe.csv ${id}`))), 2e-6), 2));
    }
    return g;
  };
  for (const r of rows) {
    const g = shapeOf(r);
    if (g) geometryOf.set(r.id, g);
    if (g && (r.map || r.osm || isWkt(r.earth))) positioned.set(r.id, g);
  }

  // Write the geometry column, leaving every other cell as it is.
  const placeFile = path.join(dir, 'data', 'place.csv');
  const place = parseCsv(fs.readFileSync(placeFile, 'utf8'));
  let gcol = place[0].indexOf('geometry');
  if (gcol < 0) { gcol = place[0].length; place[0].push('geometry'); }
  const known = new Set(place.slice(1).map(r => r[0]));
  for (const id of geometryOf.keys()) if (!known.has(id)) throw new Error(`${rows.find(r => r.id === id)?.where ?? 'globe.csv'} gives a shape for "${id}", which is not in ${path.relative(ROOT, placeFile)}`);
  for (const r of place.slice(1)) { while (r.length < place[0].length) r.push(''); r[gcol] = geometryOf.has(r[0]) ? wkt(geometryOf.get(r[0])) : ''; }
  const water = [...(globe.water ?? []), ...(on ? settings.globe.water ?? [] : [])];
  // Written only once the places are checked (below, for a universe, once its land is drawn).
  const writePlaces = basemap => { fs.writeFileSync(placeFile, toCsv(place)); writeCity(basemap); };
  // The cities' drawing, by class (src/osm.mjs's CITY_CLASSES, drawn in that order), areas and lines
  // apart: each a MultiPolygon or MultiLineString in the globe's coordinates, to about a metre.
  const cityFile = path.join(dir, 'city.json');
  // A city with a recipe for its fabric (cities/<city>.fabric.json, see src/fabric.mjs) has it grown
  // here, on the land drawn in the basemap, and drawn with the rest (already on the globe).
  const growFabric = basemap => {
    for (const file of fs.existsSync(cityDir) ? fs.readdirSync(cityDir).filter(f => f.endsWith('.fabric.json')).sort() : []) {
      const where = path.relative(ROOT, path.join(cityDir, file)), name = file.replace(/\.fabric\.json$/, '');
      const recipe = JSON.parse(fs.readFileSync(path.join(cityDir, file), 'utf8'));
      if (!cityFeatures.has(name)) throw new Error(`${where}: no ${name}.osm beside it, the city it is the fabric of`);
      const map = maps[recipe.map];
      if (!map) throw new Error(`${where}: no map "${recipe.map}" in globe.maps`);
      const detail = basemap.filter(f => /^(land|unnamed)-detail$/.test(f.properties.kind) && f.properties.map === recipe.map);
      const land = (detail.length ? detail : basemap.filter(f => /^(land|unnamed)$/.test(f.properties.kind))).map(f => f.geometry);
      const [lon0, lat0] = remap.toGlobe(map.anchor.earth), km = 6371 * deg;
      const toMap = ([lon, lat]) => [map.anchor.at[0] + (lon - lon0) * km * Math.cos(lat0 * deg) / map.kmPerUnit, map.anchor.at[1] - (lat - lat0) * km / map.kmPerUnit];
      // The map's heights, if src/terrain.mjs has kept them (a city's map does), for the slopes.
      const reliefFile = path.join(ROOT, 'layers', on ?? key, 'relief.json');
      const image = fs.existsSync(reliefFile) ? JSON.parse(fs.readFileSync(reliefFile, 'utf8')).images.find(i => i.name === `${recipe.map}-fine` && i.heights) : null;
      const heights = image && (raw => ({ grid: new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2), width: image.width, height: image.height, bbox: image.bbox, step: image.step }))(zlib.gunzipSync(fs.readFileSync(path.join(path.dirname(reliefFile), image.heights))));
      const { drawn, counts } = fabric({ recipe, hand: cityFeatures.get(name), places: geometryOf, land, map, toMap, toGlobe: p => mapToGlobe(map, remap, p), earthToGlobe: p => remap.toGlobe(p), heights, where });
      for (const f of drawn) { const cls = classify(f.tags, f.geometry.type); if (cls) cityDrawing.push({ cls, geometry: f.geometry, globe: true }); }
      const total = Object.values(counts).reduce((t, c) => ({ streets: t.streets + c.streets, buildings: t.buildings + c.buildings, gardens: t.gardens + c.gardens }), { streets: 0, buildings: 0, gardens: 0 });
      console.log(`${where}: ${total.streets} streets, ${total.buildings} buildings, ${total.gardens} gardens in ${Object.keys(counts).length} districts`);
    }
  };
  const writeCity = basemap => {
    growFabric(basemap);
    if (!cityDrawing.length) { fs.rmSync(cityFile, { force: true }); return; }
    const features = [];
    for (const cls of CITY_CLASSES) for (const area of [true, false]) {
      const parts = cityDrawing.filter(d => d.cls === cls && /Polygon$/.test(d.geometry.type) === area)
        .map(d => { const g = area ? windForD3(d.geometry) : d.geometry; return d.globe ? g : remap.project(g); }).filter(Boolean).map(g => round(g, 5))
        // A sliver rounded to nothing (a ring of fewer than four points, a line of one) is dropped.
        .filter(g => g.coordinates.length && (g.type !== 'LineString' || g.coordinates.length >= 2));
      if (!parts.length) continue;
      const coordinates = parts.flatMap(g => (g.type === 'Polygon' || g.type === 'LineString' ? [g.coordinates] : g.coordinates));
      const geometry = { type: area ? 'MultiPolygon' : 'MultiLineString', coordinates };
      const [[x0, y0], [x1, y1]] = geoBounds(geometry);
      features.push({ type: 'Feature', bbox: [x0, y0, x1, y1].map(v => Math.round(v * 1e5) / 1e5), properties: { kind: 'city', class: cls, area }, geometry });
    }
    fs.writeFileSync(cityFile, JSON.stringify({ type: 'FeatureCollection', features }));
    console.log(`layers/${key}/city.json: ${cityDrawing.length} drawn elements, ${(fs.statSync(cityFile).size / 1024).toFixed(0)} KB`);
  };
  // A layer on a universe's globe whose places have no Earth shapes of their own (a campaign's
  // points) is drawn on the universe's land. One that names lands of its own (an era's realms) gets
  // its own basemap: the universe's places and its own together, so its named lands are drawn as
  // named in its views, and in an era without them the same land is unnamed.
  const ownLands = on && rows.some(r => r.earth && !isWkt(r.earth));
  if (on && !ownLands) {
    const land = JSON.parse(fs.readFileSync(path.join(ROOT, 'layers', on, 'basemap.json'), 'utf8')).features;
    checkLand(land, positioned, water, key);
    writePlaces(land);
    console.log(`layers/${key}: ${geometryOf.size} place geometries, on the globe of ${on}`);
    process.exit(0);
  }
  const all = on ? [...readRows(path.join(ROOT, 'layers', on, 'globe.csv')), ...rows] : rows;
  const shapes = new Map([...all.filter(r => !geometryOf.has(r.id)).map(r => [r.id, shapeOf(r)]).filter(([, g]) => g), ...geometryOf]);

  // The globe's land, for the explorer to draw under its maps, in two kinds: `land`, every place's
  // Earth shape together (the world's named lands), and `unnamed`, the rest of Earth's land, which
  // no place claims and which the explorer draws fainter, so nothing is lost and nothing needs a
  // name. Natural Earth 1:110m for the whole globe, and 1:50m around each regional map (3 degrees
  // beyond its places), which the explorer draws there instead.
  const specs = all.filter(r => r.earth && !isWkt(r.earth)).map(r => r.earth).join('|');
  const geomOf = x => (x.type === 'FeatureCollection' ? x.features[0]?.geometry : x.type === 'Feature' ? x.geometry : x);
  const named = topo => remap.project(forD3(earthShape(topo, specs, 'basemap')));
  const unnamed = topo => asMulti(unnamedLand(topo, specs).map(g => geomOf(remap.project(g))));
  const source = (scale, which) => `Natural Earth 1:${scale} countries (public domain), remapped: ${which}`;
  const features = [
    { type: 'Feature', properties: { kind: 'land', source: source('110m', 'the named lands') }, geometry: dropSpecks(round(geomOf(named(countries)), 2), 2e-6) },
    { type: 'Feature', properties: { kind: 'unnamed', source: source('110m', 'land no place claims') }, geometry: dropSpecks(round(unnamed(countries), 2), 2e-6) },
  ];
  // A map's detailed coast is 1:50m unless it asks for 1:10m (`coast`: a city on its lough, say),
  // `margin` degrees beyond its places (3 unless it says). The 1:10m land is worked out only from
  // the countries near the map (the whole world at 1:10m is more than polygon-clipping can union),
  // so it suits a map of a small area.
  const COASTS = { '50m': 'countries-50m.json', '10m': 'countries-10m.json' };
  const topos = new Map(), detailedAt = new Map();
  const detailed = (coast, near) => {
    const key = `${coast} ${near ?? ''}`;
    if (detailedAt.has(key)) return detailedAt.get(key);
    if (!topos.has(coast)) topos.set(coast, atlas(COASTS[coast]));
    let topo = topos.get(coast), spec = specs;
    if (near) {
      const [x0, y0, x1, y1] = near;
      const meets = g => polysOf(feature(topo, g).geometry).some(poly => {
        const r = unwrapRing(poly[0]), xs = r.map(p => p[0]), ys = r.map(p => p[1]);
        return Math.min(...xs) <= x1 && Math.max(...xs) >= x0 && Math.min(...ys) <= y1 && Math.max(...ys) >= y0;
      });
      const kept = topo.objects.countries.geometries.filter(meets);
      const names = new Set(kept.map(g => g.properties.name));
      topo = { ...topo, objects: { ...topo.objects, countries: { ...topo.objects.countries, geometries: kept } } };
      spec = specs.split('|').filter(part => names.has(/^([^@#]+?)(?:[@#].*)?$/.exec(part.trim())[1])).join('|');
    }
    const out = { land: spec ? remap.project(forD3(earthShape(topo, spec, 'basemap'))) : null, unnamed: asMulti((spec ? unnamedLand(topo, spec) : [merge(topo, topo.objects.countries.geometries)]).map(g => geomOf(remap.project(g)))) };
    detailedAt.set(key, out);
    return out;
  };
  // The stretch of Earth (a longitude and latitude box, a degree wider) that a box on the globe covers.
  const earthBox = ([x0, y0, x1, y1]) => {
    const edge = Array.from({ length: 21 }, (_, i) => i / 20).flatMap(t => [[x0 + (x1 - x0) * t, y0], [x0 + (x1 - x0) * t, y1], [x0, y0 + (y1 - y0) * t], [x1, y0 + (y1 - y0) * t]]).map(p => remap.toEarth(p));
    return [Math.min(...edge.map(p => p[0])) - 1, Math.min(...edge.map(p => p[1])) - 1, Math.max(...edge.map(p => p[0])) + 1, Math.max(...edge.map(p => p[1])) + 1];
  };
  for (const [name, map] of Object.entries(maps)) {
    const { coast = '50m', margin = 3 } = map;
    if (!COASTS[coast]) throw new Error(`globe.maps.${name}.coast: "${coast}" is not one of ${Object.keys(COASTS).join(', ')}`);
    const flat = c => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));
    const pts = all.filter(r => r.map.startsWith(`${name} `)).flatMap(r => flat(shapes.get(r.id).coordinates));
    if (!pts.length) continue;
    const bbox = [Math.min(...pts.map(p => p[0])) - margin, Math.min(...pts.map(p => p[1])) - margin, Math.max(...pts.map(p => p[0])) + margin, Math.max(...pts.map(p => p[1])) + margin].map(v => Math.round(v * 100) / 100);
    for (const [kind, g] of Object.entries(detailed(coast, coast === '10m' ? earthBox(bbox) : null))) {
      if (!g) continue;
      // A plain rectangle in longitude and latitude: small enough here to clip as if flat.
      // (Nothing of a kind inside the box comes back as null.)
      const cut = geoProject(flipY(g), geoIdentity().reflectY(false).clipExtent([[bbox[0], -bbox[3]], [bbox[2], -bbox[1]]]));
      let clipped = cut && geomOf(flipY(cut));
      // On a fine-coast map, the water places with a shape (`globe.water`: a harbour channel, say)
      // are cut out of the land, so a ship's way in is drawn: the relief takes its sea from this too.
      const cuts = coast === '10m' ? water.map(w => shapes.get(w)).filter(w => w && /Polygon$/.test(w.type)).map(polysOf) : [];
      if (clipped && cuts.length) { const rest = polygonClipping.difference(polysOf(clipped), ...cuts); clipped = rest.length ? forD3(rest) : null; }
      const geometry = clipped && dropSpecks(round(clipped, coast === '10m' ? 4 : 3), 0);
      if (geometry) features.push({ type: 'Feature', bbox, properties: { kind: `${kind}-detail`, map: name, source: source(coast, kind === 'land' ? 'the named lands' : 'land no place claims') }, geometry });
    }
  }
  // Rivers and lakes: Natural Earth 1:50m, remapped, on every land (named or not). Rivers come in
  // three widths by Natural Earth's rank (`w` 3 is the greatest); the stretches drawn through lakes
  // ("lake centerlines") are left out. Each river is its own line, so the explorer can skip those
  // out of view; in a detailed area it draws the rivers src/terrain.mjs finds there instead.
  const lineOf = g => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []);
  const rivers = naturalEarth('ne_50m_rivers_lake_centerlines.geojson').features.filter(f => f.properties.featurecla === 'River');
  // The dry places: a river is cut where it crosses into one (the crossing found by halving the
  // stretch), and a lake goes if its middle is in one.
  // A dry place is one of the places here (by id) or a stretch of Earth (`{ "earth": spec }`), so a
  // desert can be dry in every era whatever its people call it.
  const dry = [...(globe.dry ?? []), ...(on ? settings.globe.dry ?? [] : [])].map(d => {
    if (typeof d === 'object') return round(dropSpecks(remap.project(forD3(earthShape(countries, d.earth, 'layer.json globe.dry'))), 2e-6), 2);
    if (!shapes.has(d)) throw new Error(`layer.json globe.dry lists "${d}", which globe.csv gives no shape`);
    return shapes.get(d);
  });
  const isDry = p => dry.some(g => geoContains(g, p));
  const wet = line => {
    if (!dry.length) return [line];
    const out = [];
    let cur = [];
    for (let i = 0; i < line.length; i++) {
      const inside = isDry(line[i]);
      if (i) {
        const was = isDry(line[i - 1]);
        if (was !== inside) {
          let [a, b] = was ? [line[i], line[i - 1]] : [line[i - 1], line[i]];   // a outside, b inside
          for (let k = 0; k < 16; k++) { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; if (isDry(m)) b = m; else a = m; }
          cur.push(a.map(v => Math.round(v * 100) / 100));
          if (inside) { if (cur.length >= 2) out.push(cur); cur = []; }
        }
      }
      if (!inside) cur.push(line[i]);
    }
    if (cur.length >= 2) out.push(cur);
    return out;
  };
  for (const w of [3, 2, 1]) {
    const lines = rivers.filter(f => (f.properties.scalerank <= 2 ? 3 : f.properties.scalerank <= 4 ? 2 : 1) === w)
      .flatMap(f => lineOf(geomOf(remap.project(f.geometry) ?? { type: 'none' })))
      .map(l => simplifyLine(l.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]), 0.03))
      .flatMap(wet)
      .filter(l => l.length >= 2);
    features.push({ type: 'Feature', properties: { kind: 'river', w, source: 'Natural Earth 1:50m rivers (public domain), remapped' }, geometry: { type: 'MultiLineString', coordinates: lines } });
  }
  // Lakes: water over land. Natural Earth winds them as d3 expects, but any read inside out is turned.
  const lakes = naturalEarth('ne_50m_lakes.geojson').features.flatMap(f => polysOf(geomOf(remap.project(f.geometry) ?? { type: 'none' })))
    .map(poly => poly.map(r => { const t = simplifyLine(r, 0.04); return t.length >= 4 ? t : r; }))
    .map(poly => (geoArea({ type: 'Polygon', coordinates: poly }) > 2 * Math.PI ? poly.map(r => [...r].reverse()) : poly))
    .filter(poly => !isDry(geoCentroid({ type: 'Polygon', coordinates: poly })));
  const lakeGeom = dropSpecks(round({ type: 'MultiPolygon', coordinates: lakes }, 2), 3e-6);
  if (lakeGeom) features.push({ type: 'Feature', properties: { kind: 'lake', source: 'Natural Earth 1:50m lakes (public domain), remapped' }, geometry: lakeGeom });
  checkLand(features, positioned, water, key);
  writePlaces(features);
  fs.writeFileSync(path.join(dir, 'basemap.json'), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`layers/${key}: ${geometryOf.size} place geometries; basemap ${(fs.statSync(path.join(dir, 'basemap.json')).size / 1024).toFixed(0)} KB`);
}
