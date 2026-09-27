---
type: item
title:
  "`bounty tail` retries forever at exit 0 when its target can never resolve"
status: stable
description:
  Fix bounty tail infinite retry loop when target board or list becomes
  unresolvable
lifecycle: review
id: 019feeaa-e8f2-7b85-9125-2ff933299875
kind: task
generated: { by: unknown, at: 2026-08-10 }
cycle: 2026-09-filed-is-not-fixed
parent: feature/spell-hardening
---

# `bounty tail` retries forever at exit 0 when its target can never resolve

**Filed:** 2026-08-10 · **Status:** open, unsized · **Board card:** `s5-6` ·
**Canonical source:** GitHub issue **spellbook#98** (inbound, anthill team,
2026-08-08) · **Scope ruling:** OUT of sprint 05 — a fix, not a gate

> ⚠ **RELAY, and this file is deliberately a POINTER rather than a record.**
> **spellbook#98 is the source of truth for this defect.** It came from another
> team with their own trace and their own cost attached, and this repo's routing
> is that **issues are inbound from other teams; our own findings go to
> `docs/backlog/`.** Restating their measurements here would mint a second
> account of one defect that is then free to drift from theirs — the failure
> this team corrected four times in one session. **Read the issue.**
>
> This file exists for one reason: the finding needed a home in the tree that
> outlives a session, and a reader sweeping `docs/backlog/` should not conclude
> from its absence that nobody knows.

## What it is, in one paragraph

**TAKEN ON REPORT (anthill team, via spellbook#98):** a `bounty tail` that
resolves no board retries forever, exits 0, and looks alive — printing the same
undifferentiated line as a legitimate wait. It cost the reporter 40 minutes of a
measurement run.

Two states must not print the same thing, and today they do:

| state                                               | correct action                  |
| --------------------------------------------------- | ------------------------------- |
| the board is not up **yet** (unpinned tail waiting) | **wait** — the retry is right   |
| the caller **named** a target that cannot resolve   | **fix the cwd/key and restart** |

An explicit `--session` is pinned up front, and an explicit `--session-key`
re-derives the same wrong id every iteration (the key is project-scoped and
hashes cwd — which is correct, and is the point of #69). **Neither will ever
resolve.** The loop is identical either way, the message goes to stderr, and
nothing ever exits non-zero, so nothing supervising can notice.

## Why it is filed here at all rather than only as an issue

It is this project's own thesis arriving from outside. Sprint 04's thesis was _a
consumer must be able to distinguish "nothing is there" from "I cannot tell
you."_ #98 is that sentence, found independently by a team that has never read
the roadmap, **in our tool**, with a cost attached.

That distinction matters for the arc's evidence base: _"our thesis generalises"_
is a claim about us and is testimony; _"an unrelated team independently hit our
thesis in our own tool and lost 40 minutes"_ is an artifact with an issue
number.

Their line, worth keeping verbatim:

> `ps` is not evidence a tail is attached; received bytes are.

## What is deliberately not here

Their ask names two changes and says the first is sufficient alone. **They are
not reproduced here.** They live in #98, they are the reporter's to state, and
copying them into a second document is how the two versions start disagreeing.

## Fixed (2026-09-27)

On branch `fix/bounty-tail-named-target`, per the sprint 06 ruling (`#98` row of
`docs/features/spell-hardening/sprints/06-filed-is-not-fixed/plan.md`) and the
re-measure. What `tail` does now when its board does not resolve:

- **Every retry line names what it looked for.** The session id and where it
  came from: `--session`, a key plus the cwd (and scope root) it was derived
  from, `$BOUNTY_SESSION`, a `.bounty-session` file, or the latest-board
  pointer's path for an unpinned tail.
- **A named target gives up.** `--session <id>` or `--session-key <key>` that
  has not resolved after `NAMED_TARGET_GRACE_MS` (5 s, checked at each retry, so
  about 7.75 s with the kit's backoff) exits **5** with bounty's `not_found`
  envelope. Its message carries the same "looked for" text, and its `hint` names
  the fix. There is no `--grace` flag. `BOUNTY_TAIL_GRACE_MS` overrides the
  grace for the test suite only and is deliberately undocumented.
- **"Never existed" is no longer called "closed".** A `--session` whose board is
  not running is told apart by its snapshot: the daemon writes
  `$BOUNTY_HOME/snapshots/<id>.json` on every close and keeps it. With a
  snapshot the tail ends `tail.closed` at exit 0 as before (`b0174d9f`'s re-arm
  stop). Without one it takes the named-target path above, never prints
  `tail.closed` and never offers `open --restore <id>`. A deleted snapshot looks
  the same as a board that never existed, so the wording says "no session <id>
  found" and does not claim which.
- **An unpinned tail keeps waiting**, including one whose key or id comes from
  the environment or a `.bounty-session` file (an anthill seat's first arm).

Tests: `src/bounty/backend/tail-handoff.integration.test.ts` (the `#98` cells
and B1) and `src/bounty/backend/server.test.ts` (`resolveSessionSource`).
