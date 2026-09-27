---
type: feature
title: Context and Chat Kit
description:
  Give spell surfaces one shared ref contract, a shared drop intake, a shared
  chat seam and, once a real consumer needs it, a context list that works with
  any backend, so context and chat stop being re-copied per spell.
tags: [kit, context, chat, surfaces]
status: draft
lifecycle: backlog
generated: { by: claude-opus-5-5, at: 2026-09-25 }
---

# Context and Chat Kit

## Overview

Almost every spell has a context area and a chat bar, and each spell built its
own. The investigation that led here surveyed all of them:

- a census of five spells' context UIs
- an adversarial cold read that ran the census's claims
- a Playwright walk through imago and glamour
- a survey of StoryLoom

It found that what the spells actually share is **not a sidebar**. It is a **ref
contract**: how a message refers to the things it's about (a document, a line
range, an image, a batch), and how the selection on the board rides along on the
next message. Every spell does this today, each in its own way, and each way
loses information.

This project builds that shared layer first, adds a small shared drop intake,
and uses the ref contract as the base for a shared chat seam. A shared **context
list** comes last. It is designed together with a real consumer that needs
several kinds of context (StoryLoom, or Cole's world-building idea), not
generalised from the spells that happen to exist.

The order was approved by Cole on 2026-09-25.

## Problem Statement

- **Refs diverge and lose information.** Each spell sends its selection
  differently:
  - scriptorium: a `Selection` bound to a document version, which is what fixed
    E66
  - mind-mapper: prefixed `ground` strings, where a bare id means a node
  - glamour: bare-id `ground`
  - imago: `focus` plus `selectedRefIds` plus `marks`

  The obvious unification, `"<kind>:<id>"`, would drop the version, the range
  and the role, and **bring E66 back in every spell at once**. No test would
  notice, because no test pins a grammar across spells.

- **Drop intake is copied five times.**
  - glamour, imago, magpie and scriptorium each have their own
    `fileIntake`/`droppedFiles` normaliser.
  - mind-mapper's `surface/state/intake.ts` is a deliberate port of the same
    shape.
- **Chat has four message-row implementations** and no shared way to show a
  surface shortcut (a gesture) apart from a typed message. No spell shows its
  refs as chips inside a message.
- **The same gesture means opposite things.** A plain click is "show on canvas"
  in imago and "select for chat" in glamour. Many gestures do nothing: neither
  spell has right-click, imago's tray tiles ignore clicks, and imago has a
  `Lightbox` that nothing renders.
- **StoryLoom is about to meet the same problem.** Its own report
  (`story-loom/docs/reports/2026-09-25-collaborative-workspaces-and-hosted-spells-report.md`)
  names a hosted Spellbook spell with one document plus chat as its next
  experiment. Without a shared contract, that experiment invents a fifth ref
  grammar.

## Proposed Solution

Three phases, each usable on its own. Phase 3 is **gated**.

### Phase 1: the ref contract and drop intake

**A ref contract**, as framework-agnostic TypeScript with zero dependencies. A
ref is:

- **opaque to the UI:** the UI renders it and passes it along, but never parses
  it;
- **self-describing to the agent:** it names what it points at (house-style
  `carry-frame-just-value.reference-names-what-refers`);
- minted by the host's adapter.

It supports:

- **Two modes.**
  - `pinned` refs carry the version they were taken against. This is
    scriptorium's selection, and the E66 guard.
  - `live` refs follow the target. This is StoryLoom's stack.
  - Either way, **each read records what was actually read** (a version or a
    hash, as StoryLoom's `viewHash` does). This is how "names its version" and
    "live by design" both hold.
- **An optional range**, as a tagged union: line range (scriptorium), char span
  (mind-mapper, StoryLoom links) or `#fragment` (headings).
- **An optional role**, with host-defined parameters. The role can be as simple
  as imago's focus vs. reference, or as rich as StoryLoom's guidance, adherence
  and moodboard/sequence.
- **Agent-side resolution** that accepts an id or a title and **refuses with
  candidates** when it's ambiguous or missing (StoryLoom's `corpus/refs.ts`
  pattern).

The contract also standardises the one pattern every spell already shares:
**selection is board state, and it rides on the next message.** It is ambient,
never pushed as an event (the ambient-vs-intent canon).

**Drop intake:**

- A `File` → `{name, mime, text | dataUrl}` normaliser in the zero-dependency
  layer.
- A React `DropZone` in `kit/ui` that routes by accepted types and says why it
  refused a file.

**Adopters:** the four spells that send refs today.

- scriptorium: `Selection` / `withSelection`
- mind-mapper: prefixed `ground`
- glamour: bare-id `ground`
- imago: `focus`, `selectedRefIds` and `marks`

Magpie is excluded. Its intake is pipeline input, not context. All five intake
copies (the four adopters plus magpie) move to the shared normaliser.

**Proving it:** each adopter takes on the contract **in its message payloads**,
behind its existing wire. Adopting it doesn't change what the agent sees unless
the change is deliberate.

- scriptorium, mind-mapper and glamour have acc configs, and their acc runs
  still pass.
- **Imago has no `acc.config.json`**, so it gets a manual check (or a
  conformance config first).

**Phase 1b: migrating persisted refs.** Some spells save refs or selection to
disk. Known cases:

- glamour's snapshot `selectedIds` (`persist.test.ts` pins the migration)
- imago's `refSelected` on variants, and marks
- scriptorium's note anchors, which carry a selection range

The first task in phase 1b is a full inventory. Phase 1b runs after the payload
adoption, so the size of phase 1 can be checked rather than assumed.

### Phase 2: the chat seam

Run the chat census over grapevine, mind-mapper, glamour and scriptorium, using
the same method: a no-stake census, then an adversarial cold read. Start from
the **message-surface paradigm**: one message bus, where every surface
affordance is a channel that stamps provenance.

Phase 2 decides:

- ref chips inside messages;
- how gesture messages look different from typed ones, and how to filter them;
- whether scriptorium's tasks and notes generalise.

The output is a shared message model built on phase 1's refs, and a React
message row and composer for spells. **StoryLoom's hosted-spell experiment is
the external test of the same contract.**

### Phase 3: the context list (gated)

**Gate:** a real consumer that needs several kinds of context is being built.
That's StoryLoom's adoption, or the world-building app. Until then this phase
doesn't start.

The design, as far as the investigation has established it:

- **A headless display model plus a per-host adapter.** The UI never sees paths,
  daemon message names or storage.
  - Adapter capabilities are all optional, and the matching affordance renders
    only when the adapter provides it: `list`, `intake`, `browse` (returns a
    tree, pick at any depth), `open`, `remove {label, destructive}`, `reorder`,
    `group`, `toRef`.
  - Differences between backends become capabilities, not storage types.
- **Three layers of state:**
  - _attached/enabled_: durable, ordered, grouped, possibly inherited and
    read-only
  - _selected_: ambient, and rides on the next message
  - _active_: the focus
- **The UI emits what happened** (`activated`, `selected`, a menu item was
  picked), **and the host decides what it means.**
- **One gesture set,** taken from StoryLoom's Media Manager: select, toggle,
  range, a context menu, preview, drag.
- **Per-item properties or a slot** for authored parameters (guidance,
  adherence), and inline-editable items (freeform).
- **Kinds come from a closed union with exhaustiveness.** An item shows a
  `status: pending | resolved | missing`. An unknown kind renders visibly as
  `Unknown (x)` and never falls back silently (StoryLoom's
  `unknownEntryTypeLabel`).
- **Kinds are configured per host.** Scriptorium would accept documents and
  structured documents only, and stays text-only by choice.
- **An image set is a container ref that renders as an index,** following
  StoryLoom's container-as-index. Whether imago's batches, glamour's rounds and
  the focus lens fit that model is for this phase to test.

**Reference implementations** to learn from: scriptorium (documents), glamour's
mood board (images) and StoryLoom's `ContextStack` and `ImageGroupPanel`.
**Refitting existing spells onto the list is not a goal**. It happens only where
it pays off.

## Scope

**In scope:**

- Phase 1: the ref contract (types, pure helpers, minting and resolution rules),
  the `File` normaliser, the React `DropZone`, and adoption in message payloads
  across the spells that send refs.
- Phase 2: the chat census, the shared message model, and a React message row
  and composer.
- Phase 3, **once gated in**: the headless `ContextList` contract, a React
  renderer, and one consumer.
- **Designing for use outside Spellbook:** everything shared stays React-free
  and daemon-free, except the React renderers.

**Out of scope:**

- **Distributing across repos** (publishing a package, or StoryLoom adopting
  it). This was ruled "Spellbook spells now, cross-repo later." Cole's existing
  cross-repo pattern, copying with a `DIVERGENCES.md`, stays available.
- A Vue renderer.
- **Moving shadcn primitives into `kit/ui`.** House-style
  `registry-primitives-variant-extends-recipe` keeps `surface/ui/` per spell.
- **Extracting scriptorium's sidebar as it stands.** Its file management (move
  and rename, sets, the workspace, undo, the map) stays in scriptorium.
- Restyling. The token layer and the rebrand own the look.
- Magpie's intake. It is pipeline input, not context.

**Future considerations:**

- A cross-repo package in the shape of StoryLoom's `packages/shared`.
- A Vue renderer.
- Contract-level tests that pin one ref grammar across spells.
- An agent tool scope derived from attached containers (StoryLoom
  `proposal.md:242`).

## Technical Approach

- **Where the code lives:**
  - The zero-dependency, React-free contract layer goes in `src/kit/`, as a
    module that imports nothing from React or any daemon. It must be copyable
    as-is into another repo.
  - React renderers go in `src/kit/ui/`.
  - Wire helpers that only Spellbook daemons use (projecting a ref for the
    agent, recording what was read) go in `src/kit/wire/`.
  - The 2026-08-29 build-boundary investigation's caution applies: **backend
    code ships as source**, so check what the contract layer needs in order to
    ship alongside a spell.
- **Adoption is per spell and additive.** A spell keeps its wire and changes its
  payload shape. Agent-visible changes to verbs or messages go through the acc
  declarations and the COMMANDS/SKILL.md text (for imago, the manual check
  above).
- **Persisted state:** any spell whose saved snapshot or manifest stores refs
  needs a migration. Imago already carries a legacy-shape migration as
  precedent.
- **Canon to respect:**
  - message-surface paradigm
  - conversation-primary surfaces
  - ambient vs. intent (intent is decided by who committed the act, not by kind)
  - one state, one meaning (a shared selection is mirrored to the daemon)
  - `reference-names-what-refers`
- **Method:** an anthill team or seat subagents implement; a no-stake reviewer
  verifies each phase (house practice).

## Impact & Risks

**Benefits:**

- One ref shape across spells, and later StoryLoom, so the agent reads every
  selection and every reference the same way.
- E66's class of bug is guarded at the contract, not re-fixed per spell.
- Drop intake written once.
- A chat seam ready for StoryLoom's hosted-spell experiment.
- A context list designed against real multi-kind needs, not guessed at.

**Risks:**

- **Flattening refs.** A contract that drops the version, range or role reopens
  E66.
  - _Mitigation:_ pinned and live are both first-class; range and role are in
    the type; contract tests pin a cross-spell fixture set.
  - This mitigation assumes the open question on scriptorium's chip (pinned vs.
    live) is settled as pinned. See Open Questions.
- **Designing the list too early.** Generalising from two document spells would
  produce the wrong list.
  - _Mitigation:_ phase 3 is gated on a real consumer.
- **The contract leaks the backend.** Paths or daemon message names end up in
  the shared types.
  - _Mitigation:_ the contract layer imports nothing but itself, and a no-stake
    review checks it against StoryLoom's model as a second host.
- **Agent-facing drift during adoption.**
  - _Mitigation:_ acc runs per spell. Imago needs a manual gate.
- **StoryLoom moves on its own.** Its experiment could settle on a different ref
  shape first.
  - _Mitigation:_ phase 1 is small and early. Share the contract with the
    StoryLoom side as soon as it's drafted.

**Complexity:**

- **Phase 1: medium.** The types are small; adopting them in four spells'
  payloads without changing what the agent sees is the work.
- **Phase 1b: small to medium,** depending on what the inventory finds.
- **Phase 2: medium.**
- **Phase 3: high,** and deliberately deferred.

## Open Questions

- Where exactly does the React-free contract layer live in `src/kit/`, and how
  does it ship with a spell? (See the build-boundary investigation.)
- Is `live` plus a record of what was read enough for scriptorium, or does the
  chip itself always need `pinned`? (E66 says the chip is pinned; stack-like
  attachments may be live.)
- Can "image set" become one concept (imago batches, glamour rounds, the focus
  lens, StoryLoom groups)? This is phase 3's question.
- Do the scriptorium task and note channels belong in the shared message model?
  This is phase 2's question.

**Resolved (Cole, 2026-09-25):** the hosted-spell experiment happens **in
Spellbook, as its own line of work**, not as a phase 2 deliverable. It asks how
a spell can be _hosted_ somewhere and have a _local_ agent connect to its
session in real time. That is a question of deployment and session transport,
separate from this kit. It **consumes** the phase 2 chat seam, and phase 2
should keep it in view as a second host. Tracked in
[Hosted spells with a local agent](../../items/hosted-spells/write-up.md).

## Success Criteria

- **Phase 1:**
  - Every spell that sends refs sends them in the shared shape.
  - A fixture test pins the cross-spell grammar, including the scriptorium E66
    case.
  - acc passes per spell, with imago checked by hand.
  - Drop intake has one implementation.
- **Phase 2:**
  - At least two spells render messages through the shared row, with ref chips
    and gesture messages told apart from typed ones and filterable.
- **Phase 3:**
  - One real multi-kind consumer ships on the list.
  - A second host (StoryLoom) can map its context behind the adapter without
    changing its storage.

---

**Related Documents:**

- [Investigation: Shared context and chat components for spell surfaces](../../items/shared-context-and-chat-components/write-up.md):
  the census, cold read, visual survey and StoryLoom survey behind this proposal
- [Shared code and the build boundary](../../items/shared-code-and-the-build-boundary/write-up.md):
  how shared code ships
- [Spell surface pipeline](../spell-surface-pipeline/): the bundler every
  surface ships through
- [Imago unified context library (backlog)](../../items/imago-unified-context-library.md):
  possibly absorbed by phase 3
- StoryLoom:
  `~/Projects/dreamwood/story-loom/docs/reports/2026-09-25-collaborative-workspaces-and-hosted-spells-report.md`,
  `packages/shared/src/context-stack/`,
  `apps/api/src/features/documents/corpus/refs.ts`
