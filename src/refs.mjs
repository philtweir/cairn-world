// Inline references in text: [[Caryes]] links to the entry named Caryes; [[faction/realm-ievure|the
// Emirate]] names the target exactly (model/key) and shows "the Emirate". Names match ignoring
// case, a leading "The" and a trailing parenthetical ("The Prince of Miurna (deceased)" is
// [[Prince of Miurna]]). A reference that matches nothing, or several things, stays plain text;
// the build warns about both. Shared by the build, the reader and both renderers.

export const REF = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

export const normName = s => String(s).toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();

// candidates: [{ model, key, name, ... }] -> target -> { hit } | { ambiguous: [...] } | { missing: true }
export function makeResolver(candidates) {
  const byRoute = new Map(), byKey = new Map(), byName = new Map();
  const push = (m, k, c) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(c)) m.get(k).push(c); };
  for (const c of candidates) {
    byRoute.set(`${c.model}/${c.key}`, c);
    push(byKey, c.key, c);
    if (c.name) push(byName, normName(c.name), c);
  }
  return target => {
    const t = target.trim();
    if (t.includes('/')) { const c = byRoute.get(t); return c ? { hit: c } : { missing: true }; }
    const named = byName.get(normName(t)) ?? [];
    if (named.length === 1) return { hit: named[0] };
    const keyed = byKey.get(t) ?? [];
    if (keyed.length === 1) return { hit: keyed[0] };
    if (named.length > 1 || keyed.length > 1) return { ambiguous: named.length > 1 ? named : keyed };
    return { missing: true };
  };
}

export const refsIn = text => [...String(text ?? '').matchAll(REF)].map(m => ({ target: m[1], label: m[2] ?? m[1], raw: m[0] }));
