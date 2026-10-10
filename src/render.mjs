// Static HTML for each view of the world. Input is what the ORM read back, so this exercises
// the same path a live display site would use.

import fs from 'node:fs';
import path from 'node:path';
import { blocks, inline, tableRows, toHtml } from './md.mjs';
import { backlinks as reverseLinks } from './world-read.mjs';
import { assignLenses } from './lenses.mjs';
import { groupViews } from './views.mjs';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Every page credits the rights of each layer it shows (layers/<key>/layer.json), then the ontology.
const CRM_CREDIT = 'Ontology: <a href="https://cidoc-crm.org/">CIDOC CRM</a> 7.1.3 (RDFS by FORTH-ICS, ' +
  '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>). Unofficial fan project.';
export function rightsHtml(layer) {
  const r = layer.rights;
  if (!r) return '';
  const licence = r.licence ? `<a href="${esc(r.licence.url)}">${esc(r.licence.name)}</a>` : 'All rights reserved';
  const source = r.source ? ` · <a href="${esc(r.source.url)}">${esc(r.source.name)}</a>` : '';
  return `<li><b>${esc(layer.name)}</b>: ${esc(r.statement)} © ${r.year ? `${esc(r.year)} ` : ''}${esc(r.holder)}. ${licence}${source}${layer.test ? ` <span class="test">(${esc(layer.test)})</span>` : ''}</li>`;
}
const footerFor = layerList => `<ul class="rights">${layerList.map(rightsHtml).join('')}</ul><p>${CRM_CREDIT}</p>`;

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1b17;--muted:#6b665c;--line:#d9d4c7;--accent:#8a3b12}
@media (prefers-color-scheme:dark){:root{--bg:#171512;--fg:#e8e3d6;--muted:#9a9384;--line:#38342c;--accent:#e0925a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 Georgia,serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
nav{font:14px system-ui,sans-serif;display:flex;flex-wrap:wrap;gap:.25rem 1rem;padding-bottom:.75rem;border-bottom:1px solid var(--line)}
a{color:var(--accent)}
h1{margin:1.2rem 0 .2rem}
.kind{font:13px system-ui,sans-serif;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1.2rem;margin:1.2rem 0}
dt{font:14px system-ui,sans-serif;color:var(--muted)}
dt a{color:inherit;text-decoration-style:dotted}
ul.group{margin:0;padding-left:1.1rem}
dd{margin:0}
h2{font:600 17px system-ui,sans-serif;margin-top:2.2rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}
h3{font:600 15px system-ui,sans-serif;color:var(--muted);margin:1.2rem 0 .3rem}
ul,ol{padding-left:1.2rem}
blockquote{margin:1rem 0;padding-left:1rem;border-left:3px solid var(--line);color:var(--muted);font-style:italic}
.wrap{overflow-x:auto;margin:1.2rem 0}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:.3rem .6rem;border-bottom:1px solid var(--line)}
th{font:600 13px system-ui,sans-serif;color:var(--muted)}
caption{text-align:left;font:600 13px system-ui,sans-serif;color:var(--muted);padding:.3rem .6rem}
td:first-child{white-space:nowrap;font:600 14px system-ui,sans-serif}
footer ul.rights{list-style:none;padding:0;margin:0 0 .5rem}
footer ul.rights li{margin:.15rem 0}
.test{color:#b3261e}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);font:13px system-ui,sans-serif;color:var(--muted)}
@media (max-width:480px){dl{grid-template-columns:1fr}dd{margin-bottom:.4rem}}
`;

const page = (title, nav, body, depth, footer) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${'../'.repeat(depth)}style.css">
</head><body><main>
<nav>${nav}</nav>
${body}
<footer>${footer}</footer>
</main></body></html>
`;

// "Defined in Weeping Wood · changed in Ashes of Hollowmere": which layers an entry comes from.
const provenance = (e, viewsMeta) => {
  const name = l => viewsMeta.layers[l]?.name ?? l;
  const [first, ...rest] = e.layers;
  if (!first) return '';
  return `Defined in ${name(first)}` + (rest.length ? ` · changed in ${rest.map(name).join(', ')}` : '');
};

export function renderViewIndex({ viewsMeta, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'style.css'), CSS);
  const item = v =>
    `<li>${v.gate ? `${esc(v.name)} <a href="../index.html#/${esc(v.key)}/">(password, in the explorer)</a>` : `<a href="${esc(v.key)}/index.html">${esc(v.name)}</a>`} <span class="kind">${esc(v.kind)}</span></li>`;
  // Grouped by universe: the universe itself, then its campaigns.
  const items = groupViews(viewsMeta).map(g => `<li><b>${esc(g.label)}</b><ul>${g.views.map(item).join('')}</ul></li>`).join('');
  fs.writeFileSync(path.join(outDir, 'index.html'), page('Cairn World', '<a href="../index.html">Explorer</a>',
    `<h1>Cairn World</h1><p>Pick a universe or campaign. Each shows its own entries on top of the ones it builds on.</p><ul>${items}</ul>`, 0,
    footerFor(Object.values(viewsMeta.layers))));
}

export function renderSite({ view, viewsMeta, models, entities, outDir, ontology }) {
  const viewName = viewsMeta.views.find(v => v.key === view)?.name ?? view;
  const footer = footerFor(viewsMeta.views.find(v => v.key === view).stack.map(l => viewsMeta.layers[l]));
  const byId = new Map(entities.map(e => [e.id, e]));
  const titleOf = e => e.fields.find(f => f.alias === 'name')?.value ?? e.key;
  const modelName = Object.fromEntries(models.map(m => [m.alias, m.name]));
  const href = (e, depth) => `${'../'.repeat(depth)}${e.model}/${e.key}.html`;
  const link = (e, depth) => `<a href="${href(e, depth)}">${esc(titleOf(e))}</a>`;

  const nav = depth => `<a href="${'../'.repeat(depth + 1)}index.html">All views</a><a href="${'../'.repeat(depth)}index.html">${esc(viewName)}</a>` +
    models.map(m => `<a href="${'../'.repeat(depth)}index.html#${m.alias}">${esc(m.name)}</a>`).join('');

  // Reverse edges: who points at whom, and through which field.
  const backlinks = reverseLinks(entities);
  const matches = Object.assign({}, ...models.map(m => m.matches ?? {}));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'style.css'), CSS);

  const sorted = list => [...list].sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  // Sections of a rule, entries of a table: reading order where there is one, else by name.
  const sectionOf = e => e.fields.find(f => f.alias === 'section')?.value ?? Infinity;
  const inOrder = (a, b) => sectionOf(a) - sectionOf(b) || titleOf(a).localeCompare(titleOf(b));
  const fieldOf = (e, alias) => e.fields.find(f => f.alias === alias)?.value;
  const rollTable = e => {
    const head = [fieldOf(e, 'die') || 'Roll', ...(fieldOf(e, 'columns') ? fieldOf(e, 'columns').split(' | ') : [])];
    const rows = tableRows(fieldOf(e, 'entries'));
    const width = Math.max(...rows.map(r => r.length));
    const th = head.length === width ? `<thead><tr>${head.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
      : fieldOf(e, 'die') ? `<caption>Roll ${esc(fieldOf(e, 'die'))}</caption>` : '';
    return `<div class="wrap"><table>${th}<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${toHtml(inline(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
  const HIDDEN = new Set(['name', 'description', 'entries', 'columns', 'die']);

  // Index: grouped by lens (src/lenses.mjs), the same CIDOC-CRM classes the explorer uses.
  const { lenses } = assignLenses(ontology, models.map(m => ({ alias: m.alias, ontology: m.ontology })));
  const sections = lenses.map(l => {
    const parts = l.models.map(alias => models.find(m => m.alias === alias)).map(m => {
      const items = sorted(entities.filter(e => e.model === m.alias));
      return items.length ? `<h3 id="${m.alias}">${esc(m.name)} (${items.length})</h3><ul>${items.map(e => `<li>${link(e, 0)}</li>`).join('')}</ul>` : '';
    }).join('');
    const code = l.class.replace(/^.*\//, '').replace(/_/g, ' ');
    return parts ? `<h2>${esc(l.label)} <span class="kind">${esc(code)}</span></h2>${parts}` : '';
  }).join('');
  fs.writeFileSync(path.join(outDir, 'index.html'),
    page(`${viewName} · Cairn World`, nav(0), `<h1>${esc(viewName)}</h1><p class="kind">${entities.length} entries</p><p><a href="../../index.html#/${esc(view)}/">Open the interactive explorer →</a></p>${sections}`, 0, footer));

  // Entity pages
  for (const e of entities) {
    const present = f => f.value !== null && f.value !== undefined && !(Array.isArray(f.value) && !f.value.length);
    const valueHtml = f => {
      if (f.targets.length) return f.value.map(id => byId.get(id)).filter(Boolean).map(t => link(t, 1)).join(', ');
      // A concept mapped to another ontology's term (vocab.csv `match`) links to that term.
      const term = v => { const uri = matches[f.collection]?.[v]; return uri ? `<a href="${esc(uri)}" title="${esc(uri)}">${esc(v)}</a>` : esc(v); };
      if (Array.isArray(f.value)) return f.value.map(term).join(', ');
      if (f.datatype === 'concept') return term(f.value);
      if (typeof f.value === 'boolean') return f.value ? 'Yes' : 'No';
      return typeof f.value === 'string' ? toHtml(inline(f.value)) : esc(f.value);
    };
    // A field that cites its rule links its label to that rule's page.
    const label = f => (f.rule?.key && byId.has(f.rule.id) ? `<a href="../rule/${esc(f.rule.key)}.html" title="Rule">${esc(f.label)}</a>` : esc(f.label));
    const rows = e.fields
      .filter(f => !HIDDEN.has(f.alias) && present(f))
      .map(f => {
        // A group: one line per entry, its values joined ("Mentor · Marcos").
        if (f.datatype === 'semantic') {
          const lines = f.value.map(item => item.fields.filter(present).map(valueHtml).join(' · '));
          return `<dt>${label(f)}</dt><dd>${lines.length > 1 ? `<ul class="group">${lines.map(l => `<li>${l}</li>`).join('')}</ul>` : lines[0]}</dd>`;
        }
        return `<dt>${label(f)}</dt><dd>${valueHtml(f)}</dd>`;
      }).join('');

    const inbound = (backlinks.get(e.id) ?? [])
      .sort((a, b) => inOrder(a.from, b.from))
      .map(b => `<li>${link(b.from, 1)} <span class="kind">${esc(modelName[b.from.model])} · ${esc(b.via)}</span></li>`).join('');

    const description = e.fields.find(f => f.alias === 'description')?.value;
    const body = `<p class="kind">${esc(modelName[e.model])} · ${esc(provenance(e, viewsMeta))}</p><h1>${esc(titleOf(e))}</h1>` +
      (description ? toHtml(blocks(description)) : '') +
      (e.model === 'rolltable' && fieldOf(e, 'entries') ? rollTable(e) : '') +
      (rows ? `<dl>${rows}</dl>` : '') +
      (inbound ? `<h2>Linked from</h2><ul>${inbound}</ul>` : '');

    const dir = path.join(outDir, e.model);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${e.key}.html`), page(`${titleOf(e)} · ${viewName}`, nav(1), body, 1, footer));
  }
}
