// Geometry cells. A place's geometry (P168 place is defined by, an E94 Space Primitive) is stored
// as a GeoJSON FeatureCollection, Alizarin's geojson-feature-collection datatype. Authors may
// write it in a CSV cell as WKT, which reads far better there (`POINT (24.5 42.3)`), or as GeoJSON.
// Coordinates are longitude then latitude, in degrees, in the world's own frame (for Bith na Bró,
// its globe; see src/globe.mjs).

const TYPES = {
  POINT: 'Point', LINESTRING: 'LineString', POLYGON: 'Polygon',
  MULTIPOINT: 'MultiPoint', MULTILINESTRING: 'MultiLineString', MULTIPOLYGON: 'MultiPolygon',
};
// How deep each type's coordinates nest: a Point is [x, y], a Polygon [[[x, y], ...], ...].
const DEPTH = { Point: 0, LineString: 1, MultiPoint: 1, Polygon: 2, MultiLineString: 2, MultiPolygon: 3 };

// WKT text -> GeoJSON geometry. Throws on anything it does not understand.
export function wktToGeometry(text) {
  const m = /^\s*([A-Za-z]+)\s*(\(.*\))\s*$/s.exec(text);
  const type = m && TYPES[m[1].toUpperCase()];
  if (!type) throw new Error(`not WKT this build reads (${Object.keys(TYPES).join(', ')})`);
  const tokens = m[2].match(/\(|\)|,|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  let at = 0;
  // A list in parentheses: of positions ("x y, x y") or of further lists.
  const list = () => {
    if (tokens[at++] !== '(') throw new Error('expected "("');
    const out = [];
    for (;;) {
      if (tokens[at] === '(') out.push(list());
      else { const pos = []; while (tokens[at] && !'(),'.includes(tokens[at])) pos.push(Number(tokens[at++])); out.push(pos); }
      const t = tokens[at++];
      if (t === ')') return out;
      if (t !== ',') throw new Error('expected "," or ")"');
    }
  };
  let coords = list();
  if (at !== tokens.length) throw new Error('unexpected text after the geometry');
  // MULTIPOINT may be written "(1 2, 3 4)" or "((1 2), (3 4))".
  if (type === 'MultiPoint') coords = coords.map(c => (Array.isArray(c[0]) ? c[0] : c));
  if (type === 'Point') coords = coords[0];
  const depthOf = c => (Array.isArray(c[0]) ? 1 + depthOf(c[0]) : 0);
  if (depthOf(coords) !== DEPTH[type]) throw new Error(`${type} has the wrong nesting of parentheses`);
  return { type, coordinates: coords };
}

// A CSV cell (WKT, a GeoJSON geometry, Feature or FeatureCollection) -> a FeatureCollection.
export function cellToFeatureCollection(cell) {
  const s = cell.trim();
  if (!s.startsWith('{')) return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: wktToGeometry(s), properties: {} }] };
  const g = JSON.parse(s);
  if (g.type === 'FeatureCollection') return g;
  if (g.type === 'Feature') return { type: 'FeatureCollection', features: [g] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: g, properties: {} }] };
}
