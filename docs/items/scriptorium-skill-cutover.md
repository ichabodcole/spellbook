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
names a `workspace <dir>` verb Scriptorium does not have.
