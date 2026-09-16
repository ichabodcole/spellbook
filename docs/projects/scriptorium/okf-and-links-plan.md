---
type: artifact
title: "OKF and links between documents — the plan"
status: stable
generated: { by: unknown, at: 2026-09-11 }
---

# OKF and links between documents — the plan

Sources read: the spec
([OKF 0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)),
`~/Projects/agent-cli-conformance` (mature adoption, 120 documents),
`~/Projects/Barkdown-editor/operator-mono` (partial, different extensions), and
`ichabodcole/project-docs-scaffold-template` (structure, no frontmatter schema).

## 1 · What the standard actually says

YAML frontmatter on every markdown file, one concept per file. **`type` is the
only REQUIRED field** — a free string, not a registry. Recommended: `title`,
`description`, `resource`, `tags`. Then families: provenance (`sources`,
`usage_window`), trust (`generated {by, at}`, `verified`), lifecycle (`status`:
`draft | stable | deprecated`, default `stable`; `stale_after`), and computation
fields that do not concern a document editor.

Three rules shape everything below:

1. **Trust tiers are DERIVED, never stored.** No `verified` → unverified;
   `verified` by non-human actors → machine-confirmed; `verified` by
   `human:<id>` → human-reviewed.
2. **Staleness is an instant, not a TTL:** stale when `now >= stale_after`.
3. **Consumers MUST NOT reject** a document for unknown types, unknown keys,
   missing optional fields, or broken links, and **SHOULD preserve unknown keys
   when round-tripping**. A reader is required to be generous.

Links are ordinary markdown links — bundle-relative (`/path/concept.md`) or
relative (`./other.md`). The spec says the relationship KIND lives in the prose,
and that a graph treats every link as an undirected edge.

## 2 · What Cole's projects actually do, which is more than the spec

Measured in `agent-cli-conformance`, 120 documents carrying frontmatter:

| key                                                              | count | where it comes from |
| ---------------------------------------------------------------- | ----- | ------------------- |
| `type` `tags` `status` `generated` `description`                 | 120   | OKF core            |
| `title`                                                          | 44    | OKF recommended     |
| `lifecycle` (`live` 41 · `discharged` 18)                        | 61    | **house extension** |
| `subject`, `examined`                                            | 45    | **house extension** |
| `related`                                                        | 43    | **house extension** |
| `rule_id` `tier` `probe_level` `deviation` `checker` `coverage…` | 23    | **house extension** |
| `supersedes`                                                     | 1     | OKF-adjacent        |

Types in use: `report` (45), `rule` (23), `plan` (16), `research` (15), `guide`,
`concept`, `decision`, `tutorial`, `index`, `archetype`. So **the type
vocabulary is per-project and open**, exactly as the spec intends.

`operator-mono`'s repo docs are a different picture — partial adoption with its
own extensions (`hivemind_source_id`, `last_verified`, `applied_to`, `stack`).
Two projects, two vocabularies, both legal.

⚠ **CORRECTION (Cole, 2026-09-11):** the operator-mono reference was to the
frontmatter **the app itself uses** — operations, pipelines and triggers — not
the repo's docs, which is what this seat sampled first. Read properly, the app
is the most useful prior art in the whole survey, because it has already solved
two of the four slices below:

- `useMetadataEditor.ts` edits frontmatter fields from a panel and carries
  **`preservedFields` — "unknown fields from frontmatter (preserved during
  edits)"**. That is the spec's round-trip rule, implemented, and it shows a
  structured editor IS viable if preservation is explicit rather than hoped for.
- `useLinkNavigation.ts` resolves an `op:doc/<id>` link, switches project when
  the target lives elsewhere, and surfaces a **graceful not-found** instead of a
  silent no-op — shared deliberately between the metadata panel's "Linked
  Resources / Backlinks" and in-content link clicks, "so behaviour is identical
  wherever a link is clicked". Scriptorium's links are paths rather than ids,
  but the UX rules transfer whole: one resolver behind every click, and a
  missing target SAYS so.

**Three conventions from that project's `docs/wiki/SCHEMA.md` are the ones
scriptorium must respect**, because they are where Cole's practice is sharper
than the spec:

- **`related: [type/slug]` is a TYPE-AND-BASENAME key, not a path** — "so a page
  can move between folders without rewriting every `related:` that points at
  it". A resolver that only understands paths would see none of this graph.
- **"Backlinks are computed, never authored."** The inbound half of every edge
  is derived; nothing writes it into a file.
- **Take the spec's vocabularies rather than inventing parallel ones** — the
  reason `status` is never `superseded`, and why a new distinction gets a NEW
  field instead of a widened one.

## 2b · The tooling that already exists: `pdocs`

Cole: "I plan to use the project docs frontmatter format in a lot of my
projects." That format ships with a CLI (`scripts/pdocs/cli.ts`, from the
project-docs plugin), and it already implements most of what §3 was about to
propose:

| verb        | what it gives                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------- |
| `graph`     | `nodes[] {path, tier, type, title, tags[], related[], linksOut[], linksIn[]}`, `hubs`, `tags` |
| `find`      | `--type --lifecycle --status --tag --since`, ANDed; an empty result exits 0                   |
| `backlinks` | `related[]` and `links[]` **kept apart** — frontmatter edges vs body-link edges               |
| `orphans`   | library pages the catalog cannot reach                                                        |
| `check`     | the gate; `report` names what is missing, by field                                            |
| `new`       | templates, filename grammar, `--from` wiring a link into the source document                  |

**Two consequences, and the second corrects this plan's own earlier proposal.**

1. **Scriptorium matches this vocabulary rather than inventing one.** Same
   filter names, same `type/slug` keys, same JSON shapes where they fit. Not by
   shelling out to another project's script — a spell that executes a file it
   found in a repo is a different security story — but by speaking the same
   words, so what Cole learns in one holds in the other. Where a corpus has no
   pdocs (a folder of notes, the Hollowbrook documents), scriptorium's own
   reader is the fallback that gives the same answers.
2. **`related` and body links stay APART.** §5's "support the shape" idea
   collapsed every resolving frontmatter value into one edge kind; pdocs keeps
   the frontmatter edge and the body-link edge separate on purpose, and the
   distinction is real — `related` is authored intent, a body link is a citation
   in context. The shape rule still decides WHICH values resolve; it no longer
   decides how they are displayed.

## 3 · What scriptorium should do with it

### Slice 1 · Read it, show it (the foundation the rest needs)

**The daemon parses; the surface renders.** `Bun.YAML.parse` exists (measured),
so no dependency and no YAML parser in the browser. The daemon reads the
frontmatter block of every document in the context — head of file only, cached
by path and mtime — and puts it on the wire as parsed data plus the raw block,
because a writer must be able to round-trip what it did not understand.

In the surface:

- **Rendered mode shows a metadata header, not a YAML dump**: the title, type,
  status, tags, the derived trust tier, and a stale badge when `stale_after` has
  passed. The frontmatter is metadata, so it leaves the rendered body.
- **Custom fields appear as themselves.** `lifecycle: discharged` and
  `hivemind_source_id` both render as a labelled value; nothing is dropped
  because scriptorium has not heard of it. That is the spec's "preserve unknown
  keys" as a UI rule.
- **Raw mode is untouched** — the frontmatter IS the file there.
- **The sidebar can carry type and status** once the data exists (a dot for
  `draft`, a mark for stale), which is Cole's "render different things as
  different statuses in the UI".
- **The agent gets the same parse**: a `meta` verb printing the context's
  documents with their frontmatter as JSON, so it never re-parses by hand.

**Known fields get explicit support; unknown fields still get shown and kept**
(Cole, 2026-09-11: "it's ok if we provide more explicit support for some front
matter properties … while never discarding unknown fields"). The four worth
knowing by name, because they are the ones the corpora actually carry:

| field       | explicit support                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tags`      | `find --tag`, and tags shown as chips that filter the sidebar                                                                                 |
| `status`    | OKF's three values as a badge; `find --status`                                                                                                |
| `type`      | grouping and an icon in the sidebar; `find --type`                                                                                            |
| `lifecycle` | shown and filterable (`find --lifecycle`), NEVER validated — pdocs checks it against the type's own vocabulary, which only that project knows |

Everything else renders as a labelled value and round-trips untouched.

### Slice 2 · Links, resolved

Edges come from four places, and only the first is in the spec:

1. **Markdown links** to `.md` targets, relative or bundle-relative.
2. **`related: [type/slug]`** — resolved by type and basename (§2).
3. **`sources[].resource`** when it points at a document in the context.
4. **`supersedes`**, which is directional and worth showing as such.

Resolution runs **inside the session's context first** (the context IS the
bundle), then the workspace. Anything unresolved is a **dangling link, shown as
such and never an error** — the spec requires tolerance, and a dangling link is
useful information for a writer.

The visible payoff: **a link to another context document becomes clickable and
opens that document.** Today the rendered view deliberately makes every internal
link inert (E29), because nothing could resolve it yet. This is what makes the
rendered view a way to move through a corpus rather than a preview.

#### Typed links, and wiki links — Cole, 2026-09-11

"Operator supports the ability to add a relationship to links … it would be nice
to support both standard wiki links and the additional relational property style
from Operator. This is mostly useful in understanding how different files relate
to each other for an agent and for a human looking at a graph."

Operator's shape, read from `packages/shared/src/links/`: a relation rides the
link as a QUERY — `op:doc/<id>?rel=extends,governs` — one occurrence carries all
of a link's rels, and the vocabulary
(`references extends grounded-in sourced-from governs summarizes applies see-also supersedes sister-of contrasts-with`)
is "a CONTROLLED FOLKSONOMY, not a constraint": a non-canonical rel yields a
HINT, never a block. Two details worth copying exactly:

- **A bare link is `[]` — the ABSENCE of an assertion, not a neutral
  `references`.** Operator says so in the type's own comment, and it matters for
  a graph: an unlabelled edge must not be drawn as a claim nobody made.
- **Rels are normalised (lowercased, trimmed, deduped, order kept) but their
  SPELLING is not canonicalised** — closing `see-also` onto `see_also` is the
  suggester's job at write time, not the parser's.

Scriptorium's links are paths rather than ids, so the same query rides a path:
`[label](./other.md?rel=extends)` — strip the query to resolve the file, keep it
as the edge's label. **Wiki links** (`[[other-doc]]`, `[[other-doc|label]]`)
resolve by basename within the bundle, and carry a rel the same way
(`[[other-doc?rel=supersedes|label]]`). Both are slice 2, and neither changes
slice 1.

### Slice 3 · The map

A graph over the context: nodes are documents, edges are §2's four kinds,
undirected except `supersedes`. Node colour by `type`, outline by `status`,
dimmed when stale. Clicking opens the document. Orphans and hubs fall out of the
same derivation — `agent-cli-conformance` already computes exactly this with
`lint.ts --json`, so scriptorium is catching up to a thing Cole already trusts,
not inventing it.

**RULED (Cole, 2026-09-11): an OVERLAY from a set's menu** — "Show the map of
this set". A map is a thing you consult, not a thing you sit in, and it keeps
the document pane's mode strip from growing a fourth entry. **Not taken:** a
full-pane mode beside raw/rendered/split, and a sidebar tab, which is too small
for a graph.

### Slice 4 · Adding frontmatter to a document that has none

**Offered, never automatic.** A document dropped in from elsewhere is somebody
else's file; writing into it unasked is the kind of move E24 spent its whole
design avoiding. The offer appears as a line in the document header — "No
frontmatter. Add it?" — and the agent gets a verb for the same act.

What it writes: `type` (guessed, see below), `title` from the H1, `description`
blank for the human or the agent to fill, `status: draft`, and
`generated: { by: <actor>, at: <now> }` — with the actor honestly recorded, per
SCHEMA.md's rule that "a plausible guess is worse than an admitted gap".

**The type is guessed from the neighbours, not from a fixed list.** The
vocabulary is per-project (§2): scriptorium reads the `type` values of the other
documents in the same folder and offers those first, falling back to the folder
name. A document landing in `docs/research/` among fifteen `type: research`
files gets `research` proposed — which is inference the human confirms, not a
value written behind their back.

## 4 · What I would NOT do, and why

- **No schema validation, no conformance score.** The spec forbids rejecting
  documents, and a scoring UI would turn a generous format into a nag.
- **No rewriting of frontmatter we did not author.** Save writes the buffer the
  human edited; frontmatter edits are text edits like any other. A structured
  editor that reserialises YAML would reorder keys, drop comments and reflow
  values — the round-trip the spec explicitly asks us to preserve.
- **No second vocabulary.** Where scriptorium needs a distinction OKF lacks, it
  adds a field rather than widening `status`, per SCHEMA.md.
- **Not Spellbook's own docs, yet.** This repo uses no frontmatter; adopting OKF
  here is a separate decision, worth taking only after the reader exists.

## 5 · The calls — all four ruled

1. **Link resolution scope.** The spec's bundle-relative form (`/concepts/x.md`)
   means the BUNDLE root, so the resolver needs a bundle first: **a set's entry
   root is the bundle** — `./x.md` against the document, `/x.md` against the
   entry root. **In-bundle resolves silently; an out-of-bundle target that
   exists on disk renders live and offers "Add and open" on click.** Nothing is
   pulled in behind the human's back, and the admission rule (a document must be
   in the context before it can be opened) stays intact.
2. **Where the map lives — RULED (Cole):** an overlay from a set's menu.
3. **`related`** needs no commitment: the SHAPE decides which values resolve (a
   reference contains a slash or ends in `.md`, which excludes bare `tags`), and
   §2b decides how they are shown — frontmatter edges and body links kept apart,
   as pdocs keeps them.
4. **A frontmatter write verb** — `meta-set <path> key=value` and `meta-init`,
   both announced, both a targeted text edit to one key rather than a
   reserialisation. **RULED (Cole): when the agent stamps frontmatter on a
   document the human has open and dirty, the CONFLICT BAR handles it** — "we
   can adjust if needed after getting actual usage behind us". So the verb
   writes the original, the bar appears, and the human chooses; it does not
   refuse, because an open buffer would then block the agent indefinitely.

## 6 · Sequencing

Slice 1 is worth building on its own — the parse, the wire, the rendered header,
the sidebar's status marks and the agent's `meta` and `find`; every later piece
needs it. Slices 2 and 3 are one build in practice, because the resolver IS the
graph. Slice 4 is small once 1 exists. None of it blocks the chat slice, and all
of it makes chat more useful: the agent can then be asked about a CORPUS rather
than a file.

**All four questions are ruled, so this is buildable as it stands.** The
sequence, when Cole wants it: slice 1 · slices 2+3 · slice 4.
