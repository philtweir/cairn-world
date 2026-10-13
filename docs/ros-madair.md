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

- **Sort:** `graph_id, legacyid`. A slug lookup (`[[model/key]]`) and a per-model scan prune on it;
  name order is a query-time `ORDER BY`.
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
already. `--no-render-cache` is in use (`src/search-index.mjs`), and with it the substrate is the
alpha.22 size plus the `redges_` files.

**On the render cache's cost:** the +49% measured earlier was of the tiles' `data` JSON as text
(2.39 MB with `__cache`, 1.61 MB without, in one view). Compressed, in the Parquet as fetched, it
is far less: that view's tile files were 1.16 MB with the cache (alpha.23) and 1.09 MB without
(alpha.24, from a build with slightly more data), so at most about 7%. The repeated titles
compress well; the cost is mostly in memory and parsing once a tile is read, not in download.
