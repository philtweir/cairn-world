// Generate rules/*.csv (the General layer's reference data) from the Cairn rules markdown.
//
//   npm run import-rules -- --rules <path to a checkout of github.com/yochaigal/cairn>
//   (or set CAIRN_RULES)
//
// What becomes what:
//   Player's/Warden's Guide pages and their headings  -> Rule (nested with part_of)
//   markdown tables inside them and in backgrounds     -> Roll Table (part_of its rule/background)
//   Marketplace                                        -> Item Type, Hireling Role
//   Reliquary                                          -> Item Type (kind Relic)
//   Spellbooks                                         -> Spellbook
//   Bestiary (2e) + resources/monsters (1e)            -> Monster Type, Monster Group
//   backgrounds/                                       -> Background (+ starting gear links)
// Cross-references come from the text itself: markdown links resolve to the rule, background
// or page they point at, and **bold** / _italic_ terms resolve through TERMS below and then by
// name. Every row carries a `source` for CC-BY-SA 4.0 attribution.
// Output is regenerated wholesale: edit layers/, never rules/.

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
if (!fs.existsSync(path.join(RULES, 'second-edition/players-guide'))) {
  console.error(`${RULES} does not look like a Cairn checkout (no second-edition/players-guide).`);
  process.exit(1);
}
const OUT = path.join(ROOT, 'rules');
const LICENCE = 'CC-BY-SA 4.0';
const warnings = [];

// ---- Text helpers -----------------------------------------------------------------------------

const slug = s => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Heading anchors as Jekyll/kramdown generates them ("Healing & Recovery" -> "healing--recovery").
const anchor = s => s.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
const stripMd = s => s.replace(/\*\*/g, '').replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1$2').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
// Keep emphasis, drop link targets and raw HTML; tidy blank lines.
const tidy = s => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/^\* \* \*$/gm, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
const body = text => text.replace(/^---\n[\s\S]*?\n---\n/, '');
const readMd = rel => body(fs.readFileSync(path.join(RULES, rel), 'utf8'));
const isRoll = s => /^\d+(\s*[-–]\s*\d+)?\+?$/.test(stripMd(s));

// Split markdown into heading sections; each has its prose and its tables kept apart.
function sections(text) {
  const out = [{ level: 0, title: '', lines: [] }];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, title: stripMd(m[2]), lines: [] });
    else out.at(-1).lines.push(line);
  }
  for (const s of out) {
    s.prose = []; s.tables = [];
    let table = null;
    for (const l of s.lines) {
      if (/^\s*\|/.test(l)) { if (!table) s.tables.push(table = { lines: [], before: s.prose.join('\n') }); table.lines.push(l); }
      else { table = null; s.prose.push(l); }
    }
    s.text = tidy(s.prose.join('\n'));
  }
  return out;
}

// A markdown table as { die, columns[], rows[[roll, ...cells]] }. Handles the layouts the
// rules use: a bold header row, two or three roll/value pairs side by side, and the
// transposed Reactions table (rolls in one row, results in the next).
function parseTable(lines, hint = '') {
  let rows = lines.map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  rows = rows.filter(r => !r.every(c => /^:?-*:?$/.test(c)));
  let header = [];
  const bold = c => /^\*\*.*\*\*$/.test(c);
  if (rows.length && rows[0].every(c => !c || bold(c)) && rows[0].some(c => c) && !rows[0].every(c => !c || isRoll(c))) {
    header = rows.shift().map(stripMd);
  }
  rows = rows.map(r => r.map(c => tidy(c)));
  if (rows.length === 2 && rows[0].every(isRoll) && !rows[1].some(isRoll)) {
    rows = rows[0].map((r, i) => [r, rows[1][i] ?? '']);
  }
  const width = Math.max(0, ...rows.map(r => r.length));
  // Side-by-side pairs: roll, value, roll, value...
  if (width >= 4 && width % 2 === 0 && rows.every(r => r.every((c, i) => i % 2 || !c || isRoll(c)))) {
    const out = [];
    for (let p = 0; p < width; p += 2) for (const r of rows) if (r[p]) out.push([r[p], r[p + 1] ?? '']);
    rows = out;
    header = header.slice(0, 2);
  }
  rows = rows.filter(r => r.some(c => c));
  rows = rows.map(r => [stripMd(r[0]), ...r.slice(1)]);
  let die = '';
  if (header[0] && /^\d*d\d+$/i.test(header[0])) die = header[0].toLowerCase();
  else if ((/\b(\d*d\d+)\b/i.exec(hint) ?? [])[1]) die = /\b(\d*d\d+)\b/i.exec(hint)[1].toLowerCase().replace(/^1d/, 'd');
  else if (rows.length && rows.every((r, i) => r[0] === String(i + 1))) die = `d${rows.length}`;
  const columns = header.length ? header.slice(die || isRoll(rows[0]?.[0] ?? '') ? 1 : 0).filter(Boolean) : [];
  return { die, columns, rows };
}

// Comma-separated qualities: "d8 damage", "+1 Armor", "+4 slots", "3 uses", "2 charges", "_bulky_".
function qualities(parts) {
  const q = { damage: '', armor: '', slots: '', uses: '', charges: '', props: [], rest: [] };
  for (let a of parts) {
    a = stripMd(a).trim();
    let x;
    if (!a) continue;
    if ((x = /^(d\d+(?:\s*\+\s*d\d+)?)(?: damage)?$/i.exec(a))) q.damage = x[1].replace(/\s/g, '');
    else if ((x = /^\+?(\d+) Armor$/i.exec(a))) q.armor = x[1];
    else if ((x = /^\+(\d+) slots$/i.exec(a))) q.slots = x[1];
    else if ((x = /^(\d+) uses?$/i.exec(a))) q.uses = x[1];
    else if ((x = /^(\d+) charges?$/i.exec(a))) q.charges = x[1];
    else if (/^(bulky|petty|slow)$/i.test(a)) q.props.push(a.toLowerCase());
    else q.rest.push(a);
  }
  return q;
}
// Split on commas that are not inside parentheses.
const topCommas = s => { const out = []; let d = 0, cur = ''; for (const c of s) { if (c === '(') d++; if (c === ')') d--; if (c === ',' && !d) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out.map(x => x.trim()).filter(Boolean); };
// "Tent (fits 2, _bulky_)" -> name + qualities; "Wilderness Clothes (Poncho, etc.) (_petty_)" too.
function nameAndQualities(label) {
  const parens = [...label.matchAll(/\(([^()]*)\)/g)].map(m => m[1]);
  const name = stripMd(label.replace(/\([^()]*\)/g, '')).replace(/\s+/g, ' ').replace(/[,\s]+$/, '');
  const q = qualities(parens.flatMap(topCommas));
  return { name, q };
}

// ---- Entities ---------------------------------------------------------------------------------

const MODELS = {
  rule: ['name', 'description', 'category', 'section', 'part_of', 'refers_to', 'source'],
  rolltable: ['name', 'description', 'die', 'columns', 'entries', 'section', 'part_of', 'refers_to', 'source'],
  itemtype: ['name', 'description', 'kind', 'damage', 'armor', 'slots', 'uses', 'charges', 'properties', 'recharge', 'price', 'spell', 'listed_in', 'refers_to', 'source'],
  spellbook: ['name', 'description', 'quirk', 'roll', 'listed_in', 'refers_to', 'source'],
  hireling: ['name', 'description', 'wage', 'listed_in', 'source'],
  monstergroup: ['name', 'description', 'roll', 'listed_in', 'source'],
  monstertype: ['name', 'description', 'hp', 'armor', 'str', 'dex', 'wil', 'attacks', 'group', 'spells', 'listed_in', 'refers_to', 'source'],
  background: ['name', 'description', 'names', 'gear', 'starting_gear', 'roll', 'listed_in', 'refers_to', 'source'],
};
const all = Object.fromEntries(Object.keys(MODELS).map(m => [m, new Map()]));
const owner = new Map();   // key -> model: link fields reach several models, so keys stay unique across them

function add(model, wanted, fields, mentionText = '') {
  let key = wanted;
  for (let n = 2; owner.has(key); n++) key = owner.get(wanted) === model || n > 2 ? `${wanted}-${n}` : `${wanted}-${model}`;
  owner.set(key, model);
  const e = { model, key, fields: { ...fields }, links: {}, mentions: mentionText };
  all[model].set(key, e);
  return e;
}
const link = (e, field, target) => { if (target && target !== e) (e.links[field] ??= new Set()).add(target); };
const byName = model => { const m = new Map(); for (const e of all[model].values()) { const k = e.fields.name.toLowerCase(); if (!m.has(k)) m.set(k, e); } return m; };

// ---- 1. Catalogue pages: sections that are things, not rules -------------------------------------
// Each handler gets a heading section and returns true if it took it.

const ruleByAnchor = new Map();   // "page#anchor" -> rule entity ("page#" is the page itself)
const headingIndex = new Map();   // lower-case heading -> rule entity (Player's Guide first)
const indexHeading = (name, e) => { const k = name.toLowerCase(); if (!headingIndex.has(k)) headingIndex.set(k, e); };

function addRule(page, key, fields, parent, mentions = fields.description) {
  const e = add('rule', key, fields, mentions);
  e.page = page;
  link(e, 'part_of', parent);
  return e;
}

function addRollTable(key, name, parsed, parent, section, source, mentions) {
  const entries = parsed.rows.map(r => r.join(' | ')).join('\n');
  const e = add('rolltable', key, { name, die: parsed.die, columns: parsed.columns.join(' | '), entries, section, source }, mentions);
  e.page = parent.page;
  link(e, 'part_of', parent);
  return e;
}

// Every table in a section becomes a Roll Table that is part of it.
function addTables(sec, parent, source) {
  const parsed = sec.tables.map(t => ({ t, p: parseTable(t.lines, `${sec.title} ${t.before.split('\n').slice(-3).join(' ')}`) })).filter(x => x.p.rows.length);
  const labels = parsed.map(x => x.p.columns.join(' / '));
  const distinct = labels.every(l => l) && new Set(labels).size === labels.length;
  return parsed.map(({ t, p }, i) => {
    const name = parsed.length === 1 ? sec.title : distinct ? `${sec.title}: ${labels[i]}` : `${sec.title} ${i + 1}`;
    return addRollTable(`${parent.key}-table${parsed.length > 1 ? `-${i + 1}` : ''}`, name, p, parent, i + 1, source, t.lines.join('\n'));
  });
}

const CATALOGUE = {
  marketplace(sec, parent, source, next) {
    const KINDS = { Armor: 'Armor', Weapons: 'Weapon', Transport: 'Transport', 'Upkeep & Recovery': 'Service', Gear: 'Gear' };
    const hirelings = /^Hirelings/.test(sec.title);
    if (!KINDS[sec.title] && !hirelings) return false;
    const e = addRule('marketplace', `marketplace-${slug(sec.title)}`, { name: sec.title, description: sec.text, category: 'Marketplace', section: next(), source }, parent);
    ruleByAnchor.set(`marketplace#${anchor(sec.title)}`, e);
    indexHeading(sec.title, e);
    for (const t of sec.tables) for (const [label, price] of parseTable(t.lines).rows) {
      if (!/^\d+$/.test(price ?? '')) continue;
      if (hirelings) { link(add('hireling', slug(label), { name: label, wage: price, source }), 'listed_in', e); continue; }
      // "Spear, Sword, Mace, Axe, Flail, etc. (d8 damage)": one row, several items with the same stats.
      const { name, q } = nameAndQualities(label);
      const several = KINDS[sec.title] === 'Weapon' || KINDS[sec.title] === 'Armor';
      const names = several ? name.split(',').map(s => s.trim()).filter(s => s && !/^etc\.?$/i.test(s)) : [name];
      const kind = KINDS[sec.title] === 'Service' && q.uses ? 'Gear' : KINDS[sec.title];
      for (const nm of names) {
        const it = add('itemtype', slug(nm), {
          name: nm, description: several ? '' : q.rest.join(', '), kind, damage: q.damage, armor: q.armor, slots: q.slots,
          uses: q.uses, properties: q.props.join(','), price, source,
        }, label);
        it.page = 'marketplace';
        link(it, 'listed_in', e);
      }
    }
    return true;
  },

  reliquary(sec, parent, source) {
    if (sec.level !== 2) return false;
    // "Last Breath (d6), 1 charge" / "Coin of the Father, 1 charge, _petty_"
    const [head, ...tail] = topCommas(sec.title);
    const { name, q } = nameAndQualities(head);
    const more = qualities(tail);
    const bullets = sec.prose.filter(l => /^\s*-\s+/.test(l)).map(l => l.replace(/^\s*-\s+/, '').trim());
    const recharge = bullets.find(b => /^\*\*Recharge\*\*/.test(b));
    const e = add('itemtype', slug(name), {
      name, description: tidy(bullets.filter(b => b !== recharge).join('\n')), kind: 'Relic',
      damage: q.damage || more.damage, armor: q.armor || more.armor, uses: q.uses || more.uses, charges: q.charges || more.charges,
      properties: [...q.props, ...more.props].join(','), recharge: recharge ? tidy(recharge.replace(/^\*\*Recharge\*\*:?\s*/, '')) : '', source,
    }, sec.lines.join('\n'));
    e.page = 'reliquary';
    link(e, 'listed_in', parent);
    return true;
  },

  // "Monster Categories" stays a rule (with its table); every other section is a monster.
  bestiary(sec, parent, source) {
    if (sec.title === 'Monster Categories') return false;
    bestiary.push({ sec, parent, source });
    return true;
  },
};
const bestiary = [];

// ---- 2. The two books, page by page and heading by heading -----------------------------------------

const BOOKS = [
  { key: 'players-guide', dir: 'second-edition/players-guide', pages: [
    ['overview-and-principles', 'Principles'], ['character-creation', 'Character Creation'], ['core-rules', 'Core Rules'],
    ['procedures', 'Procedures'], ['marketplace', 'Marketplace'],
  ] },
  { key: 'wardens-guide', dir: 'second-edition/wardens-guide', pages: [
    'setting-seeds', 'dungeon-seeds', 'forest-seeds', 'bestiary', 'creating-monsters', 'naming-procedures', 'growth',
    'spellbooks', 'reliquary', 'creating-backgrounds', 'pointcrawls', 'dungeon-exploration', 'detachments',
    'wilderness-exploration', 'bonds-and-omens', 'knowledge-and-perception', 'saves', 'variable-difficulty', 'combat',
    'npc-tables',
  ].map(p => [p, "Warden's Guide"]) },
];
// Left out on purpose: Vald (the default setting, not rules; it belongs in a Universe layer),
// the bibliography, and the note about the example party.

const pageTables = {};   // page -> its h1-level roll tables
BOOKS.forEach((book, bookNo) => {
  const idx = sections(readMd(`${book.dir}.md`));
  const h1 = idx.find(s => s.level === 1);
  const bookTitle = h1?.title ?? book.key;
  const bookRule = addRule(null, book.key, { name: bookTitle, description: (h1?.text ?? '').split('\n\n')[0], section: bookNo + 1, source: `Cairn 2e ${bookTitle}, ${LICENCE}` }, null);
  book.pages.forEach(([page, category], pageNo) => {
    const secs = sections(readMd(`${book.dir}/${page}.md`));
    const top = secs.find(s => s.level === 1) ?? secs[0];
    const title = top.title || page;
    const source = `Cairn 2e ${bookTitle}: ${title}, ${LICENCE}`;
    const text = [secs[0] !== top ? secs[0].text : '', top.text].filter(Boolean).join('\n\n');
    const pageRule = addRule(page, page, { name: title, description: text, category, section: pageNo + 1, source }, bookRule, text);
    ruleByAnchor.set(`${page}#`, pageRule);
    indexHeading(title, pageRule);
    // The spellbook list is the page's own table; it becomes Spellbooks, not a Roll Table.
    if (page !== 'spellbooks') pageTables[page] = addTables(top, pageRule, source);

    const stack = [{ level: 1, e: pageRule }];
    let n = 0;
    const next = () => ++n;
    for (const sec of secs.filter(s => s.level >= 2)) {
      while (stack.length > 1 && stack.at(-1).level >= sec.level) stack.pop();
      const parent = stack.at(-1).e;
      if (CATALOGUE[page]?.(sec, parent, source, next)) continue;
      const clash = [...all.rule.values()].some(r => r.page === page && r.fields.name === sec.title);
      const e = addRule(page, `${page}-${slug(sec.title)}`, {
        name: clash ? `${sec.title} (${parent.fields.name})` : sec.title, description: sec.text, category, section: next(), source,
      }, parent);
      if (!ruleByAnchor.has(`${page}#${anchor(sec.title)}`)) ruleByAnchor.set(`${page}#${anchor(sec.title)}`, e);
      indexHeading(sec.title, e);
      stack.push({ level: sec.level, e });
      addTables(sec, e, source);
    }
  });
});

// ---- 3. Spellbooks: "| **1** | **Adhere** | Effect. _Physical quirk._ |" ---------------------------

{
  const page = sections(readMd('second-edition/wardens-guide/spellbooks.md'));
  const top = page.find(s => s.level === 1);
  const listedIn = ruleByAnchor.get('spellbooks#');
  for (const t of top.tables) for (const [roll, name, text = ''] of parseTable(t.lines).rows) {
    const raw = text.trim();
    const m = /^(.*?)\s*_([^_]+?)\.?_\.?\s*$/s.exec(raw);
    const e = add('spellbook', slug(stripMd(name)), {
      name: stripMd(name), description: m ? m[1].trim() : raw, quirk: m ? `${m[2].trim()}.` : '', roll,
      source: `Cairn 2e Warden's Guide: Spellbooks, ${LICENCE}`,
    }, m ? m[1] : raw);
    e.page = 'spellbooks';
    link(e, 'listed_in', listedIn);
  }
}

// ---- 4. Monsters: the 2e bestiary, then 1st-edition monsters it doesn't cover ----------------------

const STAT = /^(\d+) HP(?:, (\d+) Armor)?, (\d+) STR, (\d+) DEX, (\d+) WIL(?:, (.*))?$/;
const traitsOf = lines => lines.filter(l => /^\s*-\s+/.test(l)).map(l => l.replace(/^\s*-\s+/, '').trim());

for (const { sec, parent, source } of bestiary) {
  const lines = sec.prose.map(l => l.trim()).filter(Boolean);
  const m = STAT.exec(stripMd(lines[0] ?? ''));
  if (!m) { warnings.push(`bestiary "${sec.title}": no stat line (${lines[0] ?? 'empty'})`); continue; }
  const traits = traitsOf(sec.prose);
  const e = add('monstertype', slug(sec.title), {
    name: sec.title, description: tidy(traits.map(t => `- ${t}`).join('\n')),
    hp: m[1], armor: m[2] ?? '', str: m[3], dex: m[4], wil: m[5], attacks: stripMd(m[6] ?? ''), source,
  }, [lines[0], ...traits].join('\n'));
  e.page = 'bestiary';
  link(e, 'listed_in', parent);
}

{
  const dir = path.join(RULES, 'resources/monsters');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    const secs = sections(readMd(path.relative(RULES, path.join(dir, f))));
    const top = secs.find(s => s.level === 1);
    const lines = (top?.prose ?? []).map(l => l.trim()).filter(Boolean);
    // Some 1e files end with a stray page number ("...day).20").
    const m = STAT.exec(stripMd(lines[0] ?? ''));
    if (!top || !m) { warnings.push(`monster ${f}: no stat line (${lines[0] ?? 'empty'})`); continue; }
    const traits = traitsOf(top.prose).map(t => t.replace(/([.)])\d+$/, '$1'));
    const base = slug(path.basename(f, '.md'));
    const newer = all.monstertype.has(base);
    add('monstertype', newer ? `${base}-1e` : base, {
      name: newer ? `${top.title} (1st ed.)` : top.title, description: tidy(traits.map(t => `- ${t}`).join('\n')),
      hp: m[1], armor: m[2] ?? '', str: m[3], dex: m[4], wil: m[5], attacks: stripMd(m[6] ?? ''),
      source: `Cairn (1st ed.) resources/monsters, ${LICENCE}`,
    }, traits.join('\n'));
  }
}

// Monster Categories: "| **1** | Avian | Phoenix, Roc, Wyvern |" -> groups, and each monster's group.
{
  const table = all.rolltable.get('bestiary-monster-categories-table');
  if (!table) warnings.push('bestiary: no Monster Categories table');
  const names = byName('monstertype');
  const named = n => names.get(n.toLowerCase()) ?? names.get(`${n} (1st ed.)`.toLowerCase());
  for (const line of (table?.fields.entries ?? '').split('\n').filter(Boolean)) {
    const [roll, group, members = ''] = line.split(' | ');
    const g = add('monstergroup', slug(group), { name: group, roll, source: table.fields.source });
    link(g, 'listed_in', table);
    for (const n of members.split(',').map(s => s.trim()).filter(Boolean)) {
      const mon = named(n);
      if (mon) link(mon, 'group', g);
      else warnings.push(`Monster Categories: "${n}" (${group}) is not in the bestiary or the 1e monsters`);
    }
  }
}

// ---- 5. Backgrounds -----------------------------------------------------------------------------------

{
  const dir = 'second-edition/backgrounds';
  const table = all.rolltable.get('character-creation-backgrounds-table');
  const rollOf = new Map((table?.fields.entries ?? '').split('\n').map(l => l.split(' | ')).map(([r, n]) => [stripMd(n ?? '').toLowerCase(), r]));
  const items = byName('itemtype');
  const spells = byName('spellbook');
  for (const f of fs.readdirSync(path.join(RULES, dir)).filter(f => f.endsWith('.md')).sort()) {
    const secs = sections(readMd(`${dir}/${f}`));
    const top = secs.find(s => s.level === 1);
    if (!top) { warnings.push(`background ${f}: no heading`); continue; }
    const key = slug(path.basename(f, '.md'));
    const source = `Cairn 2e Backgrounds: ${top.title}, ${LICENCE}`;
    const get = t => secs.find(s => s.level === 2 && s.title === t);
    const description = tidy(top.prose.filter(l => l.startsWith('>')).map(l => l.replace(/^>\s*/, '')).join(' '));
    // Gear bullets can wrap onto the next line.
    // A bullet can wrap onto the next line (an unclosed parenthesis); other loose lines are notes.
    const gear = [], notes = [];
    for (const l of get('Starting Gear')?.prose ?? []) {
      if (/^\s*-\s+/.test(l)) gear.push(l.replace(/^\s*-\s+/, '').trim());
      else if (!l.trim()) continue;
      else if (gear.length && (gear.at(-1).match(/\(/g) ?? []).length > (gear.at(-1).match(/\)/g) ?? []).length) gear[gear.length - 1] += ` ${l.trim()}`;
      else notes.push(l.trim());
    }
    const e = add('background', key, {
      name: top.title, description, names: (get('Names')?.text ?? '').replace(/\s+/g, ' '),
      gear: gear.map(stripMd).join('; '), roll: rollOf.get(top.title.toLowerCase()) ?? rollOf.get(top.title.replace(/ /g, '-').toLowerCase()) ?? '', source,
    }, [description, ...notes].join('\n'));
    if (!e.fields.roll) warnings.push(`background ${top.title}: not in the Character Creation backgrounds table`);
    if (table) link(e, 'listed_in', table);

    for (const g of gear) {
      let x;
      if ((x = /^Spellbook\s*\(([^:]+):\s*(.+)\)$/s.exec(g))) {
        const name = stripMd(x[1]);
        let sp = spells.get(name.toLowerCase());
        if (!sp) {
          const m = /^(.*?)\s*_([^_]+?)\.?_\.?\s*$/s.exec(x[2]);
          sp = add('spellbook', slug(name), { name, description: stripMd(m ? m[1] : x[2]), quirk: m ? `${m[2].trim()}.` : '', source }, x[2]);
          spells.set(name.toLowerCase(), sp);
        }
        link(e, 'starting_gear', sp);
        continue;
      }
      if (/gold pieces|\bgp\b/i.test(g)) continue;
      const { name, q } = nameAndQualities(g);
      // "Iron Dagger" is a Dagger; "Hunting Bow" a Bow. Otherwise it's an item of its own.
      const words = name.split(' ');
      let it = null;
      for (let i = 0; i < words.length && !it; i++) {
        const w = words.slice(i).join(' ').toLowerCase();
        it = items.get(w) ?? items.get(w.replace(/s$/, '')) ?? items.get(`${w}s`) ?? null;
      }
      if (!it) {
        it = add('itemtype', slug(name), {
          name, description: q.rest.join(', '), kind: 'Gear', damage: q.damage, armor: q.armor, slots: q.slots, uses: q.uses,
          charges: q.charges, properties: q.props.join(','), source,
        }, g);
        items.set(name.toLowerCase(), it);
      }
      link(e, 'starting_gear', it);
    }
    let nt = 0;
    for (const sec of secs.filter(s => s.level === 2 && s.tables.length)) {
      const title = sec.title.replace(/\s*Roll \d*d\d+:?\s*$/i, '').trim();
      for (const t of sec.tables) {
        const p = parseTable(t.lines, sec.title);
        if (p.rows.length) addRollTable(`${key}-table-${++nt}`, title, p, e, nt, source, t.lines.join('\n'));
      }
    }
  }
}

// ---- 6. Cross-references from the text -------------------------------------------------------------

// Terms the rules emphasise, mapped to the rule that defines them.
const TERMS = {
  'core-rules-attributes': ['attribute', 'attributes', 'str', 'dex', 'wil', 'strength', 'dexterity', 'willpower', 'strength (str)', 'dexterity (dex)', 'willpower (wil)'],
  'core-rules-saves': ['save', 'saves', 'str save', 'dex save', 'wil save', 'saving throw'],
  'character-creation-hit-protection': ['hp', 'hit protection'],
  'core-rules-armor': ['armor'],
  'core-rules-deprivation-fatigue': ['fatigue', 'deprived', 'deprivation'],
  'core-rules-critical-damage': ['critical damage', 'critical damage save'],
  'core-rules-attack-modifiers': ['impaired', 'enhanced', 'enhance', 'blast'],
  'core-rules-detachments': ['detachment', 'detachments'],
  'core-rules-morale': ['morale'],
  'procedures-panic': ['panic', 'panicked'],
  'core-rules-scars': ['scar', 'scars'],
  'core-rules-spellbooks': ['spellbook', 'spellbooks'],
  'core-rules-scrolls': ['scroll', 'scrolls'],
  'core-rules-relics': ['relic', 'relics', 'recharge'],
  'character-creation-inventory-slots': ['petty', 'bulky'],
  'character-creation-inventory': ['inventory', 'backpack'],
  'core-rules-hirelings': ['hireling', 'hirelings'],
  'core-rules-die-of-fate': ['die of fate'],
  'core-rules-reactions': ['reaction', 'reactions'],
  'core-rules-retreat': ['retreat'],
  'character-creation-bonds': ['bond', 'bonds'],
  'character-creation-omens': ['omen', 'omens'],
  'procedures-watches': ['watch', 'watches'],
  'procedures-downtime': ['downtime'],
};
const termIndex = new Map();
for (const [key, words] of Object.entries(TERMS)) {
  const e = all.rule.get(key);
  if (!e) { warnings.push(`TERMS: no rule "${key}"`); continue; }
  for (const w of words) termIndex.set(w, e);
}
const GENERIC = new Set(['introduction', 'overview', 'example', 'examples', 'principles', 'actions', 'the basics', 'costs', 'questions', 'sources']);
const names = Object.fromEntries(['spellbook', 'monstertype', 'itemtype', 'background', 'hireling'].map(m => [m, byName(m)]));

function resolveTerm(raw, from) {
  const t = stripMd(raw).toLowerCase().replace(/[.,:;!?)]+$/, '').replace(/^the /, '').trim();
  if (!t || t.length < 2) return null;
  const forms = [...new Set([t, t.replace(/'s$/, ''), t.replace(/s$/, ''), t.replace(/es$/, '')])];
  for (const f of forms) if (termIndex.has(f)) return termIndex.get(f);
  const byHeading = f => (!GENERIC.has(f) && f.length > 3 ? headingIndex.get(f) : null);
  const order = from.model === 'rule' || from.model === 'rolltable'
    ? [byHeading, ...['spellbook', 'monstertype', 'itemtype', 'background', 'hireling'].map(m => f => names[m].get(f))]
    : [...['spellbook', 'monstertype', 'itemtype', 'background', 'hireling'].map(m => f => names[m].get(f)), byHeading];
  for (const look of order) for (const f of forms) { const hit = look(f); if (hit) return hit; }
  return null;
}

function resolveHref(href, from) {
  const h = href.replace(/^https?:\/\/[^/]+/, '').replace(/(\.md)?\/?(#|$)/, '$2');
  let x;
  if ((x = /\/second-edition\/backgrounds\/([^/#]+)/.exec(h))) return all.background.get(slug(x[1]));
  if ((x = /\/second-edition\/(?:players-guide|wardens-guide)\/([^/#]+)(?:#(.*))?$/.exec(h))) return ruleByAnchor.get(`${x[1]}#${x[2] ?? ''}`) ?? ruleByAnchor.get(`${x[1]}#`);
  if ((x = /^#(.+)$/.exec(h)) && from.page) return ruleByAnchor.get(`${from.page}#${x[1]}`);
  if ((x = /^([a-z0-9-]+)(?:#(.*))?$/.exec(h))) return ruleByAnchor.get(`${x[1]}#${x[2] ?? ''}`) ?? ruleByAnchor.get(`${x[1]}#`);
  return null;
}

const FIELD_FOR = { monstertype: { spellbook: 'spells' }, itemtype: { spellbook: 'spell' } };
const HAS_REFS = new Set(['rule', 'rolltable', 'itemtype', 'spellbook', 'monstertype', 'background']);
for (const model of Object.keys(all)) {
  if (!HAS_REFS.has(model)) continue;
  for (const e of all[model].values()) {
    const text = (e.mentions || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    const hits = [];
    for (const m of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      const target = resolveHref(m[2], e);
      if (target) hits.push(target); else if (!/^https?:/.test(m[2])) warnings.push(`${model}/${e.key}: link "${m[2]}" resolves to nothing`);
    }
    const plainText = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    for (const m of plainText.matchAll(/\*\*([^*]+)\*\*|(?<![\w*])_([^_\n]+)_(?![\w])/g)) {
      const target = resolveTerm(m[1] ?? m[2], e);
      if (target) hits.push(target);
    }
    for (const t of hits) {
      if (t === e || e.links.part_of?.has(t) || e.links.listed_in?.has(t)) continue;
      link(e, FIELD_FOR[model]?.[t.model] ?? 'refers_to', t);
    }
  }
}

// ---- 7. Write ------------------------------------------------------------------------------------------

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [model, cols] of Object.entries(MODELS)) {
  const rows = [...all[model].values()].map(e => [e.key, ...cols.map(c => e.links[c] ? [...e.links[c]].map(t => t.key).join(',') : (e.fields[c] ?? ''))]);
  fs.writeFileSync(path.join(OUT, `${model}.csv`), toCsv([['ResourceID', ...cols], ...rows]));
  const nLinks = [...all[model].values()].reduce((n, e) => n + Object.values(e.links).reduce((a, s) => a + s.size, 0), 0);
  console.log(`rules/${model}.csv: ${rows.length} rows, ${nLinks} links`);
}
if (warnings.length) console.warn(`\n${warnings.length} warning(s):\n  ${warnings.join('\n  ')}`);
