// The small slice of markdown the rules text uses (paragraphs, bullet and numbered lists,
// quotes, **bold**, _italic_), parsed to a tree that the explorer renders as DOM text nodes,
// so the text is never trusted as HTML.
//
//   node: { t: 'p'|'ul'|'ol'|'li'|'blockquote'|'strong'|'em'|'ref', c: [node|string] }
// A 'ref' node ([[target|label]], see src/refs.mjs) also has `target`; renderers resolve it.

export function inline(s) {
  const out = [];
  const re = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]|\*\*([^*]+)\*\*|(?<![\w*])[_*]([^_*\n]+)[_*](?![\w*])/g;
  let at = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > at) out.push(s.slice(at, m.index));
    if (m[1] !== undefined) out.push({ t: 'ref', target: m[1], c: [m[2] ?? m[1]] });
    else out.push(m[3] !== undefined ? { t: 'strong', c: inline(m[3]) } : { t: 'em', c: [m[4]] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

export function blocks(text) {
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) out.push({ t: 'p', c: inline(para.join(' ')) }); para = []; };
  const flushList = () => { if (list) out.push(list); list = null; };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) { flushPara(); flushList(); continue; }
    if ((m = /^[-*]\s+(.*)$/.exec(line)) || (m = /^\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      const t = /^\d/.test(line) ? 'ol' : 'ul';
      if (list?.t !== t) { flushList(); list = { t, c: [] }; }
      list.c.push({ t: 'li', c: inline(m[1]) });
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara(); flushList();
      const last = out.at(-1);
      if (last?.t === 'blockquote') last.c.push(' ', ...inline(m[1])); else out.push({ t: 'blockquote', c: inline(m[1]) });
    } else if (list) {
      // A wrapped list item.
      list.c.at(-1).c.push(' ', ...inline(line));
    } else para.push(line);
  }
  flushPara(); flushList();
  return out;
}

// Roll Table entries are stored one per line as "roll | cell | cell".
export const tableRows = entries => String(entries ?? '').split('\n').filter(Boolean).map(l => l.split(' | '));
