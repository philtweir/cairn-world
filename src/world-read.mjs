// Read the whole world back through Alizarin's ORM into plain objects.
// Shared by the Node build (static pages) and the browser explorer, so both see the same data.
//
// Input is the store's manifest.json plus an initialised graphManager (client already set).

const isNull = v => v === null || v === undefined;

// Cardinality-n nodes come back as one list per tile, each item possibly a list itself.
async function leaves(v, isLeaf) {
  const out = [];
  for (const item of Array.from(v)) {
    const x = await item;
    if (isNull(x)) continue;
    if (isLeaf(x)) out.push(x);
    else if (typeof x[Symbol.iterator] === 'function') out.push(...await leaves(x, isLeaf));
  }
  return out;
}

async function readField(entity, node) {
  const v = await entity[node.alias];
  if (isNull(v)) return null;
  switch (node.datatype) {
    case 'number': return Number(v);
    case 'concept-list': return (await leaves(v, x => typeof x === 'string' || x instanceof String)).map(String);
    case 'resource-instance': return [(await v).id];
    case 'resource-instance-list': return (await leaves(v, x => typeof x.id === 'string')).map(x => x.id);
    default: { const s = String(v); return s === '' ? null : s; }
  }
}

// The ORM names a model after its display name: "Monster Type" -> "MonsterType".
const ormName = (graphManager, display) => {
  const flat = display.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const found = [...graphManager.wkrms.keys()].find(k => k.toLowerCase() === flat);
  if (!found) throw new Error(`ORM has no model for ${display} (have ${[...graphManager.wkrms.keys()].join(', ')})`);
  return found;
};

export async function readEntities(graphManager, manifest, onProgress = () => {}) {
  const entities = [];
  for (const m of manifest.models) {
    const all = await (await graphManager.get(ormName(graphManager, m.name))).all();
    const entryOf = new Map(m.entries.map(e => [e.id, e]));
    for (const e of all) {
      const entry = entryOf.get(e.id);
      const fields = [];
      for (const n of m.nodes) fields.push({ alias: n.alias, label: n.name, datatype: n.datatype, targets: n.targets, value: await readField(e, n) });
      entities.push({ model: m.alias, id: e.id, key: entry?.key ?? e.id, origin: entry?.origin ?? 'data', fields });
    }
    onProgress(m, entities.length);
  }
  return entities;
}

// Reverse edges: id -> [{ from: entity, via: field label }].
export function backlinks(entities) {
  const out = new Map();
  for (const e of entities) {
    for (const f of e.fields) {
      if (!f.targets.length || !f.value) continue;
      for (const id of f.value) {
        if (!out.has(id)) out.set(id, []);
        out.get(id).push({ from: e, via: f.label });
      }
    }
  }
  return out;
}
