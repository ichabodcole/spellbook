# scriptorium — how the document editor works

**Created:** 2026-09-12 · **Status:** ⚠ **IN PROGRESS — scriptorium is still
being built.** Current through E41 · **Scope:** the systems, not the screens.

> **⛔ THE SPELL IS NOT FINISHED, AND NEITHER IS THIS.** scriptorium is under
> active construction: chat is unbuilt, undo/redo is decided but unbuilt, and
> slices land most days. Read this as _the shape as it stands today_, not as a
> settled architecture — §2's invariants are the part that has held since the
> foundation and is expected to keep holding; everything else may move. When a
> slice changes one of these systems, the slice changes this document too.

> **How to read this.** §1 is the shape in one page. §2 is the load-bearing
> part: the invariants, each with the test cell that guards it — if you change
> one of those, a named cell goes red and that is the intended alarm. §3–§5 are
> the three systems worth understanding before touching anything: context,
> versions, editing. §6–§8 are reference.
>
> **This document says WHAT IS TRUE, never why.** The why lives in
> [`docs/projects/scriptorium/decision-log.md`](../../projects/scriptorium/decision-log.md),
> entry by entry, and every `(E<n>)` here is a link into it. One fact, one home:
> when they disagree, the code and the cells decide, and both documents are
> wrong until someone fixes them.
>
> **Deliberately incomplete.** It covers what exists and is settled. Chat and
> undo/redo are named in §9 and not described, because they are not built.

## 1 · The shape

scriptorium is a **conjuration**: a standing daemon holding a session, a browser
surface, and a CLI the agent drives. A human reads and edits markdown documents;
an agent can do everything the human can, through different affordances (E24).

Three parties touch the same documents:

| party      | reaches the session through           | may write                                |
| ---------- | ------------------------------------- | ---------------------------------------- |
| **human**  | the surface, over a WebSocket         | the active version (via the daemon)      |
| **agent**  | the CLI, over HTTP to the same daemon | any NON-active version's file, directly  |
| **daemon** | itself                                | every file it is asked to, and only then |

**The document of record is the file on the human's disk, and three things write
it — which is fewer than it sounds, and each is a ruling.** Save is the only
write that carries the human's _editing_ to it (§2, invariant 1). The
frontmatter verbs write it deliberately (E35 — the agent's verb writes the file
and the conflict bar handles a dirty buffer), and the structure ops create, copy
and move real files by their nature (E22/E23). Nothing else reaches it: no edit,
no merge, no version.

**Where the code lives.** Authored source is
`src/scriptorium/{backend,surface}`; the shipped artifact is
`plugins/spellbook/skills/scriptorium/{scripts,dist}`, with `dist/` committed
and required to reproduce (Contract 18). The launchers in `scripts/` are the
contract — drive those, not `dist/*.js` directly. See
[spell-backend-architecture.md](../spell-backend-architecture.md).

## 2 · The invariants

These have not changed since the foundation, and everything else is arranged to
keep them true. Each names the cell that fails if it stops being true.

| #   | Invariant                                                                                                                                                  | Decision          | Guarded by                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The original on disk is written by **Save and nothing else**. Opening copies it to v1; no edit, merge or frontmatter write ever reaches it.                | E7                | `session.test.ts` — _"an edit reaches the active version's file and never the original (E7)"_                                                                                                                                                                                                                           |
| 2   | **Only the active version is editable** by the human.                                                                                                      | E2                | _"only the active version is editable"_                                                                                                                                                                                                                                                                                 |
| 3   | An outside write to the active version is **preserved as a new version**, never clobbered — checked immediately before each write, not on a watcher timer. | E2                | _"CHECK BEFORE WRITE: an outside write the watcher has not seen yet is preserved by the next edit"_                                                                                                                                                                                                                     |
| 4   | A document can only be opened, and an original only saved, if it is **inside a context entry** and is a document-type file.                                | verify-pass 1b/1c | _"a document outside every context entry is refused"_, _"save refuses an original that was not admitted by openPath"_                                                                                                                                                                                                   |
| 5   | **Version numbers are monotonic** and never reused, even across deletion.                                                                                  | E41               | _"a version made BEFORE the counter existed still does not have its number reused"_                                                                                                                                                                                                                                     |
| 6   | The session survives a restart: context, docs, versions, active and chat all come back.                                                                    | E8                | _"context, docs, versions, active and chat come back"_                                                                                                                                                                                                                                                                  |
| 7   | The manifest is written **atomically**, so a crash mid-write cannot leave it half-parsed.                                                                  | E8                | ⚠ **weakly guarded.** The mechanism is real (`writeFileAtomic`, `session.ts`), but the cell named _"the manifest on disk is valid JSON after every change (atomic writes)"_ makes ONE change and parses once — it tests neither "every change" nor atomicity. A cell that interrupts a write would be the honest guard. |

**An invariant with no cell is a gap, not a convention.** If you add one here,
add the cell in the same change.

## 3 · Context — what is in the sidebar

**One type covers "a document" and "a folder" (E15).** A `ContextEntry` is a
root directory plus a tree of `doc`/`group` nodes. Its `membership` answers the
only question the watcher must ask when a new file appears under a root:

- **`mirrored`** — everything under the root that is a document, less what the
  human hid. A folder entry. New files under it are picked up.
- **`listed`** — exactly the nodes written down, in practice one document. A
  single-file entry, rooted at the file's parent. New siblings are **not**
  picked up.

The surface renders an entry holding one doc as a document and anything else as
a tree. That is a rendering choice, not a second type.

**A set is a folder** (E22). "Turn into a set" makes a real directory, moves the
document into it, and the entry becomes `mirrored` rooted there — keeping its
id, so nothing that named the entry breaks.

**Node order carries no meaning** (E17). The surface sorts for display; nothing
may write an order into the manifest.

**Removing an entry closes the document it holds but keeps its versions** — the
session does not forget work because a folder left the sidebar.

**Structure operations** (create, move, rename, hide, unhide, make-set, import,
workspace) are one `StructureOp` union shared by the surface and the agent, so
both parties reach the same code. Hiding is not deleting: a hidden document
stays on disk and stops being mirrored.

## 4 · Versions

A document is an **original on disk** plus **N version files** in the session
folder:

```
$SCRIPTORIUM_HOME/sessions/<sessionId>/
  manifest.json            written atomically, on every change
  docs/<slug>/v1.md, v2.md one file per version
```

**v1 is a copy of the original**, made when the document is opened. Every later
version records `from` (which version it was copied from) and `author` (`human`
| `agent`).

**Exactly one version is active.** The active version is the one the human edits
and the one Save writes to the original. Activating another is explicit —
nothing chooses it for you.

**Numbers come from a persisted counter that only climbs** (E41). They were
`max(existing) + 1`, which is correct only while nothing can be deleted; once a
version can be removed, deleting the highest would hand its number to the next
one, and a `v3` named in a chat message or an agent's notes would point at a
different document.

**Deleting refuses the active version** and says to activate another first.
Because exactly one is always active, the last version can never be deleted —
that falls out rather than being a second rule. `from` on the survivors is left
alone: "made from v2" stays true after v2 is gone.

**The agent's medium is the file.** `version-new` copies a version and prints
its path; the agent then edits that file with its own tools. E2 is **detected,
not prevented** — the daemon notices a write to the active version and preserves
it as a new version rather than forbidding it. ⚠ The other half of the design is
a social rule telling the agent not to, and **that rule is not published yet**:
scriptorium has no `SKILL.md` (there is a draft at
`docs/projects/scriptorium/SKILL.draft.md`). Until it ships, detection is the
whole mechanism.

## 5 · Editing

The human's keystrokes travel: **editor buffer → (debounced 250 ms) → daemon →
the active version's file**. The original is untouched until Save (invariant 1).

**Two writers, one document, and an annotation keeps them apart.** A change the
editor applies _from_ the daemon is stamped `remote`, and the update listener
ignores stamped transactions — otherwise a reload from disk would be sent back
as if the human had typed it and the two would chase each other.

**Text arriving from the daemon is applied as the smallest change** that turns
the old text into the new, so a reader keeps their scroll position when a
version is made active or the original reloads.

**Check before write** (invariant 3): the edit is staged in a sibling file, the
target is hashed, and the rename lands it — so the window in which an outside
write could slip through is microseconds, not the length of the write. Anything
found there first becomes a new agent version.

**An outside change to the original** is handled by state: a clean buffer
reloads silently; a dirty buffer asks, once, and the human chooses _keep mine_
or _take the file's_.

**Merging** takes named hunks from another version into the active one, and
**goes through the same `edit` path a keystroke takes** — so it inherits
invariants 1 and 3 rather than re-implementing them.

## 6 · The wire

Three vocabularies in `protocol.ts`, which is **type-only and import-free** so
the surface can import it without dragging the daemon into its bundle:

- **`ClientMsg`** — surface → daemon. What a human can ask for.
- **`ServerMsg`** — daemon → surface. State snapshots, version text, answers.
- **`AgentCmd`** — CLI → daemon over HTTP. What an agent can ask for.

**Why three and not one:** the two parties have the same capabilities but not
the same affordances (E24). The agent may name a document by absolute path and
have it opened implicitly; the human names what is already in their sidebar. The
agent's writes announce themselves in the conversation; the human's do not need
to. Collapsing the unions would force one party's ergonomics onto the other.

**State is broadcast, not synced.** The daemon sends a whole `PublicState`
snapshot on every change; the surface renders it. Version _text_ travels
separately, addressed by `doc@version`, because it is large and changes for
different reasons.

## 7 · The pure modules

**Three** backend modules hold logic with no I/O and no daemon:
`frontmatter.ts`, `links.ts`, `diff.ts`. They are unit-tested directly over real
strings, and the daemon is a caller like any other. `tree.ts` sits beside them
and is _not_ one of them — it walks the real filesystem
(`readdirSync`/`statSync`) to build the mirror, so its cells need a temp
directory.

**Two rules they share:**

**Never reserialise what you did not write.** Frontmatter is edited a line at a
time, so key order, comments, spacing and keys this spell has never heard of
survive byte for byte — which is what OKF's "preserve unknown keys" asks for and
what a parse-and-print would destroy (E35).

**Compute once, in the daemon.** The diff the surface renders and the hunks a
merge applies come from the same engine, so a hunk the human accepted cannot be
a hunk a different implementation found (E36). The surface renders; it does not
calculate.

⚠ **E51 is the one deliberate exception, and it is here so the rule above is not
read as universal.** `surface/state/projection.ts` computes the rendered
document's plain text with a source span per segment — a real calculation, in
the surface. It is there because the thing it must agree with is the RENDERER,
which is also in the surface: the projection is built by
`mdast-util-from-markdown`, wrapping the same micromark that produces the HTML,
so the two cannot disagree about what is text and what is markup. Moving it into
the daemon would put the calculation on the far side of the seam from the only
artifact it has to match, and would make a right-click wait for a round trip.
The daemon did not gain a verb for this: `dist/server.js` and `dist/cli.js` are
unchanged across that slice.

## 8 · The surface

React 19 + Tailwind v4, shadcn on `@base-ui/react`, three resizable panes:
**context sidebar**, **document**, **conversation**.

- **Document view** is CodeMirror 6, hand-wrapped — the spell dispatches its own
  transactions, so the view's lifecycle is ours (§5's annotation depends on it).
- **Four view modes**: raw, rendered, split, compare.
- **Selection works in the rendered view too** (E51), and resolves to the SAME
  source offsets the raw view reports — so the chat's attachment and a note's
  anchor mean one thing regardless of which half the human was reading.
  `state/renderedRange.ts` is the DOM half (node walking, `Range` building);
  everything decidable without a DOM is next door in `projection.ts` and has
  cells. Two things bought with scars: the rendered view keeps its OWN memory of
  the last selection, because a right-click collapses the browser's, and note
  highlights are **painted** with the CSS Custom Highlight API rather than
  wrapped in markup, because the rendered HTML is the spell's one sink.
- **State lives in the daemon**, not the surface. The surface holds view
  preferences (persisted as prefs through the daemon) and transient UI state.
  Anything another party must see is session state and goes over the wire.
- **Theme tokens are semantic and spell-level** (`rubric`, `ink`, `edge`,
  `added`/`removed`, `selected`). No raw palette in markup; `selected` is
  deliberately not the brand colour (E40).

## 9 · Not here yet

Named so their absence is a decision rather than an oversight:

- **Chat — the WIRE is built; the COMPOSER is not.** `say` exists on both
  `ClientMsg` and `AgentCmd`, a human message reaches the agent's `tail`
  carrying the selection and the active version's path, the agent's `say` lands
  in the same chat, and the pane already styles human and agent messages
  differently. What is missing is a place to type in the surface: nothing in
  `surface/` ever sends `{type: "say"}`. Explicitly last (Cole).
- **Undo/redo — the EDITOR has it; the SESSION does not.** CodeMirror's
  `history` is installed, so ⌘Z works inside the buffer today. What E28 decided
  and nobody has built is _one shared timeline of committed acts_ — undoing a
  move, a merge, an activation. The next thing editing needs.
- **Relative images** do not load; a daemon asset route scoped to the entry
  folder is the fix (E29).
- **Split halves do not scroll together** — compare's two columns cannot drift
  (one scroller, by construction), but raw/rendered are two scrollers of two
  renderings and syncing them is approximate work of its own (E36).

## Related

- [`decision-log.md`](../../projects/scriptorium/decision-log.md) — why, entry
  by entry (E1–E41)
- [`spell-backend-architecture.md`](../spell-backend-architecture.md) — how any
  spell is built, shipped and spawned
- [`dependency-and-package-boundaries.md`](../dependency-and-package-boundaries.md)
  — the import rules the bundle wards enforce

## Revision History

| Date       | Change                                                                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-12 | Created; current through E41. Six claims corrected by an adversarial pass before it landed — the worst asserted the opposite of a ruling the code records in capitals (§1/§2 row 1, frontmatter writes the original). Two invariant rows now carry ⚠ marks where the cell guards LESS than the row claims; those are gaps to close, not decoration. |
