// A city's fabric: the lanes, plots and buildings that fill its districts between what is drawn by
// hand. A recipe, layers/<layer>/cities/<city>.fabric.json, beside the city's .osm, names each
// district (a place: an entry of the .osm or of globe.csv) and how it is built up; src/globe.mjs
// grows the fabric from it on every run and draws it in city.json with the rest, so nothing of it
// is kept by hand and none of it is an entry. It is seeded: the same recipe and the same hand-drawn
// city give the same fabric, and each district has its own seed, so changing one leaves the rest.
//
// The fabric keeps to what is there. It is built on the drawn land only (the one coast), clear of
// every drawn area (water, a building, a square, a garden) and of every drawn street by its width,
// and it hangs off the hand-drawn streets and canals: closes off a spine, quay streets along canals.
//
// Patterns (a district's `pattern`; see README.md, Cities, for every setting):
//   closes    narrow closes off both sides of a street, at uneven spacing, some forked, some blind,
//             and back lanes along it: an old town on a ridge (Edinburgh's Royal Mile).
//   organic   streets grown as the edges of an irregular, relaxed Voronoi tessellation, bent by a
//             noise warp, some dropped so blocks merge: an old town that grew rather than was laid.
//   rings     quay streets along the district's canals, and cross streets between them, a few run
//             on over bridges: a canal ring (Amsterdam's).
//   frontage  nothing new: plots along the edges of what is there.
//   passages  tunnels only (an undercity), drawn under everything, with no plots.
// A `fill` grows an organic network in what a pattern leaves open. Every pattern but passages then
// cuts its blocks (the district's ground less the streets) into plots along their edges, of uneven
// width and depth, and puts a building at the front of each; or, with `uses`, gives each block one
// of a list (plots, a field, a market garden, a rope-walk), weighted by its distance from a centre.
import ClipperLib from 'clipper-lib';
import { Delaunay } from 'd3-delaunay';
import { createNoise2D } from 'simplex-noise';
import { classify } from './osm.mjs';

const C = ClipperLib, S = 1e4;   // Clipper's integers: a ten-thousandth of a map unit
const NZ = C.PolyFillType.pftNonZero;
const toPath = ring => ring.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) }));
const fromPath = path => path.map(p => [p.X / S, p.Y / S]);
const closed = r => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
function op(type, a, b) {
  const c = new C.Clipper();
  c.AddPaths(a, C.PolyType.ptSubject, true);
  if (b.length) c.AddPaths(b, C.PolyType.ptClip, true);
  const out = new C.Paths();
  c.Execute(type, out, NZ, NZ);
  return out;
}
const union = (a, b = []) => op(C.ClipType.ctUnion, a, b);
const inter = (a, b) => (a.length && b.length ? op(C.ClipType.ctIntersection, a, b) : []);
const minus = (a, b) => (a.length && b.length ? op(C.ClipType.ctDifference, a, b) : a);
const ARC = 0.003 * S;   // round ends and joins to within 30 cm
function grow(paths, d, round = false) {
  if (!paths.length || !d) return paths;
  const o = new C.ClipperOffset(2, ARC), out = new C.Paths();
  o.AddPaths(paths, round ? C.JoinType.jtRound : C.JoinType.jtMiter, C.EndType.etClosedPolygon);
  o.Execute(out, d * S);
  return out;
}
// Lines widened to areas, each by its own half-width.
function widen(lines) {
  const byHalf = new Map();
  for (const { line, half } of lines) if (line.length > 1 && half > 0) (byHalf.get(half) ?? byHalf.set(half, []).get(half)).push(line);
  const parts = [];
  for (const [half, ls] of byHalf) {
    const o = new C.ClipperOffset(2, ARC), out = new C.Paths();
    for (const l of ls) o.AddPath(toPath(l), C.JoinType.jtRound, C.EndType.etOpenRound);
    o.Execute(out, half * S);
    parts.push(...out);
  }
  return parts.length ? union(parts) : [];
}
// The pieces of lines inside an area.
function clipLines(lines, area) {
  if (!lines.length || !area.length) return [];
  const c = new C.Clipper();
  for (const l of lines) if (l.length > 1) c.AddPath(toPath(l), C.PolyType.ptSubject, false);
  c.AddPaths(area, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(C.ClipType.ctIntersection, tree, NZ, NZ);
  return C.Clipper.OpenPathsFromPolyTree(tree).map(fromPath);
}
const areaOf = paths => paths.reduce((s, p) => s + C.Clipper.Area(p), 0) / S / S;
// Polygons with their holes, [[outer, ...holes]], closed rings in map units.
function polygons(paths) {
  if (!paths.length) return [];
  const c = new C.Clipper();
  c.AddPaths(paths, C.PolyType.ptSubject, true);
  const tree = new C.PolyTree(), out = [];
  c.Execute(C.ClipType.ctUnion, tree, NZ, NZ);
  const walk = node => {
    for (const outer of node.Childs()) {
      const poly = [closed(fromPath(outer.Contour()))];
      for (const hole of outer.Childs()) { poly.push(closed(fromPath(hole.Contour()))); walk(hole); }
      out.push(poly);
    }
  };
  walk(tree);
  return out;
}
// A point test on an area (holes and all), quick for many points.
function within(paths) {
  const parts = paths.map(p => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of p) { x0 = Math.min(x0, q.X); y0 = Math.min(y0, q.Y); x1 = Math.max(x1, q.X); y1 = Math.max(y1, q.Y); }
    return { p, box: [x0, y0, x1, y1], w: C.Clipper.Orientation(p) ? 1 : -1 };
  });
  return ([x, y]) => {
    const pt = { X: Math.round(x * S), Y: Math.round(y * S) };
    let w = 0;
    for (const { p, box, w: k } of parts) if (pt.X >= box[0] && pt.X <= box[2] && pt.Y >= box[1] && pt.Y <= box[3] && C.Clipper.PointInPolygon(pt, p) !== 0) w += k;
    return w > 0;
  };
}

// Lines and points, in map units.
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const unit = (a, b) => { const d = dist(a, b) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
const turn = ([x, y], deg) => { const a = deg * Math.PI / 180; return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]; };
const lengthOf = line => line.slice(1).reduce((s, q, i) => s + dist(line[i], q), 0);
const resample = (line, step) => {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const n = Math.max(1, Math.round(dist(line[i - 1], line[i]) / step));
    for (let k = 1; k <= n; k++) out.push(lerp(line[i - 1], line[i], k / n));
  }
  return out;
};
// The point a distance along a line, and the line's direction there.
function along(line, s) {
  let run = 0;
  for (let i = 1; i < line.length; i++) {
    const seg = dist(line[i - 1], line[i]);
    if (run + seg >= s || i === line.length - 1) return { p: lerp(line[i - 1], line[i], seg ? Math.min(1, (s - run) / seg) : 0), d: unit(line[i - 1], line[i]) };
    run += seg;
  }
  return { p: line[0], d: [1, 0] };
}
const signedArea = ring => ring.slice(1).reduce((s, q, i) => s + ring[i][0] * q[1] - q[0] * ring[i][1], 0) / 2;
const centroid = ring => {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < ring.length - 1; i++) { const [x0, y0] = ring[i], [x1, y1] = ring[i + 1], k = x0 * y1 - x1 * y0; a += k; x += (x0 + x1) * k; y += (y0 + y1) * k; }
  return a ? [x / (3 * a), y / (3 * a)] : ring[0];
};
// Douglas-Peucker, to keep the drawing light. A ring is halved at its far side first, since its
// ends are the same point.
function simplify(line, tol) {
  if (line.length < 3) return line;
  if (line.length > 3 && dist(line[0], line[line.length - 1]) === 0) {
    let far = 1;
    for (let i = 1; i < line.length - 1; i++) if (dist(line[0], line[i]) > dist(line[0], line[far])) far = i;
    return [...simplify(line.slice(0, far + 1), tol).slice(0, -1), ...simplify(line.slice(far), tol)];
  }
  const keep = new Uint8Array(line.length); keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(), [ax, ay] = line[i], [bx, by] = line[j], L = Math.hypot(bx - ax, by - ay) || 1e-12;
    let worst = -1, at = -1;
    for (let k = i + 1; k < j; k++) { const d = Math.abs((bx - ax) * (ay - line[k][1]) - (ax - line[k][0]) * (by - ay)) / L; if (d > worst) { worst = d; at = k; } }
    if (worst > tol) { keep[at] = 1; stack.push([i, at], [at, j]); }
  }
  return line.filter((_, k) => keep[k]);
}

// Seeded randomness (mulberry32), one stream per district.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = s => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return h >>> 0; };
const pick = (random, [a, b]) => a + (b - a) * random();

// How wide a drawn street is, each side of its line, in map units (100 m): its `width` tag in
// metres if it has one, else by its kind.
const HALF = { motorway: 10, trunk: 9, primary: 6.5, secondary: 5, tertiary: 4.5, footway: 1.5, path: 1.5, steps: 1.5, cycleway: 1.5, pedestrian: 3 };
const halfOf = (tags, kmPerUnit) => {
  const m = Number(tags.width) > 0 ? Number(tags.width) / 2 : tags.highway ? HALF[tags.highway] ?? 3.5 : tags.railway || tags.aerialway ? 2 : 1.5;
  return m / 1000 / kmPerUnit;
};

// The fabric of a city: drawn elements { tags, geometry } in the globe's coordinates.
//   recipe   the parsed .fabric.json
//   hand     the city's own .osm features (src/osm.mjs's osmFeatures), in Earth's coordinates
//   places   id -> a place's geometry on the globe (for districts not drawn in the .osm)
//   land     the drawn land there, globe geometries (the basemap's detail)
//   map      the regional map the recipe is drawn on; toMap / toGlobe convert to and from it
//   earthToGlobe  a point of Earth to the globe
export function fabric({ recipe, hand, places, land, map, toMap, toGlobe, earthToGlobe, heights, where }) {
  const unitM = map.kmPerUnit * 1000;   // metres to a map unit
  const m = x => x / unitM;             // the recipe's lengths are metres
  // The ground's heights (src/terrain.mjs's, for a city's map), in metres at a map point, and its
  // slope there: the rise per metre east and south, uphill. Without them the city is built flat.
  const H = heights ? p => {
    const [lon, lat] = toGlobe(p), { grid, width, height, bbox, step } = heights;
    const x = Math.max(0, Math.min(width - 1.001, (lon - bbox[0]) / step)), y = Math.max(0, Math.min(height - 1.001, (bbox[3] - lat) / step));
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, g = (a, b) => grid[b * width + a] / 10;
    return g(i, j) * (1 - fx) * (1 - fy) + g(i + 1, j) * fx * (1 - fy) + g(i, j + 1) * (1 - fx) * fy + g(i + 1, j + 1) * fx * fy;
  } : null;
  const rise = p => { if (!H) return [0, 0]; const e = m(15); return [(H([p[0] + e, p[1]]) - H([p[0] - e, p[1]])) / 30, (H([p[0], p[1] + e]) - H([p[0], p[1] - e])) / 30]; };
  const range = (v, name) => {
    if (v === undefined) return undefined;
    const r = Array.isArray(v) ? v : [v, v];
    if (r.length !== 2 || !r.every(Number.isFinite)) throw new Error(`${where}: ${name} must be a number of metres or [least, most]`);
    return r.map(m);
  };
  const ringsOf = g => (g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : []);
  const linesOf = g => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []);
  const earthLine = l => l.map(p => toMap(earthToGlobe(p)));
  // The hand-drawn city on the map.
  const drawn = hand.map(f => ({ tags: f.tags, type: f.geometry.type, rings: ringsOf(f.geometry).map(earthLine), lines: linesOf(f.geometry).map(earthLine) }));
  const placeArea = id => {
    const own = drawn.find(f => f.tags['cairn:id'] === id && f.rings.length);
    if (own) return union(own.rings.map(toPath));
    const g = places.get(id);
    if (!g || !/Polygon$/.test(g.type)) throw new Error(`${where}: no place "${id}" with an outline, in the city's .osm or globe.csv`);
    return union(ringsOf(g).map(r => toPath(r.map(toMap))));
  };
  const districtIds = new Set(recipe.districts.map(d => d.place));
  // What is there, which the fabric keeps clear of: every drawn area (and a closed wall's
  // enclosure), a metre round; every drawn street, rail and wall by its width.
  const isWall = t => t.barrier === 'wall' || t.barrier === 'city_wall' || t.historic === 'city_walls';
  const areaParts = [], lineParts = [], water = [];
  for (const f of drawn) {
    if (districtIds.has(f.tags['cairn:id'])) continue;
    const cls = classify(f.tags, f.type);
    if (f.rings.length && cls) { areaParts.push(...f.rings.map(toPath)); if (cls === 'water') water.push(...f.rings.map(toPath)); }
    for (const l of f.lines) {
      if (cls === 'under' || !cls && !f.tags.man_made) continue;
      if (cls === 'water') continue;   // a canal's line: its water is drawn as an area
      const ring = l.length > 3 && dist(l[0], l[l.length - 1]) < 1e-9;
      if (ring && f.tags.barrier === 'wall') areaParts.push(toPath(l));
      lineParts.push({ line: l, half: halfOf(f.tags, map.kmPerUnit) });
    }
  }
  const drawnAreas = union(grow(union(areaParts), m(1)));
  const obstacles = union(drawnAreas, widen(lineParts));
  const waterArea = union(water);
  const landArea = union(land.flatMap(g => ringsOf(g).map(r => toPath(r.map(toMap)))));
  const handStreet = name => {
    const f = drawn.find(x => x.tags.name === name && x.lines.length);
    if (!f) throw new Error(`${where}: no street named "${name}" in the city's .osm`);
    return f.lines[0];
  };

  const out = [];
  const emitLine = (line, tags) => { if (line.length > 1) out.push({ tags, geometry: { type: 'LineString', coordinates: simplify(line, m(0.4)).map(toGlobe) } }); };
  const emitArea = (poly, tags) => {
    const rings = poly.map(r => closed(simplify(r, m(0.3)))).filter(r => r.length >= 4);
    if (rings.length && rings[0].length >= 4) out.push({ tags, geometry: { type: 'Polygon', coordinates: rings.map(r => r.map(toGlobe)) } });
  };
  const counts = {};
  for (const spec of recipe.districts) {
    const random = rng(hash(`${recipe.seed ?? 0}:${spec.place}`));
    const n2 = createNoise2D(random), noise = (x, y) => n2(x, y);
    const zone = placeArea(spec.place);
    const ground = inter(spec.margin ? grow(zone, -m(spec.margin)) : zone, landArea);
    let region = minus(ground, obstacles);
    let open = minus(ground, drawnAreas);   // where a street may run: the ground less what is drawn on it
    const flights = [];
    // Terrain: ground steeper than `cliff` (rise over run) is left as bare rock, built on by no one.
    const T = { cliff: 0.6, steps: 0.14, stairs: 0.2, terrace: 3, fall: 0.6, ...(recipe.terrain ?? {}), ...(spec.terrain ?? {}) };
    if (H && T.cliff) {
      const [[x0, y0], [x1, y1]] = boundsOf(ground), e = m(8), inGround = within(ground), squares = [];
      for (let x = x0; x <= x1; x += e) for (let y = y0; y <= y1; y += e) {
        if (!inGround([x, y])) continue;
        const [gx, gy] = rise([x, y]);
        if (Math.hypot(gx, gy) > T.cliff) squares.push(toPath([[x - e / 2, y - e / 2], [x + e / 2, y - e / 2], [x + e / 2, y + e / 2], [x - e / 2, y + e / 2]]));
      }
      // Rounded off (closed and opened by some metres), so its edge follows the rock, not the grid.
      const rock = squares.length ? inter(grow(grow(grow(grow(union(squares), m(6), true), -m(18), true), m(12), true), 0), ground) : [];
      if (rock.length) {
        region = minus(region, rock); open = minus(open, rock);
        for (const poly of polygons(rock)) if (areaOf(poly.map(toPath)) > m(1) * m(1) * 150) out.push({ tags: { natural: 'bare_rock', note: T.rockNote ?? 'Bare rock, too steep to build on' }, geometry: { type: 'Polygon', coordinates: poly.map(r => r.map(toGlobe)) } });
        // Flights of steps cut down it, now and then, from the ground above to the ground below.
        if (T.flights !== 0) {
          const inRock = within(rock), inGround = within(ground);
          for (const poly of polygons(rock)) {
            const edge = poly[0], L = lengthOf(edge);
            for (let at = random() * m(T.flights ?? 140); at < L; at += m(T.flights ?? 140) * (0.7 + 0.6 * random())) {
              const { p } = along(edge, at);
              if (!H) break;
              // Start from the edge's upper side only: the top of the rock.
              const [gx, gy] = rise(p), sl = Math.hypot(gx, gy) || 1;
              if (!inRock([p[0] - gx / sl * m(10), p[1] - gy / sl * m(10)])) continue;
              const start = [p[0] + gx / sl * m(3), p[1] + gy / sl * m(3)];
              const line = [start];
              let q = start, d = [-gx / sl, -gy / sl], wiggle = random() < 0.5 ? 1 : -1;
              for (let s = 0; s < m(320) && inGround(q); s += m(4)) {
                const [hx, hy] = rise(q), hl = Math.hypot(hx, hy) || 1;
                // Down the fall line, but slanting across it where it is steepest, as a stair does.
                const slant = Math.min(55, 25 + 30 * Math.min(1, hl));
                d = unit([0, 0], [d[0] * 0.6 + turn([-hx / hl, -hy / hl], wiggle * slant)[0] * 0.4, d[1] * 0.6 + turn([-hx / hl, -hy / hl], wiggle * slant)[1] * 0.4]);
                q = [q[0] + d[0] * m(4), q[1] + d[1] * m(4)];
                line.push(q);
                if (line.length > 6 && !inRock(q)) break;
                if (random() < 0.06) wiggle = -wiggle;
              }
              if (line.length > 6 && !inRock(line[line.length - 1])) flights.push(line);
            }
          }
        }
      }
    }
    const k = { spec, random, noise, zone, ground, region, open, m, range, handStreet, drawn, waterArea, H, rise, T, inRegion: within(region), inOpen: within(open), where: `${where} ${spec.place}` };
    const pattern = PATTERNS[spec.pattern];
    if (!pattern) throw new Error(`${where}: district ${spec.place}: no pattern "${spec.pattern}" (${Object.keys(PATTERNS).join(', ')})`);
    const { streets = [], bridges = [], parts = [] } = pattern(k);
    // `fill`: an organic network grown in what the pattern leaves open (beyond a spine's ends).
    if (spec.fill) streets.push(...PATTERNS.organic({ ...k, spec: { ...spec, organic: spec.fill, along: null }, avoid: streets }).streets);
    const n = { streets: 0, buildings: 0, gardens: 0 };
    // Streets: kept to the open ground (a tunnel to the district), the short scraps dropped.
    for (const s of streets) {
      for (const piece of clipLines([s.line], s.tags.tunnel ? zone : open)) {
        if (lengthOf(piece) <= m(12)) continue;
        // Where a lane is too steep for a cart, it is steps (a street, only where steeper still).
        for (const run of s.tags.tunnel ? [{ line: piece }] : byGrade(piece, k, s.tags)) { emitLine(run.line, run.steep ? { ...s.tags, highway: 'steps' } : s.tags); n.streets++; }
      }
    }
    for (const b of bridges) for (const piece of clipLines([b.line], waterArea)) { emitLine(piece, b.tags); n.streets++; }
    for (const f of flights) for (const piece of clipLines([f], minus(ground, drawnAreas))) if (lengthOf(piece) > m(20)) { emitLine(piece, { highway: 'steps', note: T.flightNote ?? 'Steps cut down the rock' }); n.streets++; }
    if (spec.plots || spec.uses || parts.length) {
      const blocks = polygons(minus(region, widen(streets.filter(s => !s.tags.tunnel))));
      for (const block of blocks) {
        const paths = block.map(toPath), size = areaOf(paths);
        // Too small or too thin to build on (a scrap between streets) is left open.
        if (size < m(1) * m(1) * (spec.plots?.least ?? 60) || !grow(paths, -m(3)).length) continue;
        // A block in one of the pattern's parts (a quarter) is built as that part says.
        const c = centroid(block[0]), part = parts.find(q => q.inside(c)), own = part ? { ...spec, plots: part.plots ?? spec.plots, uses: part.uses } : spec;
        const use = useOf(own, block, k);
        if (use.tags) for (const poly of polygons(grow(paths, -m(use.inset ?? 2)))) emitArea(poly, use.tags);
        if (use.strip) strip(block, paths, use.strip, k, n, emitArea);
        if (use.plots) { const P = use.plots === true ? own.plots : { ...(own.plots ?? {}), ...use.plots }; (P.fill ? solid : plots)(block, paths, P, k, n, emitArea); }
      }
    }
    counts[spec.place] = n;
  }
  return { drawn: out, counts };
}

// What a block is used for. Without `uses`, plots (the district's `plots`). With them, one of the
// list at random by weight: an area of its own (`tags`: a field, a market garden), a long building
// down its middle (`strip`: a rope-walk), plots (`plots`: true for the district's, or settings
// over them), or several together. A weight given as [near, far] runs from one to the other
// between `from` and `to` metres from `centre`, so a fringe can thin into the country.
function useOf(spec, block, k) {
  const U = spec.uses;
  if (!U) return { plots: true };
  const c = centroid(block[0]);
  const t = U.from === undefined ? 0 : Math.max(0, Math.min(1, (dist(c, U.centre ?? [0, 0]) - k.m(U.from)) / (k.m(U.to) - k.m(U.from))));
  const weights = U.list.map(u => (Array.isArray(u.weight) ? u.weight[0] + (u.weight[1] - u.weight[0]) * t : u.weight ?? 1));
  let x = k.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) < 0) return U.list[i];
  return U.list[U.list.length - 1];
}
// A long building down a block's length (its longest axis), clear of its edges.
function strip(block, blockPaths, St, k, n, emitArea) {
  const { m } = k, ring = block[0].slice(0, -1), c = centroid(block[0]);
  let xx = 0, yy = 0, xy = 0;
  for (const [x, y] of ring) { xx += (x - c[0]) ** 2; yy += (y - c[1]) ** 2; xy += (x - c[0]) * (y - c[1]); }
  const a = Math.atan2(2 * xy, xx - yy) / 2, u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]], L = 50, w = m(St.width ?? 8) / 2;
  const rect = [[-L, -w], [L, -w], [L, w], [-L, w]].map(([s, t]) => [c[0] + u[0] * s + v[0] * t, c[1] + u[1] * s + v[1] * t]);
  const pieces = polygons(inter(union([toPath(rect)]), grow(blockPaths, -m(St.clear ?? 6))));
  const best = pieces.sort((p, q) => areaOf(q.map(toPath)) - areaOf(p.map(toPath)))[0];
  if (best && areaOf(best.map(toPath)) > m(St.width ?? 8) * m(St.least ?? 80)) { emitArea(best, St.tags ?? { building: 'yes' }); n.buildings++; }
}

// The smallest rectangle round a ring (its convex hull's, on the side that fits it closest): its
// centre, its long axis u and short axis v, and its half-length and half-width along them.
function obbOf(ring) {
  const pts = [...ring.slice(0, -1)].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const e = unit(hull[i], hull[(i + 1) % hull.length]), f = [-e[1], e[0]];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of hull) { const a = p[0] * e[0] + p[1] * e[1], b = p[0] * f[0] + p[1] * f[1]; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, e, f, a0, a1, b0, b1 };
  }
  const { e, f, a0, a1, b0, b1 } = best, long = a1 - a0 >= b1 - b0;
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2, c = [e[0] * ca + f[0] * cb, e[1] * ca + f[1] * cb];
  return long ? { c, u: e, v: f, L: (a1 - a0) / 2, W: (b1 - b0) / 2 } : { c, u: f, v: e, L: (b1 - b0) / 2, W: (a1 - a0) / 2 };
}

// A block filled solid, as an old town's are: cut in two across its length, near the middle and a
// little askew, and each half again, until the pieces are a building's size; the larger cuts leave
// an alley between, and now and then a piece is left open, a yard or a garden. (The way the wards
// of Watabou's Medieval Fantasy City Generator are built, after its createAlleys.)
//   fill.area       a building's size, square metres; fill.vary how much that varies (0..1)
//   fill.chaos      how far a cut may wander off the middle and off square (0..1)
//   fill.alley      an alley's width, metres; fill.empty the chance a piece is left open, and
//   fill.garden     the chance an open piece is a garden
function solid(block, blockPaths, P, k, n, emitArea) {
  const F = P.fill, { random, m } = k, sq = m(1) * m(1);
  const minSq = sq * (F.area ?? 200), vary = F.vary ?? 0.5, chaos = F.chaos ?? 0.5;
  const alley = m(F.alley ?? 2), empty = F.empty ?? 0.04, garden = F.garden ?? 0, thin = m(F.thin ?? 3.5);
  const levels = P.levels ? (Array.isArray(P.levels) ? P.levels : [P.levels, P.levels]) : null;
  // A large house may be built round a courtyard (fill.courtyard: its chance, the least size in
  // square metres, the range's depth in metres).
  const Y = F.courtyard, M = F.misfit;
  const house = (poly, tags = { building: P.building ?? 'yes', ...(P.tags ?? {}) }) => {
    if (levels && !tags['building:levels']) tags = { ...tags, 'building:levels': String(Math.round(pick(random, levels))) };
    if (Y && areaOf(poly.map(toPath)) > sq * (Y.least ?? 300) && random() < (Y.chance ?? 0.3)) {
      const paths = poly.map(toPath), court = grow(paths, -m(Y.depth ?? 6));
      if (areaOf(court) > sq * 25) { for (const ring of polygons(minus(paths, court))) emitArea(ring, tags); n.buildings++; return; }
    }
    emitArea(poly, tags); n.buildings++;
  };
  const open = poly => { if (random() < garden) { emitArea(poly, { leisure: 'garden' }); n.gardens++; } };
  const halfPlane = (at, t, nrm, off, R) => [[-R, off], [R, off], [R, R], [-R, R]].map(([a, b]) => [at[0] + t[0] * a + nrm[0] * b, at[1] + t[1] * a + nrm[1] * b]);
  const cut = (poly, split, depth) => {
    const paths = poly.map(toPath), area = areaOf(paths), box = obbOf(poly[0]);
    // A misfit (fill.misfit: its chance, its size in square metres, and the tags to choose from): a
    // chapel, a hall, an old tower, taking a piece whole where the rest is cut small.
    if (M && depth > 0 && area < sq * (M.area ?? 900) && area > sq * (M.least ?? 250) && random() < (M.chance ?? 0.05)) {
      const pick1 = M.tags[Math.floor(random() * M.tags.length)];
      for (const piece of polygons(grow(paths, -m(M.inset ?? 1.5)))) house(piece, { ...pick1 });
      return;
    }
    const small = area < minSq * 2 ** (4 * vary * (random() - 0.5));
    if (!box || small || depth > 24 || box.W * 2 < thin * 2) {
      if (area < sq * 12 || box && box.W * 2 < thin) return;
      if (random() < empty) open(poly); else house(poly);
      return;
    }
    const spread = 0.8 * chaos, ratio = (1 - spread) / 2 + random() * spread;
    const ang = (random() - 0.5) * (Math.PI / 6) * chaos * (area < minSq * 4 ? 0 : 1);
    const at = [box.c[0] + box.u[0] * box.L * (2 * ratio - 1), box.c[1] + box.u[1] * box.L * (2 * ratio - 1)];
    const t = turn(box.v, ang * 180 / Math.PI), nrm = [-t[1], t[0]], g = split ? alley / 2 : 0, R = (box.L + box.W) * 3;
    for (const side of [1, -1]) {
      const plane = halfPlane(at, t, [nrm[0] * side, nrm[1] * side], g, R);
      for (const piece of polygons(inter(paths, [toPath(plane)]))) {
        const a = areaOf(piece.map(toPath));
        cut(piece, a > minSq / Math.max(1e-3, random() * random()), depth + 1);
      }
    }
  };
  cut(block, true, 0);
}

// A block cut into plots along its edges, each with its building at the front; what is left
// inside, a garden if the district has them.
function plots(block, blockPaths, P, k, n, emitArea) {
  const { random, noise, range, m } = k;
  const width = range(P.width, 'plots.width'), wide = P.wide ? { chance: P.wide.chance ?? 0.1, width: range(P.wide.width, 'plots.wide.width') } : null;
  const depth = range(P.depth, 'plots.depth'), build = range(P.build ?? P.depth, 'plots.build'), setback = range(P.setback ?? 0, 'plots.setback');
  const gap = m(P.gap ?? 1), cover = P.cover ?? 1, corner = P.corner ?? 40;
  const levels = P.levels ? (Array.isArray(P.levels) ? P.levels : [P.levels, P.levels]) : null;
  const taken = [], buildings = [];
  const boxOf = path => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of path) { x0 = Math.min(x0, q.X); y0 = Math.min(y0, q.Y); x1 = Math.max(x1, q.X); y1 = Math.max(y1, q.Y); } return [x0, y0, x1, y1]; };
  const meets = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  for (const ring of block) {
    const sgn = Math.sign(signedArea(ring));
    // The ring's sides: runs between its corners (a turn sharper than `corner` degrees), each
    // fronted by its own row of plots.
    const pts = ring.slice(0, -1);
    if (pts.length < 3) continue;
    const turnAt = i => {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const u = unit(a, b), v = unit(b, c);
      return Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI;
    };
    const corners = pts.map((_, i) => i).filter(i => turnAt(i) > corner);
    const sides = [];
    if (!corners.length) sides.push([...pts, pts[0]]);
    else for (let c = 0; c < corners.length; c++) {
      const i0 = corners[c], i1 = corners[(c + 1) % corners.length], side = [];
      for (let i = i0; ; i = (i + 1) % pts.length) { side.push(pts[i]); if (i === i1 && side.length > 1) break; }
      sides.push(side);
    }
    for (const side of sides) {
      const L = lengthOf(side);
      if (L < width[0]) continue;
      const cuts = [0];
      for (let s = 0; ;) {
        const w = wide && random() < wide.chance ? pick(random, wide.width) : pick(random, width);
        if (L - (s + w) < width[0] * 0.6) { cuts.push(L); break; }
        cuts.push(s += w);
      }
      for (let c = 1; c < cuts.length; c++) {
        // The plot's frontage follows the side; its back is the frontage moved in, square to its chord.
        const front = [along(side, cuts[c - 1]).p];
        let run = 0;
        for (let i = 1; i < side.length; i++) { run += dist(side[i - 1], side[i]); if (run > cuts[c - 1] && run < cuts[c]) front.push(side[i]); }
        front.push(along(side, cuts[c]).p);
        const a = front[0], b = front[front.length - 1], d = unit(a, b), inward = [-d[1] * sgn, d[0] * sgn];
        const shift = (line, o) => line.map(p => [p[0] + inward[0] * o, p[1] + inward[1] * o]);
        const D = pick(random, depth);
        const lot = toPath([...front, ...shift([b, a], D)]);
        const box = boxOf(lot);
        let plot = inter(union([lot]), blockPaths);
        const near = taken.filter(t => meets(t.box, box)).map(t => t.path);
        plot = minus(plot, near);
        if (areaOf(plot) < m(1) * m(1) * 15) continue;
        for (const p of plot) taken.push({ path: p, box: boxOf(p) });
        // Some plots stand empty (a yard, a gap in the row); noise clusters them.
        if (random() > cover * (1 + 0.3 * noise(a[0] * 0.8, a[1] * 0.8))) continue;
        const sb = pick(random, setback), bd = pick(random, build);
        const footprint = grow(inter(union([toPath([...shift(front, sb), ...shift([b, a], sb + bd)])]), plot), -gap / 2);
        for (const poly of polygons(footprint)) {
          if (areaOf(poly.map(toPath)) < m(1) * m(1) * 20) continue;
          const tags = { building: P.building ?? 'yes', ...(P.tags ?? {}) };
          if (levels) tags['building:levels'] = String(Math.round(pick(random, levels)));
          emitArea(poly, tags);
          buildings.push(...poly.map(toPath));
          n.buildings++;
        }
        // A compound's wall round its plot.
        if (P.walls) for (const poly of polygons(grow(plot, -m(0.5))).slice(0, 1)) emitArea([poly[0]], { barrier: 'wall', ...(P.wallNote ? { note: P.wallNote } : {}) });
      }
    }
  }
  // The garden: what is left of the block behind its buildings.
  if (P.gardens) {
    const left = grow(grow(minus(blockPaths, grow(union(buildings), m(1.5))), -m(1.5)), m(0.5));
    for (const poly of polygons(left)) if (areaOf(poly.map(toPath)) > m(1) * m(1) * (P.gardens.least ?? 150)) { emitArea(poly, { leisure: 'garden' }); n.gardens++; }
  }
}

// A line cut into runs by its grade: a lane steeper than `steps` (a street, `stairs`) is steps.
function byGrade(line, k, tags) {
  const { H, T, m } = k;
  const limit = /^(footway|path|track|pedestrian|cycleway|bridleway)$/.test(tags.highway) ? T.steps : /^(residential|service|living_street|unclassified)$/.test(tags.highway) ? T.stairs : Infinity;
  if (!H || limit === Infinity) return [{ line }];
  const pts = resample(line, m(8)), seg = pts.slice(1).map((q, i) => Math.abs(H(q) - H(pts[i])) / (dist(pts[i], q) / m(1) || 1));
  const steep = seg.map((_, i) => (seg[Math.max(0, i - 1)] + seg[i] + seg[Math.min(seg.length - 1, i + 1)]) / 3 > limit);
  const runs = [];
  for (let i = 0; i < seg.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.steep === steep[i]) last.line.push(pts[i + 1]); else runs.push({ steep: steep[i], line: [pts[i], pts[i + 1]] });
  }
  return runs.map(r => ({ ...r, line: simplify(r.line, m(0.4)) }));
}
// A walk from a point, turning a little as noise says, while it stays in an area; with `fall`, it
// is drawn downhill (as a close drops off a ridge), and with `across`, only by the fall square to
// that direction (a close drops off the sides of a ridge, not down its length).
function walk(k, from, dir, length, { step = 0.04, curl = 0, test = k.inRegion, fall = 0, across = null } = {}) {
  const line = [from];
  let p = from, d = dir;
  for (let s = 0; s < length; s += step) {
    const q = [p[0] + d[0] * step, p[1] + d[1] * step];
    if (!test(q)) break;
    line.push(q);
    p = q;
    if (curl) d = turn(d, curl * k.noise(q[0] * 2.3, q[1] * 2.3));
    if (fall && k.H) {
      let [gx, gy] = k.rise(q);
      if (across) { const a = gx * across[0] + gy * across[1]; gx -= a * across[0]; gy -= a * across[1]; }
      const sl = Math.hypot(gx, gy);
      if (sl > 0.03) { const w = fall * Math.min(1, sl / 0.2); d = unit([0, 0], [d[0] - w * gx / sl, d[1] - w * gy / sl]); }
    }
  }
  return line;
}
// Lanes running beside a street at a distance that wanders: back lanes, a hill's parallel streets.
function besides(k, spine, offsets, tags, half) {
  const out = [], L = lengthOf(spine);
  for (const o of offsets) {
    const pts = [];
    for (let s = 0; s <= L; s += k.m(15)) {
      const { p, d } = along(spine, s), wander = k.m(o.wander ?? 25) * k.noise(s * 0.35 + o.at, o.at * 3.1);
      const off = k.m(o.at) + Math.sign(o.at) * wander;
      pts.push([p[0] - d[1] * off, p[1] + d[0] * off]);
    }
    // On a slope, a lane keeps to its level (a smoothed height along it), as lanes along a hill do.
    if (k.H && o.contour !== false) {
      const hs = pts.map(k.H), target = hs.map((_, i) => { const w = hs.slice(Math.max(0, i - 5), i + 6); return w.reduce((a, b) => a + b, 0) / w.length; });
      pts.forEach((p, i) => {
        for (let it = 0; it < 3; it++) {
          const [gx, gy] = k.rise(p), sl = Math.hypot(gx, gy);
          if (sl < 0.03) break;
          const move = Math.max(-25, Math.min(25, -(k.H(p) - target[i]) / sl));
          p = [p[0] + gx / sl * k.m(move), p[1] + gy / sl * k.m(move)];
        }
        pts[i] = p;
      });
    }
    let run = [];
    for (const q of pts) { if (k.inOpen(q)) run.push(q); else { if (run.length > 3) out.push({ line: run, tags, half }); run = []; } }
    if (run.length > 3) out.push({ line: run, tags, half });
  }
  return out;
}

const PATTERNS = {
  // Closes off both sides of a street, and back lanes along it.
  closes(k) {
    const { spec, random, m, range } = k, C = spec.closes ?? {};
    const spine = k.handStreet(spec.along), L = lengthOf(spine), streets = [];
    const spacing = range(C.spacing ?? [15, 45], 'closes.spacing'), length = range(C.length ?? [120, 420], 'closes.length');
    const half = m(C.width ?? 3) / 2, steep = C.steps ?? 0, tags = s => ({ highway: !k.H && s < L * steep ? 'steps' : 'footway', note: C.note ?? 'A close' });
    for (const side of [1, -1]) {
      for (let s = m(C.start ?? 60) + random() * spacing[0]; s < L - m(C.end ?? 60); s += pick(random, spacing)) {
        const { p, d } = along(spine, s), nrm = [-d[1] * side, d[0] * side];
        const dir = turn(nrm, (random() - 0.5) * 2 * (C.angle ?? 15));
        const start = [p[0] + nrm[0] * m(9), p[1] + nrm[1] * m(9)];
        if (!k.inRegion(start)) continue;
        const line = [p, ...walk(k, start, dir, pick(random, length), { step: m(4), curl: C.curl ?? 3, fall: C.fall ?? k.T.fall, across: d })];
        if (line.length < 4) continue;
        streets.push({ line, tags: tags(s), half });
        // A fork, now and then, off to one side.
        if (random() < (C.fork ?? 0.2)) {
          const at = line[Math.floor(line.length * (0.35 + 0.4 * random()))], d2 = turn(dir, (random() < 0.5 ? -1 : 1) * (30 + 30 * random()));
          const branch = walk(k, at, d2, pick(random, [m(30), m(110)]), { step: m(4), curl: C.curl ?? 3, fall: (C.fall ?? k.T.fall) / 2, across: d });
          if (branch.length > 3) streets.push({ line: branch, tags: tags(s), half });
        }
      }
    }
    if (spec.backs) streets.push(...besides(k, spine, spec.backs, { highway: 'residential', note: spec.backsNote ?? 'A back lane' }, m(spec.backsWidth ?? 6) / 2));
    return { streets };
  },

  // Streets as the edges of an irregular Voronoi tessellation, relaxed, warped and thinned.
  organic(k) {
    const { spec, random, noise, m } = k, O = spec.organic ?? {};
    const base = m(O.spacing ?? 70), vary = O.vary ?? 0.35;
    const [[x0, y0], [x1, y1]] = boundsOf(k.ground);
    // Filling round streets already laid: no seed near them, and no new street into their blocks.
    const near = k.avoid ? widen(k.avoid.map(s => ({ line: s.line, half: base * 0.6 }))) : [];
    const inNear = within(near), seedable = p => k.inRegion(p) && !inNear(p);
    // Seeds: thrown at random and kept only clear of each other, the clearance wandering with noise.
    const gap = p => base * (1 + vary * noise(p[0] / base / 6, p[1] / base / 6));
    const cell = base * (1 - vary), grid = new Map(), key = (i, j) => `${i},${j}`, seeds = [];
    const tries = Math.ceil((x1 - x0) * (y1 - y0) / (cell * cell) * 8);
    for (let t = 0; t < tries; t++) {
      const p = [x0 + random() * (x1 - x0), y0 + random() * (y1 - y0)];
      if (!seedable(p)) continue;
      const g = gap(p), i = Math.floor(p[0] / cell), j = Math.floor(p[1] / cell), r = Math.ceil(base * (1 + vary) / cell);
      let clear = true;
      // On a slope, seeds are kept closer downhill than across (distance downhill counts for more):
      // cells, and so blocks, lie along the contours, as terraces do.
      const [gx, gy] = k.rise(p), sl = Math.hypot(gx, gy), st = 1 + k.T.terrace * Math.min(0.5, sl), up = sl > 0.03 ? [gx / sl, gy / sl] : null;
      const apart = q => { if (!up) return dist(p, q); const dx = q[0] - p[0], dy = q[1] - p[1], a = dx * up[0] + dy * up[1], b = dx * up[1] - dy * up[0]; return Math.hypot(b, a * st); };
      for (let a = -r; a <= r && clear; a++) for (let b = -r; b <= r && clear; b++) for (const q of grid.get(key(i + a, j + b)) ?? []) if (apart(q) < g) { clear = false; break; }
      if (!clear) continue;
      seeds.push(p);
      (grid.get(key(i, j)) ?? grid.set(key(i, j), []).get(key(i, j))).push(p);
    }
    if (seeds.length < 3) return { streets: [] };
    const box = [x0 - base * 2, y0 - base * 2, x1 + base * 2, y1 + base * 2];
    let pts = seeds;
    for (let it = 0; it < (O.relax ?? 1); it++) {
      const v = Delaunay.from(pts).voronoi(box);
      pts = pts.map((p, i) => { const c = v.cellPolygon(i); const q = c ? centroid(c) : p; return k.inRegion(q) ? q : p; });
    }
    const v = Delaunay.from(pts).voronoi(box);
    // A smooth warp bends every edge alike, so the cells still meet.
    const amp = m(O.warp ?? 12), scale = m(O.scale ?? 160);
    const warp = ([x, y]) => [x + amp * noise(x / scale, y / scale), y + amp * noise(x / scale + 31.7, y / scale - 17.3)];
    const seen = new Set(), streets = [];
    const street = m(O.width ?? 7) / 2, alley = m(O.alley ?? 2.5) / 2;
    for (let i = 0; i < pts.length; i++) {
      const c = v.cellPolygon(i);
      if (!c) continue;
      for (let j = 0; j + 1 < c.length; j++) {
        const a = c[j], b = c[j + 1], id = [a, b].map(q => q.map(x => Math.round(x * 1e6)).join(',')).sort().join(';');
        if (seen.has(id)) continue;
        seen.add(id);
        if (random() < (O.drop ?? 0.2)) continue;
        const line = resample([a, b], m(6)).map(warp), short = dist(a, b) < base * 0.5;
        // Minor ways: short edges as alleys, and (on a fringe) any edge as a lane between fields.
        if (random() < (short ? O.alleys ?? 0.35 : O.tracks ?? 0)) streets.push({ line, tags: { highway: O.alleyHighway ?? 'footway', note: O.alleyNote ?? 'An alley' }, half: alley });
        else streets.push({ line, tags: { highway: 'residential', ...(O.note ? { note: O.note } : {}) }, half: street });
      }
    }
    if (near.length) {
      const room = minus(k.open, grow(near, -base * 0.3));
      const kept = [];
      for (const s of streets) for (const piece of clipLines([s.line], room)) kept.push({ ...s, line: piece });
      return { streets: kept };
    }
    if (spec.along && spec.backs) streets.push(...besides(k, k.handStreet(spec.along), spec.backs, { highway: 'residential', note: spec.backsNote ?? 'A lane' }, m(spec.backsWidth ?? 6) / 2));
    return { streets };
  },

  // Quay streets along the canals, cross streets between them, and a few through streets bridged.
  rings(k) {
    const { spec, random, m, range } = k, R = spec.rings ?? {};
    const inZone = within(k.zone), centre = R.centre ?? [0, 0];
    const canals = k.drawn.filter(f => f.tags.waterway === 'canal' && f.lines.length).flatMap(f => f.lines).filter(l => l.some(inZone));
    const streets = [], bridges = [];
    const quay = m(R.quay ?? 20), half = m(R.width ?? 8) / 2, water = m(R.water ?? 12);
    const spacing = range(R.spacing ?? [140, 260], 'rings.spacing');
    for (const c of canals) {
      for (const side of [1, -1]) {
        const N = c.map((p, i) => { const d = unit(c[Math.max(0, i - 1)], c[Math.min(c.length - 1, i + 1)]); return [-d[1] * side, d[0] * side]; });
        streets.push({ line: c.map((p, i) => [p[0] + N[i][0] * quay, p[1] + N[i][1] * quay]), tags: { highway: 'residential', note: R.quayNote ?? 'A quay street' }, half });
      }
      // Cross streets outward from this canal to the next, square to it, a little askew.
      const L = lengthOf(c);
      for (let s = random() * spacing[0]; s < L; s += pick(random, spacing)) {
        const { p, d } = along(c, s);
        let nrm = [-d[1], d[0]];
        if (nrm[0] * (p[0] - centre[0]) + nrm[1] * (p[1] - centre[1]) < 0) nrm = [-nrm[0], -nrm[1]];
        const dir = turn(nrm, (random() - 0.5) * 2 * (R.angle ?? 5));
        const start = [p[0] + dir[0] * (water + m(3)), p[1] + dir[1] * (water + m(3))];
        if (!k.inOpen(start)) continue;
        const line = walk(k, start, dir, m(R.reach ?? 300), { step: m(4), test: k.inOpen });
        if (line.length > 3) streets.push({ line, tags: { highway: 'residential', note: R.crossNote ?? 'A cross street' }, half });
      }
    }
    // Through streets: from the centre outward across the district, bridging each canal.
    for (const b0 of R.through ?? []) {
      const b = (b0 + (random() - 0.5) * 4) * Math.PI / 180, dir = [Math.sin(b), -Math.cos(b)];
      const line = resample([[centre[0] + dir[0] * m(R.from ?? 0), centre[1] + dir[1] * m(R.from ?? 0)], [centre[0] + dir[0] * m(R.to ?? 3000), centre[1] + dir[1] * m(R.to ?? 3000)]], m(6));
      streets.push({ line, tags: { highway: 'secondary', note: R.throughNote ?? 'A through street' }, half: m(R.throughWidth ?? 10) / 2 });
      for (const piece of clipLines([line], k.zone)) bridges.push({ line: piece, tags: { highway: 'secondary', bridge: 'yes', note: R.bridgeNote ?? 'A bridge over a canal' } });
    }
    return { streets, bridges };
  },

  // Plots along what is there, and nothing new.
  frontage() { return { streets: [] }; },

  // Quarters: the district cut into a few (`quarters.count`), each grown as its own kind says (one
  // of `quarters.list`: its `organic` streets and its `plots`, at random by `weight`, or the one
  // `near` a hand-drawn feature with those tags, as a harbourside by the port), with the market
  // streets between them; as Jerusalem's old city is, or an old port's.
  quarters(k) {
    const { spec, random, noise, m } = k, Q = spec.quarters;
    const [[x0, y0], [x1, y1]] = boundsOf(k.ground), size = areaOf(k.ground), count = Q.count ?? 4;
    const seeds = [];
    for (let t = 0; seeds.length < count && t < 5000; t++) {
      const p = [x0 + random() * (x1 - x0), y0 + random() * (y1 - y0)];
      if (k.inRegion(p) && seeds.every(q => dist(p, q) > Math.sqrt(size / count) * 0.7)) seeds.push(p);
    }
    if (seeds.length < 2) return PATTERNS.organic(k);
    // Kinds: a `near` kind goes to the quarter nearest its feature, the rest by weight.
    const kinds = new Array(seeds.length).fill(null), free = Q.list.filter(q => !q.near);
    for (const q of Q.list.filter(q => q.near)) {
      const f = k.drawn.find(d => Object.entries(q.near).every(([a, b]) => d.tags[a] === b) && (d.rings.length || d.lines.length));
      if (!f) throw new Error(`${k.where}: quarters: nothing drawn with ${JSON.stringify(q.near)}`);
      const at = f.rings.length ? centroid(f.rings[0]) : f.lines[0][0];
      const i = seeds.map((p, i) => [dist(p, at), i]).filter(([, i]) => !kinds[i]).sort((a, b) => a[0] - b[0])[0]?.[1];
      if (i !== undefined) kinds[i] = q;
    }
    const total = free.reduce((a, q) => a + (q.weight ?? 1), 0);
    for (let i = 0; i < kinds.length; i++) if (!kinds[i]) { let x = random() * total; kinds[i] = free.find(q => (x -= q.weight ?? 1) < 0) ?? free[free.length - 1]; }
    const box = [x0 - 1, y0 - 1, x1 + 1, y1 + 1], v = Delaunay.from(seeds).voronoi(box);
    const amp = m(Q.warp ?? 15), scale = m(Q.scale ?? 200);
    const warp = ([x, y]) => [x + amp * noise(x / scale + 7.1, y / scale), y + amp * noise(x / scale, y / scale + 7.1)];
    const streets = [], parts = [], seen = new Set();
    seeds.forEach((_, i) => {
      const cell = v.cellPolygon(i);
      if (!cell) return;
      const ring = resample(cell, m(6)).map(warp), area = inter(k.ground, [toPath(ring)]);
      if (!area.length) return;
      // The quarter's own streets, grown in its own part of the ground.
      const sub = { ...k, spec: { ...spec, organic: kinds[i].organic ?? spec.organic, along: null }, ground: area, region: inter(k.region, area) };
      sub.inRegion = within(sub.region);
      streets.push(...PATTERNS.organic(sub).streets);
      parts.push({ inside: within(area), plots: kinds[i].plots, uses: kinds[i].uses, name: kinds[i].name });
      // The market streets along its edges.
      for (let j = 0; j + 1 < cell.length; j++) {
        const id = [cell[j], cell[j + 1]].map(q => q.map(x => Math.round(x * 1e6)).join(',')).sort().join(';');
        if (seen.has(id)) continue;
        seen.add(id);
        streets.push({ line: resample([cell[j], cell[j + 1]], m(6)).map(warp), tags: { highway: 'residential', note: Q.note ?? 'A market street' }, half: m(Q.width ?? 6) / 2 });
      }
    });
    return { streets, parts };
  },

  // An undercity: passages beside a street, round a place, and branching off them.
  passages(k) {
    const { spec, random, m } = k, Q = spec.passages ?? {}, streets = [];
    const tags = { highway: 'footway', tunnel: 'yes', layer: '-1', note: Q.note ?? 'A passage' }, half = m(2);
    const test = within(k.zone), trunk = [];
    if (spec.along) for (const s of besides({ ...k, inOpen: test }, k.handStreet(spec.along), Q.beside ?? [{ at: 90 }, { at: -90 }], tags, half)) trunk.push(s);
    if (Q.round) {
      const f = k.drawn.find(x => x.tags['cairn:id'] === Q.round.place && x.rings.length);
      if (!f) throw new Error(`${k.where}: passages.round: no place "${Q.round.place}" drawn in the city's .osm`);
      const c = centroid(f.rings[0]), r = m(Q.round.radius ?? 200);
      let run = [];
      for (let a = 0; a <= 360; a += 3) {
        const rr = r * (1 + 0.12 * k.noise(Math.cos(a * Math.PI / 180) * 1.5, Math.sin(a * Math.PI / 180) * 1.5));
        const q = [c[0] + rr * Math.sin(a * Math.PI / 180), c[1] - rr * Math.cos(a * Math.PI / 180)];
        // Broken here and there: a collapse, a cellar walled off.
        if (test(q) && k.noise(a * 0.05, 9.1) > -0.55) run.push(q); else { if (run.length > 3) trunk.push({ line: run, tags, half }); run = []; }
      }
      if (run.length > 3) trunk.push({ line: run, tags, half });
    }
    streets.push(...trunk);
    // Branches off the trunks, wandering.
    for (let i = 0; i < (Q.branches ?? 30) && trunk.length; i++) {
      const t = trunk[Math.floor(random() * trunk.length)].line, j = 1 + Math.floor(random() * (t.length - 2));
      const d = unit(t[j - 1], t[j + 1] ?? t[j]), dir = turn([-d[1], d[0]], (random() < 0.5 ? 0 : 180) + (random() - 0.5) * 50);
      const line = walk(k, t[j], dir, pick(random, [m(40), m(160)]), { step: m(5), curl: 12, test });
      if (line.length > 3) streets.push({ line, tags, half });
    }
    return { streets };
  },
};
function boundsOf(paths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const q of p) { x0 = Math.min(x0, q.X); y0 = Math.min(y0, q.Y); x1 = Math.max(x1, q.X); y1 = Math.max(y1, q.Y); }
  return [[x0 / S, y0 / S], [x1 / S, y1 / S]];
}
