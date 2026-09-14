---
name: scriptorium
description:
  A co-present markdown editor — you and the user work on real documents in a
  shared browser surface. Use when they want to work on documents WITH you:
  "open these notes so we can go through them", "let's revise this doc
  together", "open scriptorium on my world bible", "I want to edit while you
  help". They open real files, edit them, select passages and ask you about
  them; you answer in the app's chat and propose changes as NEW VERSIONS they
  accept or reject. Do NOT use for a one-off edit they asked you to just make,
  or for reading a file to yourself.
---

# Scriptorium — edit documents together

A scriptorium is the room where scribes wrote, copied and corrected manuscripts.
The user edits; you read over their shoulder, answer what they ask, and propose
changes as **new versions** they can take or leave.

Running `open` gives you a board: three panes in a browser — the context (their
files), the document, and the conversation. **This document is how the game is
played.** What each verb does, the CLI will tell you; run `help`. What follows
is what the CLI cannot: what the app is for, what your part in it is, and the
handful of rules that are invisible until you break one.

## Your part: stay in the conversation

**You are the person they are talking to, not the one doing the work.** The
single most useful thing you can do here is remain responsive — reading what
they send, answering it, and keeping track of what is going on — rather than
disappearing into a long job.

So when a request means real work — research, a rewrite of several documents,
cross-checking a set — **hand the work to a subagent and stay at the board**:

1. Tell them you are starting, in the app.
2. `task "<what you are doing>"` — it posts that message and records the work in
   one act, so the queue and the conversation cannot disagree.
3. Dispatch a subagent with the actual job.
4. `task-done <id> "<what came of it>"` when it lands.

The failure this avoids is subtle: an agent that both does the work and attends
to the human does neither well, and the human is left watching a spinner with no
one to ask. If you are working directly and they have been waiting, you will be
told — see **When you go quiet** below.

## Four rules the CLI will not teach you

**1 · Their files are the point.** Opening a document copies it into the session
as `v1`; their keystrokes land there. The file on disk changes only when they
press Save. You never write their file directly — not with Edit, not with Write.

**2 · ⛔ NEVER WRITE THE ACTIVE VERSION.** The active version is the one they
are typing in. To propose a change: `version-new` (it prints a path), then edit
_that_ path with your own tools. The surface shows it immediately and they
choose whether to make it active. Writing the active version is detected, kept
as a version of its own, and announced to both of you as a mistake — nothing is
lost, but they are told, and their cursor was in there.

**3 · Save and Revert are theirs.** There is no verb for either, deliberately.
Your work exists as versions until they accept it.

**4 · Prose goes through a file.** `say --body-file <path>` or `--stdin` from a
quoted heredoc, never as shell arguments — an unquoted heredoc eats backticks
before the CLI sees them. Same for `note` and `task`.

## The loop

```bash
S=<this skill's directory>
bun $S/scripts/cli.ts open ~/notes/chapter-3.md ~/notes/research/
bun $S/scripts/cli.ts tail        # wrap with Monitor: one JSON line per event
```

Every human message arrives on the tail carrying **what they were looking at** —
the selected passage with its document, version and line numbers, and the path
of the active version. Read it; do not ask what "this" means. Then:

```bash
bun $S/scripts/cli.ts version-new --doc <slug-or-path> --label "tighter opening"
#   → {doc, version, path} — edit that path, then:
bun $S/scripts/cli.ts say --body-file /tmp/reply.md
```

`--doc` takes a slug, a path, or a unique filename. A document they have not
opened yet works too — passing its path opens it for you without moving their
view. `state` lists everything the session knows.

## What else arrives on the tail

Facts, not chatter. The ones worth acting on:

- **`message`** — they said something. Answer it.
- **`waiting`** — they have been waiting 30 seconds with no reply from you. It
  carries the text they are waiting on. Answer, or `working` to say you are
  still on it (see below).
- **`note.added`** — they annotated a passage. The event names the document, not
  the text; `notes --doc <slug>` reads it. **A note is not a request.** They are
  marking something for themselves unless they say otherwise.
- **`doctor`** — at startup, anything worth looking at in the session, each
  finding carrying the verb that fixes it. Offer; do not silently repair.
- **`saved`, `activated`, `system`** — they changed what is where. `system`
  announcements carry a `fact` and, for structure changes, who did it.
- **`closed`** — the session ended and `tail` exits 0. A tail that stops with no
  `closed` means the daemon died; the client reports the disconnection and keeps
  retrying.

## When you go quiet

If a message of theirs sits unanswered for 30 seconds, the app tells them so —
first as a pulse, then in words — and sends you a `waiting` event. You have two
honest replies:

- **`say`** — answer them. Starting a task counts, because `task` posts as you.
- **`working [--for <seconds>]`** — "still on it". It silences the nudge for
  that message and keeps their indicator a pulse rather than "may be stuck".

You are nudged **once per message**, never repeatedly. Use `working` when you
genuinely need longer; use `say` when you have something to tell them.

## Their half, and yours

They have the board: three view modes, a version menu, notes in the margin,
search, and an undo for the context sidebar. You have the verbs. The
capabilities are equal on purpose — you can move, rename, create and organise
exactly as they can — but **do the structural things through the verbs, not
through `mv`**: the verbs announce what you did in the conversation, and a moved
document keeps its versions. A plain `mv` is silent and loses the thread.

Two things are theirs alone, and that is by design rather than omission: the
system file picker, and Reveal in Finder. You already have the paths.

## Finding things

`search <query>` searches everything in the context — fuzzy on document names,
exact in the text. **It searches what they are LOOKING at**, which is the active
version of an open document, not necessarily the file on disk. `grep` over their
folder will miss an edit they made two minutes ago; this will not. For one
document you already have, read it or grep it — that is what it is for.

## When something is wrong

Failures print one JSON envelope on stderr with stdout empty:
`{ok:false, error:{kind, exit_code, retryable, message, hint?, choices?}}`.
**Branch on `kind`, never on the message.** `choices` names what would have been
accepted, and `hint` says what to do — including how to bring back a session
whose daemon has exited.

Run `help` for every verb with its flags and a description, and `schema` for the
machine-readable declaration. **The verb list is deliberately not repeated
here** — it would go stale the moment a verb changed, and the CLI cannot.

### The flags, once

Named here because a roster-wide ward requires it, and the ward is what keeps
the list honest: it fails if this section drifts from the CLI in either
direction, so this is duplication that cannot quietly rot. What each one means
belongs to `help`.

`--session` targets a session other than the most recent, and works with every
verb. `--doc` takes a slug, a path or a unique filename. Prose comes in through
`--stdin` or `--body-file`.

| group              | flags                                                 |
| ------------------ | ----------------------------------------------------- |
| session and scope  | `--session` `--doc` `--entry` `--context` `--full`    |
| opening a session  | `--no-open` `--restore` `--timeout` `--start-timeout` |
| prose in           | `--stdin` `--body-file`                               |
| versions and diffs | `--from` `--label` `--patch` `--hunks`                |
| notes              | `--quote` `--reopen`                                  |
| work and waiting   | `--for` `--status`                                    |
| documents and sets | `--into` `--by`                                       |
| finding            | `--since` `--limit` `--type` `--tag` `--lifecycle`    |

Every flag goes to the LEFT of a bare `--`; after it, a flag is text. (`help`
and the version are verbs of their own, not flags.)

## Feedback touchpoint

At a natural close, surface friction so the tool improves:

- **Agent friction** — a verb that misbehaved, an event shape that fought you,
  something this document should have told you and did not, or something it
  spent words on that you could have discovered yourself. File a GitHub issue
  against the **Spellbook** repo (`github.com/ichabodcole/spellbook`).
- **Human** — when they are on the surface, offer once, easy to skip: "anything
  about scriptorium itself feel off or worth improving?" Route it to the same
  issues.

This is feedback about the **tool**, not about the documents being written.
