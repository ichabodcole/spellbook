---
type: write-up
title: Vocabularies for short-lived sessions
description:
  Where profiles and relation vocabularies come from for Scriptorium's
  short-lived sessions. Recommends four layers, nearest winning (the folder's
  own, the repo's up to the git root, a global user folder, and built-in packs
  attached by a marker file), and a kit hook shared with Story Studio. Cole
  ruled on 2026-11-24: as recommended, but the folder is @scriptorium.
tags: [scriptorium, profiles, relations]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Vocabularies for short-lived sessions

**Outcome:** Decided, 2026-11-24. See [Decided](#decided).

---

## Question

Where should Scriptorium's profiles and relation vocabularies come from, so that
a session that doesn't last, gathering files from anywhere, has the right
definitions without an agent writing them each time? Should Scriptorium adopt
Story Studio's single project folder instead of `_meta/`?

The answer decides where
[frontmatter-chip-editing](../frontmatter-chip-editing/item.md) gets its allowed
values, and settles the location question that
[scriptorium-skill-relations-file-location](../scriptorium-skill-relations-file-location.md)
was folded into.

## Current State

### Our kit

- **Where profiles are read.** `src/kit/workspace/profiles.ts` reads
  `_meta/profiles/<kind>.json` (`META_DIR`, `PROFILES_DIR`, lines 64–68). A
  document's frontmatter `type` names the kind. The header comment (lines 18–26)
  gives the rule: look in the document's own folder, then each parent, "up to
  the root of the context entry that holds the document and NEVER above it, so a
  profile outside the folder the user opened cannot leak in". The first file
  found wins, whole.
- **The walk.** `profileFolders(dir, root)` (lines 552–560) returns `[]` when
  `dir` is outside `root`. Otherwise it stops at `root`. `ProfileLookup.match`
  (lines 782–799) uses it.
- **`$ref` is bounded too.** A `$ref` that resolves outside the entry root
  breaks the kind: "outside the folder the human opened" (lines 728–732).
- **What a profile can say.** It is a small subset of JSON Schema: `type`,
  `enum`, `const`, `minLength`, `description` and `required` (lines 50–57).
  There are no transitions or ordering. Every result is a warning; nothing
  blocks a save.
- **Relations.** `src/kit/workspace/relations.ts` reads
  `_meta/profiles/_relations.json` (`RELATIONS_FILE`, line 52; `fileIn`, lines
  211–217). It uses the same `profileFolders` walk, so it never goes above the
  entry root either (`RelationsLookup.at`, lines 301–317). The nearest
  definition wins per relation, not per file (lines 27–32).
- **Where the root comes from.** The session hands the walk `entry.root`
  directly: `lookup.match(dirname(path), entry.root, facts.type)`
  (`src/kit/workspace/session.ts:7143`), and
  `lookup.at(dirname(path), entry.root)` (`session.ts:6540`). For a single file,
  `entryForPath` makes a `listed` entry whose root is **the file's own folder**:
  `root: dirname(abs)` (`src/kit/workspace/tree.ts:645–646`). Only a folder
  added as a set gets its own path as the root (`tree.ts:622–623`).
- **No app hook.** Our kit has no seam where an app can widen or narrow that
  root. Story Studio's kit has one (below).

### Scriptorium

- **No profiles of its own.** It registers none, and its skill never says where
  a profile file goes. `plugins/spellbook/skills/scriptorium/SKILL.md` mentions
  only the `profile` verbs and the doctor's `profiles.*` findings (lines 174,
  208, 242, 259).
- **The UI gets profiles for free.** `DocumentPane` passes the daemon's answer
  to the header (`src/kit/document/DocumentPane.tsx:2280`). The daemon answers
  the `profile` op from `session.documentProfile`
  (`src/kit/workspace/server.ts:4086–4087`, `session.ts:7324`).
  `FrontmatterHeader` then labels the `type` chip and adds the warning chip
  (`src/kit/document/FrontmatterHeader.tsx:254–257`; `profileHeader.ts:19–25`).
  So the moment a profile resolves, Scriptorium's header uses it. Today none
  ever does.
- **`meta-set` checks nothing.** `metaSet` in
  `src/scriptorium/backend/kit/wiki.ts:311–326` checks only that a key is
  well-formed, then writes any string. Profiles never block a write.
- **Git roots.** `gitRootOf` (`src/scriptorium/backend/kit/gitRoot.ts:8–16`)
  finds the working tree by a `.git` entry, files included. It is already used
  for the move plan (`wiki.ts:350–358`).
- **A global home exists.** `$SCRIPTORIUM_HOME`, by default `~/.scriptorium`
  (`src/scriptorium/backend/kit/app.ts:46–48`), holds `sessions/` and the global
  `prefs.json` (`src/kit/workspace/server.ts:1053`;
  `src/scriptorium/surface/prefsStorage.ts:7`).

### This repo's vocabulary

- **It lives in code.** This repo's `docs/` has no profile files. Its vocabulary
  is in `scripts/pdocs/lint/registry.ts`:
  - item states (lines 30–38) and feature states (line 42);
  - `kind` and `priority` (lines 60–71);
  - cycle lifecycles (lines 104–108);
  - plan, design-resolution and test-plan lifecycles (lines 590–592).
- **Status.** The OKF `status` set (`draft | stable | deprecated`) is
  `OKF_STATUS` in `scripts/pdocs/lint/rules.ts:407`.
- **Transitions.** `pdocs set` enforces the transitions between states. No
  profile can express them.
- **Per-repo changes.** A repo can add types in `.project-docs.json` under
  `lint.types`. This one adds `release`, `memory` and `lesson`.

### Story Studio's `@studio` model

Story Studio is at `~/Projects/dreamwood/story-studio`, read at `80262894`.

- **The folder.** `@studio/` (`STUDIO_FOLDER`,
  `packages/kit/src/lib/studioFolder.ts:34`) replaced both `_project.md` and
  every `_meta/`.
  - At the project's root it is a protected bundle. It holds `project.md` (id,
    title, tags, description, thumbnail and settings) and `profiles/` (kinds,
    `_relations.json`, `_markers.json`, `_world.json`), as described in
    `studioFolder.ts:1–25`.
  - In a deeper folder, `@studio/` holding only `profiles/` "layers vocabulary
    and fences nothing" (lines 20–25).
  - Cole chose one name everywhere, "as in Operator", then shortened it to
    `@studio` (commit `c9505695`: the cycle log and the `kit-project-bundle`
    item). It landed in `f09d9225`.
  - Opening an old project moves each `_meta/` into `@studio/` once
    (`packages/kit/src/workspace/studioMove.ts:1–24`).
- **`conventions.md` is not an app file.** It is a user document that sits in
  `@studio/` (Cole's `lucid-dream-codex` world has one). No code reads it; the
  only mention in code is a link in a test
  (`plugins/canvas/surface/cards.test.tsx:569`).
- **The walk.** It is the same algorithm as ours, under another name.
  `profiles.ts:20–28` and `foldersUpTo`
  (`packages/kit/src/workspace/foldersUp.ts:10–18`) stop at the root and never
  go above it.
- **The difference is where the root comes from.** Story Studio's profile pass
  calls
  `lookup.match(dirname(path), this.hooks.conventionRoot(entry.root), facts.type)`
  (`packages/kit/src/workspace/session/profiles.ts:115`). Its relations and
  markers do the same (`session/relations.ts:175`, `session/markers.ts:58`).
  - `Places.conventionRoot` (`session/places.ts:698–709`) **lifts the root to
    the project's folder** for any entry inside it. Its comment: "so a world set
    as the workspace keeps its conventions for the top folders at its top …
    Never above either (the user's call of 2026-10-13)."
  - So Story Studio already lets an app widen the walk past the entry root, up
    to a boundary the app chooses. It is a hook the kit takes.
- **Libraries.** Story Studio's draft linked-library-content write-up
  (`docs/items/linked-library-content/write-up.md` there) ("The library's
  `@studio` vocabulary: today the wrong one applies") rules that a linked
  library's documents use the library's vocabulary, not the consuming project's
  ("Blender's rule"). It is the same question as ours, of which boundary a walk
  stops at, from the other side.
- **The hidden-patterns setting** (`a18ead90`,
  `packages/kit/src/lib/hidden.ts:1–39`) layers built-in (`DEFAULT_HIDDEN`),
  then app (`hidden.patterns` pref), then project (`hidden:` in
  `@studio/project.md`). The nearest level wins **whole**. Guards that protect
  the user stay in code, not in a list.

## Findings

### 1. Scriptorium sessions never see a profile today (High)

**Evidence.** We read every manifest in `~/.scriptorium/sessions/` on 2026-11-17
(116 sessions with context, 14 September to 17 November):

| What                                                                  | Entries |
| --------------------------------------------------------------------- | ------: |
| All context entries                                                   |     847 |
| `listed` (single files, root is the file's own folder)                |     828 |
| `mirrored` (a folder added as a set)                                  |      19 |
| Under a repo with `.project-docs.json` (OKF docs, `pdocs` vocabulary) |     813 |
| Scratch or temp folders                                               |      19 |
| Elsewhere                                                             |      15 |

The 15 elsewhere include old `-wt` worktrees of pdocs repos that are gone from
disk, two folders under `~/Documents/Spellbook`, one Story Studio world
(`~/Documents/Operator/Hollowbrook`) and one backup folder.

We also searched `~/Projects` for profile folders, leaving out fixtures, tests,
`node_modules` and worktrees:

- **`_meta/profiles/`: none.**
- **`@studio/profiles/`: one**, in a Story Studio world
  (`Story_Worlds/lucid-dream-codex`, 13 kinds and four `_` files).

**Significance.** Almost every entry is one item file or one cycle file, and its
root is its own folder (`docs/items/foo/`). The walk stops there. So even a
`docs/_meta/profiles/item.json` would never be read for it. "Write the profile
once in the repo" cannot work under today's guard. And the session would have to
recreate the profile beside each opened file, which is exactly what Cole doesn't
want.

### 2. The common case is one shared, known vocabulary (High)

About 96% of entries are pdocs documents: items, write-ups, cycles, features and
plans. They come from five or more repos (Spellbook, story-studio, project-docs,
image-farm, meshmash, pedir, operator-mono), and every one carries a
`.project-docs.json`.

Their vocabulary is the same everywhere (`registry.ts`, `rules.ts:407`). It
already exists as code, and Spellbook vendors that code in `scripts/pdocs/`. A
repo's own additions (`lint.types`) are new types, not new values for the shared
fields.

So one built-in pack, attached wherever `.project-docs.json` is found, covers
almost every real session with nothing written by anyone.

### 3. A profile is keyed by `type` alone, so a pack must be scoped (High)

`type: item` means a pdocs item in a repo, but could mean anything in someone's
notes. A pack applied everywhere would warn wrongly outside pdocs repos.
Matching on the frontmatter (does it look like a pdocs item?) is guesswork.

A **marker file** is not. `.project-docs.json` at a folder above the document is
the repo saying it uses the vocabulary. It is the same file `pdocs` itself reads
to decide it is in a docs repo (exit 5 when it is missing).

### 4. The "never above" guard was written for a world, not a session (Medium-high)

The guard's reason, "a profile outside the folder the user opened cannot leak
in" (`profiles.ts:22–23`), protects a world opened as a set. In that case the
set is the world, and a folder above it belongs to someone else.

Scriptorium opens files, not worlds. For a listed file, the folder "the user
opened" is just where the file happens to sit. The same repo's conventions are
not a leak.

Story Studio already relaxed the guard, through `conventionRoot`, for the case
where its own boundary is larger than the entry. Cole ruled on that on
2026-10-13. The git root is Scriptorium's natural equivalent:

- it is one owner's tree, already used as a boundary by the move plan
  (`wiki.ts:350–358`);
- it is never above a repo, so a profile in `~/` or `~/Projects/` cannot leak
  in.

### 5. Cole's global-settings ruling argues for a global user layer, not per-session picks (Medium)

Cole ruled on 2026-11-17 that Scriptorium's settings are global, because "a
session is short, not a project you live in"
([kit-agent-modes-and-autosave](../kit-agent-modes-and-autosave.md)).

The same reasoning applies here. A pack chosen at each `open` is a choice made
again every session, which is the cost Cole wants gone. A global folder
(`~/.scriptorium/profiles/`) is written once and applies to every session, like
`prefs.json` beside it.

The ruling does not argue against the repo layer. A repo's vocabulary is a fact
about its files, not a preference, and it travels with the repo.

### 6. The folder's name has a real cost on one side only (Medium)

- **Moving off `_meta/` costs nothing.** No real `_meta/profiles/` exists
  (Finding 1).
- **Keeping it has a cost.** Story Studio worlds now keep their vocabulary in
  `@studio/profiles/`. A Scriptorium session over a Story Studio world, such as
  the Hollowbrook entry, sees none of it today.
- **The kits drift.** Ours says `_meta`, theirs says `@studio`. Every later port
  of `profiles.ts` or `relations.ts` carries the rename by hand.

Against `@studio`: the name says "studio", and a repo's `docs/@studio/` is
Scriptorium's, not Story Studio's. But Scriptorium is a sibling app on the same
kit, and Cole picked one name "everywhere, as in Operator". The name of the
folder matters less once the built-in and user layers carry the common case. Few
people will ever write one.

_Cole ruled the other way on 2026-11-24: the folder is `@scriptorium/`, since
`@studio` is Story Studio's own name. See Decided._

What Scriptorium should **not** take is the project half: `project.md`, the
pinned bundle and the project surface. Scriptorium has no project to describe.

### 7. Profiles express values, not transitions (High)

A profile's `enum` gives the chip dropdown its values (`profiles.ts:317–322`).
There is no way to say "`review` follows `active`". Order and transition rules
stay with `pdocs set`.

For [frontmatter-chip-editing](../frontmatter-chip-editing/item.md), the profile
supplies the list of values. Whether a chosen value is a legal move is that
item's question, perhaps answered by calling `pdocs set` in a pdocs repo. JSON
Schema keeps the `enum` in the file's order, so a pack can list the states in
their lifecycle order and the dropdown can show them that way.

### 8. Relations have no common pack yet (Medium)

pdocs documents relate through fields (`parent`, `blocked_by`, `related:`), not
through `?rel=` links. So a built-in project-docs pack has kinds but no
`_relations.json`.

Relation words Cole uses across sessions belong in the user layer
(`~/.scriptorium/profiles/_relations.json`). A world's own relation words come
from its folder (`@scriptorium/profiles/_relations.json`). The per-relation
merge (`relations.ts:27–32`) already layers them.

## Options

The candidate sources, and how each serves the three real uses:

- **OKF docs**: a pdocs repo, opened as single files, which is the 96% case.
- **Loose notes**: a folder or files with no repo marker.
- **A world**: a Story Studio world opened as a set.

| Source                                                 | OKF docs in a repo                                         | Loose notes                                        | A world folder                  | Written by                     | Cost                                 |
| ------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------- | ------------------------------- | ------------------------------ | ------------------------------------ |
| A. Built-in packs, attached by a marker                | **Covers it**, with no files                               | Nothing (no marker)                                | Nothing                         | Us, once; tested against pdocs | Small: pack files and a marker check |
| A'. Built-in packs, applied everywhere                 | Covers it                                                  | **Wrong warnings** on any `type: item`             | Can clash with a world's kinds  | Us                             | Small, but wrong                     |
| B. User library chosen at `open` (`open --profile p`)  | Covers it if picked each time                              | Covers it if picked                                | Redundant                       | Cole or the agent, per session | The recreation cost Cole wants gone  |
| B'. One global user folder, `~/.scriptorium/profiles/` | Can, but duplicates A                                      | **Covers it**: Cole's own kinds and relation words | Underneath the world's own      | Cole, once                     | Small: one more folder in the walk   |
| C. The repo's own folder, up to the git root           | Covers it if the repo writes one (or `pdocs` generates it) | Only inside a repo                                 | Works if the world is a repo    | Each repo, once                | Lifts the guard (Finding 4)          |
| D. The folder's own, up to the entry root (today)      | **Never reached** for a listed file (Finding 1)            | Only as a set                                      | **Covers it**: a world as a set | Per folder                     | None, as it is                       |
| Mix: D, then C, then B', then A, nearest winning       | A, overridable by the repo                                 | B'                                                 | D                               | Nobody, in the common case     | The sum, all small                   |

How a pack is attached:

| Attachment                                       | For                                   | Against                                                           |
| ------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------- |
| At `open` (`--profile`)                          | Explicit                              | A choice made again every session; agents forget it               |
| A verb (`profiles attach <pack>`)                | Can fix a session after the fact      | The same, per session; it is state on an ephemeral session        |
| Auto by marker file (`.project-docs.json` above) | Zero effort; the repo declares itself | Needs one marker per pack; a repo without the marker gets nothing |
| Auto by matching frontmatter                     | Zero effort                           | Guesswork: `type: item` is not proof (Finding 3)                  |

## Recommendation

**Layer four sources, nearest winning per kind and per relation, as the kit
already does within one walk.** Confidence: medium-high.

| Order (nearest first) | Source                                                        | Bounded by                                                            |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1                     | The folder's own `@scriptorium/profiles/`, from the folder up | The convention root (below)                                           |
| 2                     | The same walk, continued above the entry root                 | The git root, when the entry is inside one; else the entry root       |
| 3                     | The user's global folder, `$SCRIPTORIUM_HOME/profiles/`       | One folder, always in force                                           |
| 4                     | Built-in packs, each attached by its marker file              | Only where the marker is found, between the document and the git root |

Layers 1 and 2 are one walk with a higher stopping point.

**The calls the DoD asks for:**

1. **The layering.** As in the table. Within a layer the rules stay as they are:
   a nearer kind file wins whole, and a broken one still wins and matches
   nothing. A relation is decided per relation. The UI already names the file a
   profile came from (`profileSourceTitle`, `profileHeader.ts:41–45`). A
   built-in one shows as `built-in: project-docs/item.json`, so a surprising
   warning can always be traced.
2. **Above the opened entry: yes, to the git root and no further.** Do it as
   Story Studio does, with a `conventionRoot(entryRoot)` hook the kit takes and
   the app supplies:
   - Scriptorium supplies `gitRootOf(entryRoot) ?? entryRoot`.
   - Story Studio keeps its workspace lift.
   - `$ref` keeps its rule against the same lifted root.
   - The guard against leaking from outside stays. Only its boundary moves, to
     one that fits a session over files.
3. **The folder's name: `@studio/profiles/`** _(overridden: Cole chose
   `@scriptorium/profiles/`, see Decided)_, read in place of `_meta/profiles/`.
   Take the vocabulary folder only, not `project.md` or the project bundle.
   Reading `_meta/profiles/` as a fallback for one release is cheap if Cole
   wants it, but no real file needs it.
4. **How a pack is attached: automatically, by a marker file. No `open` flag and
   no verb.**
   - The first pack is `project-docs`, attached when `.project-docs.json` is
     found between the document and the git root. It holds:
     - `item`, `feature`, `cycle`, `write-up`, `plan`, `design-resolution`,
       `test-plan`, `session` and `report` kinds;
     - `status` as the OKF enum, `lifecycle`, `kind` and `priority` as enums,
       listed in workflow order.
   - A ward test pins the pack to `scripts/pdocs/lint/registry.ts` and
     `rules.ts`, so the two cannot drift silently.
   - Anything Cole wants everywhere else goes in the global folder, written
     once. That is his global-settings ruling applied to vocabularies.

**What it means for kit parity.**

- The reader files (`profiles.ts`, `relations.ts`) converge with Story Studio's
  on the `conventionRoot` hook. The folder name stays different on purpose
  (`@scriptorium` against `@studio`), so the kit takes it from the app and the
  readers stay one shared copy.
- The new parts (the global layer and marker-attached packs) are a list of extra
  fallback folders the kit takes from the app, consulted after the walk. Story
  Studio could use the same hook for an app-level vocabulary, as `hidden.ts`
  does with its built-in, app and project levels.
- The one real difference stays a policy, not a fork. Scriptorium bounds the
  walk at the git root; Story Studio bounds it at the project.

**When to reconsider.**

- If sessions start opening whole folders more than files, the git-root lift
  matters less.
- If Cole's notes outside repos grow their own conventions, a second marker (say
  `.scriptorium.json`) could attach a user pack by folder.

## Decided

Cole, 2026-11-24, on the five decisions below:

1. **Layering: as recommended.** Four layers, nearest winning.
2. **Above the opened entry: as recommended.** Up to the git root, through a
   `conventionRoot` hook.
3. **Folder name: `@scriptorium/profiles/`**, not `@studio/profiles/`. `@studio`
   is tied to Story Studio's name, as its app folder. What it costs, knowingly:
   a session over a Story Studio world does not see that world's
   `@studio/profiles/`, and each port of `profiles.ts` or `relations.ts` carries
   the rename. The kit should take the folder name from the app, so the two apps
   share the reader and differ only in the name they pass.
4. **Attaching a pack: by marker file, as recommended, also reading
   `docsRoot`.** The `project-docs` pack attaches when `.project-docs.json` is
   found between the document and the git root. Scriptorium only reads that
   file; it never creates or writes it. The file's `docsRoot` (default `docs`)
   bounds the pack to documents under that folder, so a `type: item` file
   elsewhere in the repo gets nothing from it. `lint.types` is not read for now.
   Anything Scriptorium owns lives under `@scriptorium/` or `~/.scriptorium/`.
5. **Global layer: build it now**, at `$SCRIPTORIUM_HOME/profiles/`.

## Next Steps

1. ~~Cole rules on the decisions below.~~ Done, see Decided.
2. ~~File the build items.~~ Done, 2026-11-24, both `--from` this item:
   - [kit-profile-layers](../kit-profile-layers.md): the `conventionRoot` hook,
     the extra layers and the app-named folder. Blocked by the kit split, which
     moves the two readers.
   - [scriptorium-vocabulary-layers](../scriptorium-vocabulary-layers.md): the
     git-root lift, the global layer, the `project-docs` pack bounded by
     `docsRoot` with its ward test, and the SKILL. Blocked by the kit item.
3. [frontmatter-chip-editing](../frontmatter-chip-editing/item.md) can now be
   researched. Its values come from `documentProfile`, whatever layer resolved
   it; its build items, when filed, are blocked by the two above.

## Open Questions

- **The doctor's reach.** Should `profiles` and the doctor list built-in and
  global files beside the world's? We suggest yes, marked by layer, so "where
  did this warning come from" always has an answer.
- **A dropdown for a field with no `enum`.** Should a user add one in the global
  layer, or is a free-text field simply not a dropdown? That is for the chip
  item.
- **Transitions.** Profiles cannot express them (Finding 7). Should a chip
  change in a pdocs repo go through `pdocs set`, so its transition checks apply?
  That is for the chip item.
- **Library vocabulary in Story Studio.** Story Studio's
  `linked-library-content` ruling (a library's documents use the library's
  vocabulary) would change `conventionRoot` per document, not per entry. If it
  lands there, our hook should take the document's path, not the entry root, to
  stay portable.

**Sources consulted:**

- Our kit: `src/kit/workspace/profiles.ts`, `relations.ts`, `session.ts`,
  `tree.ts` and `server.ts`; `src/kit/document/FrontmatterHeader.tsx`,
  `profileHeader.ts` and `DocumentPane.tsx`.
- Scriptorium: `src/scriptorium/backend/kit/wiki.ts`, `gitRoot.ts` and `app.ts`.
- pdocs: `scripts/pdocs/lint/registry.ts` and `rules.ts`.
- Story Studio at `80262894`:
  - `packages/kit/src/lib/studioFolder.ts` and `lib/hidden.ts`;
  - `packages/kit/src/workspace/profiles.ts`, `foldersUp.ts` and
    `studioMove.ts`;
  - `packages/kit/src/workspace/session/places.ts`, `session/profiles.ts`,
    `session/relations.ts` and `session/markers.ts`;
  - commits `c9505695`, `f09d9225` and `a18ead90`;
  - the `linked-library-content` write-up.
- `~/.scriptorium/sessions/*/manifest.json` (116 sessions), and a search of
  `~/Projects` for profile folders.

## Decisions for Cole

_Ruled on 2026-11-24; see [Decided](#decided)._

1. **Layering.** Should vocabularies come from four layers, nearest winning: the
   folder's own, then the repo's up to the git root, then a global
   `~/.scriptorium/profiles/`, then built-in packs? _Recommended: yes._
2. **Above the opened entry.** May the lookup go above the entry the human
   opened, as far as the git root and never further? _Recommended: yes, through
   a `conventionRoot` hook like Story Studio's._
3. **Folder name.** _(Overridden: `@scriptorium/profiles/`.)_ Should the kit
   read `@studio/profiles/` in place of `_meta/profiles/`? _Recommended: yes,
   the vocabulary folder only; no `project.md` or project bundle in
   Scriptorium._
4. **Attaching a pack.** Should a pack attach automatically by its marker file
   (`.project-docs.json` for the `project-docs` pack), with no `open --profile`
   flag or verb? _Recommended: yes._
5. **Global layer.** Should a global user folder exist now, or wait for a real
   need outside pdocs repos? _Recommended: build it now. It is small, it is
   where Cole's relation words go, and it follows his global-settings ruling._
