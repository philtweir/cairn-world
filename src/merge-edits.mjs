// Merge edits exported from the explorer (explorer/drafts.mjs, format cairn-edits/1) into the
// layer they were made in: layers/<layer>/data/<model>.csv. Then `npm run check` (or build).
//
//   npm run merge-edits -- cairn-edits-<layer>.json [--layer <key>] [--dry-run]
//
// The export is the layer's own rows, so merging keeps the layer semantics the explorer showed:
//   - a single-valued field's cell replaces the layer's (on the entry's first row);
//   - a repeatable field's cell (cardinality n: links, term lists) adds to the layer's;
//   - a row of a repeatable group (a tie, a scar) is added after the entry's rows;
//   - an entry the layer does not have yet is added at the end;
//   - a renamed entry keeps its references: [[Old Name]] in this layer, and in the campaigns set
//     in it, becomes [[model/key|Old Name]] (the old name resolves no more where the new one shows).
// A column the file lacks is added to its header; every row not changed stays as it was, byte
// for byte.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv } from './csv.mjs';
import { REF, normName } from './refs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT = 'cairn-edits/1';

const args = process.argv.slice(2);
const flag = k => args.includes(`--${k}`);
const option = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--layer');
const fail = msg => { console.error(`error: ${msg}`); process.exit(1); };
if (!file) fail('usage: npm run merge-edits -- <edits.json> [--layer <key>] [--dry-run]');

const edits = JSON.parse(fs.readFileSync(file, 'utf8'));
if (edits.format !== FORMAT) fail(`${file} is not an edits export (format ${edits.format ?? 'missing'}, expected ${FORMAT})`);
const layer = option('layer') ?? edits.layer;
const layerDir = path.join(ROOT, 'layers', layer);
if (!/^[a-z0-9-]+$/.test(layer ?? '') || !fs.existsSync(path.join(layerDir, 'layer.json'))) fail(`no layer "${layer}" (layers/${layer}/layer.json)`);

// A model's fields, from its CSV (General's model/, or a layer's own).
function fieldsOf(alias) {
  const dirs = [path.join(ROOT, 'model'), ...fs.readdirSync(path.join(ROOT, 'layers')).map(k => path.join(ROOT, 'layers', k, 'model'))];
  const f = dirs.map(d => path.join(d, `${alias}.csv`)).find(x => fs.existsSync(x));
  if (!f) fail(`no model "${alias}"`);
  const [head, ...rows] = parseCsv(fs.readFileSync(f, 'utf8'));
  const nodes = rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  const card = Object.fromEntries(nodes.map(n => [n.alias, n.cardinality]));
  // A field is added to, not replaced, if it repeats or sits in a group that does.
  return new Map(nodes.map(n => [n.alias, { adds: n.parent_alias ? card[n.parent_alias] === 'n' : n.cardinality === 'n', inGroup: !!n.parent_alias && card[n.parent_alias] === 'n' }]));
}

// A CSV's records with their text as written, so the unchanged ones are written back as they were.
function records(text) {
  const out = [];
  let start = 0, quoted = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if ((c === '\n' || c === undefined) && !quoted) {
      const raw = text.slice(start, i).replace(/\r$/, '');
      if (raw.trim()) out.push({ raw, cells: parseCsv(raw)[0] ?? [] });
      start = i + 1;
    }
  }
  return out;
}
const line = cells => toCsv([cells]).slice(0, -1);
const splitList = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

let changed = 0;
for (const [alias, rows] of Object.entries(edits.tables ?? {})) {
  const fields = fieldsOf(alias);
  for (const r of rows) for (const k of Object.keys(r)) if (k !== 'ResourceID' && !fields.has(k)) fail(`model "${alias}" has no field "${k}"`);
  const target = path.join(layerDir, 'data', `${alias}.csv`);
  const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const [head = { raw: null, cells: ['ResourceID'] }, ...body] = records(text);
  const header = [...head.cells];
  const col = name => { if (!header.includes(name)) header.push(name); return header.indexOf(name); };
  const log = { set: 0, added: 0, rows: 0, columns: [] };
  const before = header.length;

  // The export's rows by entry, in order: the first is its cells unless it is a group row.
  const byKey = new Map();
  for (const { ResourceID: key, ...cells } of rows) (byKey.get(key) ?? byKey.set(key, []).get(key)).push(cells);
  for (const [key, list] of byKey) {
    const isGroupRow = cells => Object.keys(cells).length > 0 && Object.keys(cells).every(k => fields.get(k).inGroup);
    const first = isGroupRow(list[0]) ? {} : list[0];
    const groupRows = list.filter(c => c !== first);
    const mine = body.filter(r => r.cells[0] === key);
    if (!mine.length) {
      // New to this layer: its rows go at the end.
      const own = [first, ...groupRows].filter(c => Object.keys(c).length);
      for (const cells of own.length ? own : [{}]) {
        const out = [key]; for (const [k, v] of Object.entries(cells)) out[col(k)] = v;
        body.push({ raw: null, cells: out });
        log.rows++;
      }
      log.added++;
      continue;
    }
    const row = mine[0];
    for (const [k, v] of Object.entries(first)) {
      const j = col(k), was = row.cells[j] ?? '';
      const now = fields.get(k).adds ? [...new Set([...splitList(was), ...splitList(v)])].join(',') : v;
      if (now !== was) { row.cells[j] = now; row.raw = null; log.set++; }
    }
    // Group entries go after the entry's last row.
    let at = body.indexOf(mine.at(-1));
    for (const cells of groupRows) {
      const out = [key]; for (const [k, v] of Object.entries(cells)) out[col(k)] = v;
      body.splice(++at, 0, { raw: null, cells: out });
      log.rows++;
    }
  }
  log.columns = header.slice(before);
  const touched = log.set || log.rows || log.columns.length;
  if (!touched) { console.log(`${path.relative(ROOT, target)}: nothing to change`); continue; }
  const out = [head.raw !== null && !log.columns.length ? head.raw : line(header), ...body.map(r => r.raw ?? line(Array.from(r.cells, c => c ?? '')))].join(eol) + eol;
  console.log(`${path.relative(ROOT, target)}: ${[log.set && `${log.set} cell(s) set`, log.added && `${log.added} new entr${log.added === 1 ? 'y' : 'ies'}`, log.rows && `${log.rows} row(s) added`, log.columns.length && `new column(s) ${log.columns.join(', ')}`].filter(Boolean).join('; ')}`);
  if (!flag('dry-run')) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, out); }
  changed++;
}
// References by a renamed entry's old name, in the layers that see the new one: this layer and
// the campaigns set in it (a campaign's campaign.csv row lists its universes).
const renamed = Object.entries(edits.renamed ?? {});
if (renamed.length) {
  const above = fs.readdirSync(path.join(ROOT, 'layers')).filter(k => {
    const f = path.join(ROOT, 'layers', k, 'data', 'campaign.csv');
    if (!fs.existsSync(f)) return false;
    const [head, ...rows] = parseCsv(fs.readFileSync(f, 'utf8'));
    const u = head.indexOf('universes');
    return rows.some(r => r[0] === k && splitList(r[u]).includes(layer));
  });
  const old = new Map(renamed.map(([route, name]) => [normName(name), route]));
  for (const key of [layer, ...above]) {
    const dir = path.join(ROOT, 'layers', key, 'data');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.csv')).sort()) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      let n = 0;
      const out = text.replace(REF, (raw, target, label) => {
        const route = !target.includes('/') && old.get(normName(target));
        if (!route) return raw;
        n++;
        return `[[${route}|${label ?? target}]]`;
      });
      if (!n) continue;
      console.log(`layers/${key}/data/${f}: ${n} reference(s) to a renamed entry made exact`);
      if (!flag('dry-run')) fs.writeFileSync(path.join(dir, f), out);
      changed++;
    }
  }
}

console.log(flag('dry-run') ? 'dry run: nothing written' : changed ? 'merged; now run `npm run check` (or `npm run build`)' : 'nothing to merge');
