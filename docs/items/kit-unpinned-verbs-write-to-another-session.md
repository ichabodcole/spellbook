---
type: item
title: Verbs without --session silently write to another live session
description:
  "GitHub #137: a verb without --session targets the newest session, so once a
  second session opens, an agent's writes land in another project and return ok:
  true. A data-safety bug."
status: stable
lifecycle: active
id: 01a1eabe-efdc-746b-95b1-9e7900a7e0eb
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, sessions, cli]
parent: feature/workspace-kit-follow-ups
source: "#137"
priority: urgent
cycle: 2026-11-research-and-safety
---

# Verbs without --session silently write to another live session

Filed as GitHub #137. **This is a data-safety bug.** An agent's messages went
into another project's session, and nothing told it.

An agent in one Scriptorium session posted with `say` and no `--session`. The
human then opened a second session, for another project and another agent. Every
verb without `--session` targets the most recently started session (the
`<spell>.latest.json` pointer, `src/kit/wire/discovery.ts`). So the agent's next
five `say` messages landed in the other session, each answered `{"ok": true}`.
Its tail had pinned `--session`, so it kept reading the right session and saw
nothing wrong. The other agent saw messages that weren't its own. Not reproduced
here yet. The issue's repro: open A, open B on another folder, run `say` without
`--session` from A's agent.

The write verbs live in `src/kit/workspace/verbs.ts`, so every kit spell has
this, not only Scriptorium.

**Suggested fix (from the issue):** when more than one session is live, refuse
any verb that writes to a session (`say`, `task`, `task-done`, `working`,
`version-new`, `note-*`, `add`, `hide`, `close`, …) without `--session`. Use the
usual envelope: kind `ambiguous_session`, `choices` listing the live session ids
with their sets, and a `hint` naming `--session`. Reads may stay lenient.
Optional: `open` prints the session id prominently, and write replies name the
`session` they went to.

Related: [scriptorium-session-identity](scriptorium-session-identity.md).

## Definition of done

- [ ] With two live sessions, a write verb without `--session` is refused with
      `ambiguous_session` and the live choices. With one, it works as now.
- [ ] Write replies name the session they went to.
- [ ] Tested with two live sessions. The SKILL says when to pass `--session`.
- [ ] #137 answered and closed once released.
