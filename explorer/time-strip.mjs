// A thin strip of time: entries with a time-span (events, mostly) in order, placed by their dates
// where they have them (an EDTF field, src/edtf.mjs) and by what comes before what where they do
// not. It sits on an entry's page under its map, and above the Events & Times list, as the map
// does for places: one hairline, a dot an entry, the one in hand marked and named.
//
// How it reads:
//   - a dated entry is a filled dot; a span (an interval, "the 800s") a short bar; an approximate
//     or uncertain date is fainter;
//   - an undated entry is a hollow dot, put where the order says (after this, before that);
//   - the axis is not linear: each gap between dates is given room by the log of its length, so
//     "400 years before" and "day 2 of play" share one strip; a long gap shows a break (≈);
//   - the world's eras lie behind as faint bands, named at their left edge;
//   - years are labelled below where they fit, in the world's calendar (layer.json "calendar").
// Every mark links to its entry and says its name and date on hover.

import { readEdtf, formatEdtf, formatYear } from '../src/edtf.mjs';

// What must come before what, by the lens's "before" properties (and their inverses, such as an
// event's "after"): id -> the ids that come first, among `list`.
export function precedence(ctx, lens, list) {
  const ids = new Set(list.map(e => e.id));
  const props = ctx.ontology.properties;
  const fwd = new Set(lens.before ?? []), inv = new Set((lens.before ?? []).map(p => props[p]?.inverse).filter(Boolean));
  const first = new Map(list.map(e => [e.id, new Set()]));
  for (const e of list) for (const l of ctx.links(e)) {
    if (!ids.has(l.id) || l.id === e.id) continue;
    if (fwd.has(l.property)) first.get(l.id).add(e.id);
    else if (inv.has(l.property)) first.get(e.id).add(l.id);
  }
  return first;
}

// An entry's date: its first EDTF field, read.
export const dateOf = e => {
  const f = e.fields?.find(x => x.datatype === 'edtf' && x.value);
  return f ? readEdtf(f.value) : null;
};

// Where each entry goes: { slots: [{ item, year, end }], years: [[slot index, year]] }, or null if
// fewer than two can be placed. An item is { e, t (its date), first (ids before it) }.
function arrange(items, focusId, min = 2) {
  const byId = new Map(items.map(x => [x.id, x]));
  const next = new Map(items.map(x => [x.id, []]));
  for (const x of items) for (const p of x.first) next.get(p)?.push(x.id);
  // A dated entry's key is its start (or its end, if its start is open); an undated one takes the
  // latest key of what comes before it, else the earliest of what comes after.
  const key = new Map(items.filter(x => x.t).map(x => [x.id, x.t.lo ?? x.t.end.lo]));
  for (let round = 0; round < items.length; round++) {
    let changed = false;
    for (const x of items) {
      if (x.t) continue;
      const before = [...x.first].map(p => key.get(p)).filter(v => v != null);
      const after = next.get(x.id).map(s => key.get(s)).filter(v => v != null);
      const k = before.length ? Math.max(...before) : after.length ? Math.min(...after) : null;
      if (k != null && key.get(x.id) !== k) { key.set(x.id, k); changed = true; }
    }
    if (!changed) break;
  }
  // By date, if there are dates (and the entry in hand can be placed among them); else by order
  // alone, among the entries that some order joins.
  const dated = items.some(x => x.t) && (!focusId || key.has(focusId));
  const joined = new Set(items.filter(x => x.first.size || next.get(x.id).length).map(x => x.id));
  const keep = items.filter(x => (dated ? key.has(x.id) : joined.has(x.id) || x.id === focusId));
  if (keep.length < (dated ? min : 2)) return null;
  // In order: what must come first does, then the earlier key, then the name.
  const kept = new Set(keep.map(x => x.id)), done = new Set(), order = [];
  const rank = x => [dated ? key.get(x.id) : 0, x.title];
  const cmp = (a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1].localeCompare(rank(b)[1]);
  while (order.length < keep.length) {
    const ready = keep.filter(x => !done.has(x.id) && [...x.first].every(p => !kept.has(p) || done.has(p))).sort(cmp);
    const x = ready[0] ?? keep.filter(y => !done.has(y.id)).sort(cmp)[0];   // a cycle: break it
    order.push(x); done.add(x.id);
  }
  // Slots: one an entry, and one more where a span ends. A dated slot's year places it, unless
  // it would run backwards (an order that contradicts the dates): then it is placed as undated.
  const slots = order.map(x => ({ item: x, year: dated && x.t ? key.get(x.id) : null }));
  for (const x of order) {
    const t = x.t;
    if (!dated || !t || t.lo == null || t.hi == null || t.hi - t.lo <= 1.001) continue;
    const at = slots.findIndex((s, i) => i > slots.findIndex(z => z.item === x) && s.year != null && s.year > t.hi);
    slots.splice(at < 0 ? slots.length : at, 0, { item: null, end: x, year: t.hi });
  }
  let last = -Infinity;
  for (const s of slots) { if (s.year != null && s.year < last) s.year = null; else if (s.year != null) last = s.year; }
  return { slots, dated, left: items.length - keep.length };
}

// ctx: the explorer's (h, svg, route, title); entries: the entries to place; focus: the one in
// hand, if any; lens: the time lens; bands: [{ name, t }] eras; calendar: the world's.
export function timeStrip(ctx, { entries, focus = null, lens, bands = [], calendar = null, colour = () => '', label = 'When' }) {
  const { h, svg, route, title } = ctx;
  const first = precedence(ctx, lens, entries);
  const items = entries.map(e => ({ id: e.id, e, t: dateOf(e), first: first.get(e.id) ?? new Set(), title: title(e) }));
  // One entry is enough when there are eras to place it among.
  const plan = arrange(items, focus?.id ?? null, bands.length ? 1 : 2);
  if (!plan) return null;
  const { slots, dated, left } = plan;

  // Room for each gap: the log of its length in years (a season is a quarter), at least a step.
  const gaps = slots.slice(1).map((s, i) => {
    const a = slots[i].year, b = s.year;
    return a != null && b != null ? { w: 1 + Math.log1p(Math.max(0, b - a) * 4), span: b - a } : { w: 1, span: null };
  });
  const box = h('figure', { class: 'timestrip', 'aria-label': label });
  const H = 62, AXIS = 30;

  const draw = width => {
    const pad = Math.min(56, width * 0.08), usable = width - 2 * pad;
    const total = gaps.reduce((n, g) => n + g.w, 0) || 1;
    let at = 0;
    const xs = slots.map((s, i) => { if (i) at += gaps[i - 1].w; return pad + (slots.length === 1 ? usable / 2 : (at / total) * usable); });
    // A year's place: between the dated slots either side of it.
    const anchors = slots.map((s, i) => [s.year, xs[i]]).filter(([y]) => y != null);
    const xOf = y => {
      if (!anchors.length) return null;
      if (y <= anchors[0][0]) return anchors[0][1];
      for (let i = 1; i < anchors.length; i++) {
        const [y0, x0] = anchors[i - 1], [y1, x1] = anchors[i];
        if (y <= y1) return y1 === y0 ? x1 : x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
      }
      return anchors.at(-1)[1];
    };
    const marks = [];
    // Eras behind, where they meet what is shown.
    if (dated && anchors.length) {
      const [y0, y1] = [anchors[0][0], anchors.at(-1)[0]];
      const shown = bands.map(b => {
        const lo = b.t.lo ?? -Infinity, hi = b.t.hi ?? Infinity;
        if (hi < y0 || lo > y1) return null;
        const a = lo <= y0 ? 0 : xOf(lo), z = hi >= y1 ? width : xOf(hi);
        return z - a < 2 ? null : { b, a, z };
      }).filter(Boolean);
      // Named at their left edge, the innermost (the last given) first, where the name fits.
      const named = new Set(), taken = [];
      for (const x of [...shown].reverse()) {
        const w = x.b.name.length * 5.6 + 8;
        if (x.z - x.a < w || taken.some(([p, q]) => x.a < q && x.a + w > p)) continue;
        named.add(x); taken.push([x.a, x.a + w]);
      }
      for (const x of shown) marks.push(svg('g', { class: 'band' }, svg('rect', { x: x.a, y: 0, width: x.z - x.a, height: H }),
        named.has(x) ? svg('text', { x: x.a + 4, y: H - 4 }, x.b.name) : null, svg('title', {}, `${x.b.name}: ${formatEdtf(x.b.t, calendar)}`)));
    }
    marks.push(svg('line', { class: 'axis', x1: Math.max(0, xs[0] - pad / 2), x2: Math.min(width, xs.at(-1) + pad / 2), y1: AXIS, y2: AXIS }));
    // Breaks: a gap much longer than the rest.
    const spans = gaps.map(g => g.span).filter(s => s > 0);
    const small = spans.length ? Math.min(...spans) : 0;
    gaps.forEach((g, i) => {
      if (g.span != null && spans.length > 1 && g.span >= 50 && g.span >= small * 20) {
        const x = (xs[i] + xs[i + 1]) / 2;
        marks.push(svg('text', { class: 'break', x, y: AXIS + 4, 'text-anchor': 'middle' }, '≈'));
      }
    });
    // Spans first, under the dots.
    for (const [i, s] of slots.entries()) {
      if (!s.end) continue;
      const from = slots.findIndex(z => z.item === s.end);
      const fuzzy = s.end.t.approximate || s.end.t.uncertain;
      marks.push(svg('line', { class: `span ${colour(s.end.e)}${fuzzy ? ' fuzzy' : ''}`, x1: xs[from], x2: xs[i], y1: AXIS, y2: AXIS, 'data-id': s.end.id }));
    }
    // An open start or end runs to the edge.
    for (const [i, s] of slots.entries()) {
      const t = s.item?.t;
      if (!t || !(t.open.lo || t.open.hi)) continue;
      marks.push(svg('line', { class: `span open ${colour(s.item.e)}`, x1: t.open.lo ? 0 : xs[i], x2: t.open.hi ? width : xs[i], y1: AXIS, y2: AXIS }));
    }
    for (const [i, s] of slots.entries()) {
      if (!s.item) continue;
      const x = s.item, t = x.t, here = x.id === focus?.id;
      const when = t ? formatEdtf(t, calendar) : 'undated';
      marks.push(svg('a', { href: route(x.e), class: `mark ${colour(x.e)}${here ? ' here' : ''}${!t ? ' undated' : t.approximate || t.uncertain ? ' fuzzy' : ''}`, 'data-id': x.id },
        svg('circle', { cx: xs[i], cy: AXIS, r: here ? 6 : 4.5 }),
        svg('title', {}, `${x.title} · ${when}`)));
    }
    // Years below, where they fit (the one in hand's always); its name above.
    // A span's end slot is labelled with its last year, not the year after it.
    let lastX = -Infinity;
    const fi = focus ? slots.findIndex(s => s.item?.id === focus.id) : -1;
    const yearAt = i => (slots[i].year == null ? null : formatYear(slots[i].end ? slots[i].end.t.end.year : slots[i].year, calendar));
    const keepAt = new Set(fi >= 0 && yearAt(fi) ? [fi] : []);
    const said = new Set([...keepAt].map(yearAt));
    for (const [i] of slots.entries()) {
      const lab = yearAt(i);
      if (!lab || said.has(lab)) continue;
      if (xs[i] - lastX < 66 || (fi >= 0 && i !== fi && Math.abs(xs[i] - xs[fi]) < 66)) continue;
      keepAt.add(i); said.add(lab); lastX = xs[i];
    }
    for (const i of keepAt) marks.push(svg('text', { class: 'year', x: xs[i], y: AXIS + 17, 'text-anchor': 'middle' }, yearAt(i)));
    if (fi >= 0) {
      const anchor = xs[fi] < width * 0.2 ? 'start' : xs[fi] > width * 0.8 ? 'end' : 'middle';
      marks.push(svg('text', { class: 'name', x: xs[fi], y: AXIS - 11, 'text-anchor': anchor }, title(focus)));
    }
    box.replaceChildren(...[svg('svg', { viewBox: `0 0 ${width} ${H}`, width, height: H, role: 'group' }, marks),
      !dated ? h('figcaption', {}, 'In order; not yet dated.')
        : left && !focus ? h('figcaption', {}, `${left} more not yet dated, so not placed.`) : null].filter(Boolean));
  };
  let drawn = 0;
  const redraw = w => { w = Math.round(w); if (w > 0 && Math.abs(w - drawn) > 4) { drawn = w; draw(w); } };
  redraw(640);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(([x]) => redraw(x.contentRect.width)).observe(box);
  return box;
}
