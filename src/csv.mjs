// Minimal RFC 4180 CSV reader/writer (quoted cells, escaped quotes, CRLF, BOM).

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

const quote = s => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows) {
  return rows.map(r => r.map(c => quote(String(c ?? ''))).join(',')).join('\n') + '\n';
}
