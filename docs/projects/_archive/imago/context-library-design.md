# imago — Unified Context Library (design)

**Date:** 2026-06-17 · **Status:** design approved, ready to plan · **Spell:**
imago · Supersedes the
[unified-context-library backlog note](../../backlog/2026-06-16-imago-unified-context-library.md)
· Prior art: StoryLoom context library (`~/Projects/dreamwood/story-loom`)

## Goal

Collapse imago's two separate "reusable text" stores — **styles** and
**quick-prompts** — into **one Context Library**: a single passive catalog of
textual agent-context. Every place context is _used_ is a **linked set** over
that catalog; the library is the one master list and the one place a guarded
**hard-delete** lives.

Two problems this solves:

1. **The destructive-delete footgun.** Today `style.remove` / `prompt.remove`
   hard-delete with no recovery (cole lost the seeded "anime" style by
   accident). In the linked-sets model the everyday ✕ is **unlink** (sever a set
   membership) — non-destructive _by nature_, the item never leaves the library.
   The only true delete is a deliberate, guarded action in the library itself.
2. **Two siloed, inconsistent stores.** Styles live in a bottom-drawer tab
   (click-to-toggle); prompts live in a composer dropdown (pick-to-fill).
   They're the same _kind of thing_ — reusable context — managed two different
   ways.

It also lays the substrate the **Projects** backlog item needs (per-project
context), without building Projects now.

## Background

### What exists today

- `ImagoState.styles: StyleEntry[]` —
  `{ name, active, captured?, description?, image?, imagePath? }`, keyed by
  normalized name. Activation = an `active` boolean on the entry, flipped by
  `style.toggle`. `style.remove` hard-deletes. Shown in `Canvas.tsx`'s
  `ReferenceDrawer` "Styles" tab (75×75 tiles, click-to-toggle, ✕ destroys).
  `style.capture` asks the agent to extract a look from the focused image; the
  agent answers with the `style.add` command (upsert on name, sets
  `active: true`).
- `ImagoState.prompts: PromptEntry[]` — `{ id, label, text }`, keyed by id, 3
  seeded with stable ids (`describe`/`palette`/`lighting`). Shown in the
  composer (`Conversation.tsx` `QuickPrompts`): pick → fills the textarea
  (one-shot, never "behind the glass"). `prompt.add/update/remove` CRUD;
  `remove` hard-deletes (the 3 defaults survive only because they're never
  targeted).
- **Image precedent (refs-as-assets):** images are `Variant`s living in
  `Batch`es; "reference" is a flag (`refSelected`) set by **dragging a thumbnail
  into the references drawer**. ✕ in the drawer _deselects_ (asset persists).
  This is the membership/linked-set pattern the Context Library generalizes.

### Lessons from StoryLoom (prior art)

- **A context library is a _passive catalog_.** Consuming surfaces hold
  references to items; the library never tracks "what's using me." Activation
  lives with the _use_, not as flags scattered on items. StoryLoom runs three
  consumption patterns (picker / stack / gallery) over one shared store. The
  linked-sets model below is this lesson applied uniformly.
- **One type + a `category` discriminator + freeform `tags[]`.** Validates our
  `ContextEntry` + `kind` + `tags` shape.
- **StoryLoom's delete is hard-destroy, no archive.** It hit the same footgun
  and never fixed it — and notably, with a true linked-library you don't fix it
  with archive at all: you fix it by making removal _unlink_, with one guarded
  hard-delete. That's the design here.
- **Does NOT transfer yet:** StoryLoom's polymorphic `parentType`+`parentId`
  context stacks earn their keep because StoryLoom has _many_ scopes. imago has
  exactly one today ("the next generation"). That seam is where **Projects**
  later plugs in — not now.

## Conceptual model

Unify the **noun** (one catalog); make every use a **linked set** over it.

1. **Unify the data** — styles + quick-prompts (later: skills, world-context)
   collapse into one `ContextEntry` with a `kind` discriminator. Mirrors the
   `Variant` unification done for images.
2. **The library is a passive master list** — the only place items truly live,
   and the only place a (guarded) hard-delete happens.
3. **Every consumption site is a linked set** — a list of ids over the library.
   Putting an item in a site = **link**; removing it = **unlink** (the item
   stays in the library). The everyday ✕ is always unlink → non-destructive by
   nature.
4. **`kind` is behavior + default filter, not a hard router** — a style
   materializes an image and acts as ambient context; a prompt inserts text. A
   site _suggests_ its kind and defaults its filter to it, but membership (the
   link) is what actually surfaces an item. `tags` carry cross-kind findability.
5. **Single scope now, Projects-ready** — the linked sets live on state;
   Projects later scopes them per-project instead of re-modelling activation.

> **Naming:** it's a **Context Library**, not a "text library" — everything in
> it is agent context, just consumed differently. The future "world context"
> idea is a deferred `context` kind (see Out of scope); deferring it also avoids
> a kind-named-"context" collision for now.

> **No `archived` flag.** It was a band-aid for conflating "remove from a site"
> with "delete from the catalog." The linked-sets model separates them: unlink
> is the safe everyday remove; hard-delete is the one deliberate destroy.
> Archive has nothing left to mean.

## Data model

One unified type replaces `StyleEntry` + `PromptEntry`:

```ts
export type ContextKind = "prompt" | "style" | "skill" | "context";

export type ContextEntry = {
  id: string; // stable id for ALL kinds
  kind: ContextKind;
  name: string; // title / label
  content: string; // the body text
  tags?: string[]; // freeform faceting + cross-kind findability (StoryLoom lesson)
  image?: string; // optional identity image (data-url; stripped in lean projection)
  imagePath?: string; // materialized on-disk path for the agent to --ref
  captured?: boolean; // style-only: extracted from an image
};
```

`ContextKind` carries `skill` and `context` for forward-compat, but **only
`prompt` and `style` are seeded, migrated, or surfaced in this pass.** No
`archived` field — see the model note above.

### State changes (`ImagoState`)

- **Remove:** `styles: StyleEntry[]`, `prompts: PromptEntry[]`.
- **Add:** `library: ContextEntry[]` — the passive master catalog.
- **Add the linked sets** (ordered id lists over `library`):
  - `activeContextIds: string[]` — styles attached to the **next generation**
    (the "active context" tray). A style is "active" iff its id is here.
  - `quickPromptIds: string[]` — prompts surfaced in the **composer**
    quick-prompts list (a curated subset; the library holds all prompts).

`StyleEntry` / `PromptEntry` types are deleted. (References stay as
`refSelected` on `Variant` — images are a separate subsystem, but conceptually
the same linked-set idea.)

### Migration mapping

| Today                                         | → `ContextEntry` + sets                           |
| --------------------------------------------- | ------------------------------------------------- |
| `PromptEntry.label`                           | `name`                                            |
| `PromptEntry.text`                            | `content`                                         |
| `PromptEntry.id`                              | `id` (preserved); id pushed into `quickPromptIds` |
| `StyleEntry.name`                             | `name` (and mint a deterministic id)              |
| `StyleEntry.description`                      | `content`                                         |
| `StyleEntry.image` / `imagePath` / `captured` | same fields                                       |
| `StyleEntry.active === true`                  | id pushed into `activeContextIds`                 |

Note: every migrated prompt is linked into `quickPromptIds` so existing prompts
keep showing in the composer (no surprise disappearance).

### `defaultState()` seeding

- 3 default prompts → `ContextEntry` `kind:"prompt"`, **stable ids preserved**
  (`describe`/`palette`/`lighting`), and **all three linked into
  `quickPromptIds`** (they show in the composer as today).
- 6 default styles (anime/painterly/photoreal/3d/watercolor/line art) →
  `ContextEntry` `kind:"style"`, **deterministic name-derived ids** (e.g.
  `style-anime`) so seeding is reproducible across calls/restores, **none
  active** (`activeContextIds: []`).
- Arrays deep-copied per call (unchanged invariant).

### Restore migration (legacy snapshots)

In the `if (restored)` block, **before** existing materialization:

1. For each legacy `state.styles[]`: build a `kind:"style"` `ContextEntry` (mint
   deterministic id; carry description→content, image/imagePath/captured); if
   `active === true`, push the new id to `activeContextIds`.
2. For each legacy `state.prompts[]`: build a `kind:"prompt"` `ContextEntry`
   **reusing the prompt's id**, and push that id to `quickPromptIds`.
3. `delete state.styles; delete state.prompts;` initialize `library`,
   `activeContextIds`, `quickPromptIds` if absent (old snapshots predating
   this).

Mirror of the refs-as-assets id-preserving migration.

### `leanState` projection (agent view)

- Strip `ContextEntry.image` data-url, keep `imagePath` + all metadata (same as
  today's `style.image` strip).
- `activeContextIds` passes through verbatim so the agent knows the standing
  set. `quickPromptIds` also passes through (cheap; lets the agent see the
  user's curated prompts).
- No archived-filtering needed (no archived state).

## Consumption sites & UX

Three sites, all linked sets over the one library.

> **Shared `LibraryPicker` component.** Linking is the same gesture everywhere
> (choose entries from the library to add to a set), so it's **one reusable
> picker UI** used across every link site — filtered to the site's default kind,
> excluding already-linked ids, emitting the chosen id(s). Where a surface also
> suits it (notably the bottom-drawer trays), **drag-and-drop from the library
> pane is an _additional_ input** on top of the picker — same `context.link`
> result either way.

### 1. Context library pane (new) — the master view

A browse/manage view of `library`, reached via the vertical switcher (below),
styled like `GenerationsRail`:

- **Kind facet pills** (icon-only, like the image filter pills): All / Prompts /
  Styles. (No "Archived" facet — there's no archived state.)
- **Entry cards:** name + content preview; styles show their identity image if
  present; a marker when the entry is linked into a site (active / in
  quick-prompts).
- **Actions:** edit (name/content/tags); **link into a site** (e.g. "add to
  quick prompts", or drag a style into the active-context tray); and **Delete**
  — the _only_ destroy, guarded by an inline confirm, removing the entry from
  `library` and from every set. This is the deliberate hard-delete; everyday
  removal happens at the sites via unlink.

### 2. Active-context tray (in the bottom drawer) — styles attached to next gen

The existing `ReferenceDrawer` already shows attached **image refs**. It gains a
mirrored **active-context tray** showing entries in `activeContextIds`: **drag a
style here from the library** to link (`context.link`); ✕ to unlink
(`context.unlink`). The old click-to-toggle "Styles" tab is removed — attachment
now flows through the same library → tray drag refs use.

### 3. Composer quick-prompts — curated prompt set

`QuickPrompts` reads the entries in `quickPromptIds` (resolved against
`library`). Pick → fills textarea (unchanged one-shot behavior). Two add paths
(the small bit of extra UI the linked model buys):

- **"+ New prompt"** — creates a `kind:"prompt"` `ContextEntry` _and_ links it
  into `quickPromptIds` in one step (so the common path feels identical to
  today).
- **"Link from library"** — pick an existing prompt (or, since kind isn't a hard
  wall, any entry) from the library to add to the quick-prompts set.

✕ on a quick-prompt → **unlink** (`context.unlink`), not delete — the prompt
stays in the library. Edit routes through `context.update`; true deletion
happens only in the library pane.

### Vertical library switcher (new)

A skinny, **non-expanding vertical icon rail** on the far left — a vertical tab
list, icons only — toggles the library pane between **Images** (the existing
`GenerationsRail`) and **Context** (the new library pane). Same pane
real-estate, two sources; a switcher, not a nav tree.

### Style capture

`style.capture` → renamed `context.capture` (capture a look from the focused
image). The agent answers with the `context.add` command (`kind:"style"`,
`link:"active"`), and the captured style is auto-linked into `activeContextIds`
(preserves today's "captured style becomes active").

## Contract changes

### Browser → server (`ClientToServer`)

Remove: `style.toggle`, `style.remove`, `style.capture`, `prompt.add`,
`prompt.update`, `prompt.remove`.

Add:

```ts
| { type: "context.add"; kind: ContextKind; name: string; content: string; tags?: string[]; image?: string; link?: ContextSet }
| { type: "context.update"; id: string; name?: string; content?: string; tags?: string[] }
| { type: "context.delete"; id: string }              // the ONLY destroy; guarded by UI confirm
| { type: "context.link"; id: string; set: ContextSet }    // add to a linked set
| { type: "context.unlink"; id: string; set: ContextSet }  // remove from a linked set (the everyday ✕)
| { type: "context.capture" }                         // capture a style from the focused image
```

where `type ContextSet = "active" | "quickPrompts"`. `context.add`'s optional
`link` links the new entry into a set in the same step (used by "+ New prompt" →
`"quickPrompts"`, and capture → `"active"`).

### Agent → server (`AgentCommand`, POST /cmd)

Remove: `style.add`, `prompt.add`.

Add:

```ts
| { type: "context.add"; kind: ContextKind; name: string; content: string; tags?: string[]; image?: string; link?: ContextSet }
```

Upsert semantics: for `kind:"style"`, upsert on normalized name (preserves
today's style upsert); other kinds id-keyed. `link:"active"` (capture flow)
pushes the entry id into `activeContextIds`. Server materializes `image` →
`imagePath`.

### Server handlers (`server.ts`)

- `context.add/update`: create/merge into `library`; honor optional `link`.
- `context.delete`: remove from `library` (the only destroy path), drop the id
  from `activeContextIds` **and** `quickPromptIds`, clean up `imagePath` on
  disk. Guarded by a UI confirm.
- `context.link/unlink`: add/remove id in the named set (idempotent). `link`
  validates kind-appropriateness softly (e.g. `"active"` expects a standing
  kind); it suggests, doesn't hard-reject, per the model — but v1 UI only offers
  sensible links.
- `context.capture`: emits the agent event (as `style.capture` does today).
- All broadcast state after mutating.

## Out of scope (this pass)

- **`skill` and `context` (world-context) kinds** — reserved in the union, not
  seeded/surfaced. Their behavior/sites get designed when added.
- **Projects / per-project context scoping** — the linked sets are the seam;
  Projects later scopes them. Separate backlog item.
- **Cross-kind linking UI** — the data model doesn't wall it off, but v1 only
  offers sensible links (styles → active tray, prompts → quick-prompts). No UI
  for linking a style into quick-prompts, etc.
- **Relationship graph between entries, bulk ops, import/export, search beyond
  simple filter** (StoryLoom had a relationship graph — YAGNI here).

## Testing

- **`state.test.ts`**: `defaultState` now seeds `library` (3 prompts with stable
  ids, all in `quickPromptIds`; 6 inactive styles) and an empty
  `activeContextIds`; `leanState` strips `ContextEntry.image` (keeps
  `imagePath`) and passes both sets through. Remove old `styles`/`prompts`
  assertions.
- **`server.integration.test.ts`**: replace the `style.*` / `prompt.*` suites
  with `context.*`: add (with/without `link`) → update → link → unlink (id
  leaves the set, entry stays in `library`) → delete (gone from `library`
  **and** both sets); link/unlink idempotency; agent `context.add` upsert
  (style-on-name) + `link:"active"`.
- **Migration test**: a legacy snapshot with `styles` (one `active:true`) +
  `prompts` restores into `library` with prompt ids preserved (and present in
  `quickPromptIds`), style ids minted, the active style's id in
  `activeContextIds`, and no leftover `styles`/`prompts`.
- **Surface unit tests** where pure helpers exist (kind filtering of the pane,
  resolving a set's ids against `library`); drag-to-link is exercised live
  (DOM), as with the refs drawer.

## Resolved build decisions (from spec review)

- **Drawer layout:** one drawer with two mirrored **sections** (image refs +
  active context), not tabs.
- **"Link from library" affordance:** a **universal `LibraryPicker`** component
  reused across every link site, **plus** drag-and-drop from the library pane as
  an additional input where it fits (the bottom-drawer trays). See the shared
  component note under Consumption sites & UX.
- **Tags in v1:** store + filter + display only — no editing affordance yet.
