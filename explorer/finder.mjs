// Finding entries without reading them all: filters over the view's Rós Madair substrate (run by
// query-engine.mjs) and text search over its Pagefind index (both built by src/search-index.mjs).
// Results are entry ids (with a search match's record), so no entry is read to find it.
//
// A filter is a set of conditions on one model's fields, compiled as Rós Madair query IR:
//   concept field  is one of its collection's terms         { concept: { path, op: 'is', value } }
//   link field     links to a given entry, to anything, or to nothing
//                                                           { has_link: { path, target? } }, { not: ... }
//   geometry       overlaps the box a map is showing        { bbox: { path, min_lng, ... } }
//   number         within a range                           { range: { path, lo, hi } }
// A number is indexed as round(value x 10^decimals), `decimals` from the node's config (default 6),
// as Rós Madair's emitter scales it, so the range is scaled the same way.

const FILTERABLE = d => ['concept', 'concept-list', 'resource-instance', 'resource-instance-list', 'geojson-feature-collection', 'number'].includes(d);

export function makeFinder({ data, suffix, view, models, engine, h, put, icon }) {
  const search = view.search ?? null;
  const graphText = new Map();   // graphid -> the model's Arches JSON (text), fetched once
  const graph = gid => graphText.get(gid) ?? graphText.set(gid, fetch(`${data}/graphs/${gid}.json${suffix}`).then(r => r.text())).get(gid);
  const collections = new Map();
  const termsOf = async (gid, alias) => {
    const node = JSON.parse(await graph(gid)).graph[0].nodes.find(n => n.alias === alias);
    const id = node?.config?.rdmCollection;
    if (!id) return [];
    if (!collections.has(id)) collections.set(id, fetch(`${data}/collections/${id}.json${suffix}`).then(r => r.json()));
    const c = await collections.get(id);
    // A tile holds a term's label id (its prefLabel's), which is what the substrate indexes.
    return Object.values(c.__allConcepts).map(t => t.prefLabels.en ?? Object.values(t.prefLabels)[0]).filter(Boolean)
      .map(l => ({ id: l.id, label: l.value })).sort((a, b) => a.label.localeCompare(b.label));
  };

  const getEngine = async () => engine;

  let pagefind = null;
  const getPagefind = () => (pagefind ??= (async () => {
    const url = `${data}/${search.pagefind}pagefind.js${suffix}`;   // the view's index
    const pf = await import(url);
    await pf.options({ excerptLength: 16 });
    await pf.init();
    return pf;
  })().catch(err => { pagefind = null; throw err; }));

  // conditions: model alias -> field alias -> { where, label }; results: model alias -> Set of ids.
  // Only the latest run sets the results: an earlier one finishing later must not undo a change.
  const conditions = new Map();
  let results = new Map(), runs = 0;

  async function run() {
    const mine = ++runs;
    const active = [...conditions].filter(([, fs]) => fs.size).map(([alias, fs]) => [alias, [...fs.values()].map(f => f.where)]);
    const next = new Map();
    if (active.length) {
      const e = await getEngine();
      for (const [alias, parts] of active) {
        const m = models.find(x => x.alias === alias);
        next.set(alias, new Set(await e.select(m.graphid, parts.length === 1 ? parts[0] : { all: parts })));
      }
    }
    if (mine !== runs) return false;
    results = next;
    return true;
  }

  return {
    // A concept field's terms ({ id, label }), from its vocabulary.
    terms: termsOf,
    // Filters need the substrate; text search the Pagefind index. A gated view has neither.
    canFilter: !!search?.substrate,
    canSearch: !!search?.pagefind,
    active: () => results.size > 0,
    // Which models a filter is set on, and the ids that pass among some models.
    filtered: alias => results.has(alias),
    ids: aliases => aliases.flatMap(a => [...(results.get(a) ?? [])]),
    // Whether an entry passes the filters: models without a filter drop out while any is set.
    passes: e => !results.size || !!results.get(e.model)?.has(e.id),
    clear() { conditions.clear(); results = new Map(); runs++; },

    // The panel for the models in view: each model's filterable fields. `onChange` redraws the list.
    panel(scopeModels, onChange) {
      const box = h('div', { class: 'filters' });
      const status = h('p', { class: 'fstatus', role: 'status' });
      const apply = async () => {
        status.textContent = 'Filtering…';
        try { if (await run()) { status.textContent = ''; onChange(); } }
        catch (err) { console.error(err); status.textContent = `Filtering failed: ${err?.message ?? err}`; }
      };
      const set = (alias, field, cond) => {
        const fs = conditions.get(alias) ?? conditions.set(alias, new Map()).get(alias);
        if (cond) fs.set(field, cond); else fs.delete(field);
        apply();
      };
      for (const m of scopeModels) {
        const nodes = m.nodes.filter(n => FILTERABLE(n.datatype) && !n.parent);
        if (!nodes.length) continue;
        const rows = nodes.map(n => {
          const current = conditions.get(m.alias)?.get(n.alias);
          if (n.datatype.startsWith('concept')) {
            const sel = h('select', { 'aria-label': `${m.name}: ${n.name}` }, h('option', { value: '' }, 'Any'));
            termsOf(m.graphid, n.alias).then(ts => {
              for (const t of ts) sel.append(h('option', { value: t.id, selected: current?.value === t.id }, t.label));
            });
            sel.onchange = () => set(m.alias, n.alias, sel.value && { value: sel.value, where: { concept: { path: n.alias, op: 'is', value: sel.value } } });
            return h('label', {}, h('span', {}, n.name), sel);
          }
          if (n.datatype.startsWith('resource-instance')) {
            // Any, some link, none, or a particular entry (suggested by the text index as you type).
            const sel = h('select', { 'aria-label': `${m.name}: ${n.name}` },
              h('option', { value: '' }, 'Any'), h('option', { value: 'some' }, 'Has one'), h('option', { value: 'none' }, 'Has none'),
              search?.pagefind && h('option', { value: 'to' }, 'Is…'));
            const list = h('datalist', { id: `fl-${m.alias}-${n.alias}` });
            const input = h('input', { type: 'search', list: list.id, placeholder: 'Type a name', 'aria-label': `${m.name}: ${n.name}: which`, hidden: true });
            const found = new Map();
            sel.value = current?.mode ?? '';
            if (current?.mode === 'to') { input.hidden = false; input.value = current.label; }
            sel.onchange = () => {
              input.hidden = sel.value !== 'to';
              if (sel.value === 'to') { input.focus(); return; }
              set(m.alias, n.alias, sel.value === 'some' ? { mode: 'some', where: { has_link: { path: n.alias } } }
                : sel.value === 'none' ? { mode: 'none', where: { not: { has_link: { path: n.alias } } } } : null);
            };
            let typed = 0;
            input.oninput = async () => {
              const hit = found.get(input.value);
              if (hit) { set(m.alias, n.alias, { mode: 'to', label: input.value, where: { has_link: { path: n.alias, target: hit } } }); return; }
              const mine = ++typed, q = input.value.trim();
              if (q.length < 2) return;
              const pf = await getPagefind();
              const s = await pf.debouncedSearch(q, {}, 200);
              if (!s || mine !== typed) return;
              // The best eight entries of the models the link can point to, from the first 80 matches.
              const ds = (await Promise.all(s.results.slice(0, 80).map(r => r.data())))
                .filter(d => !n.targets.length || n.targets.includes(d.meta.model)).slice(0, 8);
              if (mine !== typed) return;
              found.clear();
              put(list, ds.map(d => { found.set(d.meta.title, d.meta.id); return h('option', { value: d.meta.title }); }));
            };
            return h('label', {}, h('span', {}, n.name), h('div', { class: 'frow' }, sel, input, list));
          }
          if (n.datatype === 'number') {
            const lo = h('input', { type: 'number', step: 'any', placeholder: 'from', 'aria-label': `${m.name}: ${n.name}: from`, value: current?.lo ?? '' });
            const hi = h('input', { type: 'number', step: 'any', placeholder: 'to', 'aria-label': `${m.name}: ${n.name}: to`, value: current?.hi ?? '' });
            const change = async () => {
              if (lo.value === '' && hi.value === '') { set(m.alias, n.alias, null); return; }
              const d = Math.min(18, JSON.parse(await graph(m.graphid)).graph[0].nodes.find(x => x.alias === n.alias)?.config?.decimals ?? 6);
              const scale = v => Math.round(Number(v) * 10 ** d);
              set(m.alias, n.alias, { lo: lo.value, hi: hi.value, where: { range: { path: n.alias, lo: lo.value === '' ? -(2 ** 53) : scale(lo.value), hi: hi.value === '' ? 2 ** 53 : scale(hi.value) } } });
            };
            lo.onchange = change; hi.onchange = change;
            return h('label', {}, h('span', {}, n.name), h('div', { class: 'frow' }, lo, '–', hi));
          }
          // Geometry: the box the map on screen is showing.
          const show = h('span', { class: 'fbox' }, current ? current.label : 'Anywhere');
          const use = h('button', { type: 'button' }, 'Use the map’s view');
          const clear = h('button', { type: 'button', hidden: !current, 'aria-label': 'Clear' }, '×');
          use.onclick = () => {
            const maps = [...document.querySelectorAll('.geomap')].filter(x => x.viewBounds);
            const b = maps.at(-1)?.viewBounds();
            if (!b) { show.textContent = maps.length ? 'Zoom in: the map shows too much' : 'Open a map first'; return; }
            const label = `${b[0]}…${b[2]}°, ${b[1]}…${b[3]}°`;
            show.textContent = label; clear.hidden = false;
            set(m.alias, n.alias, { label, where: { bbox: { path: n.alias, min_lng: b[0], min_lat: b[1], max_lng: b[2], max_lat: b[3] } } });
          };
          clear.onclick = () => { show.textContent = 'Anywhere'; clear.hidden = true; set(m.alias, n.alias, null); };
          return h('label', {}, h('span', {}, n.name), h('div', { class: 'frow' }, use, show, clear));
        });
        box.append(h('fieldset', {}, h('legend', {}, icon('filter'), ` ${m.name}`), rows));
      }
      if (!box.childNodes.length) box.append(h('p', { class: 'fstatus' }, 'Nothing here to filter on.'));
      box.append(status);
      return box;
    },

    // Text search: the best matches, in rank order, whose records (id, model, key, title, general)
    // `accept` lets through, up to `limit`
    // (each match's details are a small file of their own, so they are read only as needed, and
    // reading stops once there are enough).
    async search(q, accept, limit) {
      const pf = await getPagefind();
      const s = await pf.search(q);
      const hits = [];
      let read = 0;
      for (; read < s.results.length && hits.length < limit; read += 40) {
        const ds = await Promise.all(s.results.slice(read, read + 40).map(r => r.data()));
        for (const d of ds) if (hits.length < limit && accept(d.meta)) hits.push({ id: d.meta.id, excerpt: d.excerpt, meta: d.meta });
      }
      // `complete`: every match was looked at, so the hits are all there are (in view).
      return { hits, complete: read >= s.results.length };
    },
  };
}

// A Pagefind excerpt (HTML, with <mark> round the matched words) as DOM, without innerHTML: the
// marks split it, and the escapes Pagefind writes are undone.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" };
export function excerptNodes(h, html) {
  const decode = s => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ENTITIES[e]);
  return html.split(/(<mark>[\s\S]*?<\/mark>)/).filter(Boolean)
    .map(p => (p.startsWith('<mark>') ? h('mark', {}, decode(p.slice(6, -7))) : decode(p)));
}
