---
type: feature
title: Workspace Kit
description:
  Re-base Spellbook's kit on Story Studio's generic modules, so spells share one
  set of primitives and Scriptorium's three-pane workspace becomes a kit any
  spell can build on.
tags: [kit, scriptorium, story-studio, surfaces]
status: draft
lifecycle: backlog
generated: { by: claude-opus-5-5, at: 2026-10-13 }
---

# Workspace Kit

## Overview

Story Studio started from Scriptorium and this repo's kit, and it has since
turned Scriptorium into a generic kit. A workspace daemon, a three-pane shell,
and context, chat and document panes each expose slots that an app fills. Atlas
and Sound Stage both run on it. This feature brings that kit back into
`src/kit/`. Its modules are ported as they are, but not blindly. Scriptorium
then re-bases onto it, and the next spell that wants a file tree, a document and
a chat gets them from the kit instead of copying Scriptorium.

This proposal is based on
[Write-up: What to take back from Story Studio](../../items/story-studio-port-back/write-up.md).
Cole chose this path (B, re-base) over cherry-picking on 2026-10-12. Most of the
write-up's taken candidates arrive with it.

## Problem Statement

- **Spells copy their UI.** Button and dialog are copied into five spells and
  context-menu into three, each through the shadcn CLI into its own
  `surface/ui/`. Common layouts are copied the same way. Several spells want the
  same three columns: a context tree, a centre pane and a chat sidebar. Each
  gets a slightly different version with slightly different behaviour.
- **Scriptorium's workspace is locked inside Scriptorium.** Its daemon,
  sessions, versions, tail and panes are about 21k lines that no other spell can
  use.
- **Story Studio has moved ahead, and the gap keeps growing.** It has a quiet
  tail, relinking on rename, links to headings, document profiles, an outside
  change toast that offers an action, error boundaries, a component-test
  harness, and per-verb help. Under cherry-picking, every one of those is a
  separate port into Scriptorium's own code, and later Story Studio fixes would
  need porting again by hand. Ported once into the same shape, later fixes
  arrive nearly as they are.

## Proposed Solution

### Two tiers

The seam map (2026-10-12) shows B is two jobs of different sizes:

| Tier                | Modules                                             | Size (Story Studio) | First consumers                  |
| ------------------- | --------------------------------------------------- | ------------------- | -------------------------------- |
| **Kit foundation**  | `ui`, `theme`, `lib`, `wire`, `cli`                 | ~8.7k lines         | Scriptorium, mind-mapper, others |
| **Workspace stack** | `workspace`, `chat`, `context`, `document`, `shell` | ~40k lines          | Scriptorium                      |

**The foundation** is for every spell: Base UI primitives installed once into
`src/kit/ui`, the fuller theme, the component-test harness, the wire fixes
(detached `startDaemon`, stdin refusal, reply hints, the stop that skips the
drain wait when nothing is open, exit codes) and per-verb CLI help.

**The workspace stack** is the generic daemon and panes. An app plugs in through
four points:

- the app declaration (name, slot versioning, launcher);
- `createWorkspaceDaemon` options (verbs, events, runners, hooks, app state,
  http);
- `WorkspaceShell` props (centre, toolbar, panels, badges, menu actions);
- `DocumentPane` slots (raw-editor extensions, inline widgets, frontmatter chips
  and trust, the app view, format views).

**Scriptorium becomes an app on the stack.** What makes it Scriptorium is its
wiki layer, and that stays in the spell: link extraction and trust tiers,
`meta.*`, `move.plan`, `hide`, `set.make`, and the map.

### Kit UI is the default, not a requirement

Cole, 2026-10-13: the kit's patterns are what a spell uses unless it needs
something else. Examples are the three-column layout, the chat sidebar beside a
context tree, and the primitives. A spell like digestify, with a different
shape, may skip them. The question gets asked twice:

1. **When a spell starts:** does it fit the kit's UI and UX patterns, or does it
   need something of its own?
2. **While it is built:** when a kit piece stops fitting, the spell either
   extends it (a slot, a variant) or replaces it locally.

The house style says how to extend and how to replace. It does not make the kit
mandatory.

### The port order: leaf first

`lib`, `wire` → `theme`, `ui`, `cli` → `workspace` → `chat`, `context` →
`document` → `shell`.

Each module is read for assumptions specific to Story Studio before it lands.
Its names are translated:

- `STORY_STUDIO_*` env names become `SPELLBOOK_*`;
- `story-studio:` storage keys and MIME types are renamed;
- `app` becomes `spell` where it names one of ours;
- the app home is reconciled with `$SCRIPTORIUM_HOME`.

Each module is also merged with the places where Spellbook is ahead: the
links-cycle extraction fixes, `tailHandoff`'s `by: human`, the registry's `--`
warning, and E65 (a note shows that it is with the agent: `notesWaiting` and the
`say` note guard in `workspace`, the badge and "Ask the agent" in
`chat/NotesPanel.tsx`). Story Studio is taking E65 back as its own item,
`kit-per-note-waiting`. Spellbook's `Dot` and `ConfirmDialog` stay where they
read ahead of Story Studio's.

### What arrives with it

Write-up candidates Cole took "with B":

- **Foundation:** the primitives and the happy-dom test harness; the fuller
  `base.css`; `startDaemon`, `stdinWaiting`, reply hints, the faster stop and
  the new exit codes; per-verb help, with an acc re-run for every spell.
- **Workspace stack:**
  - the quiet tail;
  - the outside change toast (Reload / Keep);
  - `ViewBoundary`;
  - the O(n²) first-scroll fix, sent back to Story Studio;
  - word count over the body only;
  - duplicate with Finder-style names;
  - rename and move that relink;
  - links to headings;
  - dragging a tree row into a document;
  - the image tree kind and viewer;
  - document profiles, turned on in Scriptorium without `_world.json`;
  - tasks the human creates, and cancel;
  - the split raw/rendered view.
- **E71** (the workspace is never a set's folder; supersedes E67) is built
  during the re-base. It is not patched into the current code first.

The Compare minimap (#133) and the link-health strip (#129) are already filed
and land on the ported panes.

### First step: compare the interfaces

Before porting the shell, run Atlas and Scriptorium side by side: header,
sidebars, status strip and chat. Cole finds Atlas tighter and cleaner in places.
Atlas also tells apart a connected session and an agent that is listening. The
comparison decides what the ported shell keeps from each. It is a look, not a
redesign.

## Scope

**In scope:**

- The kit foundation in `src/kit/`.
- Changing the house-style primitives rule to match (below).
- Migrating spells that opt in, starting with Scriptorium.
- The workspace stack in `src/kit/`.
- Re-basing Scriptorium, with its wiki layer as the app.
- E71.
- The candidates listed above.

**Out of scope:**

- Story Studio's build (`kit/build.ts`). Spells keep building through
  `src/build.ts`'s `buildSpell` into a committed `dist/`.
- Moving every spell onto the kit. Adoption is per spell, as above.
- The Story-specific parts: cues, world and impact check, Media Forge
  provenance, the "workspace holds the files" model, bundles, `pushLoop`.
- JSON Canvas boards. They were skipped as Atlas-specific, but see the
  mind-mapper question below.
- Phase 1 of [Context and Chat Kit](../context-and-chat-kit/feature.md): the ref
  contract and the drop intake stay that feature's work.

**Future considerations:**

- Mind-mapper re-shaped as a second app on the workspace stack.
- Canvas boards, if mind-mapper takes that shape.

## Technical Approach

- **Wards still apply to the port.**
  - `import-boundary-wards`: the kit stays a leaf, and shipped scripts use only
    `node:` and `bun:`.
  - Also the kit adoption, styling, prose, CSS-scope, dist-roster,
    launcher-pairing, surface-build-mode and spawn-path wards.
  - A ward that a ported module breaks is a finding to rule on, not a ward to
    loosen quietly.
- **Primitives move into the kit.** The rule
  `registry-primitives-variant-extends-recipe` names its own repeal: "when the
  kit ships the primitives itself". This feature fires it.
  - The rule moves to `src/kit/ui`: one registry install, with variants added
    inside the recipe.
  - It gains the opt-out: a spell that does not take the kit's UI keeps its own
    `surface/ui/` under the current rule.
- **Context and Chat Kit continues, narrowed** (Cole, 2026-10-13):
  - This feature replaces its phase 2 (the chat seam). It replaces phase 3 (the
    context list) only for the disk host: the backend-agnostic list stays there
    as a gated phase.
  - It also drops that feature's two out-of-scope lines: no shadcn primitives in
    `kit/ui`, and no extraction of Scriptorium's sidebar.
  - Its phase 1, the ref contract and drop intake, stays, rewritten on top of
    the ported `about`.
  - Of the related research, `shared-context-and-chat-components` and
    `message-log-primitive` are closed (the latter folded into this feature),
    and `context-primitive` continues outside it as the cross-project standard.
- **The chat's refs port as they are** (Cole, 2026-10-13). Story Studio's
  message `about` and `HeldSelection` come with the chat module unchanged:
  - `about` is Scriptorium's selection (pinned to a version, a line range), plus
    `entryIds`, `docs` and `noteId`.
  - The selection rules come with their tests: one held selection, which the
    chip is, and a selection that dies when its text leaves the screen.
  - The agent's message shape changes: Scriptorium's `selection`, `active` and
    `note` on a human message become the ported `about`. Scriptorium's SKILL
    text and acc config are updated with the `workspace` port.
  - The broader contract (Context and Chat Kit phase 1) comes later and treats
    `about` as the workspace stack's case of it: a selection is a pinned ref
    with a line range, and tree rows and whole documents are refs without one.
  - That contract is what widens refs to other media: images, bundles and types
    a spell defines. Links to headings give its `#fragment` range a first user.
- **Evolutions carried on top**, from the
  [prior-direction investigation](../../items/workspace-kit-prior-direction/write-up.md),
  in port order:
  - `workspace`: E65's daemon half, and the agent-facing `about` change above.
  - `chat`, `context`: E65's surface half; store and label an app's own `about`
    parts on the chip; wire `entryIds` to a gesture or remove it.
  - After the port: [`via` and `refs`](../../items/message-via-and-refs.md), one
    change shared with Story Studio, landing in its kit first. Every message
    says which gesture sent it, and a message keeps one subject and can carry
    refs (a tree multi-select, or "Add as reference").
  - After `shell`: facets and collapse in the log, once `via` exists; chip
    actions; the paradigm's house-style entry.
  - After the re-base: the quiet-tail audit and the ambiguous-name refusal, sent
    back to Story Studio.
  - **Not carried** (Cole, 2026-10-13): no daemon mirror of `pointedDocs`.
    Context arrives with the message, not ahead of it as ambient state. A human
    note or task does not appear in the chat log: it already reaches the agent
    as an event and has its own tab. The ported kit's toasts tell the human it
    happened. If the log ever shows everything, it needs filters.
- **Ports run as delegated phases.** Each runs on a cycle branch with an
  implementer and a no-stake verifier who runs the claims. That loop is the
  write-up's delegated-phase playbook, filed separately.
- **Story Studio is read, never written.** Fixes going back to it go through
  `item/kit-port-back-from-spellbook` in that repo.

## Impact & Risks

**Benefits:**

- One set of primitives and one workspace instead of per-spell copies.
- Scriptorium gains the candidates listed above.
- Later Story Studio fixes port nearly as they are.
- The next workspace-shaped spell starts from slots, not from a fork of
  Scriptorium.

**Risks:**

- **The links layer is the riskiest seam.** Scriptorium's link extraction is
  ahead of the kit's (the links cycle). The kit's relink, headings and
  link-check code assume the kit's own extraction. _Mitigation:_ port
  Scriptorium's extraction into the kit as the single extractor, with the
  links-cycle tests as the bar. Do not run two.
- **The workspace stack is twice Scriptorium's size.** About 40k lines replace
  21k. _Mitigation:_ go leaf first, read each module for Story-specific code
  before it lands, and cut what no Spellbook spell uses.
- **Re-basing breaks open sessions.** Users have state under `~/.scriptorium`.
  _Mitigation:_ the app slot carries a version and a `migrate`. E71's doctor
  finding covers sessions that already overlap.
- **Per-verb help changes the CLI's schema.** _Mitigation:_ re-run acc for every
  spell, as the call says.

**Complexity: high.** The foundation alone is medium. The workspace stack and
Scriptorium's re-base are the large part.

## Open Questions

- **Mind-mapper's shape.** Cole (2026-10-13) is considering re-designing
  mind-mapper on Atlas's pattern: a file tree, local files, and a JSON canvas in
  place of its per-project SQLite. If he does, it becomes a second app on the
  workspace stack, and the canvas boards come back into scope. That decision
  belongs to mind-mapper, not to this feature. Until then, mind-mapper takes the
  foundation tier only.
- ~~What the chat and context modules carry beyond the port.~~ **Answered** by
  the
  [prior-direction investigation](../../items/workspace-kit-prior-direction/write-up.md)
  and Cole's rulings on it (2026-10-13). The result is the evolutions list under
  Technical Approach.
- **Where document profiles' schemas live.** Atlas uses `_meta/profiles/`.
- **The three unchecked Atlas items:**
  - `kit-watcher-missed-write-macos`
  - `ended-session-recovery`
  - `kit-surface-csp`

  Check them against the ported code, not against today's.

## Success Criteria

- **Kit foundation:**
  - `src/kit/ui` holds the primitives.
  - Scriptorium and at least one other spell use them, and their own
    `surface/ui/` copies are gone.
  - Component tests run under happy-dom.
  - The gate is green.
  - Every spell passes acc after per-verb help.
- **Workspace stack:**
  - Scriptorium runs on the kit's workspace stack, with its wiki layer as the
    app.
  - The links-cycle tests pass on the kit's single extractor.
  - E71 holds: an `open <folder>` that lands inside a set makes the containing
    folder the workspace.
  - Existing sessions open after migration.
- **The fix-back path works:** at least one fix (the first-scroll cost) ports
  back to Story Studio unchanged.

## First Cycle

**Kit foundation, with Scriptorium as the first adopter:**

1. Compare Atlas and Scriptorium side by side. This informs the theme and
   primitives now, and the shell later.
2. Port `lib` and `wire` with their fixes.
3. Port `theme` and `ui`, with the happy-dom harness.
4. Change the primitives rule in house style.
5. Move Scriptorium's surface onto `src/kit/ui`.
6. Add per-verb `cli` help, and re-run acc.

The workspace stack starts in the next cycle, on a foundation that has already
been used.

---

**Related Documents:**

- [What to take back from Story Studio](../../items/story-studio-port-back/write-up.md)
- [Context and Chat Kit](../context-and-chat-kit/feature.md), phases 2 and 3
  superseded by this feature
- [Scriptorium decision log, E71](../../items/scriptorium/decision-log.md)
