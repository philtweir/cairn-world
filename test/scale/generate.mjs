// A synthetic world of N entries, for measuring how what the explorer reads grows with the size
// of a world (test/scale/README.md). Written as a universe layer, the way an author would write
// one: CSVs in layers/<key>/data/, a layer.json, nothing the build treats specially.
//
//   node test/scale/generate.mjs <N> <layers dir> [key]
//
// The shape is fixed, so worlds of different sizes differ only in size: a quarter places (a
// hierarchy under one world-place), a tenth groups (nested), two fifths people (each in a group,
// with a home), a quarter events (in chains of ten, half dated, each with a place and people).
// Every entry links to a bounded number of others, except one hub: about a tenth of all entries
// mention "the world", so its backlinks grow with N, as a real world's busiest entries' do.
// Deterministic for a given N.

import fs from 'node:fs';
import path from 'node:path';

const [nArg, layersDir, key = 'scale'] = process.argv.slice(2);
const N = Number(nArg);
if (!(N >= 20) || !layersDir) { console.error('usage: node test/scale/generate.mjs <N >= 20> <layers dir> [key]'); process.exit(1); }

let seed = 0x2545f491;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const pick = xs => xs[Math.floor(rnd() * xs.length)];
const SYL = ['ka', 'lo', 'mir', 'an', 'tes', 'ro', 'vel', 'du', 'shi', 'na', 'or', 'bel', 'cas', 'ith', 'um', 'fen', 'gar', 'ly'];
const word = () => { const w = Array.from({ length: 2 + Math.floor(rnd() * 2) }, () => pick(SYL)).join(''); return w[0].toUpperCase() + w.slice(1); };
const cell = v => (v == null || v === '' ? '' : /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (head, rows) => [head.join(','), ...rows.map(r => head.map(h => cell(r[h])).join(','))].join('\n') + '\n';

const counts = { place: Math.round(N * 0.25), group: Math.round(N * 0.1), npc: Math.round(N * 0.4) };
counts.event = N - counts.place - counts.group - counts.npc;
const keys = Object.fromEntries(Object.entries(counts).map(([m, n]) => [m, Array.from({ length: n }, (_, i) => `${m}-${i + 1}`)]));
const names = new Map();
const nameOf = (m, k) => names.get(`${m}/${k}`) ?? names.set(`${m}/${k}`, `${word()} ${word()}`).get(`${m}/${k}`);
// A sentence that mentions one or two other entries, and sometimes the world.
const all = Object.entries(keys).flatMap(([m, ks]) => ks.map(k => [m, k]));
const ref = ([m, k]) => `[[${m}/${k}|${nameOf(m, k)}]]`;
const describe = () => {
  const xs = Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => pick(all));
  const hub = rnd() < 0.1 ? ` Known across [[place/the-world|the World]].` : '';
  return `A ${pick(['quiet', 'old', 'restless', 'storied', 'small'])} thing, tied to ${xs.map(ref).join(' and ')}.${hub}`;
};

const out = path.join(layersDir, key);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'data'), { recursive: true });
fs.writeFileSync(path.join(out, 'layer.json'), JSON.stringify({ rights: { holder: 'generated', statement: `A synthetic world of ${N} entries, for scaling tests.` } }, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'data', 'universe.csv'), csv(['ResourceID', 'name', 'description', 'published'], [{ ResourceID: key, name: `Scale test (${N})`, description: `A synthetic world of ${N} entries.`, published: 'true' }]));

// Places: the world; regions under it; settlements under regions; sites under settlements.
const P = keys.place, regions = Math.max(1, Math.round(Math.sqrt(P.length) / 2)), settlements = Math.max(1, Math.round(P.length * 0.3));
const places = [{ ResourceID: 'the-world', name: 'The World', description: 'Everything.', kind: 'Region', within: '' }];
P.forEach((k, i) => {
  const kind = i < regions ? 'Region' : i < regions + settlements ? 'Settlement' : 'Site';
  const within = kind === 'Region' ? 'the-world' : kind === 'Settlement' ? P[Math.floor(rnd() * regions)] : P[regions + Math.floor(rnd() * settlements)];
  const lon = -20 + rnd() * 40, lat = -10 + rnd() * 40;
  places.push({ ResourceID: k, name: nameOf('place', k), description: describe(), kind, within, geometry: rnd() < 0.3 ? `POINT (${lon.toFixed(3)} ${lat.toFixed(3)})` : '' });
});
fs.writeFileSync(path.join(out, 'data', 'place.csv'), csv(['ResourceID', 'name', 'description', 'kind', 'within', 'geometry'], places));

const G = keys.group;
fs.writeFileSync(path.join(out, 'data', 'group.csv'), csv(['ResourceID', 'name', 'description', 'base', 'member_of'],
  G.map((k, i) => ({ ResourceID: k, name: nameOf('group', k), description: describe(), base: pick(P), member_of: i > G.length * 0.1 ? G[Math.floor(rnd() * i)] : '' }))));

fs.writeFileSync(path.join(out, 'data', 'npc.csv'), csv(['ResourceID', 'name', 'description', 'member_of', 'home'],
  keys.npc.map(k => ({ ResourceID: k, name: nameOf('npc', k), description: describe(), member_of: pick(G), home: pick(P) }))));

const KINDS = ['Meeting', 'Battle', 'Journey', 'Encounter', 'Treaty', 'Discovery'];
fs.writeFileSync(path.join(out, 'data', 'event.csv'), csv(['ResourceID', 'name', 'description', 'kind', 'date', 'place', 'participants', 'after'],
  keys.event.map((k, i) => {
    const year = Math.floor(rnd() * 800);
    return {
      ResourceID: k, name: nameOf('event', k), description: describe(), kind: pick(KINDS),
      date: rnd() < 0.5 ? String(year).padStart(4, '0') : '', place: pick(P),
      participants: [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(keys.npc)))].join(','),
      after: i % 10 ? keys.event[i - 1] : '',
    };
  })));
console.log(`${out}: ${N} entries (${Object.entries(counts).map(([m, n]) => `${n} ${m}`).join(', ')}, plus the world)`);
