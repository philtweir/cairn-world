// Extended Date/Time Format (EDTF, ISO 8601-2), as much of it as a world's history needs: read
// into a span of years, so dates can be checked (src/build.mjs) and drawn (explorer/time-strip.mjs).
//
//   0812          a year            -0400       400 years before year 0
//   0812-03       a month           0812-03-14  a day (a time after it is allowed, and ignored)
//   0812-21       a season: 21 spring, 22 summer, 23 autumn, 24 winter
//   08XX, 081X    unspecified digits: some year in that range
//   -0400~        approximate        0812?  uncertain        -0688%  both
//   -1188/-0188   an interval         ../0812  open start      0812/..  open end
//   /0812         unknown start (and 0812/, unknown end)
//
// Years are counted as written, year 0 included (EDTF's astronomical numbering), in whatever
// reckoning the world declares (layer.json "calendar"); `formatYear` names them.

const DATE = /^(-?)(\d{4}|\d{0,3}X{1,4}|\d{2,3}X{1,2}|\d{3}X)(?:-(\d{2}|XX)(?:-(\d{2}|XX)(?:T[\d:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)?)?)?)?([?~%]?)$/;
const SEASONS = { 21: [2, 5], 22: [5, 8], 23: [8, 11], 24: [11, 14] };   // months from the year's start
const SEASON_NAMES = { 21: 'spring', 22: 'summer', 23: 'autumn', 24: 'winter' };

// One date: { lo, hi } in years (hi exclusive), its qualifiers, and how precise it is.
function readDate(s) {
  const m = DATE.exec(s);
  if (!m) return null;
  const [, neg, year, month, day, q] = m;
  if (year.length !== 4) return null;
  const sign = neg ? -1 : 1;
  const lowest = Number(year.replace(/X/g, '0')), highest = Number(year.replace(/X/g, '9'));
  // A negative year counts down: -04XX runs from -0499 to -0400.
  let lo = sign > 0 ? lowest : -highest, hi = (sign > 0 ? highest : -lowest) + 1;
  let precision = /X/.test(year) ? 'years' : 'year';
  let season = null;
  if (month && month !== 'XX') {
    const n = Number(month);
    if (SEASONS[n]) { season = n; lo += SEASONS[n][0] / 12; hi = lo + 3 / 12; precision = 'season'; }
    else if (n >= 1 && n <= 12 && !/X/.test(year)) {
      lo += (n - 1) / 12; hi = lo + 1 / 12; precision = 'month';
      if (day && day !== 'XX') {
        const d = Number(day);
        if (d < 1 || d > 31) return null;
        lo += (d - 1) / 365; hi = lo + 1 / 365; precision = 'day';
      }
    } else return null;
  }
  return { lo, hi, approximate: q === '~' || q === '%', uncertain: q === '?' || q === '%', precision, season, year: sign * lowest, text: s };
}

// A value: { lo, hi, approximate, uncertain, open: { lo, hi }, start, end }, or null if it is not
// EDTF this reads. An open or unknown end is null in `lo`/`hi`.
export function readEdtf(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (!s.includes('/')) {
    const d = readDate(s);
    return d && { lo: d.lo, hi: d.hi, approximate: d.approximate, uncertain: d.uncertain, open: { lo: false, hi: false }, start: d, end: d };
  }
  const [a, b, ...rest] = s.split('/');
  if (rest.length) return null;
  const end = x => (x === '..' || x === '' ? null : readDate(x));
  const start = end(a), finish = end(b);
  if ((a && a !== '..' && !start) || (b && b !== '..' && !finish) || (!start && !finish)) return null;
  if (start && finish && start.lo > finish.lo) return null;
  return {
    lo: start?.lo ?? null, hi: finish?.hi ?? null,
    approximate: !!(start?.approximate || finish?.approximate), uncertain: !!(start?.uncertain || finish?.uncertain),
    open: { lo: a === '..', hi: b === '..' }, start, end: finish,
  };
}

// calendar: { after: 'óT', before: 'rT' } (layer.json); a year as the world writes it.
export function formatYear(y, calendar = null) {
  const n = Math.floor(y);
  const after = calendar?.after ?? '', before = calendar?.before ?? null;
  if (n < 0 && before) return `${(-n).toLocaleString('en')} ${before}`;
  return `${n.toLocaleString('en')}${after ? ` ${after}` : ''}`;
}

// A value read back as words: "c. 400 rT", "spring 812 óT", "1,188–188 rT", "before 812 óT".
export function formatEdtf(value, calendar = null) {
  const t = typeof value === 'string' ? readEdtf(value) : value;
  if (!t) return String(value ?? '');
  // One date, without its era: "c. 400", "spring 812", "the 800s", "14 March 812?".
  const one = d => {
    const y = Math.abs(d.year).toLocaleString('en');
    const parts = d.text.replace(/^-/, '').split('-');
    const when = d.precision === 'years' ? `the ${y}s`
      : d.precision === 'season' ? `${SEASON_NAMES[d.season]} ${y}`
      : d.precision === 'month' ? `${MONTHS[Number(parts[1]) - 1]} ${y}`
      : d.precision === 'day' ? `${Number(parts[2].slice(0, 2))} ${MONTHS[Number(parts[1]) - 1]} ${y}` : y;
    return `${d.approximate ? 'c. ' : ''}${when}${d.uncertain ? '?' : ''}`;
  };
  const era = d => (d.year < 0 ? calendar?.before ?? '' : calendar?.after ?? '');
  const tag = (s, d) => (era(d) ? `${s} ${era(d)}` : s);
  if (t.start === t.end) return tag(one(t.start), t.start);
  if (!t.start) return tag(t.open.lo ? `up to ${one(t.end)}` : `? – ${one(t.end)}`, t.end);
  if (!t.end) return t.open.hi ? `from ${tag(one(t.start), t.start)} on` : tag(`${one(t.start)} – ?`, t.start);
  if (era(t.start) === era(t.end)) return tag(`${one(t.start)}–${one(t.end)}`, t.end);
  return `${tag(one(t.start), t.start)} – ${tag(one(t.end), t.end)}`;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
