// A city drawn in OpenStreetMap's own format: layers/<layer>/cities/*.osm, as JOSM edits them (a
// plain local file: the root's upload="never" keeps JOSM from offering to send it to OpenStreetMap).
// Coordinates are Earth's, as on OpenStreetMap, and src/globe.mjs remaps them like any Earth shape.
//
// An element tagged `cairn:id=<ResourceID>` is that place's geometry: the entry itself (its name,
// description, what it lies within) stays in the layer's place.csv. Everything else is drawing:
// streets, buildings, water, walls, ground, which the explorer draws under the places once a map is
// zoomed in close, from the layer's city.json. OpenStreetMap's tags say what each is
// (https://wiki.openstreetmap.org/wiki/Map_features); `classify` below reads the ones it draws.

// The elements of an .osm file: nodes, ways and relations with their tags. A small reader for
// what JOSM writes (attributes in any order, entities in values), not a general XML parser.
export function parseOsm(xml, where) {
  const attrs = s => Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], unescape(m[2] ?? m[3])]));
  const tagsOf = body => Object.fromEntries([...body.matchAll(/<tag\b([^>]*?)\/?>/g)].map(m => attrs(m[1])).map(a => [a.k, a.v]));
  const live = a => a.action !== 'delete' && a.visible !== 'false';
  const nodes = new Map(), ways = new Map(), relations = new Map();
  for (const m of xml.matchAll(/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const a = attrs(m[1]);
    if (!live(a)) continue;
    const lon = Number(a.lon), lat = Number(a.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`${where}: node ${a.id} has no lon/lat`);
    nodes.set(a.id, { id: a.id, c: [lon, lat], tags: tagsOf(m[2] ?? '') });
  }
  for (const m of xml.matchAll(/<way\b([^>]*?)>([\s\S]*?)<\/way>/g)) {
    const a = attrs(m[1]);
    if (!live(a)) continue;
    const refs = [...m[2].matchAll(/<nd\b[^>]*?ref\s*=\s*["']([^"']+)["']/g)].map(x => x[1]);
    const missing = refs.find(r => !nodes.has(r));
    if (missing) throw new Error(`${where}: way ${a.id} names node ${missing}, which is not in the file`);
    ways.set(a.id, { id: a.id, refs, tags: tagsOf(m[2]) });
  }
  for (const m of xml.matchAll(/<relation\b([^>]*?)>([\s\S]*?)<\/relation>/g)) {
    const a = attrs(m[1]);
    if (!live(a)) continue;
    const members = [...m[2].matchAll(/<member\b([^>]*?)\/?>/g)].map(x => attrs(x[1]));
    relations.set(a.id, { id: a.id, members, tags: tagsOf(m[2]) });
  }
  return { nodes, ways, relations };
}
const unescape = s => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()]
  ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));

// Tags that make a closed way an area rather than a loop of line (OpenStreetMap's own convention,
// in short): a building, water, land use, a park or a place is an area; a street that closes on
// itself (a square's ring road) is still a line unless it says area=yes.
const AREA_KEYS = ['building', 'landuse', 'leisure', 'natural', 'amenity', 'place', 'boundary', 'man_made', 'historic', 'water', 'area:highway'];
// A canal or river drawn as a closed outline (its banks) says area=yes; a dock or riverbank is
// always an area.
const isArea = (tags, closed) => closed && tags.area !== 'no'
  && (tags.area === 'yes' || AREA_KEYS.some(k => k in tags) || tags.waterway === 'dock' || tags.waterway === 'riverbank');

// Every element worth a geometry, as { kind: 'node'|'way'|'relation', id, tags, geometry } in
// Earth's longitude and latitude. Nodes with no tags are only the corners of ways.
export function osmFeatures({ nodes, ways, relations }, where) {
  const out = [], inRelation = new Set();
  const line = w => w.refs.map(r => nodes.get(r).c);
  for (const r of relations.values()) {
    if (r.tags.type !== 'multipolygon' && r.tags.type !== 'boundary') continue;
    const rings = role => joinRings(r.members.filter(m => m.type === 'way' && (m.role || 'outer') === role && ways.has(m.ref)).map(m => line(ways.get(m.ref))), `${where}: relation ${r.id}`);
    const outers = rings('outer'), inners = rings('inner');
    for (const m of r.members) if (m.type === 'way' && !Object.keys(ways.get(m.ref)?.tags ?? {}).length) inRelation.add(m.ref);
    if (!outers.length) continue;
    // Each hole goes to the outer ring that holds its first corner.
    const polys = outers.map(o => [o]);
    for (const i of inners) (polys.find(p => inRing(i[0], p[0])) ?? polys[0]).push(i);
    out.push({ kind: 'relation', id: r.id, tags: r.tags, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } });
  }
  for (const w of ways.values()) {
    if (inRelation.has(w.id) || !Object.keys(w.tags).length) continue;
    const c = line(w), closed = c.length > 3 && w.refs[0] === w.refs[w.refs.length - 1];
    if (c.length < 2) continue;
    out.push({ kind: 'way', id: w.id, tags: w.tags, geometry: isArea(w.tags, closed) ? { type: 'Polygon', coordinates: [c] } : { type: 'LineString', coordinates: c } });
  }
  for (const n of nodes.values()) if (Object.keys(n.tags).length) out.push({ kind: 'node', id: n.id, tags: n.tags, geometry: { type: 'Point', coordinates: n.c } });
  return out;
}

// Ways joined end to end into closed rings (a multipolygon's outer edge is often several ways).
function joinRings(lines, where) {
  const left = lines.map(l => [...l]), rings = [];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  while (left.length) {
    let ring = left.shift();
    while (!same(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const i = left.findIndex(l => same(l[0], end) || same(l[l.length - 1], end));
      if (i < 0) throw new Error(`${where}: a ring does not close`);
      const [next] = left.splice(i, 1);
      ring = ring.concat((same(next[0], end) ? next : next.reverse()).slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// What the explorer draws an element as, from its tags; null for what it does not draw. Areas
// are filled, lines stroked; the classes are drawn in this order, ground first.
export const CITY_CLASSES = ['ground', 'green', 'water', 'under', 'path', 'street', 'major', 'rail', 'wall', 'building'];
const GREEN = /^(park|garden|grass|cemetery|grave_yard|wood|forest|meadow|orchard|allotments|village_green|recreation_ground|scrub|heath)$/;
const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
const PATH = /^(footway|path|steps|pedestrian|cycleway|track|bridleway|corridor)$/;
export function classify(tags, type) {
  const area = type === 'Polygon' || type === 'MultiPolygon';
  // Underground (a tunnel, a cellar's passage): drawn faint, under the streets.
  if (!area && (tags.tunnel === 'yes' || Number(tags.layer) < 0) && (tags.highway || tags.railway)) return 'under';
  if (tags.building) return area ? 'building' : null;
  if (tags.natural === 'water' || tags.water || tags.landuse === 'basin' || tags.landuse === 'reservoir' || tags.leisure === 'marina' || tags.waterway === 'dock' || tags.waterway === 'riverbank') return area ? 'water' : null;
  if (tags.waterway) return 'water';
  if (tags.railway || tags.aerialway) return area ? null : 'rail';
  if (tags.barrier === 'city_wall' || tags.barrier === 'wall' || tags.historic === 'city_walls') return 'wall';
  if (tags.highway) return area ? 'ground' : MAJOR.test(tags.highway) ? 'major' : PATH.test(tags.highway) ? 'path' : 'street';
  if (tags.man_made === 'bridge' || tags.bridge) return area ? 'ground' : 'street';
  if (GREEN.test(tags.leisure ?? '') || GREEN.test(tags.landuse ?? '') || GREEN.test(tags.natural ?? '') || tags.amenity === 'grave_yard') return area ? 'green' : null;
  if (tags.landuse || tags.amenity || tags.leisure || tags.place === 'square') return area ? 'ground' : null;
  return null;
}
