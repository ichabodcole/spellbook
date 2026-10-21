---
type: item
title: The Scriptorium SKILL describes the kit's contract
description:
  Rewrite the SKILL to the kit's verbs, flags, events and refusals, so an agent
  reading only the SKILL drives a session on the flipped build; lands before
  Cole's trial.
status: stable
lifecycle: backlog
id: 01a15b3a-27c0-706a-8a19-5ca5ca424431
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium, skill]
cycle: 2026-10-cutover
parent: feature/workspace-kit
from: cycle/2026-10-cutover
blocked_by: [01a15b3a-2716-70a6-872a-d30f3aad2a2c]
---

# The Scriptorium SKILL describes the kit's contract

`plugins/spellbook/skills/scriptorium/SKILL.md` still describes the shipped
Scriptorium. After the flip, an agent reading it would be told about verbs,
flags and events the default no longer has. The survey of 2026-10-20 listed each
passage with what it becomes. Most are a change of vocabulary:

- `about` and `via` on the human's messages, and how to tell a typed question
  from a button press;
- the note events and `system` facts (`note.edited`, `set.make`, `folder.add`,
  `manifest.migrated`);
- `link-check` in place of `dangling --entry`, and `relink` after a move;
- the WORKSPACE entry replaced by "name where every new file goes", with
  `add-folder`, `make-set` and `import --into`;
- `reveal` as an agent verb, 21 new flags, and `--entry` gone;
- a verb with no `--session` going to the newest session only, and the refusal
  when the human ended it;
- a stalled note's "Ask the agent";
- older sessions converting as they open.

One passage is wrong, not just renamed: rule 2 promises `active.outside` with
`activatedBeforeWritten: true`, which the kit's fact doesn't carry. It is
reworded around `preservedAs`.

This lands before Cole's trial, so the agent in that trial reads the contract it
is actually running.

## Definition of done

- [x] Every passage in the survey's list is rewritten, and every verb and flag
      the SKILL names exists in the CLI's `schema`.
- [x] `tail-rule-parity` and `shipped-skill-references` are green.
- [x] A cold agent given only the SKILL drives a scratch session end to end:
      open, tail, answer a message with a version, resolve a note, `link-check`,
      relink after a move, and close.

## Done and verified

Commits on `impl/scriptorium-skill-cutover`: the SKILL rewrite with the coupled
ward and golden (`docs(scriptorium): the SKILL describes the kit's contract`),
and this record.

- **Checked against the CLI as it runs by default**, not the survey alone:
  `help`, `schema`, and a scratch session driven over the websocket (a typed
  message, a selection, a note, Ask the agent, a human rewrite, the racy
  two-step into `active.outside`, a move, `relink`, `link-check`, the `~`
  refusal, `reveal`, newest-session routing past an older live session, and the
  ended-by-human refusal). Three survey rows read differently on the running
  build and the SKILL follows the build: `state.active` is
  `{doc, version, path}`, not a slug; a message's selection is
  `fromLine`/`toLine`, not `lines`; and the `--doc` refusal's `choices` are open
  slugs, not paths.
- **Every verb and flag the SKILL names is in `schema`**: a scratch checker
  (every `--flag`, each verb+flag pair on a command line or span, and every span
  that opens with a verb-shaped word, against a reviewed list of fields and
  event names) passes on the new SKILL and fails on the old one (`--entry`,
  `workspace`). The flat list is the kit's 47 flags.
- **The flag ward moved with the SKILL** (`grimoire/flag-invariant.test.ts`).
  Its source scan reads the `defineCli` in `backend/cli.ts`, which after the
  flip is the earlier Scriptorium behind the hatch; the default's flags come
  from the kit's options table, which a text scan cannot follow. The ward now
  takes Scriptorium's table from the kit CLI itself (`DEFAULT_TABLE`), as its
  kit-registry cell already does for imports. It goes with the shipped CLI.
- **The documented golden follows the SKILL**: regenerated from the SKILL's
  commands at their lines (prose mentions of a bare verb, the `version` field,
  `diff --context` and `task-status` excluded with reasons), and the golden
  re-captured: 198 to 206 invocations, no recorded behaviour changed;
  `workspace` and `workspace <dir>` are gone, `link-check`, `graph`,
  `backlinks`, `new-doc`, `new-folder`, `import --into`, `add-folder`,
  `make-set` and `add` are in.
- **Cold read**: a fresh agent given only the SKILL drove a scratch session end
  to end (tail, a version answering the selected passage, a note acted on and
  resolved, `move`, `relink`, `link-check` at 0, `close` with `by: "agent"`).
  Its stumbles, each fixed in the SKILL: `relink` and `link-check` read only
  active versions, so a version proposed before a move keeps the old link (now a
  warning); the hints' `say "<reply>"` against rule 4; the `grounding` line,
  sparse ids and `state` as the backlog; `sets` empty when nothing is broken; a
  tail started after the end prints only `tail.closed`. No re-read was run.
- **Deliberately left out**: `SCRIPTORIUM_SHIPPED` (a temporary hatch), and the
  survey's extras on symlinked notes and `meta-set` in `$SCRIPTORIUM_HOME`.

**Found, not fixed here**: a proposed version is not relinked by a move, and
nothing flags it (above); and the kit's `workspace.overlap` doctor fix still
names a `workspace <dir>` verb Scriptorium does not have (filed as
`kit-doctor-overlap-fix-names-missing-verb`; the SKILL says to ignore that fix).

**After the no-stake verify** (a second commit for the kit, a third for the
SKILL): the verifier ran the SKILL's claims against the build and found ten
wrong or missing. Each is fixed:

- an Ask the agent message's `about.doc` is the OPEN document; the note's is the
  `--doc` in the `hint`;
- a bare `tail` after the human ended the newest session waited forever
  (`# no session yet, retrying...`) while every other verb refused. Fixed in the
  kit, below; the SKILL's stderr rule now covers `#` status lines;
- `link-check`'s `sets` names every set its answer names, `leaving` included;
- `broken` is absent when nothing broke, and also carries the moved document's
  own relative links;
- the `system` facts `relink`, `folder.create`, `reveal` and
  `original.reloaded`;
- `task-done` and `task-status` take their words as arguments only, and `task`'s
  text is the title;
- dangling and unsupported links count in `count`, and are still not errors;
- `tail --once`, joining late from `state.cursor`/`epoch`, and the agent's own
  `by: "agent"` events on the tail;
- trims: the link-check paragraph moved beside the move paragraph, the link
  paragraph shortened, the flag list labelled as a reference (the flag ward
  needs every flag named), and rule 1 now true of `move`, `rename`, `make-set`
  and `relink` writing to disk.

The documented golden was regenerated for the moved lines (207 invocations; no
recorded behaviour changed against the fixture before this item).

## Port-back notes

- **`src/kit/workspace/verbs.ts`, `cmdTail`'s `onUnresolved`:** a bare `tail`
  (no `--session`, no `--since`) that finds no live daemon re-reads
  `newestSession()` on every retry, the rule every other verb routes by, so a
  session that comes up is bound. When the newest session's manifest records an
  end (`ended.by`, any of human, agent or timeout), the tail waits that end out
  through a grace window before it binds to it and stops; the handoff then
  prints `tail.closed` with that `by` and the session's `open --restore`
  command, exit 0, as `tail --session <id>` already did. **Why the window:** a
  daemon `open` is starting (a new session, or a restore of the ended one)
  records itself as the newest only once it is up (`recordLastOpened`, after
  `publishPointer`), and an agent often arms the tail and runs `open` together.
  The first cut of this fix (`c97b343b`) stopped at once and so stopped on the
  old session in that race; a second verifier's harness reproduced it at every
  offset from -1000 to +50 ms. The window is `open`'s default start timeout (45
  s, `DEFAULT_START_TIMEOUT_MS`), configurable as `tailEndedGraceMs`; the window
  restarts if the newest session changes, and a newest session with no end, or
  none at all, is waited on as before (`# no session yet, retrying...`). A
  status line says the wait once:
  `# session <id> was ended (by <by>); waiting <n>s for a new one before stopping...`.
  Story Studio's tail has the same `onUnresolved`; weigh it against its
  single-project routing.
- **The help footer** now says tail's stderr carries `#` status lines beside the
  `:` keepalives (a reader skips both), and that a tail with no `--session`
  follows the newest session and ends 0 with `tail.closed` once that one has
  ended and no new one came up within `open`'s start timeout.
- **Tests** (`verbs.test.ts`, on the fixture CLI with the window shortened): the
  human-ended newest stops after the window, never the older live one; the
  agent- and timeout-ended newest stop with that `by`; a session that comes up
  0, 300, 1200 or 2500 ms after the tail is armed is bound; a restore of the
  ended session inside the window is bound; an older ended session beside a
  newer one with no end is waited on (newest only); a newest with no end is
  waited on; an empty home is waited on. Mutations, each red then restored
  byte-equal: no window; stop only on `human`; stop on any ended session; stop
  on any newest session, ignoring `ended`.

- **An end `by: "agent"` skips the window** (a third verifier's round): the
  agent closed that session itself, so a bare tail stops on it at once; human
  and timeout ends keep the window. `DEFAULT_START_TIMEOUT_MS` is exported, and
  the CLI exposes its effective window as `cli.tailEndedGraceMs`, so a test pins
  the default (45 s, never 0). The help footer says the window is `open`'s
  DEFAULT start timeout, from the constant, and that an agent end stops at once.
  More tests: the window restarts when the newest session changes, and the stop
  names the new one (timed past the retry backoff, 0.25 s doubling to 5 s); the
  agent end stops well inside a 20 s window; the timeout end waits its window.
  Mutations, each red: no restart on a new newest; the newest read once and
  cached; the window timed from the first sighting; a default window of 0; an
  agent end that waits the window. **Weigh before porting:** an agent that runs
  `close`, then `open` and a bare tail together, now gets `tail.closed` about
  the session it closed rather than the new one; arming the tail after `open`
  returns (or with `--session`) avoids it.

**Left as it is, deliberately:** `tail --since N` with no `--session`, when the
newest session has ended, prints `tail.closed` with no `by` (a re-arm never
reached the session, so the handoff has no session to read the end from).
