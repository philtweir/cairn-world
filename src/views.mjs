// Views grouped by universe, for the explorer's selector and the plain pages' index: each
// universe, then the campaigns set in it. A campaign set in several universes is listed under
// the first in its stack; one set in none goes in a group of its own.
// Input is data/views.json; output is [{ universe: view|null, label, views: [view, ...] }].

export function groupViews(viewsMeta) {
  const groups = new Map();
  const groupFor = key => {
    if (!groups.has(key)) {
      const u = key && viewsMeta.views.find(v => v.key === key);
      groups.set(key, { universe: u ?? null, label: u?.name ?? viewsMeta.layers[key]?.name ?? 'Not set in a universe', views: u ? [u] : [] });
    }
    return groups.get(key);
  };
  for (const v of viewsMeta.views) {
    if (v.kind === 'universe') { groupFor(v.key); continue; }
    const u = v.stack.find(l => viewsMeta.layers[l]?.kind === 'universe') ?? null;
    groupFor(u).views.push(v);
  }
  // Universes alphabetically, the ungrouped last; within a group the universe, then campaigns A–Z.
  return [...groups.values()]
    .sort((a, b) => (a.universe || a.label !== 'Not set in a universe' ? 0 : 1) - (b.universe || b.label !== 'Not set in a universe' ? 0 : 1) || a.label.localeCompare(b.label))
    .map(g => ({ ...g, views: [...g.views.filter(v => v.kind === 'universe'), ...g.views.filter(v => v.kind !== 'universe').sort((a, b) => a.name.localeCompare(b.name))] }));
}
