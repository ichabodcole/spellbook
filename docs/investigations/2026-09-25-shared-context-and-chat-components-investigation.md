---
type: investigation
title: "Investigation: Shared context and chat components for spell surfaces"
description:
  Can the spells' separately built context sidebars, and later their chat bars,
  collapse into one configurable kit component each, and what does each spell
  need that the shared version must carry?
tags: [kit, context, chat, surfaces]
status: draft
lifecycle: active
generated: { by: claude-opus-5-5, at: 2026-09-25 }
---

# Investigation: Shared context and chat components for spell surfaces

**Outcome:** Proposal Recommended. The order is agreed; the context list is
gated on a real consumer that needs several kinds of context (StoryLoom or the
world-building app).

---

## Question / Motivation

Most spells have a **context sidebar** and a **chat bar**, and each spell has
built its own. The designs are related but were shaped by each spell's needs. We
keep copying the same patterns from spell to spell, and the copies drift.

Cole's hunch is that a smaller, more basic set sits underneath them:

- **Context** as a possibly multimodal input. Drag in documents, structured
  documents (folder or tree), images and sets of images. Browse them. The agent
  has the same access. Each spell **configures which kinds it accepts**. A spell
  that only needs documents doesn't get image drag-and-drop.
- **Chat** as one bus. Some messages are typed straight to the agent. Others are
  **shortcuts from the surface**: select something, pick an action, and it goes
  out as a message with attached context. The two render differently, can be
  filtered, and the agent can fetch the attached context when it needs it.

Scriptorium, the newest spell, is the starting candidate for both. Its context
sidebar handles single documents and structured documents, and its chat has more
around it (tasks, notes).

**The decision this informs:** whether to build a shared `kit` context component
(first) and a shared chat component (second), what shape each takes, and which
spells would be refitted onto them. The chat half is **in scope but sequenced
second**. It gets its own census once the context half has a direction.

### Scope

- **In:** Spellbook spells only. Shared code lives in `src/kit/`, which spells
  already import from.
- **Out, for now:** reuse across repos (media-buffet and others). That needs
  packaging and distribution work of its own. Record anything the census shows
  that would make it harder later, but don't design for it here.
- **Not a restyle.** The house token layer and the rebrand already own the look.
  This investigation is about structure and behaviour.

### The consumer that forces multiple kinds: a world-building app (Cole, 2026-09-25)

Cole has a concrete use for context of more than one kind. It's a planned
**world-building** app whose context mixes:

- individual documents
- structured articles
- **images brought in to be analysed and to shape the aesthetic**, a
  mood-board-first way of talking about style

The images side is glamour's territory. The documents side is scriptorium's. The
app is both.

- **Scriptorium stays text-only, by choice.** It would configure the shared list
  for documents and structured documents only. That is the exact case "configure
  the kinds you accept" is for, so keeping scriptorium narrow is not a gap.
- **This answers the cold read's condition** that a list waits for a third
  consumer. The consumer is a _new_ app built on the component, not a refit.
  That changes the pilot:
  - Design the list against the world-building app's needs.
  - Use scriptorium (documents) and glamour's mood board (images) as the
    **reference implementations** to learn from.
  - Refit existing spells later, and only where it pays off.
- **Where the idea comes from: StoryLoom**, Cole's separate set of
  story-building apps. It includes world building and already has context of
  more than one kind _at some levels_. Cole is exploring the idea there too. He
  sees a strong context UI, and the primitives underneath it, as a real
  value-add that could be built in Spellbook **or** extracted for other apps.
  Two consequences:
  - **StoryLoom is prior art the census hasn't looked at.** It should be
    surveyed before the list is designed.
  - **StoryLoom is the most likely first host outside Spellbook.** This is why
    the "UI doesn't know the backend" constraint carries weight: cross-repo
    reuse is out of scope _for building_, but in scope _for design_.
- **Status: an idea, not yet named, not yet started** (Cole, 2026-09-25). The
  shared list waits for that app to exist. Until then, the ref contract and the
  DropZone are justified by duplication that exists today in the spells.

### Design constraint: the UI doesn't know the backend (Cole, 2026-09-25)

The shared context UI must **not couple to a Spellbook daemon.** It should work
with a different system behind it, with the host writing a translation (adapter)
layer around it. Whether an entry is a file on disk, a database row or inline
content should ideally **not matter at the UI level**. Cole isn't sure that
holds everywhere, so find where it breaks rather than assume it.

Consequences for the design:

- **Two layers, not one component.**
  - A **headless UI** takes a display model plus callbacks.
  - A **per-backend adapter** maps a store onto it.
  - Spellbook's daemons get one adapter each, or a shared `kit/wire` adapter.
- **Differences become capabilities, not storage types.** The census's
  ref-versus-copy split stops being a UI problem. For example:
  - `remove?: { label, destructive }` covers hide, archive and delete.
  - `list?` backs path autocomplete.
  - `open?` returns content or a viewer.
  - `accepts` plus `intake(File | text)` covers drops.
- **Refs are probably opaque strings the adapter mints.** The UI renders and
  passes them without parsing them.
- **A likely limit:** a browser drop gives a `File`, never a path. So "link the
  real file on disk" (scriptorium) can only be something the _adapter_ does (a
  path box or a daemon picker), never the UI.
- **Cross-repo reuse stays out of scope**, but this constraint keeps it cheap
  later.
- **The UI emits what happened; the host decides what it means** (Cole,
  2026-09-25). Clicking an image in the list reports that the image was
  activated. It isn't wired to one outcome. The host decides whether that means
  "reference it in the conversation", "show it on the canvas" or something else.
  The list doesn't know the canvas exists.

## Current State Analysis

### Context implementations (census targets)

| Spell       | Files                                                                                                           | Size (lines) | Kinds it holds (to verify)                  |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------- |
| scriptorium | `src/scriptorium/surface/components/context/` — `ContextSidebar`, `EntryTree`, `AddPath`, `MapOverlay`, `menus` | ~2,100       | single docs, structured docs (tree)         |
| imago       | `src/imago/surface/components/` — `ContextLibrary`, `LibraryPicker`, `LibrarySwitcher`                          | ~550         | images; switchable libraries                |
| glamour     | `src/glamour/surface/components/` — `LibraryGrid`, `LibraryTile`                                                | ~195         | images (grid)                               |
| mind-mapper | `src/mind-mapper/surface/ContextRail.tsx`                                                                       | ~250         | TBD; likely closest to scriptorium          |
| magpie      | `src/magpie/surface/` — image intake (no file named "context")                                                  | TBD          | source images; is intake a context sidebar? |

Scriptorium alone is about 2,100 lines, roughly two thirds of all the context UI
in the tree. It is the richest implementation and also the most specialised.

### Chat implementations (phase 2 census targets)

- scriptorium: `ChatComposer` (with tasks and notes next to it)
- grapevine: `Composer`, `MessageFeed`, `MessageRow`
- mind-mapper: `MessageBubble`
- glamour: `MessageBubble`

That makes four separate message-row implementations.

### The shared home already exists

`src/kit/` has `ui/` (`ConfirmDialog`, `Dot`), `lib/`, `theme/` and `wire/`
(SSE, event log, tail handoff and more). Scriptorium and imago already import
`kit/ui`, so **surface code already crosses spell boundaries through the
bundler.** The 2026-08-29 build-boundary investigation said "surface code ships
built, so sharing it is nearly free once a spell is relocated." Every spell has
since moved to React + Bun + Tailwind v4. **The packaging question that
investigation left open is closed for surface code.** What's left is design.

### Existing canon this must respect

- **Message-surface paradigm** (mind-mapper drive #9): the chat bar is the one
  message bus. Every surface affordance is a channel into it that stamps
  provenance and attachments. There should be one filterable stream, not a chat
  **plus** an ingest queue **plus** a jobs panel. This is the starting spec for
  phase 2.
- **Conversation-primary surfaces:** buttons are shortcuts for conversational
  acts and never the only way to do something.
- **Ambient vs intent** (co-presence): context on the board is **ambient** state
  the agent pulls. The agent's event stream only carries **intent**. A shared
  context component must not start pushing ambient changes as events.
- **One state, one meaning:** a shared fact has one state, mirrored to the
  daemon. Scriptorium's E66 bugs (the context chip not matching the selection)
  came from exactly this seam.

## Investigation Findings

### Phase 1 context census (2026-09-25, a no-stake subagent, read-only)

**Headline: the five "context" UIs hold four different things.** Only
**scriptorium** and **mind-mapper** hold context in this investigation's sense:
source documents the human brings in and the agent reads.

- **Imago's "Context Library"** is a store of authored **text snippets**
  (prompts and styles), not images.
- **Glamour's library** mixes context (the `ref` and `context` kinds) with
  **work product** (`gen` and `style`).
- **Magpie's intake** is one input that starts a pipeline.

What they really share is smaller than a sidebar: **an entry list, plus refs
that ride along on a message** (`ground` / `withSelection`).

#### Needs matrix (summary)

| Capability           | scriptorium                            | mind-mapper                      | glamour                             | imago                     | magpie                  |
| -------------------- | -------------------------------------- | -------------------------------- | ----------------------------------- | ------------------------- | ----------------------- |
| Kinds                | doc, and a folder "set"                | doc (free-text `kind`)           | ref, context, **gen, style**        | prompt, style (text)      | one composite image     |
| Render               | list, drills into a tree               | card rows                        | tile grid                           | cards                     | canvas                  |
| Drop                 | copies into the workspace (docs only)  | text via `POST /ingest`          | anywhere; image→ref, text→context   | none (drag goes out only) | replaces the board      |
| Path box / OS picker | yes (links the real file) / yes        | no                               | no                                  | no                        | composer file input     |
| Agent add verb       | `add`                                  | `ingest`                         | **none**                            | `context <kind>`          | `source`                |
| Structure            | entries plus trees, workspace, hidden  | flat                             | flat, facets, focus, archive        | flat plus linked sets     | singleton               |
| Selection            | open doc; the chip is a **text range** | open doc                         | **multi**, mirrored (`item.select`) | link toggle               | n/a                     |
| Agent read           | `state` then the real file             | `state`, `doc <id>`              | `state` then `Read path`            | `state` (lean)            | `state` then `path`     |
| Event on add?        | no (structure ops yes)                 | `doc.added`, not inbound         | **yes, `item.add`**                 | no                        | **yes, `source.added`** |
| Persistence          | per session, the manifest              | **per project**, SQLite plus FTS | per-session snapshot                | per-session snapshot      | per-session snapshot    |

#### Contract divergence

No two spells agree on any of these:

- **Entry type name:** `ContextEntry` in both scriptorium and imago, with
  **different shapes**. Elsewhere it's `DocMeta`/`Doc`, `LibraryItem` or
  `Source`.
- **Title field:** `label`, `title` or `name`.
- **Identity scheme.**
- **Transport:** mind-mapper uses REST; the rest use WebSocket.
- **Ref grammar on messages:**
  - mind-mapper: `ground: ["doc:<id>", ...]`, prefixed
  - glamour: `ground` as bare ids
  - imago: `focus` plus `selectedRefIds`
  - scriptorium: a `Selection` object
- **What "remove" means:** hide (the file is kept), delete the file, archive, or
  destroy.

**Ref versus copy is a split in the model, not a setting.** Scriptorium links
real files. Mind-mapper and glamour copy content into their store. Imago holds
content inline. What "remove" means follows from that choice.

#### What does not fit

1. **Glamour `gen`/`style` items are work product.** They carry review marks
   (star, like, canonical). Glamour also _pushes_ `item.add` as an agent event.
   Tests pin this, and SKILL.md documents it as the wake signal.
2. **Magpie's intake is input to a pipeline.** It holds one full-resolution
   image, a drop replaces it, and the drop is itself the command. Keep it out.
3. **Imago's library is a snippet store with named-set membership** (`active`,
   `quickPrompts`), which no other spell has. Its image context is a flag on
   work-product variants. `LibrarySwitcher` switches **panes**, not libraries.
   **Hypothesis 2's cross-kind worry does not hold**, but a new one replaces it:
   in imago and glamour, context and work product share one entity type.
4. **Scriptorium's sidebar is a file manager:**
   - mirrored/listed membership plus a watcher
   - move and rename with a plan step
   - set promotion, the workspace, undo over the context's shape (E60),
     frontmatter marks, and MapOverlay

   None of this belongs in a core. Its chat chip is an _editor text range_, so a
   "select entry → chip" core would not model it.

5. **Mind-mapper's docs are provenance roots:**
   - who asserted the kind (user or agent)
   - the doc lens
   - deleting a cited doc returns 409 with counts
   - storage per project, not per session
6. **Persistence scope differs** (session, project, cross-session). A shared
   contract cannot assume one.

#### Candidate shape (the census's claim, not yet ratified)

**The shared unit is an entry list plus a ref contract, not a sidebar.**

- **`kit/ui/context/ContextList`**
  - Props: `entries`, `kinds: KindRegistry`,
    `selection {mode: none|single|multi, ids, onChange}`, `onOpen`, `onAdd`,
    `onRemove`, `menuFor?`.
  - Layout comes from the kinds present: list, tree or grid.
- **Kind interface:**
  `{ id, label, icon, accepts {mime, ext}, layout, render, intake(file|path|text) → AddRequest | Refusal, refPrefix, agentRead: "path" | {verb} }`.
- **`kit/wire/context.ts`** (types plus pure helpers):
  - `Entry = { id, kind, title, path?, by: human|agent, meta? }`
  - `context.add` / `context.remove`, and `state.context`
  - **`ground: ["<kind>:<id>"]`** as the one ref grammar on messages. This is
    mind-mapper's, and it subsumes glamour's and imago's.
  - `parseGround`/`formatGround` and lean-projection helpers
- **No event on add by default.** A kind can opt in with `intentOnAdd` (the
  glamour and magpie cases), so the ambient-versus-intent exception is
  _explicit_.
- **Stays in each spell:** scriptorium's file management and map, mind-mapper's
  lens and marks, imago's linked sets, glamour's review marks, and magpie
  entirely.

**Where the claim is weakest:**

- Only two real sidebars (plus glamour's two input kinds) may be **too thin to
  pay back** the cost of a shared list.
- **The ref grammar may be the real shared asset.** That is the chat seam in
  phase 2, not the list.
- The natural pilot is **mind-mapper** (plain docs), not glamour or imago.

#### Refit risks

- **Scriptorium's "kit-ready" header claim is false.** `ContextSidebar.tsx:1-4`
  says it is props-only and can move to `src/kit/` as it stands. In fact it
  imports scriptorium's protocol types, `useDaemon` types
  (`Listing`/`Planning`/`Mapping`) and scriptorium-local shadcn `@/ui/*`.
- **The shadcn primitives are duplicated** in `scriptorium/surface/ui` and
  `mind-mapper/surface/ui`. They have to move to `kit/ui` first.
- **Token vocabularies diverge:**
  - scriptorium: `text-ink-faint`
  - imago: `text-faint`, `bg-surface-2`
  - glamour: still has raw `slate`/`violet` in `LibraryGrid`/`LibraryTile`
- **Tests that pin today's contracts:**
  - scriptorium: `cli-contract.test.ts`
  - glamour: `types.test.ts` (`item.add` is an event)
  - imago: `server.integration.test.ts`
  - mind-mapper: `ingest.test.ts` (`text`, not `content`)
- **Agent-facing contract:** verb or message renames touch acc declarations,
  COMMANDS tables and SKILL.md text.
  - **Imago has no `acc.config.json`**, so a refit there has no conformance
    check.
  - **Mind-mapper has no SKILL.md** under `plugins/spellbook/skills`. Verify
    before counting the doc cost.
- **Persisted state needs one migration per spell** for any reshape of an entry
  (snapshots, the manifest, SQLite).
- **One state, one meaning:** a shared `selection` prop must be mirrored to the
  daemon. Glamour mirrors it; mind-mapper keeps it in local React state.

### Adversarial cold read (2026-09-25, a second no-stake subagent that ran the claims)

**The descriptive half of the census mostly holds. Its candidate shape does
not.** The pinning tests cited pass:

- scriptorium `cli-contract`: 39/39
- imago `server.integration`: 42/42
- mind-mapper `ingest` + `groundRefs`: 11/11
- glamour `reduce`: 24/24

#### Corrections to the census

- **Glamour's `item.add` pin** is in `reduce.test.ts:113` (`isImperative`) and
  `daemon.integration.test.ts:135,377`. There is no `types.test.ts`.
- **Mind-mapper is hybrid, not REST-only.** Commands go through `fetch`; state
  is pushed over a WebSocket (`useProjectState.ts:105`).
- **Imago does have image-context drops,** just not in `ContextLibrary`.
  Dropping on the composer (`Conversation.tsx:108`) or the References tray
  (`Canvas.tsx:895`) sends `ref.add`. That is **real image context**, which the
  census filed as a flag on work product.
- **Mind-mapper's `ground` has three prefixes** (`groundRefs.ts`): a bare id is
  a **node**, plus `doc:` and `zone:`. Most of it refers to _board_ things, not
  context.
- **Imago's `say`** also carries `flattenedImagePath` and `marks`
  (`server.ts:896`).
- **Moving the shadcn primitives into `kit/ui` would break canon.** Five spells
  carry `surface/ui`, and the copies already differ. House-style
  `registry-primitives-variant-extends-recipe` (house-style.md:553) says the
  registry owns each spell's `surface/ui/`.

#### What the cold read broke in the candidate shape

1. **`ground: ["<kind>:<id>"]` loses information and brings back a fixed bug.**
   - Scriptorium's `Selection` is
     `{doc, version, path, fromLine, toLine, text}`. Flattening it to `doc:<id>`
     drops the version binding that **fixed E66**. It also breaks house-style
     `carry-frame-just-value.reference-names-what-refers` (house-style.md:421):
     a ref must name the thing _and its version_.
   - Imago's focus versus reference is a _role_ on the same kind, and `kind:id`
     can't express a role.
   - Three spells anchor refs to **text ranges**, each differently: scriptorium
     (lines plus version), mind-mapper (`spanMatch.ts`) and digestify
     (`AnnotationLayer`).
2. **`Entry` fits neither backend.**
   - Scriptorium's entry is a _root_ with a tree of nodes, so `Entry` can only
     project one row of it.
   - Mind-mapper's `kind` is a _semantic_ doc type asserted by a user or the
     agent, while the candidate's `kind` is a _modality_. One field can't mean
     both.
3. **`intentOnAdd` sits on the wrong axis.** Glamour emits `item.add` only for
   the _human's_ add. The canon defines intent by **who committed the act**, not
   by kind. Glamour and magpie follow the rule rather than break it, so this is
   a per-spell daemon decision, not a kind property.
4. **It breaks Cole's constraint.** These leak into UI props, and all of them
   belong in the adapter or `kit/wire`:
   - `path?`
   - `agentRead`
   - `refPrefix`
   - `context.add` / `state.context`
   - `intake → AddRequest`

#### Where storage reaches the UI, and the capability that replaces it

| Seam     | Today                                                                                                                                                        | As an adapter capability                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop     | scriptorium already reads `File.text()` in the browser and sends `{import, name, text, into}` (`ContextSidebar.tsx:187`); only `into` is a filesystem detail | `intake?(files \| text, target?)`                                                                                                               |
| Path box | AddPath needs a listing source                                                                                                                               | `browse?(prefix)`; leave it out and the box doesn't render                                                                                      |
| Remove   | hide, delete, archive or 409, depending on the spell                                                                                                         | `remove?: {label, destructive, confirm?, run(key)}`                                                                                             |
| Open     | varies                                                                                                                                                       | `open?(key)` returns `{content}` or `{viewer}`                                                                                                  |
| Refs     | varies                                                                                                                                                       | `toRef(key, range?)`: **opaque to the UI, self-describing to the agent** (names the referent and its version, and can carry a range and a role) |

Revised boundary sketch:

```
kit/ui   ContextList({ items: {key, title, badge?, icon?, children?}[],
           layout, selection: {mode, keys, onChange}, capabilities, onOpen })
adapter  { list(); intake?(); browse?(); open?(); remove?; toRef(key, range?) }
daemon   persistence, when to emit an intent event, agent verbs (unchanged)
```

#### Alternatives, steelmanned

- **(a) Do nothing, or extract only primitives plus a DropZone.** Primitives are
  ruled out by canon. A **DropZone plus a `File` normaliser** is cheap real
  duplication (`fileIntake`/`droppedFiles` in four spells) and is worth doing
  whatever else is chosen.
- **(b) Ref contract first.** **The cold read favours this.** Every spell sends
  refs, the refs cover board things and not only context, canon already governs
  them, and phase 2 (chat) depends on them.
- **(c) Extract scriptorium's sidebar as-is.** Premature. The only other doc
  spell (mind-mapper) has the opposite model.

**The cold read's verdict:**

1. A `kit/wire` ref contract
2. A DropZone and normaliser
3. The chat census, on top of (1)
4. A `ContextList` only when a third plain-list consumer appears, with
   mind-mapper as the pilot

**Biggest risk:** a flat ref grammar would reopen E66 in every spell at once,
and no test would catch it, because no test pins a grammar across spells.

#### Orchestrator's note on the verdict

Step 4's condition, "a third consumer", may already be met once the list is
**modality-agnostic behind an adapter**:

- docs: scriptorium, mind-mapper
- images: imago's References tray, glamour's `ref`/`context` kinds

The census undercounted image context, and the cold read's own correction (the
imago drops) adds a consumer. Whether a shared list comes now or later is a
**sequencing decision for Cole**. The evidence is clear on the order of the
first two steps, not on when the list should follow.

### Visual survey of image context (imago, glamour)

Method: both spells ran from their release bundles, each in a scratch home. A
subagent drove them with Playwright and wrapped `WebSocket.send` to capture
every outgoing frame, then checked the daemon side with `tail`/`state`. The
orchestrator spot-checked two of the screenshots. Screenshots were saved to
session scratch and are not kept in the repo.

**Cole remembered right, and it's imago.** The image sidebar is imago's left
**Library** rail (`GenerationsRail.tsx`).

- Clicking a tile **shows it on the canvas** (`focus.set`).
- Dragging a tile to the **References** tray under the canvas marks it as a chat
  reference (`ref.select`). The same flag shows as a 📎 badge on the tile, one
  state in two places.
- Dropping an OS file on the tray or the composer imports it as a reference
  (`ref.add`) and adds a gesture line to the chat ("you pointed at a
  reference").

Glamour has no image sidebar. Its images sit in a centre grid where a click
**selects for chat** (`item.select`, with cmd-click for multi-select). The
composer then reads "grounded to N selected items", and the message goes out
with `ground: [ids]`.

**Findings for the shared list:**

1. **The same gesture means opposite things.** A plain click means "show on
   canvas" in imago and "select as chat context" in glamour. This confirms the
   rule that **the UI emits `activated`/`selected` and the host decides what it
   means.**
2. **A list needs two channels, not one.** Imago uses a _focused_ item and
   _reference_ items at the same time, and both go out on `say`. So "selected"
   alone is too little; the list needs "active" as well.
3. **Selection is board state that rides on the next message** in both spells:
   `selectedRefIds` in imago, `ground` in glamour. **This is the pattern to
   standardise.** Only glamour's `item.add` wakes the agent. Imago's `ref.add`
   stays ambient.
4. **Neither spell shows references as chips inside a message.** Glamour prints
   an "about: …" line; imago prints nothing. Imago's payload also carries a
   `focus` role and `flattenedImagePath`, so **the ref contract needs roles, not
   only ids.**
5. **The gesture set is patchy.** Neither spell uses right-click. Imago's tray
   tiles do nothing on click, dragging into imago's composer does nothing, a
   double-click in imago sends `focus.set` twice, and imago has a `Lightbox`
   component that nothing renders. **A shared list could define the gesture set
   once:** preview/open, select, multi-select, a context menu, and draggable
   items.
6. **Sets.** Imago groups images into **batches** (one per import, and "generate
   · 4 variants" for generations) with facets All, Generated, Imported and
   References. Glamour has no batches: generated tiles carry a "round N" badge,
   and "focus these" makes a temporary lens set. **An "image set" in practice
   means batch, round or lens. It is not yet one concept.**

Two unrelated glamour bugs showed up in passing: opening the details flyout
squeezes the grid down to thumbnails, and the flyout's title overlaps the facet
bar. They are for the backlog, not this investigation.

### StoryLoom survey (2026-09-25, read-only, code and docs)

Repo: `~/Projects/dreamwood/story-loom`. Studio is **Nuxt/Vue**, not React.
Paths below are relative to that repo.

**StoryLoom's context is a durable, ordered, per-level, inheritable stack, not
an ephemeral selection.**

- Stack entries (`context_stack_entries`) attach a library, container, document
  or freeform text to a level: project, collection, storyline, segment.
- Storylines and segments have two lanes: _context_ (text) and _creative input_
  (text plus images). Only the text stacks inherit down the levels.
- Images live in a **different store** (JSON on the storyline or segment row,
  pixels in Media Buffet) with a **different component** (`ImageGroupPanel`).
  Each image carries per-image **guidance** ("why this image?") and
  **adherence**. A group is a `sequence` or a `moodboard`.
- Images reach the writing model **only as analysis text**, a hashed, versioned
  artifact per image.
- Studio has **no chat.** The agent works through MCP with full parity.
- **Convergence:** StoryLoom's own report
  `docs/reports/2026-09-25-collaborative-workspaces-and-hosted-spells-report.md`
  (verified; draft, by Codex) names **a hosted Spellbook spell with one document
  plus a chat panel** as StoryLoom's next experiment, and cites scriptorium's
  version-carrying selection as precedent. **Phase 2 of this work _is_ that
  experiment's chat seam.**

**What StoryLoom does better, to adopt:**

- **A closed kind union with exhaustiveness.** It fails loudly on the server and
  renders a visible `Unknown (x)` in the UI
  (`packages/shared/src/context-stack/index.ts:76-105`).
- **Tri-state target resolution,** `pending | resolved | missing`, with dangling
  targets that keep a reason (deleted vs. never existed).
- **A forgiving, scope-bound agent ref grammar** (`corpus/refs.ts`): id, title,
  `[[wikilink]]`, `#fragment`, with typed refusals that carry candidates.
- **Provenance recorded when content is read.** Refs are live, and every read
  records a `viewHash`/`input_hash` of what was actually handed over.
- **Per-reference human intent** (guidance, adherence, moodboard vs. sequence),
  a much richer "role" than imago's focus vs. reference.
- **Media Manager already has the full gesture set:** range and toggle
  multi-select, a right-click menu, a DropZone, and a grid that emits
  `select(item, event)` so the page decides. **A single API seam**
  (`api-helpers.ts`) is precedent for an adapter.
- **Container-as-index:** a folder ref renders as structure plus abstracts, not
  contents. That is a natural model for an **image set**.

**Where it breaks the proposed adapter:**

- **Order has meaning.** Stack order is a positional contract with generation,
  so the list needs `reorder`.
- **Items carry authored parameters** (groups, guidance, adherence, group mode),
  so the list needs item properties or a slot.
- **Freeform entries are editable content inside the list,** not refs.
- **Inherited, read-only items with enable toggles** are a third durable state
  (_attached/enabled_), separate from _selected_ and _active_.
- **One visual list over two stores** means the adapter merges them, and order
  _across_ modalities is undefined.
- **`ContextStack.vue` fetches directly.** Moving that behind an adapter is a
  StoryLoom change, though Media Manager shows the pattern.

**Consequences for the recommendation** (the project is already created):

1. **Refs have two modes, not one.** `pinned` (scriptorium's E66 case) or `live`
   (StoryLoom's stack), and **every read records what version or hash was
   actually read.** Requiring a pinned version everywhere would contradict
   StoryLoom. Allowing only live refs would reopen E66.
2. **`range` is a tagged union** (lines, char spans, `#fragment`). **`role`
   carries host-defined parameters,** not only an enum. Refs **resolve by title
   as well as id and refuse with candidates.**
3. **The ContextList has three layers**, not two: _attached/enabled_ (durable:
   ordered, grouped, possibly inherited), _selected_ and _active_. It also needs
   `reorder`, `group`, item properties, inline-editable items, `status` with a
   visible unknown-kind fallback, and `browse` that returns a tree.
4. **The contract is framework-agnostic TypeScript with zero dependencies;
   renderers are per framework.** Types, the adapter interface, the gesture
   vocabulary and a pure selection reducer go in a React-free module (the shape
   of `packages/shared`). Spellbook renders in React; StoryLoom would render in
   Vue against the same contract. Cross-repo _distribution_ stays later. Cole's
   existing pattern is to copy and record differences in `DIVERGENCES.md`.
5. **StoryLoom is the phase 3 consumer, and its hosted-spell experiment lines up
   with phase 2.** Design "selection rides on the next message" so both share
   one ref shape from day one.

### Initial observations: status after the census

1. _The component is the easy half._ **Confirmed, and stronger than stated.**
   The contracts diverge on every axis, and ref versus copy is a split in the
   model.
2. _Entry kinds beat flags._ **Holds for the list.** The imago library-switching
   worry was wrong (it switches panes), but a new complication appeared: context
   and work product share one entity type in imago and glamour.
3. _Some "context" isn't context._ **Confirmed.** Magpie is out, glamour
   `gen`/`style` are out, and imago's library is a snippet store.

### Original hypotheses (kept for the record)

1. **The component is the easy half.** Context isn't only a sidebar. The daemon
   holds the entries, the agent reads them through the CLI, and the selection
   drives a chip into chat. A shared sidebar with no shared **context contract**
   (what an entry is, how it's added, removed and read, how selection flows)
   would push the hard part back onto every spell. The census should record each
   spell's backend shape, not just its JSX.
2. **Entry kinds may beat feature flags.** Configure the component with the
   kinds it accepts (for example `doc`, `structured-doc`, `image`, `image-set`),
   with each kind bringing its own renderer, drop and add handling, and agent
   read path. That may read better than `allowImages: false`. It fails if a
   spell needs a behaviour that crosses kinds (imago's library switching might
   be one).
3. **Some "context" may not be context.** Glamour's library and magpie's intake
   might be **work product** or **input to a pipeline**, not context in the
   scriptorium sense. The message-surface paradigm keeps artifacts separate from
   the input stream. The census needs a DOES-NOT-FIT bucket so these don't get
   forced into the shared component.

## Research Plan

### Phase 1: context census (do first)

Run one no-stake subagent over the five implementations. For each spell, record:

- **Entry kinds** and how each one renders (list, tree, grid, thumbnail).
- **Add paths:** drag-and-drop, path entry, picker, paste, agent-added.
- **Structure:** flat list, tree, grouped, multiple libraries.
- **Selection:** single or multi, and what selection _does_ (chip into chat,
  preview, overlay).
- **Agent read path:** the CLI verbs and daemon endpoints the agent uses to see
  context, and whether it pulls or gets pushed.
- **Backend contract:** where entries live, their shape, and what persists.
- **Behaviour only this spell has,** and whether it's essential or incidental.

Output:

1. A **needs matrix** (spells × capabilities).
2. A **contract divergence** table: where the backend shapes disagree.
3. A **DOES-NOT-FIT bucket:** anything that resists the shared model, and why.
4. A candidate **minimal core plus kinds** shape, stated as a claim to falsify.

Then run an **adversarial cold read** of that candidate shape by a second
no-stake subagent before anyone treats it as agreed.

### Phase 2: chat census (after the context shape has a direction)

Same method over the four message implementations. Start from the
message-surface paradigm: channels, provenance, attachments, filtering, and how
a surface shortcut becomes a message that carries a reference to its context.
Decide whether scriptorium's tasks and notes generalise or stay local to
scriptorium.

## Recommendation

- [x] **Create Proposal.** Action is warranted, in this order.

1. **A ref contract in `kit/wire`.** It standardises the one pattern every spell
   already shares: **selection is board state, and it rides on the next
   message.** It also standardises how a message refers to what it's about.
   - Refs are minted by the adapter. They are **opaque to the UI** and
     **self-describing to the agent**: they name the thing referred to _and its
     version_ (house-style `reference-names-what-refers`).
   - A ref can carry a **range** (scriptorium lines, mind-mapper spans,
     digestify anchors) and a **role** (focus vs. reference, as in imago).
   - Guard: **never flatten to `kind:id`.** That brings E66 back.
2. **A DropZone plus a `File` normaliser in `kit/ui`.** Five spells duplicate
   this today. It is cheap, and it pays off whatever comes next.
3. **The phase 2 chat census,** built on step 1. That census decides:
   - ref chips inside a message (no spell has them yet)
   - how gesture lines and typed messages are shown apart, and filtered
   - whether scriptorium's tasks and notes generalise
4. **A `ContextList` of headless UI plus an adapter,** designed together with a
   real consumer that needs several kinds of context (StoryLoom or the
   world-building app). Scriptorium (documents) and glamour's mood board
   (images) are **reference implementations**, not refit targets.
   - Two channels: _selected_ and _active_.
   - One gesture set.
   - Adapter capabilities: `intake`, `browse`, `open`, `remove`, `toRef`.
   - **Survey StoryLoom first.**

**Rationale.** Every spell shares refs, and today they diverge in ways that lose
information. That makes refs the load-bearing asset, and phase 2 depends on
them. The list is where Cole's value-add lies, but the Spellbook spells alone
don't justify it: only two hold context in the census's sense. It should be
designed against the consumer that needs several kinds of context, not
generalised from the spells that happen to exist.

**Not recommended:**

- extracting scriptorium's sidebar as it stands
- moving shadcn primitives into `kit/ui` (breaks canon)
- `intentOnAdd` as a property of a kind (intent is decided by who committed the
  act)

## Open Questions

- Where does StoryLoom live, and what does its context model look like? This is
  prior art for step 4.
- Can "image set" become one concept? Today it means imago's batches, glamour's
  rounds or the focus lens.
- Does the ref contract need a runtime module that daemons share, or only types
  plus pure helpers? Backend code ships as source, so the build-boundary
  investigation's caution applies.
- Does "explore" (preview, lightbox, scriptorium's `MapOverlay`) belong in the
  shared list or in the host?
- A refit of an existing spell changes acc declarations and COMMANDS/SKILL.md
  text. Imago has no `acc.config.json` to catch the drift.

## Next Steps

1. **Done 2026-09-25:** Cole approved the order. The project is
   [`context-and-chat-kit`](../projects/context-and-chat-kit/proposal.md). Phase
   1 is the ref contract plus the DropZone, phase 2 the chat census, phase 3 the
   ContextList, gated on a consumer.
2. Survey StoryLoom's context UI and model once its location is known.
3. Backlog: glamour's flyout squeezes the grid to thumbnails and its title
   overlaps the facet bar. Imago's `Lightbox` is dead code, and a double-click
   sends `focus.set` twice.
4. Fix scriptorium's `ContextSidebar.tsx:1-4` "kit-ready" header claim, which is
   false.

---

**Related Documents:**

- [Shared code and the build boundary](./2026-08-29-shared-code-and-the-build-boundary.md):
  the packaging groundwork
- [Spell surface pipeline](../projects/spell-surface-pipeline/): the bundler
  every surface now ships through
- [Imago unified context library (backlog)](../backlog/2026-06-16-imago-unified-context-library.md):
  an open item this may absorb
- [Scriptorium: chat context doesn't mirror the selection (backlog)](../backlog/2026-09-22-scriptorium-chat-context-does-not-mirror-the-selection.md):
  the selection→chip seam
- `grimoire/house-style.md`: surface conventions
