// Who may see what of a view, and from when: role-based access with a clock. Nothing in it is
// about games; the words are principals, grants and epochs.
//
// Any layer may hold layers/<key>/access/:
//   principals.csv  principal,name,member_of
//     A principal is `user:<slug>` or `group:<slug>`; `everyone` is built in, and every principal
//     is in it. `member_of` lists groups (comma-separated); a member has every grant its groups
//     have, and their groups' in turn.
//   epochs.csv      epoch,name,date
//     The layer's clock: epoch 1, 2, ... as they happen. Epoch 0 (before any) is implicit. The
//     layer's current epoch is its last row.
//   grants.csv      principal,target,fields,permission,from
//     target: `*`, `layer:<key>` (every entry that layer has), `model:<alias>`, or `<model>/<key>`.
//     fields: field aliases (comma-separated), or blank for the whole entry. A field inside a
//       group grants its whole group (Arches grants by nodegroup).
//     permission: `read` (the fields, or all of it) or `discover` (that it exists, and its name).
//     from: the epoch it starts at (blank: 0). Grants never end, so what a principal may see only
//       grows with the clock: the window at epoch T holds the window at every epoch before it.
//
// A view is closed when its own layer.json says "access": { "closed": true } (and optionally a
// "default" principal to view as). In a closed view the grants of every layer in its stack apply:
// a universe or era can say what is common knowledge for all the campaigns set in it. A grant
// whose `from` is past its layer's current epoch is held back: it is not published at all until
// the epoch it names is added to epochs.csv. Grants from the view's own layer keep their epoch (the
// explorer can look back to any of them); grants from the layers below are on from the start.
// A view that is not closed is open to everyone, as before; its layers' grants still apply to the
// closed views above it.
//
// A gated view's gate (layer.json "gate", src/set-password.mjs) can name a principal; in a closed
// view the gate is then that principal's credential, not a door: anyone may open the view, and
// viewing as that principal (or as any member of it) asks for the password.
//
// The resolved grants, one row per principal, entry and nodegroup (null: the whole entry), are
// written to views/<view>/tables/access.parquet (src/tables.mjs). What a principal may see is
// worked out in the explorer (explorer/store.mjs, setWindow). This only filters what the explorer
// shows: the published files hold everything, as the gate's do.

import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './csv.mjs';

export const PERMISSIONS = ['read', 'discover'];
export const EVERYONE = 'everyone';
const PRINCIPAL = /^(everyone|(user|group):[a-z0-9][a-z0-9-]*)$/;
const COLUMNS = {
  principals: ['principal', 'name', 'member_of'],
  epochs: ['epoch', 'name', 'date'],
  grants: ['principal', 'target', 'fields', 'permission', 'from'],
};
const splitList = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

// A layer's access files as rows ({ file, line, get }), or null if it has none.
export function readAccess(layersDir, key, problem) {
  const dir = path.join(layersDir, key, 'access');
  if (!fs.existsSync(dir)) return null;
  const out = {};
  for (const [name, cols] of Object.entries(COLUMNS)) {
    const file = path.join(dir, `${name}.csv`);
    out[name] = [];
    if (!fs.existsSync(file)) continue;
    const [head = [], ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(path.dirname(layersDir), file);
    for (const c of head) if (!cols.includes(c)) problem(`${rel}: unknown column "${c}" (expected ${cols.join(', ')})`);
    rows.forEach((r, i) => out[name].push({ file: rel, line: i + 2, get: Object.fromEntries(cols.map(c => [c, (r[head.indexOf(c)] ?? '').trim()])) }));
  }
  for (const f of fs.readdirSync(dir)) if (!Object.keys(COLUMNS).includes(f.replace(/\.csv$/, ''))) problem(`layers/${key}/access/${f}: not an access file (principals.csv, epochs.csv, grants.csv)`);
  return out;
}

// A layer's epochs, checked: [{ epoch, name, date }] in order, and its current epoch.
function clock(acc, problem) {
  const epochs = [];
  for (const r of acc?.epochs ?? []) {
    const n = Number(r.get.epoch);
    if (!Number.isInteger(n) || n !== epochs.length + 1) { problem(`${r.file}:${r.line} epoch "${r.get.epoch}" should be ${epochs.length + 1} (epochs count up from 1, one row each)`); continue; }
    epochs.push({ epoch: n, name: r.get.name || `Epoch ${n}`, date: r.get.date || null });
  }
  return { epochs, current: epochs.length };
}

// Everything a closed view's grants come to.
//   view: its key; stack: its layers, bottom first; access: layer key -> readAccess's result;
//   models: [{ alias, nodes: [{ alias, nodegroup_id }] }]; entries: [{ id, model, key, layers }];
//   settings: the view's layer.json "access"; gate: its gate, if any.
// Returns { principals: [{ id, name, groups, gated }], epochs, default, grants: rows, held }.
export function resolveAccess({ view, stack, access, models, entries, settings, gate, problem }) {
  // Principals, from every layer in the stack.
  const principals = new Map([[EVERYONE, { id: EVERYONE, name: 'Anyone', member_of: [] }]]);
  for (const key of stack) for (const r of access[key]?.principals ?? []) {
    const id = r.get.principal;
    if (!PRINCIPAL.test(id)) { problem(`${r.file}:${r.line} principal "${id}" should be user:<slug> or group:<slug>`); continue; }
    if (id === EVERYONE) { problem(`${r.file}:${r.line} "everyone" is built in`); continue; }
    if (principals.has(id)) { problem(`${r.file}:${r.line} principal "${id}" is declared twice in ${view}'s stack`); continue; }
    principals.set(id, { id, name: r.get.name || id.replace(/^\w+:/, ''), member_of: splitList(r.get.member_of), row: r });
  }
  for (const p of principals.values()) for (const g of p.member_of) {
    if (!g.startsWith('group:') || !principals.has(g)) problem(`${p.row.file}:${p.row.line} ${p.id} is a member of "${g}", which is not a group declared in ${view}'s stack`);
  }
  // Each principal's groups, all the way up (itself and everyone included).
  const groupsOf = (id, seen = new Set()) => {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const g of principals.get(id)?.member_of ?? []) if (principals.has(g)) groupsOf(g, seen);
    return seen.add(EVERYONE);
  };
  const gatedBy = gate?.principal ?? null;
  if (gatedBy && !principals.has(gatedBy)) problem(`layers/${view}/layer.json gate.principal "${gatedBy}" is not declared in ${view}'s stack`);
  const listed = [...principals.values()].map(p => {
    const groups = [...groupsOf(p.id)].sort();
    return { id: p.id, name: p.name, groups, gated: !!gatedBy && groups.includes(gatedBy) };
  });
  const def = settings?.default ?? EVERYONE;
  if (!principals.has(def)) problem(`layers/${view}/layer.json access.default "${def}" is not declared in ${view}'s stack`);
  else if (listed.find(p => p.id === def).gated) problem(`layers/${view}/layer.json access.default "${def}" is behind the gate`);

  // Grants, resolved to entries and nodegroups.
  const own = clock(access[view], problem);
  const byModel = new Map(models.map(m => [m.alias, m]));
  const byRoute = new Map(entries.map(e => [`${e.model}/${e.key}`, e]));
  const out = new Map();   // principal|resource|nodegroup|permission -> row
  let held = 0;
  for (const key of stack) {
    const { current } = key === view ? own : clock(access[key], problem);
    for (const r of access[key]?.grants ?? []) {
      const g = r.get, where = `${r.file}:${r.line}`;
      if (!principals.has(g.principal)) { problem(`${where} principal "${g.principal}" is not declared in ${view}'s stack`); continue; }
      if (!PERMISSIONS.includes(g.permission)) { problem(`${where} permission "${g.permission}" should be ${PERMISSIONS.join(' or ')}`); continue; }
      const from = g.from === '' ? 0 : Number(g.from);
      if (!Number.isInteger(from) || from < 0) { problem(`${where} from "${g.from}" should be an epoch number`); continue; }
      const fields = splitList(g.fields);
      if (fields.length && g.permission === 'discover') { problem(`${where} discover is for whole entries (its name only); leave fields blank`); continue; }
      let hits;
      const t = g.target;
      if (t === '*') hits = entries;
      else if (t.startsWith('layer:')) {
        if (!stack.includes(t.slice(6))) { problem(`${where} target "${t}": no layer "${t.slice(6)}" in ${view}'s stack`); continue; }
        hits = entries.filter(e => e.layers.includes(t.slice(6)));
      } else if (t.startsWith('model:')) {
        if (!byModel.has(t.slice(6))) { problem(`${where} target "${t}": no model "${t.slice(6)}" in ${view}`); continue; }
        hits = entries.filter(e => e.model === t.slice(6));
      } else if (byRoute.has(t)) hits = [byRoute.get(t)];
      else { problem(`${where} target "${t}" is not *, layer:<key>, model:<alias> or a <model>/<key> in ${view}`); continue; }
      for (const f of fields) if (!hits.some(e => byModel.get(e.model).nodes.some(n => n.alias === f))) problem(`${where} field "${f}" is in none of the entries "${t}" names`);
      // Held back: its epoch has not come.
      if (from > current) { held++; continue; }
      const at = key === view ? from : 0;
      for (const e of hits) {
        const nodes = byModel.get(e.model).nodes;
        const ngs = fields.length ? [...new Set(fields.map(f => nodes.find(n => n.alias === f)?.nodegroup_id).filter(Boolean))] : [null];
        for (const ng of ngs) {
          const k = [g.principal, e.id, ng, g.permission].join('|');
          if (!out.has(k) || out.get(k).from > at) out.set(k, { principal: g.principal, resource_id: e.id, nodegroup_id: ng, permission: g.permission, from: at });
        }
      }
    }
  }
  return { principals: listed, epochs: own.epochs, default: def, grants: [...out.values()], held };
}
