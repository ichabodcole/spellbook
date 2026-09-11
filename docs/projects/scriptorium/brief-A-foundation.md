# Scriptorium — brief A: the foundation, end to end

**For:** a brief-driven implementer. **From:** the lead, 2026-09-11. **Branch:**
`feat/scriptorium-foundation` (already created from `develop`; the project docs
are its first commit). **Read first, in this order:** this brief;
[`precursor.md`](./precursor.md); [`decision-log.md`](./decision-log.md) (E1–E13
— every design choice below is ruled there, do not re-open them);
[`investigation.md`](./investigation.md); then
[`docs/playbooks/scaffolding-a-spell-playbook.md`](../../playbooks/scaffolding-a-spell-playbook.md),
which is THE procedure — this brief supplies its design answers, it does not
replace it. `docs/architecture/spell-backend-architecture.md` §1–§3 explains why
the procedure is shaped the way it is.

Scriptorium is a co-present document editor: a human opens local markdown files,
edits them in a browser surface served by a local daemon, and talks to an agent
in a chat pane; the human's text selection rides with every message; the agent
edits by writing **new version files** with its own file tools.

This brief is **slice A**: the whole loop, working end to end, on the house
build. Slice B (file-tree polish, right-click quick actions, saved prompts) is a
separate brief. Split-screen diff, annotations, rendered view and links are
**out of scope** (E11).

---

## 1 · Reference spells — copy their shape, not their prose

| concern                                                                                    | reference                                                                                   | why                                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| per-session daemon, `open` handshake, CLI COMMANDS table, `schema`, error contract, acc L0 | **glamour** (`src/glamour/backend/{cli,server}.ts`, `glamour/tests/cli-contract.test.ts`)   | the most modern per-session spell (E13 picks its discovery convention) |
| shadcn workspace member, React + Tailwind v4 surface, `@/` alias, `context-menu`           | **grapevine** (`src/grapevine/{package.json,tsconfig.json,components.json}`, `surface/ui/`) | the house's shadcn spell; porting playbook §S0 documents the setup     |
| selection travels with a message; the message-surface paradigm; epoch on the event log     | **mind-mapper** (`src/mind-mapper/`)                                                        | the paradigm's source                                                  |
| launcher shapes, entry predicate, kit                                                      | the scaffolding playbook N3/N4                                                              | —                                                                      |

Use the **shadcn skill** (`.claude/skills/shadcn/`) for every component. It is
untracked and belongs to Cole: use it, never stage it. Run shadcn commands from
`src/scriptorium/` (the playbook's S0 note: the probe fails from the repo root).
Registry: **`@shadcn` only** for this slice.

---

## 2 · The eight questions (playbook N1) — answered

Entries: **`cli`** and **`server`**, both built, both with launchers.

| #   | question                                      | `cli`                                                                    | `server`                                                                                                                                           |
| --- | --------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | arithmetic                                    | **none carried.** Any path is computed at the emitted address (`dist/`). | none; `SKILL_ROOT`/`DIST_DIR` only as the kit's `resolveMode` needs, true at `dist/server.js`                                                      |
| 2   | serves?                                       | no                                                                       | **yes** — `/` is the built `index.html` via `serveFromDist` (no substitution, no custom router beyond `/state`, `/cmd`, `/events`, `/ws`, `/fs/*`) |
| 3   | second half?                                  | **yes** — shares `backend/heartbeat.ts` with the server                  | yes                                                                                                                                                |
| 4   | lifecycle                                     | single-shot per verb; `tail` is long-running                             | **long-running, per session**, idle-timeout like glamour                                                                                           |
| 5   | `main()` returns while the process must live? | no → **natural-return** launcher                                         | follow **glamour's server exactly** and DRIVE it (N3)                                                                                              |
| 6   | event ids recovered across restart?           | —                                                                        | **no → stamp an epoch** (mind-mapper's shape; kit `eventLog` with `{ epoch }`)                                                                     |
| 7   | a kit subject in a different shape?           | no — choose the kit's shape                                              | no                                                                                                                                                 |
| 8   | a kit module names this spell as its source?  | **structurally no** (first spell scaffolded after the convergence)       | same                                                                                                                                               |

Write these answers into each entry's header comment block (playbook N1's
"validation" row).

---

## 3 · Kit verdicts (playbook N4) — rule on every row

`errors` SUBJECT · `serveDist` SUBJECT · `housekeeping` SUBJECT (all three
exports: idle-close, sweep, drain) · `tailEvents` SUBJECT (the `tail` verb) ·
`heartbeat` SUBJECT (cli ↔ server via `backend/heartbeat.ts`) · `discovery`
SUBJECT (session-JSON, E13) · `eventLog` SUBJECT, **with epoch** · `sse` SUBJECT
· `lib/printJson` SUBJECT (a spell that speaks the agent wire imports it — N4).
Teardown order (register A6): **state it** in the server and pick glamour's
(unlink discovery, then the `closed` frame) unless you find a reason not to.

---

## 4 · Storage (E8) — the daemon owns the session, versions are files

```
$SCRIPTORIUM_HOME   (default ~/.scriptorium)
  sessions/<sessionId>/
    manifest.json        # context entries, docs, versions, active, chat — the daemon's state, written atomically
    docs/<doc-slug>/v1.md, v2.md, …    # one file per version
  prompts.json           # slice B (E9) — do not build yet, but do not squat the name
```

- **Opening a document** writes `v1.md` from the original; the human edits the
  **active** version; edits reach its file debounced (~250 ms after typing
  stops).
- **Save** copies the active version over the original. **Revert** copies the
  original back over the active version. The original is written **only** by
  Save (E7).
- **The agent never writes the active version** (E2). A write to it that the
  daemon did not make is detected (hash of the daemon's own last write) and
  announced in the chat as a system message.
- **Outside change to an original:** buffer clean → reload; buffer dirty → a
  system message asks (the diff view that should answer it is slice C).
- Watch with **`@parcel/watcher`** on the session folder (and on the parents of
  opened originals), hash-compare, skip self-writes (investigation §5).
- `manifest.json` survives a daemon restart: `open --restore <sessionId>`
  (glamour's `--restore` is the reference) reloads the context, docs and
  versions.

---

## 5 · The two wires

### Agent — CLI verbs (COMMANDS table, glamour's shape; every rejection through `kit/wire/errors.ts`)

| verb                                                       | does                                                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `open [<path>…] [--no-open] [--restore <id>]`              | spawn a session (browser opens), optionally adding paths; prints `{url, port, session_id}`                                                     |
| `add <path>…`                                              | add a file or folder to the context list                                                                                                       |
| `state [--full]`                                           | the session: context, open doc, versions (with **paths**), active, dirty, selection                                                            |
| `tail [--since <n>]`                                       | the human's messages as JSON lines, each carrying `selection` (`{doc, version, path, fromLine, toLine, text}`) and the active version's `path` |
| `version-new [--doc <rel>] [--from <vN>] [--label <text>]` | copy a version to a new file; prints its `path` — the agent then edits that file with its own tools                                            |
| `say <text…> \| --stdin \| --body-file <path>`             | a chat message from the agent (grapevine's `--body-file` rule — agents send prose through files, never unquoted heredocs)                      |
| `activate <vN> [--doc <rel>]`                              | make a version active (the human can too)                                                                                                      |
| `info` · `close` · `schema` · `help` · `version`           | as glamour                                                                                                                                     |

Every enumerable `usage` rejection carries `choices` (A1). Unknown verb → the
verb roster; unknown flag → the flag map.

### Human — surface ⇄ daemon over the WebSocket

State snapshots down; up: `open`, `edit {doc, version, text}`, `select`,
`say {text, withSelection}`, `activate`, `save`, `revert`, `context.add {path}`,
`fs.list {path}`. Keep every surface action an ordinary chat-visible message or
state change (the message-surface paradigm).

---

## 6 · The surface — what "done" looks like for slice A

React 19 + Tailwind v4, shadcn **base-nova**, a Bun workspace member exactly as
grapevine is (porting playbook S0: `package.json`, `tsconfig.json` with
`"@/*": ["./surface/*"]`, `components.json`; add `"src/scriptorium"` to the root
`workspaces`). Adopt the kit's stylesheet (Contract 21). Dark and light via the
house semantic tokens (memory: spell-theming-convention — no raw palette in
markup).

1. **Three resizable panes** — shadcn `resizable` (drag handles), not `sidebar`
   (E11 layout ruling). Pane sizes persisted in `localStorage` (wrap access in
   try/catch).
2. **Context pane** — the context list: added files and folders. A folder entry
   opens a **file tree** (start from `@shadcn/sidebar-11`, "a sidebar with a
   collapsible file tree") with a way back to the list. **Adding:** a path input
   with daemon-backed completion/browse (`fs.list`) — see §7 for why not
   drag-and-drop.
3. **Editor pane** — CodeMirror 6, **hand-rolled wrapper** (investigation §1),
   markdown language, line wrapping, `history()` undo/redo, **one EditorState
   per doc+version** kept across switching (Operator's pattern), outside changes
   applied as `Transaction.remote` + `isolateHistory`. Header: doc name, version
   pills (click to view a version read-only; "Make vN active"), `● unsaved`,
   **Save (⌘S)**, **Revert**.
4. **Chat pane** — shadcn **`message` + `message-scroller`** (streaming follow,
   jump to latest). Human, agent and system messages visually distinct; system
   messages compact. Composer with a **selection chip** ("v1 · lines 4–9 · 212
   chars", toggleable) — the selection rides the message. ⌘↵ sends.
5. **Empty and error states** are real (shadcn `empty`), not blank panes.

---

## 7 · ⚠ One constraint the brain dump did not know about — drag-and-drop

A plain browser page **cannot learn a dropped file's path** (browsers expose a
`File` with a name and contents, never a filesystem path). E1 says documents are
real files the spell saves back to, so a dropped file cannot be linked to its
original. Slice A adds context **by path** (surface input + CLI `add`). Do not
build drag-and-drop; the lead is putting the options to Cole.

---

## 8 · Instruments, gate, and WIP status

- Follow playbook **N7**: the pinned instruments will red on arrival — edit each
  pin deliberately, with its reason, in the same commit as the change that moves
  it. Add the two `.gitignore` un-ignore lines for `dist/`.
- **WIP status — mind-mapper's precedent** (`47238d7`): scriptorium ships **no
  `SKILL.md`** in the plugin during development; write the draft to
  `docs/projects/scriptorium/SKILL.draft.md` (it is how the lead drives the
  spell). Pin scriptorium in `roster-drift`'s `PINNED` with the reason "WIP — no
  SKILL.md until the foundation is usable", and add a registry row in
  `grimoire/trigger-registry.md` with status **in development** only if
  roster-drift tolerates it; if it would red, say so and leave the row for
  release.
- **acc**: add `acc.config.json` and reach CONFORMANT L0 on `scripts/cli.ts`,
  run **from the skill directory** (acc discovery is cwd-based).
- Tests: backend unit cells (manifest, versions, self-write suppression), a
  CLI-contract cell set (glamour's), a daemon integration cell that spawns the
  **launcher** against a temp `SCRIPTORIUM_HOME` and temp originals, and a
  `dev-styled` cell (grapevine's). Build before any process test (T23).

---

## 9 · Done means

- [ ] Playbook N1–N9 followed; the eight answers and every kit verdict written
      where the next reader finds them.
- [ ] `bun run build` · `bun scripts/dist-check.ts` → 0 (scriptorium in its
      roster **by name**) · `bun run gate > <scratch>/g.log 2>&1; echo $?` → 0.
- [ ] **Driven end to end through the launchers** with a temp home and temp
      originals: `open` a folder → the surface loads (release mode) → open a
      file → edit → undo/redo → Save writes the original, and only then → select
      text and send a message → `tail` prints it with the selection and the
      active path → `version-new` → the agent edits that file → the surface
      shows it → `activate` → Revert → `close`. Screenshots of the surface
      (Playwright) saved under the scratchpad, not the repo.
- [ ] A write to the active version from outside is announced.
- [ ] acc L0 from the skill directory.
- [ ] A short journal, `docs/projects/scriptorium/slice-A-journal.md`: what was
      built, what was driven, what surprised you, and **what you could not do**.

## 10 · Hard constraints — non-negotiable

- **Never** stage, stash, commit, edit or `git checkout --` `skills-lock.json`
  (modified) or `.claude/skills/shadcn/` (untracked). `git status` showing them
  is correct.
- Never kill pids 23127 or 66902, nor any grapevine / mind-mapper process you
  did not start. Every daemon you start runs with its own temp home under the
  session scratchpad
  (`/private/tmp/claude-501/-Users-colereed-Projects-Spellbook/64c2a835-f0ef-4b8d-b475-cbb79283ac0c/scratchpad/`)
  and is torn down before you finish.
- **Nothing in the repo root** — check `find . -maxdepth 1 -type d -empty` and
  `git status` before every commit. Playwright writes screenshots and a
  `.playwright-mcp/` folder into the repo root by default: pass a filename and
  delete stragglers.
- Build **only** through `bun run build`. Run the gate **unpiped**, exit read
  from a file. `bunx biome check --write` on changed files before each commit.
  Type errors now block the gate (T37): `type-check-ward` must stay at zero.
- Commit in **chapters** (scaffold · backend · surface · instruments · docs),
  each with the trailers:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.
- **Do not merge and do not push.** The lead lands it after a verify pass.
- If something in this brief is wrong against the tree, **say so in the journal
  and in your report** rather than working around it silently.

Report back: what landed (shas), the gate and dist-check exits, what you drove
and what you did not, and every deviation from this brief with its reason.
