// Edits made in the explorer: one more layer on top of the view's stack, kept in this browser
// (IndexedDB) until exported. An edit is written the way a layer's CSV is
// (layers/<key>/data/<model>.csv): a row keyed by ResourceID, a cell per field, in the same
// cell syntax (links by slug, terms by label, [[references]] in text). explorer/store.mjs builds
// the rows into resources with Alizarin's CSV loader and composes them over the published entries
// with its layer composition, so an edited entry reads as it will once the edits are in the files.
//
// The layer semantics carry over: a single-valued field in the edit replaces the one below; a
// repeatable field or group (cardinality n) adds to what is below, and nothing below is removed.
//
// The export ({ format, layer, build, tables }) is that layer's rows, by model; src/merge-edits.mjs
// writes them into layers/<layer>/data/, and the next build has them.

export const FORMAT = 'cairn-edits/1';

// entry: { model, key, created, cells: { field: cell }, rows: [{ field: cell }] } -- `cells` are
// the first row's (single-valued fields replace, repeatable ones add), `rows` further rows, each
// one more entry in a repeatable group (a tie, a scar).
export async function openDrafts(view, build) {
  const db = await openDb();
  const blank = () => ({ format: FORMAT, layer: view, build, entries: {} });
  let doc = (await db.get(view)) ?? blank();
  const save = () => db.put(view, doc);
  const id = (model, key) => `${model}/${key}`;
  return {
    view,
    list: () => Object.values(doc.entries),
    get: (model, key) => doc.entries[id(model, key)] ?? null,
    async put(entry) { doc.entries[id(entry.model, entry.key)] = entry; await save(); },
    async remove(model, key) { delete doc.entries[id(model, key)]; await save(); },
    async clear() { doc = blank(); await save(); },
    // The layer's rows by model, as a layer CSV would hold them. `renamed` (model/key -> the name
    // it had) lets the merge keep [[Old Name]] references pointing at a renamed entry.
    exported: (renamed = {}) => ({
      format: FORMAT, layer: view, build, exported: new Date().toISOString(),
      renamed,
      // Entries the edits make (not in any layer below), so a reimport knows them.
      created: Object.values(doc.entries).filter(e => e.created).map(e => id(e.model, e.key)),
      tables: Object.values(doc.entries).reduce((t, e) => {
        const first = { ResourceID: e.key, ...e.cells };
        const rows = Object.keys(e.cells).length || !e.rows.length ? [first, ...e.rows.map(r => ({ ResourceID: e.key, ...r }))] : e.rows.map(r => ({ ResourceID: e.key, ...r }));
        (t[e.model] ??= []).push(...rows);
        return t;
      }, {}),
    }),
    // An export read back in (from this browser or another): its rows replace the edits here to
    // the same entries. `groupFields(model)` is the set of fields inside repeatable groups (whose
    // cells make a row of their own), or null for a model the view does not have.
    async imported(file, groupFields) {
      if (file?.format !== FORMAT) throw new Error(`not an edits file (format ${file?.format ?? 'missing'}, expected ${FORMAT})`);
      if (file.layer !== view) throw new Error(`these edits are for "${file.layer}", not "${view}"`);
      const got = {};
      for (const [model, rows] of Object.entries(file.tables ?? {})) {
        const group = groupFields(model);
        if (!group) throw new Error(`no model "${model}" in this view`);
        for (const { ResourceID: key, ...row } of rows) {
          if (!key) continue;
          const e = got[id(model, key)] ??= { model, key, created: !!file.created?.includes(id(model, key)), cells: {}, rows: [] };
          const part = inGroup => Object.fromEntries(Object.entries(row).filter(([f, v]) => v !== '' && group.has(f) === inGroup));
          Object.assign(e.cells, part(false));
          if (Object.keys(part(true)).length) e.rows.push(part(true));
        }
      }
      Object.assign(doc.entries, got);
      await save();
      return Object.keys(got).length;
    },
  };
}

// A key-value store in IndexedDB, or in memory where there is none (a private window).
async function openDb() {
  const memory = new Map();
  const fallback = { get: async k => memory.get(k), put: async (k, v) => { memory.set(k, v); } };
  if (typeof indexedDB === 'undefined') return fallback;
  try {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('cairn-world', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('edits');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const run = (mode, f) => new Promise((resolve, reject) => {
      const tx = db.transaction('edits', mode);
      const req = f(tx.objectStore('edits'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
    return { get: k => run('readonly', s => s.get(k)), put: (k, v) => run('readwrite', s => s.put(structuredClone(v), k)) };
  } catch {
    return fallback;
  }
}
