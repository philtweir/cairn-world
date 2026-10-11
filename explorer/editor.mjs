// The form that edits an entry, as an edit to the view's own layer (explorer/drafts.mjs): it
// writes cells as the layer's CSV would hold them, and only for the fields changed, so the edit
// overrides no more than it means to. Layer semantics show in the form: a single-valued field is
// replaced; a repeatable field or group (cardinality n) keeps what the layers below give it, and
// the edit can only add to it.
//
// A geometry is not edited here (the layer CSV takes it as WKT; see the README).

// ctx: { h, state, store, terms(graphid, alias) -> [{ label }], title }; e: the entry in full;
// entry: its edit so far, or null. Returns { el, read() -> the edit's { cells, rows } }.
export function editForm(ctx, e, entry) {
  const { h, state, store } = ctx;
  const m = state.modelOf[e.model];
  const draft = entry ?? { model: e.model, key: e.key, created: false, cells: {}, rows: [] };
  const valueOf = alias => e.fields.find(f => f.alias === alias)?.value ?? null;
  const keyOf = id => state.byId.get(id)?.key ?? null;
  const parts = [];

  for (const n of m.nodes.filter(x => !x.parent)) {
    if (n.datatype === 'geojson-feature-collection') {
      parts.push({ el: h('div', { class: 'efield' }, h('span', { class: 'elabel' }, n.name), h('p', { class: 'note' }, 'A geometry is edited in the layer’s CSV (as WKT).')) });
      continue;
    }
    if (n.datatype === 'semantic') { parts.push(group(n)); continue; }
    const now = cellOf(n, valueOf(n.alias));
    if (n.cardinality === 'n') {
      // What the layers give it stays; the edit adds to it.
      const added = new Set(splitCell(draft.cells[n.alias]));
      const kept = [].concat(valueOf(n.alias) ?? []).filter(v => !added.has(n.targets.length ? keyOf(v) : String(v)));
      const input = inputFor(n, draft.cells[n.alias] ?? '');
      parts.push({
        el: h('div', { class: 'efield' }, h('span', { class: 'elabel' }, n.name),
          kept.length ? h('p', { class: 'kept' }, h('small', {}, 'From the layers: '), kept.map((v, i) => [i ? ', ' : '', n.targets.length ? (state.byId.get(v) ? ctx.title(state.byId.get(v)) : v) : String(v)])) : null,
          h('div', { class: 'eadd' }, h('small', {}, kept.length ? 'Add: ' : ''), input.el)),
        read: out => { const c = input.read(); if (c || n.alias in draft.cells) out.cells[n.alias] = c; },
      });
      continue;
    }
    const input = inputFor(n, n.alias in draft.cells ? draft.cells[n.alias] : now);
    parts.push({
      el: h('label', { class: 'efield' }, h('span', { class: 'elabel' }, n.name), input.el),
      read: out => { const c = input.read(); if (n.alias in draft.cells || c !== now) out.cells[n.alias] = c; },
    });
  }

  // A group: one entry (all its fields together, as the layer must give them) or, if repeatable,
  // its entries from the layers plus the ones this edit adds.
  function group(n) {
    const kids = m.nodes.filter(c => c.parent === n.alias);
    const items = valueOf(n.alias) ?? [];
    const cellsOf = item => Object.fromEntries(kids.map(c => [c.alias, cellOf(c, item.fields.find(f => f.alias === c.alias)?.value ?? null)]));
    if (n.cardinality !== 'n') {
      const now = items[0] ? cellsOf(items[0]) : Object.fromEntries(kids.map(c => [c.alias, '']));
      const inputs = kids.map(c => [c, inputFor(c, c.alias in draft.cells ? draft.cells[c.alias] : now[c.alias])]);
      return {
        el: h('fieldset', { class: 'efield' }, h('legend', {}, n.name), inputs.map(([c, i]) => h('label', {}, h('span', { class: 'elabel' }, c.name), i.el))),
        read: out => {
          const got = Object.fromEntries(inputs.map(([c, i]) => [c.alias, i.read()]));
          if (kids.some(c => c.alias in draft.cells || got[c.alias] !== now[c.alias])) Object.assign(out.cells, got);
        },
      };
    }
    const mine = draft.rows.filter(r => Object.keys(r).some(k => kids.some(c => c.alias === k)));
    const same = (a, b) => kids.every(c => (a[c.alias] ?? '') === (b[c.alias] ?? ''));
    const kept = items.filter(i => !mine.some(r => same(cellsOf(i), r)));
    const added = h('ul', { class: 'added' });
    const rows = [];
    const show = r => {
      const li = h('li', {}, kids.filter(c => r[c.alias]).map((c, i) => [i ? ' · ' : '', `${c.name}: ${r[c.alias]}`]), ' ',
        h('button', { type: 'button', class: 'linkish', onclick: () => { rows.splice(rows.indexOf(r), 1); li.remove(); } }, 'Remove'));
      rows.push(r);
      added.append(li);
    };
    mine.forEach(show);
    let inputs = [];
    const fresh = h('div', { class: 'erow' });
    const reset = () => { inputs = kids.map(c => [c, inputFor(c, '')]); fresh.replaceChildren(...inputs.map(([c, i]) => h('label', {}, h('span', { class: 'elabel' }, c.name), i.el))); };
    reset();
    return {
      el: h('fieldset', { class: 'efield' }, h('legend', {}, n.name),
        kept.length ? h('ul', { class: 'kept' }, kept.map(i => h('li', {}, i.fields.filter(f => f.value != null && !(Array.isArray(f.value) && !f.value.length)).map((f, j) => [j ? ' · ' : '', f.targets.length ? [].concat(f.value).map(id => (state.byId.get(id) ? ctx.title(state.byId.get(id)) : id)).join(', ') : String(f.value)])))) : null,
        added, fresh,
        h('button', { type: 'button', onclick: () => { const r = Object.fromEntries(inputs.map(([c, i]) => [c.alias, i.read()]).filter(([, v]) => v)); if (Object.keys(r).length) { show(r); reset(); } } }, `Add to ${n.name}`)),
      read: out => { out.rows.push(...rows); },
    };
  }

  // A field's input, holding its CSV cell.
  function inputFor(n, cell) {
    const label = `${m.name}: ${n.name}`;
    if (n.targets.length) return picker(n, cell, label);
    if (n.datatype === 'number') { const i = h('input', { type: 'number', step: 'any', value: cell, 'aria-label': label }); return { el: i, read: () => i.value.trim() }; }
    if (n.datatype === 'boolean') {
      const s = h('select', { 'aria-label': label }, h('option', { value: '' }, '—'), h('option', { value: 'true', selected: cell === 'true' }, 'Yes'), h('option', { value: 'false', selected: cell === 'false' }, 'No'));
      return { el: s, read: () => s.value };
    }
    if (n.datatype === 'concept') {
      const s = h('select', { 'aria-label': label }, h('option', { value: '' }, '—'), cell ? h('option', { value: cell, selected: true }, cell) : null);
      ctx.terms(m.graphid, n.alias).then(ts => { for (const t of ts) if (t.label !== cell) s.append(h('option', { value: t.label }, t.label)); });
      return { el: s, read: () => s.value };
    }
    if (n.datatype === 'concept-list') {
      const list = h('datalist', { id: `el-${n.alias}` });
      ctx.terms(m.graphid, n.alias).then(ts => list.append(...ts.map(t => h('option', { value: t.label }))));
      const i = h('input', { type: 'text', value: cell, list: list.id, placeholder: 'Terms, separated by commas', 'aria-label': label });
      return { el: h('span', {}, i, list), read: () => splitCell(i.value).join(',') };
    }
    const long = n.alias !== 'name' && (cell.length > 60 || /\n/.test(cell) || n.alias === 'description');
    const i = long ? h('textarea', { rows: Math.min(14, Math.max(3, Math.ceil(cell.length / 70) + (cell.match(/\n/g)?.length ?? 0))), 'aria-label': label }, cell)
      : h('input', { type: 'text', value: cell, 'aria-label': label });
    return { el: i, read: () => i.value.trim() };
  }

  // Links: the entries as chips, removable, and a box that finds more by name.
  function picker(n, cell, label) {
    const chosen = splitCell(cell);   // slugs
    const box = h('span', { class: 'picks' });
    const draw = () => box.replaceChildren(...chosen.map(k => h('span', { class: 'pick' }, nameOfKey(k), ' ',
      h('button', { type: 'button', 'aria-label': `Remove ${nameOfKey(k)}`, onclick: () => { chosen.splice(chosen.indexOf(k), 1); draw(); } }, '×'))));
    const nameOfKey = k => { const x = [...state.byId.values()].find(y => y.key === k && n.targets.includes(y.model)); return x ? ctx.title(x) : k; };
    draw();
    const list = h('datalist', { id: `el-${n.alias}-${Math.random().toString(36).slice(2, 8)}` });
    const found = new Map();
    const one = n.datatype === 'resource-instance';
    const input = h('input', { type: 'search', list: list.id, placeholder: one ? 'Find an entry' : 'Add an entry', 'aria-label': label });
    let typed = 0;
    input.oninput = async () => {
      const hit = found.get(input.value);
      if (hit) {
        if (one) chosen.splice(0);
        if (!chosen.includes(hit.key)) chosen.push(hit.key);
        input.value = '';
        draw();
        return;
      }
      const mine = ++typed, t = input.value.trim();
      if (t.length < 2) return;
      const rs = await store.named(t, { models: n.targets, general: true, limit: 8 });
      if (mine !== typed) return;
      found.clear();
      list.replaceChildren(...rs.map(x => { const v = `${ctx.title(x)} (${state.modelOf[x.model]?.name ?? x.model})`; found.set(v, x); return h('option', { value: v }); }));
    };
    return { el: h('span', { class: 'picker' }, box, input, list), read: () => chosen.join(',') };
  }

  // A value, as read, back to its CSV cell.
  function cellOf(n, v) {
    if (v == null) return '';
    if (n.targets.length) return [].concat(v).map(id => keyOf(id) ?? '').filter(Boolean).join(',');
    if (Array.isArray(v)) return v.join(',');
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  return {
    el: h('div', { class: 'eform' }, parts.map(p => p.el)),
    read() {
      const out = { cells: {}, rows: [] };
      for (const p of parts) p.read?.(out);
      return { ...draft, cells: out.cells, rows: out.rows };
    },
  };
}

export const splitCell = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
