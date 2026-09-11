# Scriptorium — slice A journal (the foundation)

**Date:** 2026-09-11 · **Branch:** `feat/scriptorium-foundation` · **Brief:**
[`brief-A-foundation.md`](./brief-A-foundation.md), as amended during the
session by E15–E18 and the lead's surface split (below). **Author:** the
brief-driven implementer. Not merged, not pushed.

## The split, recorded

The brief asked for the whole loop on the surface. During the session the scope
changed three times, all from Cole through the lead:

1. **E15** — one context model for a single document and a structured set.
2. **E16** — the surface is built one piece at a time, the context sidebar
   first, the sidebar props-driven so it can later serve other apps.
3. **The lead's split** — this slice builds **surface chapter 1 only**: the
   empty three-pane layout, wired to the daemon's WebSocket state, with E18's
   status strip. **The lead builds chapters 2 and 3** (the context sidebar and
   the read-only CodeMirror viewer) with Cole, after the tree-library pick
   (`@headless-tree/react`, E17). The backend, CLI, launchers, instruments, acc
   and the end-to-end CLI drive stayed in full scope here.

So there is **no sidebar component** in this slice. Where its boundary will be:
`surface/state/useDaemon.ts` is the only code that touches the daemon
(WebSocket, `send`); a sidebar should take `ContextEntry[]` (protocol.ts), a
selection and callbacks as props, and `App.tsx` does the wiring. The
`ClientMsg`s the sidebar will send already exist and were driven: `open`,
`open.doc`, `context.add`, `context.remove`, `fs.list`.

## What was built

| chapter  | commit     | what                                                                                                                            |
| -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| scaffold | `c6999d79` | workspace member (`package.json`, `tsconfig.json`, `components.json`), build delegator, `.gitignore` lines                      |
| backend  | `b84a22e6` | daemon, session model, context tree, CLI, launchers, acc config, unit/contract/integration cells, the backend's instrument pins |
| surface  | `46f54a7f` | three resizable panes, placeholders on live state, status strip, both themes, dev-styled cell, the surface's pins               |
| cells    | `df327053` | the contract cells clean up their temp dirs                                                                                     |
| docs     | (this)     | decision log E14–E18, `SKILL.draft.md`, this journal                                                                            |

**Where the next reader finds the design answers.** The eight N1 answers and
every N4 kit verdict are in the header blocks of
`src/scriptorium/backend/server.ts` and `backend/cli.ts`. All nine kit rows are
SUBJECT; `housekeeping`'s snapshot hook is deliberately not passed (the manifest
is written on every change), and that is said at the verdict. The teardown order
(glamour's: unlink discovery, then the `closed` frame) is stated with its reason
in the same header.

**Backend shape.** `session.ts` owns every write and knows nothing about
sockets; `server.ts` decides what to broadcast; `tree.ts` is pure filesystem.
Storage is the brief's §4 exactly, plus `logs/` (below). Opening writes `v1`; an
edit reaches the active version's file; Save is the only write to the original;
Revert copies the original back; `open --restore <id>` reloads the manifest (a
new epoch, the same session id).

**The context model (E15)** is
`ContextEntry { id, label, root, membership, nodes }` with `doc` / `group`
nodes. `membership` is `mirrored` (a folder: new files under the root join) or
`listed` (exactly the nodes written down — a single file, rooted at its parent).
It is not a file/folder type: a promoted single document stays `listed` and
gains nodes. Node order carries no meaning (E17); a scan happens to come out
name-sorted.

## What was driven, end to end, through the launchers

All with `SCRIPTORIUM_HOME` and `TMPDIR` under the session scratchpad and temp
originals. The transcript is `scratchpad/drive2/transcript.txt`.

- **The daemon launcher alone** (Gotcha 3): it prints its handshake and keeps
  serving; with `--timeout 3` and no subscriber it ended itself at exit 124.
  Terminal-exit is the right shape.
- `open docs/book single/letter.md` → both entries: `book` mirrored (a `ch1`
  group, `ch1/opening.md`, `notes.md`), `letter.md` listed and rooted at
  `single/` → the surface's `open` → `v1.md` written → an edit reaches `v1`
  (dirty) and not the original → Save writes the original, and only then →
  `select` + `say` → `tail` prints the message with its selection and the active
  path → `version-new --label less-cliched` prints `v2.md`'s path → **I edited
  `v2.md` with my own Edit tool**, and the surface's socket received the new
  text (`version.text`, origin `remote`) → `activate v2` → Revert put the saved
  text back over v2 → **an Edit-tool write to the active v2 was announced** in
  the chat and on the tail (`fact: active.outside`) → `say --body-file` →
  `close`: the tail ended at 0 on `closed`, no pointer left, no daemon left →
  `open --restore` brought back 2 entries, the doc at v2 of 2, 7 chat messages,
  a new epoch → `version-new --doc nope` → exit 5 with `choices: ["opening"]`.
- **Save and Revert were driven over the WebSocket** (as the surface will send
  them), not through the CLI: the brief's verb table has no `save`/`revert`
  verb, and saving is the human's act (E7). The lead's message asked to drive
  them "through the CLI"; there is nothing to drive there.
- `fs.list` (WebSocket and `GET /fs/list`) and `context.add` over the socket.
- **The surface, in Playwright, served in release mode by the built daemon:**
  panes render; dragging a handle moved 180 px; the stored layout
  (`react-resizable-panels:scriptorium:panes:…`) restored identical widths after
  a reload; both themes paint and the choice survives a reload; the placeholders
  updated live when `cli.ts add` ran. Screenshots:
  `scratchpad/shots/01…06-*.png` (dark, light, resized, with the strip).
- **acc** from the skill directory: `acc check scripts/cli.ts` → **CONFORMANT
  L0**, 16 of 17 core rules passed, 0 failures, 1 unverified (kit 0.1.11). The
  schema round trip is also a cell (`cli-contract.test.ts`).
- `bun run build` · `bun scripts/dist-check.ts` → **0**, scriptorium listed by
  name (5 tracked / 5 on disk) · `bun run gate` → **0** (2,164 pass).

## Deviations from the brief, each with its reason

1. **`node:fs` `watch`, not `@parcel/watcher`.** `@parcel/watcher` loads a
   per-platform native package with a runtime `require(name)`; bundled into
   `dist/server.js` it is not inlined (probed: the bundle keeps
   `__require(name)`), so the shipped daemon would need a `node_modules` the
   marketplace never copies — import-boundary ward 1b's rule. Bun 1.4's
   recursive `watch` was measured first: in-place write, atomic tmp+rename, and
   both in a subdirectory, all reported. Hash-compare and self-write suppression
   are unchanged.
2. **The daemon's stderr goes to `$SCRIPTORIUM_HOME/logs/`, not to the CLI.**
   glamour's `stdio: [.., .., "inherit"]` hands the CLI's stderr to a detached
   daemon, so a caller that reads `open`'s stderr to EOF waits for the whole
   session — the integration cell hung at 60 s. A start failure quotes the log's
   tail in its hint.
3. **Instruments are not a chapter of their own.** Playbook N7 says each pin
   moves in the same commit as the change that moves it, so the backend and
   surface chapters carry their own pins; brief §8 points at N7.
4. **The surface stops at the layout** (the split above). No CodeMirror, chat,
   selection chip or Save/Revert UI; the daemon supports all of them.
5. **`GET /fs/version` and `GET /fs/list`** are the `/fs/*` routes; the surface
   will fetch version text from the first.
6. **Doc ids are slugs**, and `--doc` also accepts an original's path or a
   unique file name; the brief's `--doc <rel>` is served by the unique-name and
   path forms.

## What the brief or the playbook got wrong against the tree

- **@parcel/watcher cannot ship** in a bundled daemon (deviation 1). The
  investigation drove it under Bun but not through `bun run build`.
- **The backend chapter cannot be green alone.** spawn-path's "every shipped pin
  resolves" reds at `b84a22e6` because the CLI's mode switch pins
  `dist/index.html`, which only the surface chapter builds (measured in a
  scratch worktree: 252 pass / 1 fail). Said in that commit's message; the tip
  is green.
- **N7's table is short by two.** `strict-parse-invariant` (17 → 19 invocations)
  and `terminator-invariant`'s unit cell (files and call sites) both red on
  arrival and are not in N7's list; the `choices` census is only in the rules
  ledger. `entry-points.ts`'s `INTERNAL_ENTRY_POINTS` did not red (the
  no-SKILL.md pin hides the flag ward) but the daemon's private argv belongs in
  it, and was added.
- **gate-honesty did not red until the files were in the index** — it measures
  tracked files, so an untracked scaffold passes it; it redded the moment the
  surface was staged.
- **`import-boundary-wards` says "there is no ninth spell to forget."** It was
  true of ports. A comment now says so beside the ninth row.
- **The `choices` census's raiser rule (a) matches across function boundaries.**
  `function NAME(` is matched lazily up to the next `): never` within 600
  characters, so any function declared just above a `never`-returning one
  (`api`, then `requireSession`) was counted as a raiser, and its calls as raise
  sites. Worked around by declaring `daemonRefused` first; the instrument is not
  fixed. glamour's CLI has the same shape and may carry the same miscount.
- **surface-dep-cap**: shadcn's `resizable` needs `react-resizable-panels`, a
  fifth surface dependency the house-style rule says needs a recorded ruling
  before `bun add`. It is declared in the member manifest; the rule was not
  amended (that is the grimoire seat's, and Cole's). The viewer will add
  CodeMirror, which is the same question again.

## What surprised me

- **Pane sizes do not survive a new session.** localStorage is per origin, and
  every session binds a fresh port — so a layout persists across reloads of one
  session and is lost at the next `open`. The fix is the next chapter's
  decision: a fixed port, or a daemon-held preference in `$SCRIPTORIUM_HOME`.
- **Rebuilding under a live daemon blanks the page.** `serveFromDist` caches its
  whitelist per process; the new `index.html` is served and its new chunk
  refused (404). Restart the session after a build.
- The playbook's method held: the eight questions answered as design with no
  file to grep, and the launcher shapes came out as predicted and were then
  driven. The instruments that red on arrival were the playbook's list plus the
  two above.

## What I could not do, or did not

- The sidebar, the viewer, editing, undo/redo, chat, the selection chip and the
  Save/Revert/`⌘S` UI — out of this slice by the split.
- `ward`'s release-time items (README and marketplace listings, the feedback
  touchpoint, the fresh-agent run, a version bump) — scriptorium is undeclared
  on mind-mapper's precedent; `SKILL.draft.md` is the draft.
- Version undo (E6), drag-and-drop (E14), saved prompts (E9).
- The six `scripts/instruments/` checks the gate never runs were not run.
- No cold verification pass; that is the lead's next step.
- dist-check's reproduction arm was run locally on the committed tree (exit 0);
  CI remains the authority (Contract 18).
