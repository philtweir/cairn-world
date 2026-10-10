# cairn-world

A Cairn campaign world kept as plain CSV and published as a standalone static site. The site
loads the data with [Alizarin](https://github.com/flaxandteal/alizarin) (Arches resource models,
CIDOC-CRM ontology) in the browser and uses it to show entries and the relationships between them.
No server, and no connection to the Cairn rules site.

```sh
npm install
npm run check          # validate everything, write nothing
npm run build          # write dist/: explorer, plain pages, tile store (published views only)
npm run build -- --all # also include unpublished universes/campaigns, for local preview
npm run serve          # http://localhost:8000
npm run import-rules -- --rules ../cairn   # regenerate rules/ from a checkout of yochaigal/cairn
```

Needs Node 22+. Alizarin comes from npm, pinned to `2.0.0-alpha.139`; npm's `latest` tag is still
an old 1.0.0, so upgrade by exact version (`npm install --save-exact alizarin@<version>`). Alizarin is AGPL-3.0, which applies to
anything that ships it, including this site.

## Layout

| Path | What |
|---|---|
| `model/models.csv` | One row per model: `alias,name,ontology_class` |
| `model/<alias>.csv` | That model's fields (see below) |
| `model/vocab.csv` | Controlled vocabularies: `collection_name,concept_label` |
| `layers/<key>/data/<alias>.csv` | One universe or campaign: its entries, overrides and additions (see Layers) |
| `layers/<key>/model/` | Optional: models only that layer and its descendants use |
| `rules/<alias>.csv` | Generated reference data from the Cairn rules (see below); never edit |
| `explorer/` | Browser explorer source (HTML, CSS, JS); bundled with Alizarin into the site root |
| `src/` | Build script, rules importer, CSV helpers, HTML renderer, shared ORM reader |

## Ontology

A deliberately small CIDOC-CRM subset. Models come in two kinds: *instances* (your campaign) and
*types* (the rules), and instances point at their type with `P2 has type`.

| Instances | CRM class | Types | CRM class |
|---|---|---|---|
| Place | E53 Place | Background | E55 Type |
| Faction | E74 Group | Monster Type | E55 Type |
| NPC | E21 Person | Item Type | E55 Type |
| Creature | E20 Biological Object | Vocabularies (SKOS) | E55 Type |
| Relic | E22 Human-Made Object | Universe | E89 Propositional Object |
| Event | E5 Event | Campaign | E7 Activity |

Links: NPC -> Background and Stat block (Monster Type); Creature -> Monster Type; Relic -> Item
Type. Every type page lists the campaign entries that use it ("Linked from"). Other CRM properties
used: P89 falls within, P7 took place at, P11 had participant, P55 has current location, P52 has
current owner, P107i member of, P74 residence. Faction alliances and enmities have no CRM
equivalent, so they use `cairn:allied_with` / `cairn:hostile_to`. Cairn stats are plain number
fields; no ontology covers game mechanics.

## Layers

The world is a stack of layers. Each layer holds models and entries; an upper layer can add entries,
override parts of lower ones, and add to their lists, without copying them.

| Layer | Where | Sits on |
|---|---|---|
| **General** | `model/`, `rules/`, optional `layers/general/` | nothing: the base of every stack |
| **Universe** | `layers/<key>/`, holding one Universe row with ResourceID `<key>` | General |
| **Campaign** | `layers/<key>/`, holding one Campaign row with ResourceID `<key>` | General plus the universes in its `universes` field |

Nothing is tagged with a campaign. Which layer an entry belongs to is where its row lives, and how
layers stack is read from the root entities themselves (a Campaign's `universes` links).

**Links point down.** A row may only link to entries visible in its own layer's stack: General
cannot point into a universe, a universe cannot point into a campaign, and two campaigns cannot see
each other. The build reports a link that breaks this, naming the layer that holds the target.

**Same key, same entity.** Alizarin derives a resource id from model + ResourceID only, so a row in
a campaign with the key of a universe entry *is* that entry. Each Universe and Campaign is a
**view**: its stack composed by Alizarin's `composeResourceLayers`, topmost layer first:

| Field kind | What an upper layer does | Example (`ashes-of-hollowmere`) |
|---|---|---|
| Single-valued | Replaces it; fields it leaves blank are inherited | `place.csv`: `hollowmere,Burned,...` keeps Hollowmere's name, kind and hex |
| Single-valued link | Replaces the link | `npc.csv`: Old Marta's `home` becomes the Sunken Chapel |
| Multi-valued | Adds to it; can never remove an entry | `faction.csv`: the Ferrymen gain an enemy |

To end something (an alliance, a life), use a single-valued status or an Event, not deletion. The
build prints every composed entry and what each upper layer does to it ("overrides status,
description", "adds to enemies"), as an audit of what each campaign changes. Each layer is built with its own tile namespace; without that, the same field
in two layers shares a tile id and composition silently keeps only the topmost list.

**Publishing.** Universe and Campaign rows have `published`. `npm run build` writes only published
views, and only the layers they stand on, so unpublished data never reaches `dist/`.
`npm run build -- --all` includes everything for a local GM preview: never deploy that output.

Not done yet: model overlays (a campaign adding *fields* to a General model). A layer can define new
models in `layers/<key>/model/`, and Alizarin's `LayeredGraph` supports overlays, but the build does
not create overlay graphs yet.

## Rules data (`rules/`)

`npm run import-rules -- --rules <path>` reads a checkout of the Cairn rules repo and writes:

| File | Source | Rows |
|---|---|---|
| `monstertype.csv` | `resources/monsters/*.md` (1st-edition stat lines) | 145 |
| `background.csv` | `second-edition/backgrounds/*.md` (names, starting gear) | 20 |
| `itemtype.csv` | `second-edition/players-guide/marketplace.md` (armor, weapons, transport) | 27 |

Not imported: the d6 origin tables, 2e bestiary prose, spells, services and hirelings. Gear is kept
as text on Background, not linked to Item Types. The source text is CC-BY-SA 4.0; each row has a
`source` field, and anything you publish built from it must credit and share alike.

Setting- or campaign-specific types (a "Bell" item) go in that layer's `data/itemtype.csv`.

## Authoring

**Add an entry:** append a row to `layers/<key>/data/<alias>.csv`. `ResourceID` is your own stable slug
(`old-marta`); it also becomes the page filename.

**Link entries:** put the target's `ResourceID` in the link cell. Several links go in one quoted
cell, comma-separated: `"old-marta,ferrymen"`. The build swaps these for Alizarin's UUIDs and
errors on unknown or ambiguous keys.

**Add a field:** add a row to `model/<alias>.csv`, then a column of the same alias in the data.

| Column | Meaning |
|---|---|
| `alias` | Field key; also the data CSV column name |
| `datatype` | `string`, `number`, `concept`, `concept-list`, `resource-instance-list` |
| `cardinality` | `1` or `n` |
| `ontology_class`, `parent_property` | CRM names (`E41_Appellation`), full URIs, or `cairn:` terms |
| `collection_name` | For concept fields: which vocabulary in `vocab.csv` |
| `target_model` | For links: model alias, or `npc\|faction` for several |

The build passes `target_model` to Alizarin as model names in its `graphs` column, and checks that
the graph ids Alizarin derives from those names match the models it built. Link cells are resolved
by the build itself, because a link may only reach entries visible from its layer.

**Add a vocabulary term:** add a row to `model/vocab.csv`. Concept cells in the data must match a
label exactly.

## The site (`dist/`)

| Path | What |
|---|---|
| `index.html`, `app.js`, `alizarin_bg.wasm` | The explorer: loads one view's tile store with Alizarin's WASM ORM and uses it for everything it shows |
| `pages/` | Every view as plain HTML, readable without JavaScript |
| `data/` | The tile store |

The explorer has a universe/campaign picker, a searchable list with model filters, a detail page
per entry saying which layers it comes from ("Defined in The Weeping Wood · changed in Ashes of
Hollowmere"), "Linked from" backlinks, and a 1-hop relationship graph. URLs look like
`/#/<view>/<model>/<key>`. Switching view reloads the page, so each view starts with a clean ORM:
the same entity differs between views. General-only entries (the 192 rules) are hidden until asked for.

The build reads each view back through the ORM with its own `GraphManager` and `StaticStore`, and
renders the plain pages from that; the explorer reads the same way, through `src/world-read.mjs`.

### Tile store (`dist/data/`)

| Path | Contents |
|---|---|
| `views.json` | Published views, their stacks, and layer names |
| `views/<view>/manifest.json` | That view's models, fields, and every entry's id, key and contributing layers |
| `views/<view>/bundles/<graphid>.json`, `resources/<id>.json` | Composed resources, per model and one by one |
| `layers/<layer>/<graphid>.json` | Each layer's own, uncomposed resources, for hosts that compose themselves |
| `graphs.json`, `graphs/<id>.json`, `collections/<id>.json` | Shared models and vocabularies |

A resource is `{ resourceinstance, tiles: [{ nodegroup_id, data: { <node id>: value } }] }`. Output is
deterministic: the same CSVs give the same bytes. About 13 MB with three views, mostly the WASM and
each view's copy of the rules.

## Deploying

`.github/workflows/pages.yml` checks, builds and deploys `dist/` to GitHub Pages on every push to
`main`. Nothing generated is committed. One-time setup: repository **Settings -> Pages -> Source:
GitHub Actions**. The site is then at `https://<user>.github.io/<repo>/`. Any static host works
too: build and upload `dist/`.

- **Pages sites are public.** Everything in `data/` is readable on the site, JSON included. Do not
  put GM-only secrets in a world you publish.
- **Size.** About 7 MB, most of it Alizarin's 4.4 MB WASM, fetched once per visitor.
- **Licences.** Rules text in `rules/` is adapted from Cairn (CC BY-SA 4.0), so the site credits it
  and the adapted data is share-alike. Alizarin is AGPL-3.0. Add your own licence for `layers/`.
- **Tested** over plain HTTP in Chromium at desktop and phone widths. The deploy workflow itself has
  not been run.

## Alizarin notes

- Every layer needs its own tile `uuidNamespace` for multi-valued fields to accumulate; Alizarin
  warns if it sees the same tile id with different data in two layers.
- Warnings about non-CRM properties are suppressed for the `cairn:` namespace only.
- Earlier workarounds (concept-id translation, patching link targets, pinning publication ids,
  flattening nested lists by hand, one process per view, exact-name model lookups) were removed as
  alpha.137 and alpha.139 fixed them.

## Using the data elsewhere

The tile store is readable by Alizarin's `ArchesClientLocal` (Node) and `ArchesClientRemoteStatic`
(browser); `src/build.mjs` and `explorer/app.js` show the wiring for each.
