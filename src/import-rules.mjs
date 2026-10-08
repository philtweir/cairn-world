// Generate rules/*.csv (reference data) from the Cairn rules markdown.
//
//   npm run import-rules -- --rules <path to a checkout of github.com/yochaigal/cairn>
//   (or set CAIRN_RULES)
// Sources are CC-BY-SA 4.0; every row carries a `source` field for attribution.
// Output is regenerated wholesale: edit data/, never rules/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from './csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argIdx = process.argv.indexOf('--rules');
const rulesArg = argIdx > 0 ? process.argv[argIdx + 1] : process.env.CAIRN_RULES;
if (!rulesArg) {
  console.error('Pass the path to a Cairn checkout: npm run import-rules -- --rules ../cairn');
  process.exit(1);
}
const RULES = path.resolve(rulesArg);
if (!fs.existsSync(path.join(RULES, 'resources/monsters'))) {
  console.error(`${RULES} does not look like a Cairn checkout (no resources/monsters).`);
  process.exit(1);
}
const OUT = path.join(ROOT, 'rules');

const slug = s => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Strip markdown emphasis, and the stray page numbers some monster files end with ("...day).20").
const plain = s => s.replace(/[_*]/g, '').replace(/([.)])\d+$/, '$1').trim();
const skipped = [];

const body = text => text.replace(/^---\n[\s\S]*?\n---\n/, '');
const heading = text => body(text).match(/^# (.+)$/m)?.[1].trim();

function write(alias, header, rows) {
  fs.mkdirSync(OUT, { recursive: true });
  const used = new Set();
  for (const r of rows) {
    let key = r[0], n = 2;
    while (used.has(key)) key = `${r[0]}-${n++}`;
    r[0] = key; used.add(key);
  }
  fs.writeFileSync(path.join(OUT, `${alias}.csv`), toCsv([header, ...rows]));
  console.log(`rules/${alias}.csv: ${rows.length} rows`);
}

// ---- Monsters: "4 HP, 1 Armor, 8 STR, 11 DEX, 14 WIL, ceremonial dagger (d6)" ---------------

const STAT = /^(\d+) HP(?:, (\d+) Armor)?, (\d+) STR, (\d+) DEX, (\d+) WIL(?:, (.*))?$/;
{
  const dir = path.join(RULES, 'resources/monsters');
  const rows = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const name = heading(text);
    const lines = body(text).split('\n').slice(body(text).split('\n').findIndex(l => l.startsWith('# ')) + 1).map(l => l.trim()).filter(Boolean);
    const m = STAT.exec(lines[0] ?? '');
    if (!name || !m) { skipped.push(`monster ${f}: no stat line (${lines[0] ?? 'empty'})`); continue; }
    const traits = lines.slice(1).filter(l => l.startsWith('- ')).map(l => plain(l.slice(2)));
    rows.push([slug(path.basename(f, '.md')), name, traits.join(' '), m[1], m[2] ?? '', m[3], m[4], m[5], plain(m[6] ?? ''), 'Cairn (1st ed.) resources/monsters, CC-BY-SA 4.0']);
  }
  write('monstertype', ['ResourceID', 'name', 'description', 'hp', 'armor', 'str', 'dex', 'wil', 'attacks', 'source'], rows);
}

// ---- Backgrounds ---------------------------------------------------------------------------

{
  const dir = path.join(RULES, 'second-edition/backgrounds');
  const rows = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    const text = body(fs.readFileSync(path.join(dir, f), 'utf8'));
    const name = heading(text);
    const sections = Object.fromEntries(text.split(/^## /m).slice(1).map(s => [s.split('\n')[0].trim(), s.split('\n').slice(1).join('\n')]));
    const desc = text.split('\n').filter(l => l.startsWith('>')).map(l => plain(l.replace(/^>\s*/, ''))).join(' ');
    const names = (sections['Names'] ?? '').trim().replace(/\s+/g, ' ');
    const gear = (sections['Starting Gear'] ?? '').split('\n').filter(l => l.startsWith('- ')).map(l => plain(l.slice(2))).join('; ');
    if (!name) { skipped.push(`background ${f}: no heading`); continue; }
    rows.push([slug(path.basename(f, '.md')), name, desc, names, gear, 'Cairn 2e backgrounds, CC-BY-SA 4.0']);
  }
  write('background', ['ResourceID', 'name', 'description', 'names', 'gear', 'source'], rows);
}

// ---- Marketplace: armor, weapons, transport ------------------------------------------------
// Rows like "Spear, Sword, Mace, etc. (d8 damage)" share stats across several names.

{
  const text = body(fs.readFileSync(path.join(RULES, 'second-edition/players-guide/marketplace.md'), 'utf8'));
  const KINDS = { Armor: 'Armor', Weapons: 'Weapon', Transport: 'Transport' };
  const rows = [];
  for (const section of text.split(/^## /m).slice(1)) {
    const title = section.split('\n')[0].trim();
    const kind = KINDS[title];
    if (!kind) continue;
    for (const line of section.split('\n').filter(l => l.startsWith('|'))) {
      const [label, price] = line.split('|').slice(1, 3).map(s => s.trim());
      if (!label || /^-+$/.test(label) || !/^\d+$/.test(price)) continue;
      const m = /^(.*?)\s*\((.*)\)\s*$/.exec(label);
      const names = (m ? m[1] : label).split(',').map(s => s.trim()).filter(s => s && !/^etc\.?$/i.test(s));
      const attrs = (m ? m[2] : '').split(',').map(s => s.trim());
      let damage = '', armor = '', slots = '';
      const props = [];
      for (const a of attrs.map(a => a.replace(/_/g, ''))) {
        let x;
        if ((x = /^(d\d+) damage$/.exec(a))) damage = x[1];
        else if ((x = /^\+?(\d+) Armor$/.exec(a))) armor = x[1];
        else if ((x = /^\+(\d+) slots$/.exec(a))) slots = x[1];
        else if (['bulky', 'petty', 'slow'].includes(a)) props.push(a);
      }
      for (const name of names) {
        rows.push([slug(name), name, '', kind, damage, armor, slots, props.join(','), price, 'Cairn 2e Marketplace, CC-BY-SA 4.0']);
      }
    }
  }
  write('itemtype', ['ResourceID', 'name', 'description', 'kind', 'damage', 'armor', 'slots', 'properties', 'price', 'source'], rows);
}

if (skipped.length) console.warn(`\nskipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
