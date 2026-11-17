---
type: write-up
title: Story Studio document UX, since the last scan
description:
  What Story Studio has shipped since 2026-10-12 that Scriptorium and Spellbook
  should take, take later or skip, across document UX, the agent's side, CI,
  tests, the daemon and process.
tags: [scriptorium, story-studio, ux, kit, ci]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Story Studio document UX, since the last scan

**Outcome:** Decided by Cole on 2026-11-17; follow-up items filed.

---

## Question

Which document-UX changes has Story Studio made since the 2026-10-12 scan that
Scriptorium should take, take later, or skip? The answer decides which items to
file for the next feature cycle.

In scope: the UI and interaction patterns Scriptorium shares with Story Studio.
That means the document pane, versions, notes, chat, the right column, the tree
and navigation. Out of scope:

- Story Studio's own areas: projects, boards and canvas, stages, audio and
  packaging.
- Kit bug fixes, which come back over `kit-parity`.

**Widened (Cole, 2026-11-17).** Story Studio has changed more than its document
UX, and not everything worth taking is something he remembers. For example, it
shards its CI test run, and it has an activity log. So the scan also sweeps its
git history since 2026-10-12 for anything general-purpose: CI and tests,
tooling, process and conventions, and the daemon. Those candidates get the same
three calls.

## Current State

- **Story Studio** lives at `~/Projects/dreamwood/story-studio`. It has made 966
  commits since 2026-10-12: 638 docs, about 330 code.
- **The last scan** was
  [What to take back from Story Studio](../_archive/story-studio-port-back/write-up.md).
  Anything it decided, this scan doesn't repeat.
- **The paradigms are diverging.** Story Studio is built around plugins and
  projects. Scriptorium's sessions are short, open on sets of folders, and have
  no home project. Each candidate is judged against Scriptorium's model.
- **The kits have drifted in shape.** Story Studio split its kit on 2026-11-07
  and 08: `protocol/*`, `session/*`, `daemon/*` (about 30 files),
  `verbs/rows/*`, and WorkspaceShell and DocumentPane each into a handful of
  files. Ours are still single files (`session.ts` 9,040 lines, `server.ts`
  5,357, `WorkspaceShell.tsx` 2,341, `DocumentPane.tsx` 2,405). The UI leaves
  are still close (`ChatComposer` about 37 lines apart, `HistoryArrows` 21), but
  anything with a daemon, verb, shell or pane half is a rewrite by hand, not a
  cherry-pick, until
  [kit-split-oversized-modules](../kit-split-oversized-modules.md) catches us
  up.

## Findings

Four read-only researchers on 2026-11-17: the inbox, versions and notes; the
shell, right column and navigation; chat and the agent's side; and a general
sweep of the git history. Commits are Story Studio's.

### Already ours

The whole composer cycle (floating composer, per-note waiting, the focused-note
highlight, the late-edit guard, via and refs), note-reply staying on its note,
and `--body-file` on most verbs. Our composer is ahead in places ("Ask the
agent" on a stuck note). Story Studio's search grouping and the composer's "You"
echo are back-ports of ours.

### Document UX: take

| #   | Candidate                                                                                                                                  | Evidence                                                   | Size         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------ |
| U1  | **Leave an agent version** without taking it: it stays in history and leaves the inbox                                                     | `221163b6`; `version.leave`, a `left` mark                 | small–medium |
| U2  | **The inbox**: a top-bar button and popover, "For you" and "With the agent"; each row opens its thing and carries its acts                 | `98e34890`, `3539a3e1`; kit `shell/inbox.ts` (pure)        | large        |
| U3  | **One row per document's agent versions**; taking v5 settles v2–v4. Port the final rule: Story Studio got it wrong twice in review         | `523e4834`                                                 | small, in U2 |
| U4  | **Owed notes go to the inbox**; the Notes panel speaks only for its own document. Removes our `notes-elsewhere` box; keep our rail mark    | `365f91ea`                                                 | small        |
| U5  | **Back and Forward through what you opened**, with arrows and keys (⌃- / ⌃⇧- on a Mac); Back returns to your place in the document         | `27589601`, `352133db`, `33d7d81d`; `navHistory.ts` pure   | large        |
| U6  | **Raw undo survives a trip to the rendered view and back**                                                                                 | `92e657ed` (`historyField`)                                | small–medium |
| U7  | **new-doc holding the agent's text** (`--body-file`/`--stdin`), so there's no empty v1 to activate. Our `doc.create` op already takes text | `a5eeb703`                                                 | small        |
| U8  | **Activity tab**: the daemon's records (made, moved, renamed, activated) leave chat for their own list; the agent's tail is unchanged      | `a5174d51`; `lib/messageSide.ts`, `chat/ActivityPanel.tsx` | medium       |
| U9  | A quiet background `--once` tail, if ours turns out to be noisy (check first)                                                              | `74eae9ec`                                                 | small        |

Two more are already filed: the right-click away from the selection (#146, in
this cycle) and the link inserted mid-word (#147).

U1 to U4 belong together, in that order: Story Studio did U1 first so the
inbox's count can always go down. The inbox belongs **in the kit**, opt-in per
spell, with Scriptorium first: every kind it keeps comes from the kit's own
snapshot, and apps add rows through a slot. Keep only the kinds Scriptorium has
(notes for you, notes owed, agent versions, relink, the message waiting); drop
asks and replies in other chats. U1 overlaps the backlog's
`scriptorium-keep-only-active-version` and
`scriptorium-eager-or-lazy-versioning`; decide them together.

### Document UX: take later

- **Icon tabs** in the right column (`416160b2`, `80cfe342`). They don't depend
  on Story Studio's per-type columns, so the icons work on our column alone.
  Three text tabs aren't crowded; they pay off once the Activity tab adds a
  fourth. They must port with U4, or the Notes dot stops covering owed notes
  elsewhere.
- **Autosave**, with Save and Revert shown only for what it won't write, and
  Save As (`188b5d41`, `d23ba145`). Whether a reviewer's typing should save by
  itself is Cole's call. Meanwhile: hide the Save and Revert buttons when clean
  rather than disabling them.
- The URL mirroring the open history (helps a reload; a session's port dies with
  it).
- `version-new --many` (`67948375`), one tail event per bulk call (`5d3a0ec9`),
  one prose reader for every verb (`44782ba0`, breaking: removes `--text-file`).
  Ride the kit split.
- Failed tasks with Dismiss in the inbox. Scriptorium rarely runs tasks.
- Chat links resolved against a fixed root (`a5174d51`). Reproduce first; likely
  a `kit-parity` fix.
- Copy a document or folder with its links following (`4f1ddee3`); Mermaid and
  images wherever a document is drawn (`a65ec055`). Listed, not studied.

### Document UX: skip

- **Ask and Auto modes**, the ask dialog and the allow list (`5d3a0ec9`,
  `dd1ee44e`). Scriptorium's agent proposes and the human takes, which is Ask.
  See the general sweep below for the case for researching it kit-wide.
- **Order by hand** (`8c61d510`). It writes `.order` files into the folders
  Scriptorium opens, which are often other repos.
- **Several chats per session** (`1f1172b3`). Sessions are short. This also
  makes `kit-note-replies-only-in-open-chat` moot.
- Links that outlive a launch, and Copy link (`4dcf1141`): they need Story
  Studio's always-running service.
- Undo and redo arrows in the header (they'd sit beside the context's arrows);
  submenu slots; map, board and stage rows.

### General: take

| #   | Candidate                                                                                                                                          | Evidence                         | Size         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------ |
| G1  | **`check:linux`**: run CI's Linux check locally in Docker (`git archive HEAD` into `oven/bun`), or over SSH. Answers "local green is not evidence" | `89abe47b`, `e8d578ee`           | small        |
| G2  | **Typecheck in the gate.** We have a `tsconfig.json` but nothing runs `tsc`. Size the backlog of errors with one run first                         | Story Studio's `check`           | small–medium |
| G3  | **A per-daemon page key**: the page's socket and `/fs` routes need a key, so an agent's plain `curl` can't act as the human. We check Origin only  | `1d7b4d29`                       | medium       |
| G4  | **Stale-build detection**: a daemon running old code after an upgrade says so on the page and in `tail`                                            | `3a945b58` (adapt per daemon)    | medium       |
| G5  | **A per-test-file TMPDIR** in the test preload; Story Studio's shared temp folder had grown to 45,682 entries and slowed daemon boots              | `31adf7bb`                       | small        |
| G6  | **A lint rule against `toBeNull` on DOM queries** (Bun's passes on a live element), with the kit's `expectNull`                                    | `460f8290`                       | small        |
| G7  | **A 1,200-line file limit** in Biome, with frozen per-file overrides that can only shrink. Belongs to the kit split                                | `360e67eb`                       | small        |
| G8  | **Two more root guards**: refuse the disk root and `$HOME` as a set                                                                                | `28376008`, `d24aca16`           | small        |
| G9  | **An implementing-a-branch playbook**: the gate lock, the load check, the missing-hook trap in a new worktree, pure-refactor rules                 | `implementing-a-branch-playbook` | small        |
| G10 | **Running-a-cycle and release playbooks**: carried-forward lists, sorting lessons at close, checking research follow-ups are filed                 | Story Studio's playbooks         | small        |
| G11 | The test-speed notes Story Studio wrote for other playbooks (lost watcher writes, `--rerun-each`)                                                  | `2026-10-test-speed`             | small        |

### General: take later

- **Sharded CI** (`1376e1b5`, `f706c1a7`). Story Studio shards because one run
  hit about 9.7 GB on the 2-core runner, not for speed. Ours (491 files, about 5
  minutes) passes. Adopt it on our first shut-down runner. Add the memory
  sampler (`free -m` every 30 s) now: one line, and a silent shutdown becomes
  evidence.
- **Ask and Auto modes, kit-wide, as research.** A co-presence primitive every
  spell could use; it needs Cole's product call.
- Hidden patterns as a setting (`a18ead90`): belongs with
  `scriptorium-session-vocabularies`.
- The hardening pass (`writeAtomic`, a crash-leftover sweep, an async lock), the
  path and text helpers, and the shared test helpers (`writeUntilSeen`): diff
  file by file during the kit split.
- Architecture tests that parse imports; pinned runners and actions;
  `Work-Item:` commit trailers; a portable skills install (`~/.agents/skills`,
  for other harnesses).

### General: skip

- CI only on `main` and PRs: our pre-commit hook doesn't run the full gate, so
  CI on `develop` is our only automatic full check.
- Root dev scripts: per-spell daemons make them less useful.

### Kit-parity, not this port

The Lane C agent paper cuts (`2320b1c9`: new-doc not in state, same-name slugs,
tail progress noise, snapshot coalescing), undo after a version switch, an agent
merge under a pending edit, and the "has no vN" refusal when going back after a
comparison (`3539a3e1`). These are kit bug fixes.

## Recommendation

**Port the kit split first.** Every take above with a daemon, shell or pane half
is a rewrite into our single files until then; both UX researchers came to this
independently. So the next cycle opens with the split's build (G7 with it), then
the inbox group (U1 to U4), then navigation (U5, U6).

The small ones don't wait for the split: U7, G1, G2, G5, G6, G8, and the
playbooks (G9 to G11). G3 is a safety hole, but builds after the split.

## Decided

Cole, 2026-11-17, on the open questions:

1. **The kit split comes first.** Better now than adding to the debt. The next
   cycle opens with its build, before the UX ports.
2. **The daemon's records leave chat.** Most of them are his own acts (switching
   versions, saving), which he already knows about, and they bury the
   conversation with the agent. The inbox will carry what he needs to know. The
   timing was left to us: the Activity tab and icon tabs land on one branch,
   since the Activity tab is the fourth tab that makes icons pay off. Icon tabs
   become a take.
3. **Autosave: yes, not necessarily now.** It goes with the Ask and Auto modes
   and progressive consent, as one kit-wide research item. For Scriptorium the
   settings are **global**, not layered per folder: a session is short, not a
   project you live in. Whether the choices survive across sessions is for the
   research; his guess is yes, or you'd re-decide them every session.
4. **The page key: our lean.** It is filed high priority but builds after the
   split, since it rewrites `server.ts` and the daemon client, which the split
   moves.
5. **Ask and Auto: take**, inside the research item in 3. Keep Story Studio's UX
   where it makes sense for Scriptorium; the question is how to build it without
   a project home or an always-running service.

The take lists above were accepted as proposed.

## Next Steps

1. ~~Cole reviews the calls.~~ Done, see Decided.
2. ~~File each take as an item.~~ Done: 17 items and the `scriptorium-inbox`
   feature, all `--from` this item. Typecheck in the gate and the per-file
   TMPDIR went into existing items (`typecheck-gate-is-a-project-not-a-flag`,
   `tmpdir-leak-house-wide`); the 1,200-line limit into
   `kit-split-oversized-modules`.
3. ~~Send the kit-parity list to Story Studio.~~ Done, message 67.
4. ~~Close this item.~~ Done.

## Open Questions

Answered in Decided.

---

**Related Documents:**

- [Which of Story Studio's new document UX should Scriptorium take?](./item.md)
- [What to take back from Story Studio](../_archive/story-studio-port-back/write-up.md)
- [Split the kit's oversized modules](../kit-split-oversized-modules.md)
