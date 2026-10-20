# Rós Madair: what this site publishes for it, and what it asks

This site builds on Rós Madair (pinned to `0.1.0-alpha.24`: the emitter, the npm compiler and the
crates move in lockstep, and a substrate's `format_version` must match its reader). Beside each
view's substrate it publishes its own tables, in `views/<view>/tables/`, for what Rós Madair does
not hold yet. This page proposes the contracts those tables would keep if Rós Madair reads them.
Nothing here is frozen until both sides say so; until then the tables keep their current columns
(noted against each).

General rules for all three:

- **Parquet, zstd, one file per view** (small: they are fetched whole, `src/tables.mjs`), each
  listed with its size in `tables/manifest.json` (`{ artifacts: [{ path, bytes }] }`, as the
  substrate's manifest lists its files).
- **Columns named here are the contract; any others are the consumer's own and ignored.** A
  reader must not fail on an unknown column, and a writer may add one without a version bump.
- **Sorted for the probe each is read by**, since pruning is by sort order only (no bloom filters
  in the bundled DuckDB writer).
- **Ids are Arches ids** (resource, graph, node, nodegroup, tile UUIDs as text), the same as in the
  substrate.

## 1. `resources.parquet`: the entry table

One row per resource in the view, after composition (a resource in several layers is one row).

| Column | Type | Null | Meaning |
|---|---|---|---|
| `resource_id` | VARCHAR | no | The resource instance id. Unique. |
| `graph_id` | VARCHAR | no | Its model's graph id. |
| `legacyid` | VARCHAR | no | The resource's `legacyid` (here: its slug, unique within its graph). |
| `descriptors` | STRUCT(name VARCHAR, description VARCHAR, map_popup VARCHAR) | no (members may be) | Arches' descriptors, as composed: what a chip, a list row or a link needs without hydrating. |
| `layers` | VARCHAR[] | no | The layers the resource comes from, bottom first (provenance; one element for a single-layer substrate). |
| `tags` | VARCHAR[] | no (may be empty) | Consumer flags, opaque to Rós Madair, for scoping (here: `general-only`). |
| `cluster_key` | UBIGINT | no | Where the resource's tiles are: the key the tile files are sorted by (§6). |

- **Sort:** `resource_id`, so a lookup by id prunes to one row group (§6). Here ids are derived
  from the graph and slug (uuid5), so a slug lookup (`[[model/key]]`) is an id lookup; a reader
  whose ids are not derived would want a second, `graph_id, legacyid`-sorted copy. Name order is a
  separate per-model index (§6), not this table's sort.
- **Uniqueness:** `(graph_id, legacyid)` and `resource_id` each unique.
- **Today (to migrate once frozen):** `resource_id, model, graph_id, key, name, layers, general`.
  `key` becomes `legacyid`, `name` becomes `descriptors.name`, `general` becomes the tag
  `general-only`, and `model` (the alias) stays as a consumer column.

## 2. In-text references as edges: an emit-time sidecar

Text fields here hold `[[model/key]]` references (CIDOC-CRM P67 refers to). They are links the
emitter cannot see, so today they are a separate `mentions.parquet` that the explorer unions with
the substrate's `edges_*`, and they are missing from `redges_*` and from `Backlink`.

Proposal: the emitter reads an optional **`data_dir/edges/*.jsonl`** (one JSON object a line) and
writes each row into the source resource's `edges_<graph>` and `redges_<graph>` like any other
edge:

| Field | Type | Null | Meaning |
|---|---|---|---|
| `src_resource` | string | no | The resource whose text refers. |
| `src_node` | string | no | The node holding the text (a real node id of the source's graph: here the `description` node, or whichever string node it is in). |
| `src_nodegroup` | string | no | That node's nodegroup. |
| `src_tile` | string | no | The tile holding the text. |
| `target_resource` | string | no | The resource referred to. |
| `predicate` | string | yes | The relationship, as a full URI; default the source node's own property. Here always `http://www.cidoc-crm.org/cidoc-crm/P67_refers_to`, so a typed query can tell a mention from a link field. |

- The row is attributed to a real node, nodegroup and tile, so a nodegroup-scoped window (§3) can
  hide a mention with the text it is in. Today's sidecar cannot do this: it uses the pseudo-node
  `mentions` with no tile, so a window has to require the whole resource to be readable.
- Rós Madair would need a `predicate` column on `edges_`/`redges_`, or a separate pseudo-node per
  predicate. The column is preferred, since the predicate is information, not a node.
- **Today:** `mentions.parquet`: `src_resource, src_node ('mentions'), src_nodegroup ('mentions'),
  src_tile (null), target_resource`, sorted `target_resource, src_resource`.

## 3. `access.parquet`: grants, resolved

Who may see what of a closed view, and from when (`src/access.mjs`). Resolved to ids at build
time, so nothing in it names a layer, a model alias or a field alias. Grants never end, so the
window only grows with the epoch.

| Column | Type | Null | Meaning |
|---|---|---|---|
| `principal` | VARCHAR | no | `everyone`, `group:<slug>` or `user:<slug>`. |
| `resource_id` | VARCHAR | no | The resource granted. |
| `nodegroup_id` | VARCHAR | yes | One nodegroup granted; null is the whole resource. |
| `permission` | VARCHAR | no | `read`, or `discover`: the resource exists, with its descriptors, and nothing else. |
| `from_epoch` | INTEGER | no | The epoch the grant starts at (0: from the start). |

Plus **`principals.parquet`**, membership already flattened:

| Column | Type | Null | Meaning |
|---|---|---|---|
| `principal` | VARCHAR | no | A principal. |
| `in` | VARCHAR | no | A principal whose grants it has: itself, `everyone`, and every group it is in, at any depth. One row each. |

**Sort:** `access` by `principal, resource_id`; `principals` by `principal`.

**The window** for principal P at epoch T is every row of `access` with `principal IN (SELECT in
FROM principals WHERE principal = P)` and `from_epoch <= T`. Reading through it means:

- a resource is visible (in `resources`, as a link target) if the window names it at all;
- a tile is readable if the window grants `read` on its resource with a null nodegroup, or on its
  nodegroup; concepts and ordered values go with their tile's nodegroup;
- an edge is visible if its target is visible and its source tile is readable (with §2, mentions
  included);
- `discover` gives the descriptors and nothing from the tiles.

**Today:** the same, except `from_epoch` is named `from` (a reserved word: a hazard for every
reader), and the membership closure is in `views.json`, not a table. Epoch names and dates
(display only) are in `views.json`; they need not be part of the contract.

## 4. Dates: what the ordered store gets now, and a test range

The site's dates are EDTF (`src/edtf.mjs` is a small reader of the subset it uses: lo/hi in years,
qualifiers, precision). `quantize_date` (alizarin-core) handles plain ISO dates only. On this
site's data, through alpha.24:

| Value | Meaning | Ordered row? |
|---|---|---|
| `0000` | year 0 | yes: -719528 (1 Jan 0000), correct |
| `0812-21` | spring 812 (EDTF season) | **none** (month 21 rejected) |
| `-1188~/-0188~` | c. 1188 to c. 188 before year 0 | **none** (interval, qualifiers) |
| `../0812` | up to 812, open start | **none** |
| `-0400~`, `0812?`, `08XX` | approximate, uncertain, unspecified | **none** (qualifier and `X` fail the year parse) |

Negative plain years should compute (Hinnant's `days_from_civil` is exact for them), but nothing
here has exercised it. **Test range for this world:** years **-2000 to 1000** (the First Empire is
c. -1188 to -188; the present is 812), in every form above.

Proposal for the `[lo, hi]` ordered store:

- `q_lo`, `q_hi` BIGINT days from 1970-01-01. `q_hi` exclusive: the day after the last day the
  value can mean. A year is its 1 January to the next; a season is three months (EDTF 21 spring:
  March to May; 22 summer; 23 autumn; 24 winter: December to February); `08XX` is 0800 to 0900.
- Open ends NULL; an unknown end (`/0812`) NULL as well.
- `approximate`, `uncertain` BOOLEAN; they leave the bounds as written (a reader may widen).
- A range predicate is an overlap test (`q_lo < hi AND q_hi > lo`), with NULL ends open.

## 5. The top three, from this side

1. **The entry table (§1).** Agreed: the broadest payoff, and the smallest change here.
2. **In-text refs as edges, with a predicate (§2).** For this site this ranks above field-merge
   overlays. Composition here is done at build by Alizarin and works. The only browser overlay is
   the edit layer, which is small and ours. Mentions, though, are half of every page's
   connections, and they are what keeps `mentions.parquet`, the union in every edges view and the
   whole-resource rule in access windows alive.
3. **EDTF intervals in the ordered store (§4).** Until then the explorer places dates itself and
   date filters miss most of this site's values.

Field-merge overlays and browser hydration matter less here: Alizarin composes and hydrates
already. `--no-render-cache` is in use for now (`src/search-index.mjs`), because nothing here reads
the cache yet: the explorer names links from `resources.parquet`. That is the small-world shortcut
(§6): at scale the cache is how a page names its links without a table of every entry, so it comes
back on with locator-aware hydration, and it has to respect access (§3): a tile's cache may only
carry the names of targets its readers can discover.

**On the render cache's cost:** the +49% measured earlier was of the tiles' `data` JSON as text
(2.39 MB with `__cache`, 1.61 MB without, in one view). Compressed, in the Parquet as fetched, it
is far less: that view's tile files were 1.16 MB with the cache (alpha.23) and 1.09 MB without
(alpha.24, from a build with slightly more data), so at most about 7%. The repeated titles
compress well; the cost is mostly in memory and parsing once a tile is read, not in download.

## 6. Scaling: reading only what a page needs

The rule: **nothing a page reads may grow with the number of resources (N).** Reading one
resource in full is fine (its cost is its own size); a table of every resource, a file scanned to
find one row, or a list of every id is not. `test/scale/` measures it: synthetic worlds of N
resources, the real explorer over the same pages in each, every byte its query engine reads
counted, and each page's growth exponent (bytes ~ N^k) reported. It fails above k = 0.2.

### Two layers, both needed

1. **The locator (the substrate).** Tile files are sorted by `(cluster_key, resource_id)`. A read
   `WHERE cluster_key = ?` prunes to its row group; a read `WHERE resource_id = ?` cannot, since
   resources are contiguous but in no id order, so every row group's `resource_id` min/max spans the
   whole range. The entry table carries no `cluster_key`, so there is no cheap way from a resource
   to its tiles. **Fix:** put `cluster_key` (computed at emit, and currently dropped) in the entry
   table (§1), and hydrate in two pruned reads: the entry table by `resource_id` (sorted by id), then
   the tiles `WHERE cluster_key = ? AND resource_id = ?`. This affects every reader, native included.
2. **The transport (the browser).** How DuckDB in the browser gets bytes: a file registered by URL
   and read with a broad scan can come down whole, where HTTP range reads of direct URLs fetch only
   the row groups and column chunks a query touches. (This site fetches files of 512 KB or less
   whole on purpose, within an 8 MB budget: bounded, so fine at any N; anything larger must be
   range-read.)

Each needs the other. With range reads but no locator, a page range-reads every row group of
several tile files: still O(N), just in smaller pieces. With the locator but whole-file transfer,
the plan prunes but the wire carries the whole file. Fixed together, a page costs a bounded number
of row groups.

### The evidence (this site, before any fix)

Distinct bytes read by DuckDB per page, worlds of 1,000, 4,000 and 16,000 resources (a quarter
places, a tenth groups, two fifths people, a quarter events; one hub mentioned by a tenth of
everything):

| Page | N=1,000 | N=4,000 | N=16,000 | k |
|---|---|---|---|---|
| View opening | 81K | 176K | 509K | 0.66 |
| Places lens | 157K | 499K | 1,852K | 0.89 |
| Events & Times lens | 235K | 822K | 3,127K | 0.93 |
| People lens | 261K | 951K | 1,121K | 0.53 |
| A person | 204K | 2,246K | 7,358K | 1.29 |
| An event | 190K | 2,231K | 8,247K | 1.36 |
| A place | 220K | 2,299K | 6,042K | 1.20 |
| The hub | 187K | 2,170K | 9,112K | 1.40 |
| Cold start onto a person | 642K | 2,416K | 8,002K | 0.91 |
| Name search (Pagefind; browser bytes) | 250K | 263K | 320K | 0.09 |

Requests grow too, more slowly (a person's page from 15 to 26). The browser's own fetches (JSON,
the explorer) are flat.

**The locator, in file sizes (N=16,000):** one person's page reads 2.49 MB of the 2.58 MB NPC tile
file, 1.64 MB of the 2.63 MB Event tile file and 1.31 MB of the 1.43 MB Place tile file, about 95%
of each, to hydrate a few dozen resources. That is the N^1.2-1.4 on entry pages: whole tile files,
and more of them as the neighbourhood grows. The rest is this site's own tables: the view opening
and every list read all of `resources.parquet` (0.49 MB; counts and lists scan it, and it is sorted
by model and name), and the hub most of `mentions.parquet` (0.62 MB; its backlinks are unpaged).
Those are fixed by §1 (sorted by id, in bounded files), per-model counts in the manifest, and paged
backlinks with a per-target count.

### The method, for a standing gate

- **Corpora** at sizes a factor of 4 or more apart, in a fixed shape, so only size varies. Include
  a hub whose backlinks grow with N: busy resources are where O(N) hides.
- **Trace the reads.** Here: the query engine in a process of its own under
  `strace -e trace=openat,pread64,close`, its reads attributed to files by descriptor and cut per
  page by marker files (opening `<marks>/<page>` between pages). Per page: distinct bytes (each
  byte once), every read (re-reads included), files opened, and requests (reads within 16 KB of
  each other merged, roughly what a range reader asks for).
- **Fail on growth, not on size:** the exponent between the smallest and largest corpus, k > 0.2,
  per measure per pattern. A fixed budget passes a whole-graph read at a small N; an exponent
  doesn't.
- **What gates which layer:** traced native reads gate the locator (layer 1): which row groups a
  plan touches is the same for any reader. They do not see the wire (layer 2). That needs the
  browser's own engine against an HTTP server that honours `Range` and logs each request, which
  `test/scale/measure.mjs`'s static server is close to (it counts requests and bytes per page). A
  mode without the engine stand-in, run where DuckDB in the browser can load its Parquet extension
  (CI), would gate layer 2 the same way. Not done yet.
- **Footers and manifests** grow with N too (a footer lists every row group; the manifest every
  file), but stay invisible while each file is a single row group (below about 100,000 rows at
  DuckDB's default). A gate should use corpora past that, or emit test corpora with small row
  groups, so the growth shows.

Run against the native reader, for each lookup pattern (a resource by id, by slug, its backlinks,
a model listed by name, a count), this is the gate Rós Madair could keep: every pattern flat as N
grows.
