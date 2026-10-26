---
type: item
title: Port Story Studio's via and refs into the kit daemon
description:
  'Port the workspace half of Story Studio''s bbc54fd (a message''s via and
  refs) and of 4e6d4d4, and move the one-ask guard from about.ask to via: "ask".'
status: stable
lifecycle: done
id: 01a1478f-325f-7538-8b08-92d7bd9f7ca2
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# Port Story Studio's via and refs into the kit daemon

Story Studio landed `bbc54fd` after our port base. A message now says which
gesture sent it (`via`: `chat`, `describe`, `fix` or `ask`) and what it draws on
(`refs`). It also landed `4e6d4d4`, which saves an edit overtaken by the agent's
version switch where it was typed. Both touch `packages/kit/src/workspace` as
well as the panes. This item ports the workspace half of each, so cycle 3 ports
panes onto a daemon that already speaks the current wire.

Cole's rulings in Story Studio apply: `KIT_VIA` is `chat`, `describe`, `fix` and
`ask`; buttons don't carry held refs; tree refs mark the chip; there are no
folder refs; and only modifier-selected rows count as refs.

`0ff5698` (a pending edit sent before a version switch) touches only the context
and document panes, so it goes with cycles 3 and 4.

**Done and verified (2026-10-16).** Ported by hand on `impl/kit-port-via-refs`
in three kit commits and one for the flagged Scriptorium:

- `messageParts.ts`, `via` and `about.refs` on the wire, the subject a page
  names (`about.path`), `contextDocEach`, and `say --via`;
- the one-ask guard on a human's `via: "ask"`, with `about.ask` removed;
- an edit overtaken by a switch, saved where it was typed (`LATE_EDIT_MS`,
  `editLeft`).

Removing `from === "human"` from `askOutstanding` turns three tests red (two
unit cells and a daemon cell). So does counting any `via` (two unit cells), or
arming the daemon's check on any `via` (two daemon cells), or on a
case-insensitive `"ask"` (one daemon cell). Removing the version check from
`switchLeaving` turns one `editLeft` cell red: an edit to a version the switch
did not leave. The kit and Scriptorium suites pass. acc is conformant for both
CLIs. The default path's help, every verb's help, schema, boot errors and a
scripted session with its tail are byte-identical to `cycle/wiki-layer` after
masking ids, ports and times.

### Differences from Story Studio

- **The agent's `via` of the wrong type is refused with a 400.** Our `/cmd`
  field checks (`checkAgentCmd`) refuse a field of the wrong type before
  anything runs. Story Studio reads it as absent.
- **The daemon's ask check needs a string `noteId`.** Story Studio's needs only
  a truthy one. Hardening, the same in effect for any page that sends one.
- **The agent's `say` drops a non-string entry id on its own.** Ours used to
  drop the whole list. This is Story Studio's hunk on the same rule, taken to
  converge; nothing here pinned the old way.
- **`4e6d4d4`'s tests are client tests** (`context/daemonClient.agentSwitch`),
  and this kit has no client yet. `editLeft.server.test.ts` drives the same
  cells through the socket instead, plus two: a version the human makes and
  moves into counts as a switch, and an edit to a version the switch did not
  leave is refused within the window.
- **Test cells kept beside Story Studio's:**
  - the agent's `say` with `via: "ask"` leaves the human's first ask free;
  - no other `via` (an app's, or a case variant such as `"Ask"`) is an ask, in
    the guard and in the daemon; surrounding spaces are trimmed on arrival
    (`cleanVia`), so a human's `"ask "` is stored as `"ask"` and is guarded, as
    in Story Studio;
  - a system line is never an ask;
  - a message about a note with no `via` is typed.
- **Test plumbing:**
  - `context.add` frames send `path`, our client op, not `paths`;
  - `noteAsk.server.test.ts` seeds its documents beside the workspace, as ours
    always has;
  - `MAX_REFS` names Story Studio's chip cap in words, since there is no shell
    here.
- **The flagged Scriptorium's acc census is re-recorded.** Only `say`'s record
  changed, which now lists `--via`.

Our own differences are untouched by these hunks: lowercased relation names,
`NODE_ENV` read through a parameter, `refuseScriptorium` and the manifest
guards, the `/cmd` field checks and the scratch-home preload.

Not ported: the context, document, chat and shell halves; the Atlas and Sound
Stage changes; `0ff5698`.

## Definition of done

- [x] The workspace files of `bbc54fd` and `4e6d4d4` are in `src/kit/workspace`,
      with their tests. Each difference from Story Studio is named in this item,
      with the reason.
- [x] The one-ask guard (`askOutstanding`) arms only on a human's `via: "ask"`.
      `about.ask` is gone from the wire, the guard and the tests. A test fails
      if the guard counts an agent's message or a non-ask `via`.
- [x] The flagged Scriptorium passes its suites and acc on the new wire. The
      SKILL delta in `scriptorium-on-kit-daemon` is updated for `via` and
      `refs`.
- [x] The default path is unchanged (no diff in help, verbs, a scripted tail or
      boot errors).
