# OKF and links between documents — the plan

**Status:** proposed, nothing built. Written 2026-09-11 after Cole asked for it
before the chat slice: "we would have a sort of standard we support … maybe we
can show a graph of the documents, we could render different things that are in
that markdown as different statuses in the UI … and if you bring in a document
that doesn't have it, there should probably be some sort of option to maybe
automatically add it or help you add it."

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

`operator-mono` is a different picture — partial adoption, and its own
extensions (`hivemind_source_id`, `last_verified`, `applied_to`, `stack`). Two
projects, two vocabularies, both legal.

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

## 5 · The calls — one ruled, three open

**RULED: where the map lives** — an overlay from a set's menu (§3, slice 3).

The three still open, each sharpened by a second pass through the spec:

1. **Link resolution scope.** The spec's bundle-relative form (`/concepts/x.md`)
   means the BUNDLE root, not the filesystem root — so a resolver cannot work
   until it decides what the bundle is. **A set's entry root is the bundle**:
   `./x.md` resolves against the document, `/x.md` against the entry root. That
   makes the open question narrower than it looked: what happens to a link that
   ESCAPES the bundle, which is common in Cole's wiki (`decisions/x.md` →
   `../concepts/exit-codes.md`). Context-only reads as broken; silently reaching
   into the workspace grows the context behind the human's back and punches
   through the admission rule that keeps a page from getting an arbitrary file
   opened. **Proposed: in-bundle resolves silently; an out-of-bundle target that
   exists on disk renders live and offers "Add and open" on click** — one click,
   nothing silent, admission intact.
2. **`related: [type/slug]` — no commitment needed after all.** Support the
   SHAPE rather than the name: any frontmatter value that resolves to a document
   in the bundle becomes an edge, LABELLED with the key it came from. `related`,
   `supersedes`, `sources[].resource` and operator-mono's `applied_to` all work
   without being named in the code, and a changed convention loses edges rather
   than inventing wrong ones. The trap is false edges — `tags: [exit-codes]`
   would match `exit-codes.md` — so a value counts as a reference only if it
   CONTAINS A SLASH or ENDS IN `.md`. Cole's tags are bare words, excluded by
   shape rather than by a blocklist.
3. **A frontmatter write verb for the agent.** Three things argue for one: the
   ANNOUNCEMENT (E24's `mv`-versus-`move` argument — a hand-edited frontmatter
   changes the file with no line in the conversation), ROUND-TRIP SAFETY (the
   right implementation is a targeted text edit to one key; an agent rewriting
   the block tends to reserialise the YAML, reordering keys and losing comments,
   which is what the spec's "preserve unknown keys" forbids), and SCOPE
   (stamping `status: stable` is a verb's job; editing a nested `sources` list
   is text work and stays text work). **Proposed:** `meta-set <path> key=value`
   and `meta-init`, both announced.

   **The case that needs a ruling:** the agent stamps frontmatter on a document
   the human has open with unsaved edits. The verb writes the ORIGINAL (never
   the active version — E2), so the conflict bar appears and the human chooses;
   keeping theirs discards the stamp. The alternative is for the verb to refuse
   while the document is dirty. **Proposed: let the conflict bar handle it** —
   that machinery exists for exactly this, and refusing lets an open buffer
   block the agent indefinitely.

## 6 · Sequencing

Slice 1 is worth building on its own — it is the parse, the wire, the header and
the agent's `meta`, and every later piece needs it. Slices 2 and 3 are one build
in practice (the resolver IS the graph). Slice 4 is small once 1 exists. None of
it blocks the chat slice; all of it makes chat more useful, because the agent
can then be asked about a corpus rather than a file.
