# cairn-world

A Cairn campaign world kept as plain CSV and published as a standalone static site. The site
loads the data with [Alizarin](https://github.com/flaxandteal/alizarin) (Arches resource models,
CIDOC-CRM ontology) in the browser and uses it to show entries and the relationships between them.
No server, and no connection to the Cairn rules site.

```sh
npm install
npm run check          # validate everything, write nothing
npm run build          # write dist/: explorer and tile store (published views only)
npm run build -- --all # also include unpublished universes/campaigns, for local preview
npm run serve          # http://localhost:8000
npm run import-rules -- --rules ../cairn   # regenerate rules/ from a checkout of yochaigal/cairn
npm run set-password -- <layer>            # put a password in front of one view (see Layers)
npm run globe -- <layer>                   # place a universe's places on its globe (see Maps)
```

Needs Node 22+. Alizarin comes from npm, pinned to `2.0.0-alpha.139`; npm's `latest` tag is still
an old 1.0.0, so upgrade by exact version (`npm install --save-exact alizarin@<version>`). Alizarin is AGPL-3.0, which applies to
anything that ships it, including this site.

## Layout

| Path | What |
|---|---|
| `model/models.csv` | One row per model: `alias,name,ontology_class` |
| `model/<alias>.csv` | That model's fields (see below) |
| `model/vocab.csv` | Controlled vocabularies: `collection_name,concept_label[,match]` (`rules/vocab.csv` adds the ones generated from the rules' tables) |
| `layers/<key>/data/<alias>.csv` | One universe or campaign: its entries, overrides and additions (see Layers) |
| `layers/<key>/model/` | Optional: models only that layer and its descendants use |
| `layers/<key>/layer.json` | Layer settings: `rights` (required), optional password `gate`, optional `test` note, optional `globe` (see Maps). `layers/general/layer.json` is General's |
| `layers/<key>/globe.csv`, `basemap.json` | Optional: what each place is on Earth or on a regional map, and the globe's land, for `npm run globe` (see Maps) |
| `rules/<alias>.csv` | Generated reference data from the Cairn rules (see below); never edit |
| `ontology/` | CIDOC-CRM 7.1.3 RDFS (FORTH-ICS, CC BY 4.0), `extensions.csv` (terms from outside CRM, each tied to CRM), `prefixes.csv`, `labels.csv` (display labels) |
| `explorer/` | Browser explorer source (HTML, CSS, JS); bundled with Alizarin, d3-force and d3-geo into the site root |
| `src/` | Build script, rules importer, globe script, CSV, markdown and geometry helpers, shared ORM reader |

## Ontology

A deliberately small CIDOC-CRM subset. Models come in three kinds: *instances* (your campaign),
*types* (kinds of thing the rules define), and *propositions* (the rules text itself).

| Instances | CRM class | Types | CRM class | Rules text | CRM class |
|---|---|---|---|---|---|
| Place, Route | E53 Place | Background | E55 Type | Rule | E89 Propositional Object |
| Faction | E74 Group | Monster Type, Monster Group | E55 Type | Roll Table | E89 Propositional Object |
| NPC, PC | E21 Person | Item Type, Spellbook | E55 Type | Universe | E89 Propositional Object |
| Document | E31 Document | | | | |
| Creature | E20 Biological Object | Hireling Role | E55 Type | Campaign | E7 Activity |
| Relic | E22 Human-Made Object | Vocabularies (SKOS) | E55 Type | | |
| Event | E5 Event | | | | |

Typed relationships:

| From | Field | Property | To |
|---|---|---|---|
| Rule, Roll Table | Part of | P148i is component of | Rule (Roll Tables also Background or Campaign) |
| Rule, Roll Table, Item Type, Spellbook, Monster Type, Background | Refers to | P67 refers to | any rules model |
| Item Type, Spellbook, Monster Type/Group, Background, Hireling Role | Listed in | P67i is referred to by | the Rule or Roll Table that lists it |
| Monster Type | Group | P127 has broader term | Monster Group |
| Monster Type | Spells | `cairn:wields` | Spellbook |
| Item Type | Spell | `cairn:holds_spell` | Spellbook |
| Background | Starting gear | `cairn:starts_with` | Item Type, Spellbook |
| Route | Connects | `cairn:connects` | Place (both ends) |
| Route | Hazards | P67 refers to | Creature, Monster Type, Place |
| NPC | Background, Stat block | P2 has type | Background, Monster Type |
| Creature / Relic | Type / Item type | P2 has type | Monster Type / Item Type |
| Faction | Allies, Enemies | `cairn:allied_with`, `cairn:hostile_to` | Faction |
| Campaign | Set in | `cairn:set_in` | Universe |
| NPC, PC | Ties (group) | P140i was attributed by → E13 Attribute Assignment: P141 assigned (NPC, PC), P177 assigned property of type (Tie Kind) | |
| PC | Scars (group) | P44 has condition → E3 Condition State: P2 has type (Scar) | |
| PC | Inventory | `cairn:carries` | Item Type, Spellbook |
| Document | Creation (group) | P94i was created by → E65 Creation: P14 carried out by, P4 has time-span | NPC, PC, Faction |
| Document | Refers to | P67 refers to | most instance and type models |
| Relic | Carries | P128 carries | Document (a physical copy of it) |
| Event | Kind; Involved | P2 has type (Event Kind); P12 occurred in the presence of | Relic, Document, Creature |
| Event | Session, When; After | P4 has time-span; P183i starts after the end of | (E52 Time-Span); Event |
| Background, Monster Type, Item Type, Spellbook | Refers to (group) | P67i is referred to by → E33 Linguistic Object: P67 refers to | any rules model |
| Roll Table | About | P129 is about | Background, Campaign |
| Route | Hazards | P53i is former or current location of | Creature |
| Place | Terrain; Geometry | P2 has type (Terrain Difficulty: Easy, Tough, Perilous); P168 place is defined by (E94 Space Primitive, a GeoJSON FeatureCollection; see Maps) | |
| Faction | Member of | P107i is current or former member of | Faction |
| PC | Faction; Home | P107i is current or former member of; P74 has current or former residence | Faction; Place |

**PC.** Character Creation defines a PC, so General defines the model: background, age, current
and maximum STR/DEX/WIL and HP, Armor, gold, Fatigue, Deprived, the eight traits, bond, omen,
inventory, scars, ties. Traits and scars are concepts from vocabularies the importer builds out of
the rules' own d10 and Scars tables. PCs themselves live in campaign layers.

**Fields cite their rules.** A model CSV may have a `rule` column naming a General Rule
(`hp,...,character-creation-hit-protection`). The build checks it exists, writes it into the
graph as the node's description, and the explorer links that field's label to the
rule. PC, NPC, Monster Type, Item Type, Spellbook, Hireling Role and Background fields cite theirs.

**Typed ties** are E13 Attribute Assignments, CIDOC-CRM's way to say a link has a type. CRM has no
person-to-person relationship property, so each tie is an entry in a repeatable group: who it is
with (P141) and what kind (P177, a Tie Kind concept). The kind reads "the other person is my X":
on Bryn, `marcos,Mentor` says Marcos is her mentor; on Marcos, `bryn,Apprentice` says the reverse.
Tie Kinds match terms in the [RELATIONSHIP vocabulary](http://purl.org/vocab/relationship/)
(`rel:mentorOf` is the property from the other person to this one). Kinds without a term
(Relative) are left unmatched.

**Checked against CRM.** The build loads the CIDOC-CRM 7.1.3 RDFS and checks every model: its
class exists, each field's class and property exist, the property's domain admits the class the
field hangs from, and its range admits the field's class and every model it links to. Anything
outside CRM must be declared in `ontology/extensions.csv`: a property with its domain and range,
a class with its CRM parent. Without a parent the build stops, because nothing could place it.
The check caught real mistakes, now fixed: types "referring to" rules (P67 is only for
propositions; a type's text, an E33 Linguistic Object, now does the referring), tables as
components of backgrounds (now P129 is about), route hazards as references (now P53i is
location of), and the hex field's P87/E44, which CRM 7 removed.

**Other ontologies.** Prefixes in model CSVs expand through `ontology/prefixes.csv`
(`cairn:`, `rel:`, `skos:`; unprefixed names are CRM). A vocabulary row's `match` column maps a
concept to another ontology's term (as skos:exactMatch). Alizarin's collections CSV has no column
for this, so the build keeps the matches and publishes them in each view's manifest; the
explorer links a matched concept to its term.

Also used: P89 falls within, P7 took place at, P11 had participant, P55 has current location, P52
has current owner, P107i member of, P74 residence. Cairn stats are plain number fields; no ontology
covers game mechanics. Every page lists what links to it ("Linked from"), so a Rule shows its
sections and tables, a Monster Group its monsters, a Spellbook the monsters that carry it.

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

**Rights.** Every layer carries its copyright attribution in `layers/<key>/layer.json`, and the
build stops if one is missing:

```json
{ "rights": { "holder": "Yochai Gal", "statement": "Rules data adapted from Cairn (2nd edition) by Yochai Gal.",
              "licence": { "name": "CC BY-SA 4.0", "url": "https://creativecommons.org/licenses/by-sa/4.0/" },
              "source": { "name": "cairnrpg.com", "url": "https://cairnrpg.com" }, "year": "2024" } }
```

`holder` and `statement` are required; `year`, `licence` and `source` are optional, and no
`licence` means all rights reserved. The explorer's footer
credits every layer in that view's stack. A layer can also carry `"test": "..."`, shown on its
views' home pages and footers, for content that should not stay.

**Password gate.** `npm run set-password -- <layer>` writes a random salt and the salted SHA-256
of a password to `layers/<layer>/layer.json`. The explorer then asks for that password before it
loads the view, and remembers it in that browser (`Lock` in the header forgets it). Gated views are
never the default view. This keeps players from wandering into the
Warden's notes; it is not security. The layer's CSVs are in this public repository, and its data
files are on the site like any other view's. `--remove` takes the gate off.

Not done yet: model overlays (a campaign adding *fields* to a General model). A layer can define new
models in `layers/<key>/model/`, and Alizarin's `LayeredGraph` supports overlays, but the build does
not create overlay graphs yet.

## The interface: lenses from the ontology

The explorer divides each view into **lenses**, and takes them from CIDOC-CRM rather than from a
list of models. Each layout it can draw is pinned to the CRM property it is built on
(`src/lenses.mjs`); the lens's class is that property's domain or range in the RDFS. Its name is
the class's display label from `ontology/labels.csv` (term, label, one-line summary; unknown terms
fail the build), or CRM's own label where there is none. The CRM code and label stay on show
beside it:

| Lens | Class (from the RDFS) | Layout | Built on |
|---|---|---|---|
| People & Groups | range: E39 Actor | network of links between actors | P107 has current or former member |
| Places | domain: E53 Place | "within" tree, plus a graph of connections | P89 falls within |
| Events & Times | domain: E2 Temporal Entity | timeline: by session, then by CRM "before" relations (P176, P182, P183) | P4 has time-span |
| Things | domain: E18 Physical Thing | cards grouped by the place or actor each links to | P52 has current owner |
| Texts & Lore | domain: E89 Propositional Object | whole/part tree | P148 has component |
| Kinds | domain: E55 Type | broader/narrower tree, with how much of the view uses each type | P127 has broader term |

A model joins the lens whose class is its nearest ancestor in the CRM class hierarchy, so a
Person is an Actor before a Physical Thing. Nothing maps a model to a lens by hand: a new model in
any layer finds its lens from its class, and a class from another ontology finds it through the
CRM parent it must declare. (Tested: a campaign-only Ship, E22, appears under Things; a foreign
`ex:Familiar` is rejected until declared under E20, then appears there too.) The layouts
work from links, lens membership and those properties alone: an entry that only joins two places
is drawn as the line between them, whatever its model, and places with a geometry (P168) are drawn
on the world's globe (see Maps).

**Entry pages** lead with the description, then facts (stats as chips, a stat and its "Max"
merged as "STR 9/14", short values as tags, longer text as notes), then **Connections**: one chip
per related entry, grouped by the relationship, whether this entry links to it or it links here.
Entries only mentioned in text are collapsed into one line, and the graph sits folded under "Map
of connections". **Author view** (the pencil button, remembered per browser) adds the technical layer:
reference checking, the layers an entry comes from, its CRM class, and the lens classes on the
home page. Lens icons, like lens names, come from `ontology/labels.csv`: the `icon` column names a
[Lucide](https://lucide.dev) icon (ISC licence). The build checks each name against
`lucide-static` and bundles only the icons in use into `dist/icons.svg`, a sprite of monochrome
line icons drawn in the text colour.

The view's own root (the Universe or Campaign) is its home page: a card per lens with how many
entries are this layer's own, inherited, or General, and the layer audit of what this layer
changes. Detail pages are as before, with the lens as a breadcrumb.

## Maps

**Only places have geometry.** That is CIDOC-CRM's own position: a Place is defined by an E94
Space Primitive (P168), and everything else is somewhere by way of a place. An event took place at
one (P7), a thing has a current location (P55), a person or group a residence (P74). So the Place
model has one `geometry` field (Alizarin's `geojson-feature-collection`), and nothing else does.

**An entry's map** sits across the top of its page. The explorer finds it from the ontology, not
from field names: its own geometry if it is a place; else every place it links to by a property
whose other end is an E53 Place (in either direction); and the places of the events it took part
in. A linked place with no geometry is drawn as the nearest place it falls within that has one,
marked as rough ("The Raven of Carrowmore, somewhere in Linos"); one with none at all is named in
the caption as having no location yet. A place's map also shows, dashed, what it lies within and
what lies within it, and a route is drawn as the line between its two places. The Places lens
shows every place with a geometry on one globe. The globe turns by dragging; the buttons zoom.

**Writing geometry.** In a CSV cell, as WKT in longitude and latitude (`POINT (-9.84 27.765)`;
also LINESTRING, POLYGON and their MULTI forms) or as GeoJSON. The build turns it into a GeoJSON
FeatureCollection and checks it with `@alizarin/geo` (Alizarin's geometry extension, which
Alizarin's CSV loader does not call itself): coordinates in range, rings closed, at most 1,500
positions per value. The explorer does not need that extension, so it is not in the site bundle.

**Globes.** A universe whose world is Earth remapped can be placed on its globe. In its
`layer.json`, `globe.remap` gives the remap (the pole that becomes the globe's north pole, the
point on its seam, and the south and east-west squeeze), and `globe.maps` pins regional maps to it.
`globe.csv` says, for each place, what it is on Earth (Natural Earth country names joined by `|`,
or WKT in Earth's longitude and latitude) or where it is on a regional map (`dells POINT (x y)`, in
that map's units, x east and y south). `npm run globe -- <layer>` repeats the remap and writes the
`geometry` column of the layer's `place.csv` (countries dissolved into one outline per realm), and
`basemap.json`, the globe's land: Natural Earth 1:110m for the whole globe and 1:50m around each
regional map, which the explorer draws in place of the coarse coast there. The script needs the
Natural Earth data only as a dev dependency (`world-atlas`); its output is committed, and the build
publishes the basemap with the views that stand on the layer.

**Bith na Bró** uses its world globe's remap (pole 50.27°E 10°S, seam 150°E 50°S, south 0.5,
east-west 0.55). Realms are their countries ("In the projection: Sweden"). The High Marks are read
as Austria, Czechia, Slovakia, Hungary, Slovenia, Croatia, Bosnia and Herzegovina, Serbia,
Montenegro, Kosovo, North Macedonia, Albania, Bulgaria, Romania, Moldova, Ukraine and Belarus: an
assumption, as the notes say only "the remaining countries of Central and Eastern Europe". Miurna
and Leantis ("part of Russia") have no shape until it is settled which part, and Cofrey is drawn as
Mongolia alone. The Dells map is pinned with the Bonefort at remapped Burgas, drawn north-up, at
5 km to a map unit: the scale at which its land and sea best agree with the globe's coast (14 of
its 15 places; the Fist of Glass, rocks off the coast, is too small for the coastline data). That
makes the Dells about 130 by 100 km, and Hearth to the Trading Post about one 30 km watch.

## Rules data (`rules/`)

`npm run import-rules -- --rules <path>` reads a checkout of the Cairn rules repo and regenerates
the General layer's data from it:

| Model | Source | Rows |
|---|---|---|
| Rule | Player's Guide (principles, character creation, core rules, procedures, marketplace) and Warden's Guide: one per page and per heading, nested with `part_of`, in reading order (`section`) | 396 |
| Roll Table | every table in those pages and in the backgrounds (traits, bonds, omens, scars, weather, seeds, naming, NPCs...) | 125 |
| Item Type | the whole Marketplace (armor, weapons, transport, upkeep, gear), the Reliquary (kind Relic, with uses, charges, recharge), and background starting gear not sold in the Marketplace | 166 |
| Spellbook | Warden's Guide spellbooks (effect and quirk), plus spells only found in backgrounds | 100 |
| Monster Type | the 2e Bestiary, then 1st-edition monsters; where both have one, the 1e entry is `<key>-1e` | 229 |
| Monster Group | the Bestiary's Monster Categories | 20 |
| Hireling Role | Marketplace hirelings, with daily wage | 12 |
| Background | `second-edition/backgrounds/`: names, gear as written, gear as links, d20 roll | 20 |

Links come from the text, not from a hand-made list. Markdown links resolve to the page, heading or
background they point at. **Bold** and _italic_ terms resolve through a short glossary in the
importer (_fatigue_, _deprived_, _enhanced_, _blast_, _petty_, _bulky_, STR/DEX/WIL...) to the rule
that defines them, then by name to a spellbook, monster, item, background or heading. So a monster
that carries the _Charm_ spellbook links to it, and a relic that leaves you _deprived_ links to
Deprivation & Fatigue. Starting gear matches Marketplace items by name ("Iron Dagger" is a
Dagger); anything else becomes its own Item Type.

Left out on purpose: Vald (the 2e default setting is world, not rules, so it belongs in a Universe
layer), the bibliography, and the note about the example party. The source text is CC-BY-SA 4.0;
each row has a `source` field, and anything you publish built from it must credit and share alike.

Setting- or campaign-specific types (a "Bell" item, a module's monsters and spells) go in that
layer's `data/`, using the same General models.

## Authoring

**Add an entry:** append a row to `layers/<key>/data/<alias>.csv`. `ResourceID` is your own stable slug
(`old-marta`); it also becomes the page filename.

**Link entries:** put the target's `ResourceID` in the link cell. Several links go in one quoted
cell, comma-separated: `"old-marta,ferrymen"`. The build swaps these for Alizarin's UUIDs and
errors on unknown or ambiguous keys.

**Add a field:** add a row to `model/<alias>.csv`, then a column of the same alias in the data.

**References in text.** Any text field can name another entry: `[[Caryes]]` links by name
(ignoring case, a leading "The" and a trailing parenthetical, so `[[Prince of Miurna]]` finds
"The Prince of Miurna (deceased)"); `[[faction/realm-ievure|the Emirate]]` names the target exactly
and shows other words. Like links, references point down: the build warns when a reference
matches nothing the layer can see, or several things (with the exact form to use instead); either
way the text still reads, unlinked. Each reference also becomes a derived "Mentions" link
(P67 refers to), so the referent lists it under "Linked from" and graphs show it.

In the explorer, a reference is styled by how the entry whose text it is
stands to the referent: **related** (it links to the referent by a real field: a normal link),
**related only the other way** (dashed), or **mentioned, no relationship** (dotted amber). The last
are the ones to check: a passing mention needs no relationship, but "her brother" probably does.
Only direct links count, so membership through a cell or a place reached through an event still
reads as a mention.

**Groups** (ties, scars, a document's creation): a `semantic` row in the model with
`parent_alias` set on its fields. In the data, a resource takes one row per group entry; repeat
the ResourceID and leave its other single-valued fields blank (the build rejects a repeat row
that contradicts the first). Repeat rows need not be adjacent. Groups are repeatable
(cardinality `n`) and accumulate across layers like any other list: a campaign can add a tie to
a universe NPC.

| Column | Meaning |
|---|---|
| `alias` | Field key; also the data CSV column name |
| `datatype` | `string`, `number`, `concept`, `concept-list`, `resource-instance-list` |
| `cardinality` | `1` or `n` |
| `ontology_class`, `parent_property` | CRM names (`E41_Appellation`), full URIs, or prefixed terms (`cairn:`, `rel:`) |
| `parent_alias` | For a field inside a group: the group's alias |
| `collection_name` | For concept fields: which vocabulary in `vocab.csv` |
| `target_model` | For links: model alias, or `npc\|faction` for several |
| `rule` | Optional: the General Rule that defines this field |

The build passes `target_model` to Alizarin as model names in its `graphs` column, and checks that
the graph ids Alizarin derives from those names match the models it built. Link cells are resolved
by the build itself, because a link may only reach entries visible from its layer.

**Add a vocabulary term:** add a row to `model/vocab.csv`. Concept cells in the data must match a
label exactly.

## The site (`dist/`)

| Path | What |
|---|---|
| `index.html`, `app.js`, `style.css`, `icons.svg`, `alizarin_bg.wasm` | The explorer: loads one view's tile store with Alizarin's WASM ORM and uses it for everything it shows |
| `data/` | The tile store |

The explorer has a universe/campaign picker, a searchable list with model filters, a detail page
per entry saying which layers it comes from ("Defined in The Weeping Wood · changed in Ashes of
Hollowmere"), "Linked from" backlinks, and a 1-hop relationship graph. URLs look like
`/#/<view>/<model>/<key>`. Switching view reloads the page, so each view starts with a clean ORM:
the same entity differs between views. General-only entries (about 1,070 rules entries) are hidden
until asked for. Rule text renders its markdown (lists, bold, italics), and Roll Tables render as
tables.

There are no plain HTML pages: the site needs JavaScript, since the world is only read through
Alizarin. As a check, the build reads each view back through the ORM with its own `GraphManager`
and `StaticStore`, the same way the explorer does (`src/world-read.mjs`), and fails if any entry
does not come back.

### Tile store (`dist/data/`)

| Path | Contents |
|---|---|
| `views.json` | Published views, their stacks, and layer names |
| `views/<view>/manifest.json` | That view's models, fields, and every entry's id, key and contributing layers |
| `views/<view>/bundles/<graphid>.json`, `resources/<id>.json` | Composed resources, per model and one by one |
| `layers/<layer>/<graphid>.json` | Each layer's own, uncomposed resources, for hosts that compose themselves |
| `graphs.json`, `graphs/<id>.json`, `collections/<id>.json` | Shared models and vocabularies |
| `layers/<layer>/basemap.json` | A universe's land on its globe, for maps (see Maps) |

`views.json` carries `build`, a hash of the rest of `data/`. The explorer fetches `views.json`
fresh and requests every other file, and the page its script and stylesheet, with `?v=<build>`,
so a browser never combines a cached model from one deploy with data from the next (Pages lets
browsers cache files for 10 minutes; without this, a model change showed as "Tile ... has
nodegroup not on model" until the cache expired).

A resource is `{ resourceinstance, tiles: [{ nodegroup_id, data: { <node id>: value } }] }`. Output is
deterministic: the same CSVs give the same bytes. About 63 MB and 10,000 files with five views,
mostly each view's copy of the rules, one file per resource.

## Deploying

`.github/workflows/pages.yml` checks, builds and deploys `dist/` to GitHub Pages on every push to
`main`. Nothing generated is committed. One-time setup: repository **Settings -> Pages -> Source:
GitHub Actions**. The site is then at `https://<user>.github.io/<repo>/`. Any static host works
too: build and upload `dist/`.

- **Pages sites are public.** Everything in `data/` is readable on the site, JSON included, gated
  views too. Do not put GM-only secrets in a world you publish.
- **Size.** A visitor fetches Alizarin's 4.4 MB WASM once, plus one view's bundles (about 2 MB).
- **Licences.** Rules text in `rules/` is adapted from Cairn (CC BY-SA 4.0), so the site credits it
  and the adapted data is share-alike. Alizarin is AGPL-3.0. The CIDOC-CRM RDFS (published as
  `data/ontology.json`) is CC BY 4.0 and credited in the footer. `@alizarin/geo` is AGPL-3.0, like
  Alizarin. d3-force, d3-geo and the Lucide icons are ISC. Natural Earth data (basemaps and realm
  outlines) is public domain. Add your own licence for `layers/`.
- **Tested** over plain HTTP in Chromium at desktop and phone widths, password gate included.

## Campaigns in this repository

| Layer | Kind | Notes |
|---|---|---|
| `weeping-wood` | Universe | Small test world |
| `the-drowned-bell`, `ashes-of-hollowmere` | Campaign | Two campaigns on the Weeping Wood, showing overrides and additions |
| `bith-na-bro` | Universe | Bith na Bró: the Six Kingdoms and Nine States, the Engineers, the churches, the Order of the White Raven; the Dells and surrounds from the regional map; places on the world globe (see Maps) |
| `ravens-in-the-dells` | Campaign (solo) | Albric's cell of the Order: three PCs with ties, gear and finds; Adventure #1 so far; the Omen and the 30 km watch |
| `the-empire` | Universe, **test** | Player-facing background for Seven Silver Spheres; remove with it |
| `seven-silver-spheres` | Campaign, password gate, **test** | Warden notes for *Seven Silver Spheres* by Martin Orchard ([pointlessmonument.itch.io](https://pointlessmonument.itch.io)): places, routes, monsters, relics, spellbooks, tables, NPCs, events; Marcos's will, letter and map as Documents with each PC's copy; three placeholder PCs tied to Marcos |

*Seven Silver Spheres* and The Empire are test layers, to be removed when done. *Seven Silver
Spheres* is © Martin Orchard and is not openly licensed; both layers' `rights` say so. The layer condenses and
paraphrases it as running notes and credits the author; it is not a substitute for the booklet.
Because this repository is public, those notes are public too, password or not. Make the
repository private, or keep that layer out of it, if that matters.

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
