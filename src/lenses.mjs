// Lenses: how the interface divides a view, derived from the ontology and nothing else.
//
// Each layout the interface knows how to draw is pinned to one CIDOC-CRM property that it is
// built on: a network of who belongs to whom, a map of what lies within what, a timeline of
// what has a time-span, and so on. The lens's class is that property's domain or range as the
// RDFS defines it, and its name is the class's CRM label. A model belongs to the lens whose
// class is its nearest ancestor in the CRM class hierarchy (ties go to the earlier lens). No
// model, field or category name appears here, so a new model in any layer finds its lens from
// its class alone, and a class from another ontology does through its declared CRM parent.
//
// Runs in Node (plain pages) and the browser (explorer); `ontology` is data/ontology.json.

export const CRM = 'http://www.cidoc-crm.org/cidoc-crm/';

// `up`: the anchor property points from part to whole (P89 falls within, P127 has broader
// term). Otherwise it points from whole to part (P148 has component, P107 has member) and its
// inverse is the one that points up.
export const LENSES = [
  { id: 'actors', layout: 'network', anchor: `${CRM}P107_has_current_or_former_member`, end: 'range', up: false },
  { id: 'places', layout: 'places', anchor: `${CRM}P89_falls_within`, end: 'domain', up: true },
  // Undated entries are ordered by CRM's "before" relations between temporal entities.
  { id: 'time', layout: 'timeline', anchor: `${CRM}P4_has_time-span`, end: 'domain', up: null,
    before: ['P176_starts_before_the_start_of', 'P182_ends_before_or_with_the_start_of', 'P183_ends_before_the_start_of'].map(p => CRM + p) },
  { id: 'things', layout: 'things', anchor: `${CRM}P52_has_current_owner`, end: 'domain', up: null },
  { id: 'propositions', layout: 'tree', anchor: `${CRM}P148_has_component`, end: 'domain', up: false },
  { id: 'types', layout: 'tree', anchor: `${CRM}P127_has_broader_term`, end: 'domain', up: true },
];
const FALLBACK = { id: 'other', layout: 'list', anchor: null, up: null, class: `${CRM}E1_CRM_Entity` };

// Every ancestor of a class (itself included) with its distance: Map(uri -> steps).
export function ancestors(ontology, cls) {
  const out = new Map([[cls, 0]]);
  const queue = [cls];
  while (queue.length) {
    const c = queue.shift();
    for (const p of ontology.classes[c]?.parents ?? []) if (!out.has(p)) { out.set(p, out.get(c) + 1); queue.push(p); }
  }
  return out;
}

// models: [{ alias, name, ontology }] -> { lenses: [lens + { class, label, comment, models }], lensOf: { alias: id } }
// Only lenses that some model falls into are returned, in LENSES order.
export function assignLenses(ontology, models) {
  const defined = [...LENSES.map(l => {
    const p = ontology.properties[l.anchor];
    return { ...l, class: p?.[l.end] };
  }).filter(l => l.class), FALLBACK];
  const lensOf = {};
  for (const m of models) {
    const up = ancestors(ontology, m.ontology);
    let best = null;
    for (const l of defined.slice(0, -1)) {
      const d = up.get(l.class);
      if (d !== undefined && (!best || d < best.d)) best = { l, d };
    }
    lensOf[m.alias] = (best?.l ?? FALLBACK).id;
  }
  const lenses = defined.filter(l => Object.values(lensOf).includes(l.id)).map(l => ({
    ...l, label: ontology.classes[l.class]?.label ?? l.class, comment: ontology.classes[l.class]?.comment ?? '',
    models: models.filter(m => lensOf[m.alias] === l.id).map(m => m.alias),
  }));
  return { lenses, lensOf };
}

// The parent of an entity within a hierarchical lens, following the lens's anchor property
// (or its inverse, whichever points up). `links` is world-read's links(); `inLens(id)` tests membership.
export function parentsOf(ontology, lens, e, links, inLens) {
  if (lens.up === null) return [];
  const upward = lens.up ? lens.anchor : ontology.properties[lens.anchor]?.inverse;
  return links(e).filter(l => l.property === upward && inLens(l.id)).map(l => l.id);
}
