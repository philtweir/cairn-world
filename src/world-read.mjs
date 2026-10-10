// Read the whole world back through Alizarin's ORM into plain objects.
// Shared by the Node build (its read-back check) and the browser explorer, so both see the same data.
//
// Input is a view's manifest.json plus an initialised graphManager (client already set).
//
// An entity is { model, id, key, layers, fields }. A field is { alias, label, datatype, targets,
// rule, value }. A group (a `semantic` node, such as a PC's ties) has datatype 'semantic' and a
// value that is a list of { fields } items, one per entry; a single-valued group is a list of one.

import { makeResolver, refsIn } from './refs.mjs';

const isNull = v => v === null || v === undefined;

// All values of a list field. A cardinality-n field is a PseudoList of per-tile entries, which
// Alizarin flattens; a single-valued list field is already a plain list.
async function items(v) {
  const list = typeof v.flattened === 'function' ? await v.flattened() : await Promise.all(Array.from(v, x => x));
  return list.filter(x => x !== null && x !== undefined);
}

async function readField(entity, node) {
  const v = await entity[node.alias];
  if (isNull(v)) return null;
  switch (node.datatype) {
    case 'number': return Number(v);
    case 'boolean': return v === true || v === 'true';
    case 'geojson-feature-collection': return await v.forJson();
    case 'concept-list': return (await items(v)).map(String);
    case 'resource-instance': return [(await v).id];
    case 'resource-instance-list': return (await items(v)).map(x => x.id).filter(id => typeof id === 'string');
    default: { const s = String(v); return s === '' ? null : s; }
  }
}

const empty = v => v === null || (Array.isArray(v) && !v.length);
const fieldOf = (node, value) => ({ alias: node.alias, label: node.name, datatype: node.datatype, targets: node.targets, collection: node.collection ?? null, rule: node.rule ?? null, property: node.property ?? null, value });

async function readGroup(entity, node, children) {
  const v = await entity[node.alias];
  if (isNull(v)) return null;
  // Each entry of a repeatable group is its own tile; a single group is one.
  const entries = node.cardinality === 'n' ? await Promise.all(Array.from(v, x => x)) : [v];
  const out = [];
  for (const entry of entries.filter(x => !isNull(x))) {
    const fields = [];
    for (const c of children) fields.push(fieldOf(c, await readField(entry, c)));
    if (fields.some(f => !empty(f.value))) out.push({ fields });
  }
  return out.length ? out : null;
}

const P67 = 'http://www.cidoc-crm.org/cidoc-crm/P67_refers_to';
const titleOf = e => e.fields.find(f => f.alias === 'name')?.value ?? e.key;

// Resolves [[...]] references against a view's entities: target -> entity or null.
export function resolverFor(entities) {
  const resolve = makeResolver(entities.map(e => ({ model: e.model, key: e.key, name: titleOf(e), e })));
  return target => resolve(target).hit?.e ?? null;
}

// How a [[reference]] in `from`'s text stands to its referent `to`: 'rel' if `from` links to it by a
// real (not derived) field, 'rel-in' if only `to` links back, 'mention' if neither. A mention-only
// reference may be a passing remark, or a relationship that should be recorded (a sibling, say).
export function refRelation(from, to, back) {
  if (!from || !to) return 'rel';
  if (links(from).some(l => !l.derived && l.id === to.id)) return 'rel';
  if ((back.get(from.id) ?? []).some(b => !b.derived && b.from.id === to.id)) return 'rel-in';
  return 'mention';
}

// Every [[reference]] in an entity's text becomes a derived "Mentions" link (P67 refers to: the
// text refers to its referent), so mentions show up in backlinks and graphs like any link.
function addMentions(entities) {
  const resolve = resolverFor(entities);
  for (const e of entities) {
    const texts = e.fields.flatMap(f => (typeof f.value === 'string' ? [f.value] : f.datatype === 'semantic' ? (f.value ?? []).flatMap(i => i.fields.map(c => c.value).filter(v => typeof v === 'string')) : []));
    const ids = [...new Set(texts.flatMap(refsIn).map(r => resolve(r.target)?.id).filter(id => id && id !== e.id))];
    if (ids.length) e.fields.push({ alias: 'mentions', label: 'Mentions', datatype: 'resource-instance-list', targets: ['*'], collection: null, rule: null, property: P67, value: ids, derived: true });
  }
}

export async function readEntities(graphManager, manifest, onProgress = () => {}) {
  const entities = [];
  for (const m of manifest.models) {
    // get() accepts the display name ("Monster Type") as well as the class name ("MonsterType").
    const all = await (await graphManager.get(m.name)).all();
    const entryOf = new Map(m.entries.map(e => [e.id, e]));
    const top = m.nodes.filter(n => !n.parent);
    for (const e of all) {
      const entry = entryOf.get(e.id);
      const fields = [];
      for (const n of top) {
        const value = n.datatype === 'semantic'
          ? await readGroup(e, n, m.nodes.filter(c => c.parent === n.alias))
          : await readField(e, n);
        fields.push(fieldOf(n, value));
      }
      entities.push({ model: m.alias, id: e.id, key: entry?.key ?? e.id, layers: entry?.layers ?? [], fields });
    }
    onProgress(m, entities.length);
  }
  addMentions(entities);
  return entities;
}

// Every outgoing link of an entity: { id, label }. Links inside a group are labelled with the
// group and its entry's other values ("Ties: Mentor"), which is what makes them typed.
export function links(e) {
  const out = [];
  for (const f of e.fields) {
    if (f.datatype === 'semantic') {
      for (const item of f.value ?? []) {
        const words = item.fields.filter(c => !c.targets.length && !empty(c.value) && c.datatype !== 'string').map(c => [].concat(c.value).join(', '));
        const label = words.length ? `${f.label}: ${words.join(', ')}` : f.label;
        // A group with a single field (a text that refers to things) is labelled by the group.
        const plain = c => (item.fields.length === 1 ? f.label : `${f.label}: ${c.label}`);
        for (const c of item.fields) if (c.targets.length && c.value) for (const id of c.value) out.push({ id, label: words.length ? label : plain(c), property: c.property, derived: false });
      }
    } else if (f.targets.length && f.value) for (const id of f.value) out.push({ id, label: f.label, property: f.property, derived: !!f.derived });
  }
  return out;
}

// Reverse edges: id -> [{ from: entity, via: field label, property }].
export function backlinks(entities) {
  const out = new Map();
  for (const e of entities) {
    for (const { id, label, property, derived } of links(e)) {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ from: e, via: label, property, derived });
    }
  }
  return out;
}
