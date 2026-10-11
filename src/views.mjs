// Views grouped by universe, for the explorer's selector: each universe, then its eras (in their
// order), each followed by the campaigns set in it, then the campaigns set in the universe itself.
// A campaign is filed under the first era, else the first universe, in its stack; one set in none
// goes in a group of its own.
// Input is data/views.json; output is [{ universe: view|null, label, views: [view, ...] }], each
// view with `depth`: 0 for a universe, 1 for an era or a campaign set in the universe, 2 for a
// campaign set in an era.

export function groupViews(viewsMeta) {
  const kindOf = k => viewsMeta.layers[k]?.kind;
  const groups = new Map();
  const groupFor = key => {
    if (!groups.has(key)) {
      const u = key && viewsMeta.views.find(v => v.key === key);
      groups.set(key, { universe: u ?? null, label: u?.name ?? viewsMeta.layers[key]?.name ?? 'Not set in a universe', views: [] });
    }
    return groups.get(key);
  };
  for (const v of viewsMeta.views) groupFor(v.kind === 'universe' ? v.key : v.stack.find(l => kindOf(l) === 'universe') ?? null);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const eraOf = v => v.stack.find(l => kindOf(l) === 'era') ?? null;
  return [...groups.entries()]
    .sort(([, a], [, b]) => (a.universe || a.label !== 'Not set in a universe' ? 0 : 1) - (b.universe || b.label !== 'Not set in a universe' ? 0 : 1) || a.label.localeCompare(b.label))
    .map(([key, g]) => {
      const mine = viewsMeta.views.filter(v => (v.kind === 'universe' ? v.key : v.stack.find(l => kindOf(l) === 'universe') ?? null) === key);
      const eras = mine.filter(v => v.kind === 'era').sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || byName(a, b));
      const campaigns = mine.filter(v => v.kind === 'campaign').sort(byName);
      return {
        ...g,
        views: [
          ...mine.filter(v => v.kind === 'universe').map(v => ({ ...v, depth: 0 })),
          ...eras.flatMap(e => [{ ...e, depth: 1 }, ...campaigns.filter(c => eraOf(c) === e.key).map(c => ({ ...c, depth: 2 }))]),
          ...campaigns.filter(c => !eraOf(c) || !eras.some(e => e.key === eraOf(c))).map(c => ({ ...c, depth: 1 })),
        ],
      };
    });
}
