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

**Where the line is:** if it will take longer than a reply, it is work. One
version of one document is usually not — write it and answer. Reading four
entries to check they agree is, even though it touches no document. When you
cannot tell, `task` costs almost nothing and makes the waiting legible; guessing
the other way leaves them with no one to ask.

**Three ways to put something in front of them, and they are not
interchangeable:** `say` is the conversation and it is what answers a question;
`task` is the conversation plus a record that something is in flight, which is
what makes a spinner honest; `note` is an annotation pinned to a passage in a
document, for something worth marking where it happened rather than saying out
loud. If you are replying, `say`. If you are disappearing for a while, `task`.

## Four rules the CLI will not teach you

**1 · Their files are the point.** Opening a document copies it into the session
as `v1`; their keystrokes land there. The file on disk changes only when they
press Save. You never write their file directly — not with Edit, not with Write.

**2 · ⛔ NEVER WRITE THE ACTIVE VERSION.** The active version is the one they
are typing in — `docs[].active` in `state`. To propose a change: `version-new`
(it prints a path), then edit _that_ path with your own tools. The surface shows
it immediately and they choose whether to make it active. Writing the active
version is detected, kept as a version of its own, and announced to both of you
as a mistake — nothing is lost, but they are told, and their cursor was in
there.

**3 · Save and Revert are theirs.** There is no verb for either, deliberately.
Your work exists as versions until they accept it.

**4 · Prose goes through a file.** `say --body-file <path>` or `--stdin` from a
quoted heredoc, never as shell arguments — an unquoted heredoc eats backticks
before the CLI sees them. Same for `note` and `task`.

## The loop

```bash
S=<this skill's directory>
bun $S/scripts/cli.ts open ~/notes/chapter-3.md ~/notes/research/
bun $S/scripts/cli.ts tail        # wrap with Monitor
```

**⚠ Not every line is JSON. Ignore any line beginning with `:`** — those are
keepalives (`: scriptorium-keepalive`), and a loop that parses every line will
throw on the first one. Everything else is one event per line.

Every human message arrives on the tail carrying **what they were looking at** —
the selected passage with its document, version and line numbers, and the path
of the active version. Read it; do not ask what "this" means. Then:

```bash
bun $S/scripts/cli.ts version-new --doc <slug, or a PATH if not open yet> --label "tighter opening"
#   → {doc, version, path} — edit that path, then:
bun $S/scripts/cli.ts say --body-file /tmp/reply.md
```

### Getting a document into the session

**There is no `open-document` verb — expect to look for one.** `open` starts a
SESSION over files and folders; that puts them in the context but does not open
any of them. A document becomes open — copied in as `v1`, with versions you can
write — the first time someone reaches for it: the human by clicking it, you by
naming its **path** to `version-new`.

So for a document the human has not opened:

```bash
bun $S/scripts/cli.ts version-new --doc /abs/path/from/the/context.md
```

That opens it and gives you a v2 to write, without moving their view.

**⚠ `--doc` accepts a slug or a unique filename only for a document that is
ALREADY open.** For anything else it must be an absolute path — a filename gets
you `no document "keeper.md" in this session`. `state` lists what is open
(`docs[].slug`) and what is merely in the context. A refusal names the paths you
could have used.

**The path `version-new` prints is never the active one** — that is what makes
it safe to write with your own tools.

## What else arrives on the tail

Facts, not chatter. The ones worth acting on:

- **`message`** — they said something. Answer it.
- **`waiting`** — they have been waiting 30 seconds with no reply from you. It
  carries the text they are waiting on. Answer, or `working` to say you are
  still on it (see below).
- **`note.added`** — they annotated a passage, and **expect you to act on it**.
  A short note arrives whole — the passage (`quote`), what they wrote (`body`)
  and its `lines`; a long one says to read it with `notes --doc <slug>`. Answer
  it or propose a version, then **resolve it** (`note-resolve <id>`): resolving
  is what tells them it is dealt with, and the event's `hint` names the exact
  command. A `note.edited` from them carries the same fields and is owed the
  same.
- **`doctor`** — at startup, anything worth looking at in the session, each
  finding carrying the verb that fixes it. Offer; do not silently repair. **It
  says nothing when there is nothing wrong**, so its absence is good news rather
  than a broken tail. Run the `doctor` verb any time to ask directly.
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

**A note of theirs shows the same thing** — a pulse on the note until you say
something in the app or resolve it, then "may be stuck" after 30 seconds.
`working` covers notes too. There is no nudge for a note: when one looks stuck,
they have a button that asks you about it, and it arrives as an ordinary
`message`.

## The four words that mean something specific

You will meet these in `state` and `help`. Two of them are the kind you can act
wrongly on precisely because you already know the ordinary English word.

- **A SET is a structural unit, not a loose grouping.** It is a top-level folder
  in the context, with an id (`--entry`), its own link graph, and rules about
  what may be created inside it. `make-set` is not cosmetic: it makes a folder
  named for a document and moves the document into it.
- **The CONTEXT is what is in their sidebar** — the documents and sets they
  chose for this session. (Unrelated to `diff --context`, which means lines of
  surrounding text. Same word, two meanings, one of them a flag.)
- **The WORKSPACE is where new things land** — a `new-doc` outside a set goes
  there. **⚠ `open` does NOT set it**, so it may be somewhere other than the
  folder you just opened; `workspace` prints it, `workspace <dir>` moves it.
  Check before creating, or you will leave a document where they are not
  looking.
- **ACTIVE means two different things in `state`.** `docs[].active` is a version
  number, and it is the one rule 2 is about. `state.active` (beside `openDoc`)
  is which document their VIEW is on, and is `null` before they open anything.
  Reading the wrong one under a rule that says "never write the active version"
  is the expensive mistake here.

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

A failure is one JSON envelope on stderr, stdout empty. **Branch on `kind`,
never on the message.** `choices` names what would have been accepted and `hint`
says what to do — including how to bring back a session whose daemon has exited.

Run `help` for every verb with its flags and a description, and `schema` for the
machine-readable declaration. The verb list is not repeated here.

### The flags, once

Every flag the CLI accepts, in one place. **⚠ Deliberately FLAT: which verb
takes which is in `help`, on that verb's own row.** Grouping them by theme reads
as a claim about what they do and gets it wrong — `--status` looks like it
belongs to `task-status`, and it does not; `task-status` takes a positional and
`--status` is a `find` filter.

`--body-file` `--by` `--context` `--doc` `--entry` `--for` `--from` `--full`
`--hunks` `--into` `--label` `--lifecycle` `--limit` `--no-open` `--patch`
`--quote` `--reopen` `--restore` `--session` `--since` `--start-timeout`
`--status` `--stdin` `--tag` `--timeout` `--type`

`--session` works with every verb and targets a session other than the most
recent.

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
