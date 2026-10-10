// Read the whole world back through Alizarin's ORM into plain objects.
// Shared by the Node build (static pages) and the browser explorer, so both see the same data.
//
// Input is a view's manifest.json plus an initialised graphManager (client already set).

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
    case 'concept-list': return (await items(v)).map(String);
    case 'resource-instance': return [(await v).id];
    case 'resource-instance-list': return (await items(v)).map(x => x.id).filter(id => typeof id === 'string');
    default: { const s = String(v); return s === '' ? null : s; }
  }
}

export async function readEntities(graphManager, manifest, onProgress = () => {}) {
  const entities = [];
  for (const m of manifest.models) {
    // get() accepts the display name ("Monster Type") as well as the class name ("MonsterType").
    const all = await (await graphManager.get(m.name)).all();
    const entryOf = new Map(m.entries.map(e => [e.id, e]));
    for (const e of all) {
      const entry = entryOf.get(e.id);
      const fields = [];
      for (const n of m.nodes) fields.push({ alias: n.alias, label: n.name, datatype: n.datatype, targets: n.targets, value: await readField(e, n) });
      entities.push({ model: m.alias, id: e.id, key: entry?.key ?? e.id, layers: entry?.layers ?? [], fields });
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
