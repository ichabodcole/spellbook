---
name: scriptorium
description:
  A co-present markdown editor. Use when the user wants to work on documents
  WITH you in a shared editor — "open these notes so we can edit together",
  "let's go through this doc", "help me revise this file", "open scriptorium on
  this folder". The human opens real markdown or text files in a browser
  surface, edits them, selects text and asks you about it; you answer in the
  chat and propose edits by writing NEW VERSION FILES with your own file tools.
  Do NOT use for a one-off edit the user asked you to just make, or for reading
  a file to yourself.
---

<!--
  DRAFT — NOT SHIPPED. scriptorium is in development (brief A, slice A). This
  file lives in docs/projects/scriptorium/ on mind-mapper's precedent
  (47238d7): a spell that has not coalesced does not claim a roster slot. It is
  how the lead drives the spell during development. Ship it as
  plugins/spellbook/skills/scriptorium/SKILL.md when the foundation is usable,
  and unpin roster-drift, flag-invariant and the trigger-registry row then.
-->

# Scriptorium — edit documents together

A scriptorium is the room where scribes wrote, copied and corrected manuscripts.
The human edits; you read over their shoulder, answer, and propose changes as
**new versions** they can take or leave.

Kind: **conjuration** — one daemon per session (several at once are fine),
serving a three-pane browser surface: context (files and folders), the document,
and the conversation.

## The rules that make it work

1. **Documents are real files** (E1). Opening a file copies it into the session
   as `v1`; the human's edits reach `v1` as they type; the original on disk
   changes **only when the human saves** (E7).
2. **You never write the active version** (E2) — the one the human is editing.
   To propose an edit: `version-new`, then edit the file it prints with your own
   Edit/Write tools. The surface shows your changes live. A write to the active
   version is detected, kept as a new version of its own, and announced to both
   of you; the active version keeps the human's text.
3. **Every message carries its context.** A human message on the tail carries
   the selection (`doc`, `version`, `path`, `fromLine`, `toLine`, `text`) and
   the active version's `path`. Read the path; do not ask what they mean.
4. **Revising your own pending version is fine** (E10): if the human asks for a
   change to a version you wrote and they have not made active, edit it in place
   and say so. Once they have activated it, make a new version.

## The loop

```bash
S=<skill-dir>
bun $S/scripts/cli.ts open ~/notes/chapter-3.md ~/notes/research/   # prints {url, port, session_id}
bun $S/scripts/cli.ts tail            # wrap with Monitor: one JSON line per event
```

On a `{"type":"message", …}` line, name the document the message is about —
`selection.doc` when there is a selection, else `active.doc`:

```bash
bun $S/scripts/cli.ts version-new --doc <selection.doc or active.doc> --label "tighter opening"
#   → {doc, version, path}; edit <path> with your Edit tool
bun $S/scripts/cli.ts say --body-file /tmp/reply.md          # prose ALWAYS through a file
```

When the human has opened nothing yet (`active` is `null`) — or asks about a
document by name — pass its PATH: `version-new --doc ~/notes/research/b.md`
opens any document in the context for you (without moving the human's view) and
copies its v1. A path outside the context is refused; `add` it first. `state`
lists the context entries and every opened doc.

The human makes a version active in the surface (or asks you to: `activate v2`),
and saves when they are happy.

## Verbs

| verb                                                  | does                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `open [<path>…] [--no-open] [--restore <id>]`         | spawn a session (opens the browser), adding files/folders; `--restore` reloads a closed one              |
| `add <path>…`                                         | add files or folders to the context list                                                                 |
| `state [--full]`                                      | context, docs with every version's `path`, the active version, dirty, selection                          |
| `tail [--since <n>]`                                  | the human's messages and the session's facts as JSON lines                                               |
| `version-new [--doc <d>] [--from <vN>] [--label <t>]` | copy a version (default: the active one) to a new file; prints its `path`; a context doc's path opens it |
| `say <text…>` · `say --body-file <p>` · `say --stdin` | a chat message from you                                                                                  |
| `activate <vN> [--doc <d>]`                           | make a version the active one                                                                            |
| `info` · `close` · `schema` · `help` · `--version`    | discovery JSON · end the session (the manifest stays) · acc declaration                                  |

`--session <id>` targets a session other than the most recent. `--doc` accepts a
slug (`state` lists them), a path (resolved against YOUR cwd), or a unique file
name. Put every flag to the LEFT of `--`: after it, a flag is text.

**Prose goes through `--body-file`** (or `--stdin` from a quoted heredoc), never
as arguments from an unquoted heredoc — the shell eats backticks first.

## Tail events

| `type`                             | when                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `grounding`                        | first line: which session and port the tail bound to                                                     |
| `ready`                            | the daemon booted (`restored: true` after `open --restore`)                                              |
| `message`                          | the human sent a message: `text`, `selection`, `active {doc, version, path}`                             |
| `doc.opened`                       | the human opened a document for the first time (`path` is its v1)                                        |
| `saved` · `reverted` · `activated` | the human (or you) changed which text is where                                                           |
| `system`                           | an announcement: `fact` is `active.outside`, `original.reloaded`, `original.conflict`, `version.created` |
| `epoch.changed`                    | the daemon restarted; refetch `state`                                                                    |
| `closed`                           | the session ended; `tail` exits 0                                                                        |

## Exit codes and the error envelope

Success: JSON on stdout, exit `0`. Failure: stdout empty, ONE JSON document on
stderr —
`{ok:false, error:{kind, exit_code, retryable, message, hint?, choices?, server?}, meta:{command}}`.

| exit | kind        | means                                                                      |
| ---- | ----------- | -------------------------------------------------------------------------- |
| `0`  | —           | done                                                                       |
| `2`  | `usage`     | change the command (`choices` names what is accepted)                      |
| `5`  | `not_found` | no session, no such path, doc or version (`choices` when the set is known) |
| `6`  | `conflict`  | a precondition failed (e.g. `--restore` of a running session)              |
| `1`  | `internal`  | scriptorium broke; the daemon log is under `$SCRIPTORIUM_HOME/logs/`       |

Branch on `kind`, never on `message`. `tail` waits for a session rather than
failing, and exits `0` when the session closes.

## Where things live

`$SCRIPTORIUM_HOME` (default `~/.scriptorium`): `sessions/<id>/manifest.json`
and `sessions/<id>/docs/<slug>/v1.md, v2.md, …`; `logs/` for daemon stderr.
Discovery pointers: `scriptorium-<id>.json` and `scriptorium-latest.json` in the
system temp directory.

## Not yet (slice A)

The surface is the empty three-pane layout; the context sidebar, the document
viewer/editor and the chat pane arrive in the next slices (E16). Save and Revert
are surface acts (the daemon has them; there is no CLI verb for them, because
saving is the human's decision — E7). Split-screen diff, annotations, saved
prompts and drag-and-drop are later slices (E9, E11, E14).
