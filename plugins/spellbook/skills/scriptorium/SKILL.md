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
as `v1`; their keystrokes land there. Its text on disk changes only when they
press Save, or when a structural verb they agreed to rewrites it (`move`,
`rename`, `make-set`, `relink`). You never write their file directly — not with
Edit, not with Write.

**2 · ⛔ NEVER WRITE THE ACTIVE VERSION.** The active version is the one they
are typing in — `docs[].active` in `state`. To propose a change, write your text
to a file and hand it over in one step:
`version-new --body-file <path> --label "…"` (or `--stdin` from a quoted
heredoc). The version is born holding your text. The surface raises a toast the
moment the version exists, naming it and you as its author, with **Activate**
and **Show diff**; they choose whether to make it active. A version made while
their browser was disconnected is toasted when it reconnects. **You do not need
to announce a new version in chat.** Say _why_ you made it if that helps them
decide. Writing the active version is detected, kept as a version of its own,
and announced to both of you as a mistake — nothing is lost, but they are told,
and their cursor was in there.

The older two-step form still works and is **racy**: plain `version-new` copies
a version and prints its path for you to edit, but the toast offers that copy at
once. If they activate it before you write, your write lands on the active
version. The safeguard puts their text back in the active version, keeps yours
as yet another version, and says so: a `system` event with
`fact: "active.outside"`, whose `preservedAs` is the version that now holds your
text (`preservedPath` its file). **Do not make another version then**: tell them
that version holds your draft.

**3 · Save and Revert are theirs.** There is no verb for either, deliberately.
Your work exists as versions until they accept it.

**4 · Prose goes through a file.** `say --body-file <path>` or `--stdin` from a
quoted heredoc, never as shell arguments — an unquoted heredoc eats backticks
before the CLI sees them. Same for `task`, `version-new`, and
`note --quote '<exact text>'`. `task`'s text becomes the task's title in their
queue, so keep it to a line. `task-done` and `task-status` take their words as
arguments only: keep them short, quoted, and free of backticks. An event's
`hint` writes `say "<reply>"` as shorthand for the verb; the reply still goes
through a file.

**Write `say` in markdown; it renders** in a narrow side panel: keep headings
small and tables narrow. Web links open in a new tab. Write a link to a document
relative to its set (`[the glade](./locations/the-glade.md)`) or as an absolute
path; a path opens any document in their context, while a bare name or a
`type/slug` key looks only in the link's own set. A file outside the context, or
one that does not exist, is reported to them instead. Raw HTML shows as text.

## The loop

```bash
S=<this skill's directory>
bun $S/scripts/cli.ts open ~/notes/chapter-3.md ~/notes/research/
bun $S/scripts/cli.ts tail        # wrap with Monitor, timeout_ms 1800000
```

`open` with no paths adds the folder you ran it from, as a set.

**Keep watching past Monitor's 30-minute cap.** Arm the tail with Monitor at
`timeout_ms: 1800000`. It ends itself just before the cap, and its last line
(`type: "tail.…"`) names your next act. That line's `command` is the verb and
its arguments only, bookmark (`--since`) included, with no launcher and no path.
Always run it with this skill's own launcher, the one you use for its other
verbs: `bun <this skill's directory>/scripts/cli.ts <command>`. A `command` of
`tail --since 12` runs as
`bun <this skill's directory>/scripts/cli.ts tail --since 12`. Never reuse a
launcher path from an earlier line or session: the plugin's directory changes
when it updates. Do what `next` says:

- `monitor`: arm Monitor again with the launcher and `command`.
- `background`: nothing happened; the human is away. Run the launcher and
  `command` as a background Bash task (`run_in_background`). It exits on the
  next event, which wakes you. Handle the event, then follow its line back to
  Monitor.
- `stop`: the session closed or its daemon is gone. Do not re-arm; the launcher
  and `command` bring it back. If you run it, arm the tail again with no
  `--since` (and the session id it prints, where there is one): a restarted
  daemon starts a new event log.

If Monitor expires before that line arrives, re-arm silently with
`--since <the last id you saw>`, written `<id>@<its epoch>` when events carry an
`epoch`. Never re-arm without `--since`: that replays events you have already
handled. If the launcher refuses a `command` with a usage error, its message
names the forms it accepts; fix the arguments to match.

**⚠ Not every line is JSON. Ignore any line beginning with `:` or `#`** — they
are on stderr: keepalives (`: scriptorium-keepalive`) while the stream is quiet,
and status lines starting `# ` while it waits for a session, and a loop that
parses both streams will throw on the first one. stdout is one JSON line per
event, after a first `grounding` line naming the session. Some of your own acts
come back, marked `by: "agent"`: `task.*`, `version.created` and the `system`
facts (a move, a relink, a new folder). They need no answer. Your `say` never
comes back, and your `note-resolve` only on `tail --all` (as `note.resolved`,
`by: "agent"`). Event `id`s skip the events that stay off your tail
(`tail --all` shows them); nothing was lost. `tail --once` prints the next event
and its `tail.*` line, then exits; it is what `background` runs.

**Joining a session late**, read the backlog first: `state` (`chat`, `waiting`,
`notesWaiting`, `tasks`) and `notes` for each document with open notes. Tailing
from `state`'s `cursor` and `epoch` (`--since <cursor>@<epoch>`) skips
everything before it, note events and their hints included.

Every human message arrives on the tail as a `message` carrying `about`: **what
they were looking at**. With a passage selected, that is the passage (`text`,
`fromLine`, `toLine`) with its `doc`, `version` and the `path` of that version's
file; with none, the document they have open; `refs` lists anything else they
pointed at. Read it; do not ask what "this" means. It also carries `via`, the
gesture it came through: `chat` is typed in the composer, and anything else is a
button that spoke for them in a few words (`ask`: a note's **Ask the agent**,
see below; `describe`: describe an image; `fix`: fix a profile warning). Answer
the act the button stands for, not its wording. Then:

```bash
bun $S/scripts/cli.ts version-new --doc <slug, or a PATH if not open yet> --label "tighter opening" --body-file /tmp/draft.md
#   → {doc, version, path, written: true} — it already holds your text; then:
bun $S/scripts/cli.ts say --body-file /tmp/reply.md
```

### Getting a document into the session

**There is no `open-document` verb — expect to look for one.** `open` starts a
SESSION over files and folders; that puts them in the context but does not open
any of them. A document becomes open — copied in as `v1`, with versions you can
write — the first time someone reaches for it: the human by clicking it, you by
naming its **path** to `version-new`.

So for a document the human has not opened, write your text to a file and:

```bash
bun $S/scripts/cli.ts version-new --doc /abs/path/from/the/context.md --body-file <path> --label "…"
```

That opens it and gives you a v2 that holds your text from the start, without
moving their view (Rule 2). Leaving out `--body-file` makes v2 a copy for you to
edit, which is the racy two-step form.

**⚠ `--doc` accepts a slug or a unique filename only for a document that is
ALREADY open.** For anything else it must be an absolute path — a filename gets
you `no document "keeper.md" in this session`. `state` lists what is open
(`docs[].slug`, each with its `original` path) and what is merely in the
context. The refusal's `choices` are the open documents' slugs.

**The path `version-new` prints is never the active one when it is made** — but
the human can activate it a moment later, which is why the one-step
`--body-file` form is the normal way to propose a version.

## What else arrives on the tail

Facts, not chatter. The ones worth acting on:

- **`message`** — they said something, or pressed a button that says it for them
  (`via`). Answer it.
- **`waiting`** — they have been waiting 30 seconds with no reply from you. It
  carries the text they are waiting on. Answer, or `working` to say you are
  still on it (see below).
- **`note.added`** — they annotated a passage, and **expect you to act on it**.
  A short note arrives whole — the passage (`quote`), what they wrote (`body`)
  and its `lines`; a long one says to read it with `notes --doc <slug>`. Answer
  it or propose a version, then **resolve it** (`note-resolve <id>`): resolving
  is what tells them it is dealt with, and the event's `hint` names the exact
  command. If the passage is no longer in the active version, the event says
  `passage: "gone"` instead of giving `lines`. Their rewrite of a note arrives
  as a `system` event with `fact: "note.edited"` carrying what it now says, and
  their reopen as `note.resolved` with `resolved: false`: both are owed an
  answer in the same way. `fact: "note.removed"` means they deleted it.
- **`version.created`, `activated`, `reverted`, `merged`** — what is on offer,
  or which version is active, changed. `activated` matters most: it moves the
  version rule 2 is about.
- **`saved`** — on your tail only when their save may overtake your work in
  flight; `because` says which (`version`, `task`, `note`, or `findings` for a
  profile file).
- **`task.created`** and the other `task.*` events — a task they asked for (pick
  it up), or one in flight that moved.
- **`system`** — a fact about the files or the session, in `fact`, with `text`
  (what the chat said) and, where it matters, `by`. The structural ones are
  `move`, `rename`, `relink`, `set.make` (a document made a set), `folder.add`,
  `folder.create`, `doc.create`, `import`, `trash` and `reveal`.
  `original.missing` and `original.back` say their file went or came back;
  `original.reloaded` says an open document with no unsaved edits changed on
  disk and was reloaded, and `original.conflict` that one with edits did (or
  that it changed while the session was closed). `active.outside` is rule 2's
  safeguard; `manifest.migrated` is under **Older sessions**.
- **`doctor`** — at startup, anything worth looking at in the session, each
  finding carrying the verb that fixes it. Offer; do not silently repair. **It
  says nothing when there is nothing wrong**, so its absence is good news rather
  than a broken tail. Run the `doctor` verb any time to ask directly. Its
  findings' `kind`s: `original.missing`, `context.ghost`, `names.shared`,
  `links.dangling`, `links.unsupported`, `links.heading`, `profiles.*` and
  `relations.*`. Scriptorium has no workspace folder, so it never reports
  `workspace.overlap`.
- **`closed`** — the session ended. The tail follows it with `tail.closed` and
  exits 0. The event and the line carry `by`: `human` (their End session
  button), `agent` (your `close`), or `timeout` (the idle close). A tail started
  after the end prints only the `tail.closed` line, `by` and all. After a human
  or timeout end, a bare `tail` (no `--session`) first waits up to `open`'s
  DEFAULT start timeout (45 s, whatever `--start-timeout` you passed) in case a
  new session is coming up, and binds it if one does; after your own `close`, it
  stops at once. A daemon that dies without `closed` (a crash, a `kill -9`) ends
  the tail with `tail.lost` instead, on stdout, so you hear it. Both name
  `open --restore <id>` as the way back.
- **`by: "human"` means they ended it on purpose.** It is not a crash to repair.
  Stop watching, and do not reopen it unless they ask; wrap up in the terminal
  if there is anything to say. Route on `by`, not on the hint's wording. A verb
  you run on that session afterwards is refused (`not_found`) as "the human
  ended session …", with no `choices`, for the same reason.

**When they say they are done in the chat** ("we're done", "that's all"), run
`close` yourself. The button is a shortcut for saying it; saying it still works.

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
something in the app, resolve it, or rewrite it (`note-edit`), then "may be
stuck" after 30 seconds. `working` covers notes too. There is no nudge for a
note. When one looks stuck, they have an **Ask the agent** button on it, and it
arrives as a `message` with `via: "ask"` and the note's id in `about.noteId`.
**`about.doc` there is the document they have OPEN, which may not be the
note's:** the note's document is the `--doc` in the event's `hint`, which names
the exact `notes` and `note-resolve` commands (or find the id with `notes`). The
note then shows it is with you until you reply, resolve it or `note-edit` it. If
they rewrite it, it is owed again.

## The words that mean something specific

You will meet these in `state` and `help`. Two of them are the kind you can act
wrongly on precisely because you already know the ordinary English word.

- **A SET is a structural unit, not a loose grouping.** It is a top-level folder
  in the context, with an id (`context[].id` in `state`), its own link graph,
  and rules about what may be created inside it. `make-set` is not cosmetic: it
  makes a folder named for a document and moves the document into it. **⚠ If a
  context entry in `state` carries `truncated`, its folder was too big to list
  whole, and every answer about links covers part of it:** `add` a sub-folder as
  a set of its own, or `hide` folders that do not belong. (`graph` and
  `backlinks` also say `truncated` when their own list was cut at its cap.)
- **The CONTEXT is what is in their sidebar** — the documents and sets they
  chose for this session. (Unrelated to `diff --context`, which means lines of
  surrounding text. Same word, two meanings, one of them a flag.)
- **There is no workspace: a new file goes where you name it.**
  `new-doc <folder>/<name>.md`, `new-folder <folder>/<name>` and
  `import <file> --into <folder>` (`--into` is required) each take a place
  inside a set, or a folder in one; name the folder of the document under
  discussion unless they said otherwise. Anywhere else is refused, and the
  refusal names the ways to make a place: `add-folder <path>` (a new empty
  folder anywhere its parent exists, as a new set), `make-set <doc>`, or
  `add <folder>` for one that exists. **⚠ `add-folder` refuses a literal `~`**,
  which arrives unexpanded when quoted or passed from a script: write the full
  path.
- **ACTIVE means two different things in `state`.** `docs[].active` is a version
  number, every document's own, and it is the one rule 2 is about.
  `state.active` (beside `openDoc`) is which document their VIEW is on,
  `{doc, version, path}`, and is `null` before they open anything. A document
  they are not looking at still has an active version; reading `state.active` as
  the only one, under a rule that says "never write the active version", is the
  expensive mistake here.

## Their half, and yours

They have the board: three view modes, a version menu, notes in the margin,
search, and an undo for the context sidebar. You have the verbs. The
capabilities are equal on purpose — you can move, rename, create and organise
exactly as they can — but **do the structural things through the verbs, not
through `mv`**: the verbs announce what you did in the conversation, and a moved
document keeps its versions. A plain `mv` is silent and loses the thread.

**A move breaks links, and fixing them is part of the move.** When it broke any,
`rename`, `move` and `make-set` print `broken` (absent when nothing broke): the
links that pointed at the old place, and the moved document's own relative links
that no longer reach from the new one, each with its `line`, `from` (as written)
and `to` (as it would be rewritten). Offer to update them, and run `relink` when
they agree: it rewrites them all as part of that same act, so one undo puts back
both. `--update-links` on `rename` or `move` does it in one step; `move-plan`
shows what a move would break before you make it. `relink` is refused once
anything else has changed the context's shape, so offer it straight away. Left
alone, the human sees the same offer in their sidebar. Wiki links are never
rewritten. **⚠ `relink` and `link-check` read each document's ACTIVE version:**
a version you proposed before the move keeps the old link and nothing flags it.
Make the move first, or propose that version again afterwards.

**`link-check` checks every link in the session**, in sections. The two you will
meet most are `dangling`, links that answer nothing (each with its source,
`line`, the link as written, `raw`, and where it looked, `tried`), and
`unsupported`, links with a scheme nothing here opens, such as `op:doc/…`. Both
count as problems in `count`, but neither is an error: a world points at things
not written yet, so fix or keep each as the human prefers. Hint sections such as
`symmetry`, `unusedImages` and `leaving` stay out of `count`. Every entry
carries `set`, and `sets` lists the sets the entries come from, `leaving`'s
included, in the order the human's broken-links list groups them. A link to a
folder is not dangling, and links inside code or HTML comments are not links. A
`line` is the line in the text it was read from, the active version for an open
document.

`reveal <path>` shows a file in their file manager, for when they ask where
something is. The system file picker is theirs alone, by design.

## Finding things

`search <query>` searches everything in the context — fuzzy on document names,
exact in the text. **It searches what they are LOOKING at**, which is the active
version of an open document, not necessarily the file on disk. `grep` over their
folder will miss an edit they made two minutes ago; this will not. For one
document you already have, read it or grep it — that is what it is for.

## Older sessions

A session an earlier Scriptorium saved is converted the first time it is
restored (`open --restore <id>`). The first thing on its tail after `ready` is a
`system` event with `fact: "manifest.migrated"`, whose `kept` is the old
manifest, left beside the new one; the chat tells the human the same. A `doctor`
often follows, naming files that went missing while it was closed. Nothing about
how you work with it changes.

## When something is wrong

A failure is one JSON envelope on stderr, stdout empty. **Branch on `kind`,
never on the message.** `choices` names what would have been accepted and `hint`
says what to do — including how to bring back a session whose daemon has exited.

Run `help` for every verb with its flags and a description, and `schema` for the
machine-readable declaration. The verb list is not repeated here.

### Reference: every flag

Every flag the CLI accepts, as a reference list; there is nothing here to read
through. **⚠ Deliberately FLAT: which verb takes which is in `help`, on that
verb's own row.** Grouping them by theme reads as a claim about what they do and
gets it wrong — `--status` looks like it belongs to `task-status`, and it does
not; `task-status` takes a positional and `--status` is a `find` filter.

`--against` `--all` `--body-file` `--bundles` `--by` `--context` `--doc`
`--edge` `--failed` `--focus` `--for` `--format` `--from` `--full` `--heading`
`--hops` `--hunk` `--hunks` `--into` `--kind` `--kindless` `--label`
`--lifecycle` `--limit` `--max-side` `--no-open` `--once` `--parent` `--patch`
`--quality` `--quote` `--rel` `--reopen` `--restore` `--session` `--since`
`--source` `--start-timeout` `--status` `--stdin` `--tag` `--timeout` `--type`
`--untyped` `--update-links` `--via` `--within`

`--session <id>` works with every verb that talks to a session. Without it, a
verb goes to the **newest** session, the one a daemon last started (new or
restored), and only to it: never past it to an older one that happens to still
be running. If the newest has ended or crashed, the refusal says so by name;
pass `--session` for the one you meant.

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
