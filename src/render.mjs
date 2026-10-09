// Static HTML for each view of the world. Input is what the ORM read back, so this exercises
// the same path a live display site would use.

import fs from 'node:fs';
import path from 'node:path';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ATTRIBUTION = 'Rules text adapted from <a href="https://cairnrpg.com">Cairn</a> by Yochai Gal, ' +
  '<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>. Unofficial fan project.';

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
dd{margin:0}
h2{font:600 15px system-ui,sans-serif;color:var(--muted);margin-top:2rem}
ul{padding-left:1.2rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);font:13px system-ui,sans-serif;color:var(--muted)}
@media (max-width:480px){dl{grid-template-columns:1fr}dd{margin-bottom:.4rem}}
`;

const page = (title, nav, body, depth) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${'../'.repeat(depth)}style.css">
</head><body><main>
<nav>${nav}</nav>
${body}
<footer>${ATTRIBUTION}</footer>
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
  const items = viewsMeta.views.map(v =>
    `<li><a href="${esc(v.key)}/index.html">${esc(v.name)}</a> <span class="kind">${esc(v.kind)} · ${v.stack.map(l => esc(viewsMeta.layers[l]?.name ?? l)).join(' › ')}</span></li>`).join('');
  fs.writeFileSync(path.join(outDir, 'index.html'), page('Cairn World', '<a href="../index.html">Explorer</a>',
    `<h1>Cairn World</h1><p>Pick a universe or campaign. Each shows its own entries on top of the ones it builds on.</p><ul>${items}</ul>`, 0));
}

export function renderSite({ view, viewsMeta, models, entities, outDir }) {
  const viewName = viewsMeta.views.find(v => v.key === view)?.name ?? view;
  const byId = new Map(entities.map(e => [e.id, e]));
  const titleOf = e => e.fields.find(f => f.alias === 'name')?.value ?? e.key;
  const modelName = Object.fromEntries(models.map(m => [m.alias, m.name]));
  const href = (e, depth) => `${'../'.repeat(depth)}${e.model}/${e.key}.html`;
  const link = (e, depth) => `<a href="${href(e, depth)}">${esc(titleOf(e))}</a>`;

  const nav = depth => `<a href="${'../'.repeat(depth + 1)}index.html">All views</a><a href="${'../'.repeat(depth)}index.html">${esc(viewName)}</a>` +
    models.map(m => `<a href="${'../'.repeat(depth)}index.html#${m.alias}">${esc(m.name)}</a>`).join('');

  // Reverse edges: who points at whom, and through which field.
  const backlinks = new Map();
  for (const e of entities) {
    for (const f of e.fields) {
      if (!f.targets.length || !f.value) continue;
      for (const id of f.value) {
        if (!backlinks.has(id)) backlinks.set(id, []);
        backlinks.get(id).push({ from: e, via: f.label });
      }
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'style.css'), CSS);

  const sorted = list => [...list].sort((a, b) => titleOf(a).localeCompare(titleOf(b)));

  // Index
  const sections = models.map(m => {
    const items = sorted(entities.filter(e => e.model === m.alias));
    return `<h2 id="${m.alias}">${esc(m.name)} (${items.length})</h2><ul>${items.map(e => `<li>${link(e, 0)}</li>`).join('')}</ul>`;
  }).join('');
  fs.writeFileSync(path.join(outDir, 'index.html'),
    page(`${viewName} · Cairn World`, nav(0), `<h1>${esc(viewName)}</h1><p class="kind">${entities.length} entries</p><p><a href="../../index.html#/${esc(view)}/">Open the interactive explorer →</a></p>${sections}`, 0));

  // Entity pages
  for (const e of entities) {
    const rows = e.fields
      .filter(f => f.alias !== 'name' && f.alias !== 'description' && f.value !== null && f.value !== undefined && !(Array.isArray(f.value) && !f.value.length))
      .map(f => {
        let v;
        if (f.targets.length) v = f.value.map(id => byId.get(id)).filter(Boolean).map(t => link(t, 1)).join(', ');
        else if (Array.isArray(f.value)) v = f.value.map(esc).join(', ');
        else v = esc(f.value);
        return `<dt>${esc(f.label)}</dt><dd>${v}</dd>`;
      }).join('');

    const inbound = (backlinks.get(e.id) ?? [])
      .sort((a, b) => titleOf(a.from).localeCompare(titleOf(b.from)))
      .map(b => `<li>${link(b.from, 1)} <span class="kind">${esc(modelName[b.from.model])} · ${esc(b.via)}</span></li>`).join('');

    const description = e.fields.find(f => f.alias === 'description')?.value;
    const body = `<p class="kind">${esc(modelName[e.model])} · ${esc(provenance(e, viewsMeta))}</p><h1>${esc(titleOf(e))}</h1>` +
      (description ? `<p>${esc(description)}</p>` : '') +
      (rows ? `<dl>${rows}</dl>` : '') +
      (inbound ? `<h2>Linked from</h2><ul>${inbound}</ul>` : '');

    const dir = path.join(outDir, e.model);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${e.key}.html`), page(`${titleOf(e)} · ${viewName}`, nav(1), body, 1));
  }
}
