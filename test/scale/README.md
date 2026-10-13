# Scaling harness

The rule this checks: **nothing the explorer reads may grow with the number of entries in a world
(N).** Reading one entry in full is fine, since its cost is that entry's size; reading anything
whose size is proportional to N (a table of every entry, a file scanned to find one row, a list
of every id) is not. The harness builds synthetic worlds of different sizes, runs the real
explorer over the same pages in each, measures what every page reads, and reports how each
measure grows with N.

```sh
# a world of N entries, built alone in a scratch copy of the repository (General included)
node test/scale/workspace.mjs 1000  /tmp/scale-1000
node test/scale/workspace.mjs 16000 /tmp/scale-16000
# what each page reads (needs Playwright with Chromium, and strace)
NODE_PATH=$(npm root -g) node test/scale/measure.mjs /tmp/scale-1000/dist  m-1000.json
NODE_PATH=$(npm root -g) node test/scale/measure.mjs /tmp/scale-16000/dist m-16000.json
# growth: each measure's exponent k in bytes ~ N^k; fails if any k > 0.2
node test/scale/report.mjs 1000=m-1000.json 16000=m-16000.json
```

- **`generate.mjs`**: a synthetic universe of N entries in a fixed shape: a quarter places (a
  hierarchy under one world-place), a tenth groups, two fifths people, a quarter events (in chains
  of ten, half dated), each linking to a bounded number of others. One hub, "the world", is
  mentioned by about a tenth of all entries, so its backlinks grow with N, as a real world's
  busiest entries' do. Deterministic for a given N.
- **`workspace.mjs`**: copies the tracked files except the other layers, links `node_modules`
  and `.cache`, adds the generated world, builds. 1,000 entries take about 20 s, 16,000 about
  140 s.
- **`engine-server.mjs`**: the explorer's query engine stood in for by DuckDB's native build (the
  browser's needs a Parquet extension this sandbox cannot download), in a process of its own: same
  SQL (`explorer/engine-sql.mjs`), same files, same Rós Madair compiler, every file read by range
  as the browser reads any file too large to fetch whole.
- **`measure.mjs`**: the real explorer in Chromium; the engine traced with `strace`, cut per
  page by marker files, so every byte DuckDB reads from the view's Parquet is counted; the static
  server counting everything else the browser fetches. Pages: the view opening; the Places, Events
  & Times and People lenses; a person, an event, a place and the hub; a name search; and a cold
  start straight onto a person. Measures: distinct bytes read, every read (re-reads included),
  files opened, requests (reads within 16 KB merged, roughly what an HTTP range reader asks for),
  and the browser's own bytes and requests.
- **`report.mjs`**: the measures side by side, and each one's growth exponent between the
  smallest and largest world.

The traced reads are DuckDB native's against local files. DuckDB in the browser reads the same row
groups and column chunks over HTTP, coalesced differently, so absolute requests differ; how they
grow with N is the point.

## Baseline (October 2026, before any of the fixes)

```
page            measure               N=1000     N=4000    N=16000   exponent
open            engine bytes             81K       176K       509K    0.66  GROWS
lens-places     engine bytes            157K       499K      1852K    0.89  GROWS
lens-time       engine bytes            235K       822K      3127K    0.93  GROWS
lens-actors     engine bytes            261K       951K      1121K    0.53  GROWS
entry-npc       engine bytes            204K      2246K      7358K    1.29  GROWS
entry-event     engine bytes            190K      2231K      8247K    1.36  GROWS
entry-place     engine bytes            220K      2299K      6042K    1.20  GROWS
entry-hub       engine bytes            187K      2170K      9112K    1.40  GROWS
search          browser bytes           250K       263K       320K    0.09
cold-entry-npc  engine bytes            642K      2416K      8002K    0.91  GROWS
```

(Requests grow too, more slowly: an entry page goes from 10-15 to 21-26. The browser's own fetches
are flat, apart from Pagefind's slight growth with the index.)

Where it goes, at 16,000 entries:

- **Entry pages** read most of several models' tile files (2.5 MB of a 2.7 MB file), because
  they look tiles up by `resource_id`, and Rós Madair sorts tiles by its cluster key: each
  resource's tiles lie together, but in no id order, so no row group can be skipped.
- **The view opening and every list** read all of `resources.parquet` (0.5 MB at this size):
  counts, the sidebar and the lists scan it, and id lookups cannot prune it either (it is sorted by
  model and name).
- **The hub** also reads most of `mentions.parquet`, its backlinks unpaged.
- **The Events & Times lens** reads the whole event tile file, for the time strip and the list.

The fixes, in order (what they ask of Rós Madair is in `docs/ros-madair.md`): locate tiles by cluster key and
use the render cache; the entry table sorted by id in bounded files; paged backlinks and per-scope
lists; precomputed counts; access as rules; a map tile pyramid and a local time strip.
