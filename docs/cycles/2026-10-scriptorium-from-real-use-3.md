---
type: cycle
title: Scriptorium from real use, round three
description:
  "Three asks from Cole's 2026-10-01 sessions on 5.0.1: the version-new race
  (#117), Diff with one version (#116), and an End session button."
tags: [scriptorium, surfaces]
status: draft
lifecycle: closed
started: 2026-10-01
appetite:
  Stop when the three ship and a no-stake verifier has driven each in a real
  browser; anything that grows a design question is filed, not stretched.
after: []
generated: { by: pdocs, at: 2026-10-01 }
---

# Scriptorium from real use, round three

## Why now

All three come from Cole's own sessions on 5.0.1, on 2026-10-01: the signal this
project waits for before building UI. One (#117) is a race the 5.0.0 new-version
toast made likely, so it is ours to close.

## Scope

- **[item/scriptorium-activate-races-version-write](../items/scriptorium-activate-races-version-write.md)**
  (#117) — `version-new --body-file`/`--stdin`, and a truer safeguard message.
- **[item/scriptorium-diff-with-one-version](../items/scriptorium-diff-with-one-version.md)**
  (#116) — Diff disabled with one version, and an honest message on any other
  route in.
- **[item/scriptorium-end-session-button](../items/scriptorium-end-session-button.md)**
  — an End session control in the top bar; the daemon ends the session after a
  confirmation modal (Cole's ruling).

**Release:** additive; nothing a caller sees changes meaning. (Planned as a
patch; the End session `feat` commits make it a minor, 5.1.0: see Outcome.)

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Options not taken                                                                                                                                                    |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-10-01 | #117 is fixed at the source: `version-new` takes the content, so no unwritten copy is ever offered; plus a truer safeguard message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Toast only once the copy changes (hides the race, and a deliberate unchanged copy is a real use).                                                                    |
| 2   | 2026-10-01 | **Cole's ruling on End session:** the daemon ends the session itself, and the agent learns from `closed` (marked as ended by the human). A confirmation modal in the browser guards against a stray click; no agent round trip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The button asks the agent to close (never closes if the agent is gone); confirm through the agent (slower than typing); no confirmation (a stray click ends it).     |
| 3   | 2026-10-01 | Reviewed by Cole in Scriptorium session 12e4c09d: all three items good to go. **His rulings on End session, part two:** after the end, no lock-out and no new page, but the status reads "Session ended" and stops retrying (today it would say "daemon unreachable — retrying" forever), and the modal warns about unsaved edits. The agent must know the end was intentional, so `closed` says the human ended it and not to reopen unless asked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Leave the page as is (Cole's first instinct: it already shows a disconnect, but the daemon itself is gone, so it would read as a fault); bar the page after the end. |
| 4   | 2026-10-01 | Two implementers in parallel, split by area: one on #117 (`version-new` body flags, safeguard message), one on #116 + End session (surface, the close path). Both touch `SKILL.md` and maybe `protocol.ts`/`cli.ts`, so each keeps those edits small and the lead resolves overlap at integration. Then one no-stake verifier in a real browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | One per item (End session and #116 share the surface); one for all three (serial).                                                                                   |
| 5   | 2026-10-01 | #116, implementer's call, accepted: Diff is disabled only when nothing can differ (one version, no unsaved edits, file unchanged on disk). One version with unsaved edits, or whose file changed on disk, really differs from the file, and the changed-on-disk banner's "See the difference" needs that view. Told to Cole.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Disable whenever there is one version (the item's wording; would break the banner's diff).                                                                           |
| 6   | 2026-10-01 | End session, lead's follow-up: after a deliberate end, every control that needs the daemon is disabled or says the session ended (composer, Save, Revert, version menu; the raw editor goes read-only). One `ended` flag drives all of it. This is the same fact as "Session ended", so it sits inside Cole's "two small changes", not beside it: a control that silently does nothing was the defect. `closed.by` is `human`, `agent` or `timeout`; the tail line is built in the shared kit (`tailWithHandoff`'s optional `closedBy`).                                                                                                                                                                                                                                                                                                                                                                            | Leave Save/Revert/composer live and inert (they lie); lock the whole page (Cole ruled against).                                                                      |
| 7   | 2026-10-01 | #117, implementer's first cut changed `say`/`task`/`note`/`note-edit` to answer a missing `--body-file` as `not_found` (5) through the one shared reader. Reversed for this cycle: the four keep `usage` (2), pinned by a test, and only `version-new` answers 5. A caller-visible exit-code change belongs in a breaking-changes note, not a patch; filed to the reply-shape cycle. Their refusals now name their own verb (they all said "say"). The safeguard's case is decided by content (still equal to the copy at activation), not a time window.                                                                                                                                                                                                                                                                                                                                                           | Ship the 2→5 change now (forces a major or a silent break); a "shortly after" time window (a magic number, and wrong when the human waits).                          |
| 8   | 2026-10-01 | Integrated on the cycle branch: source commits cherry-picked, implementers' dist commits skipped, one rebuild (`318faa89`). Gate 3159 pass, 0 fail. The acc batch is re-recorded once on the committed build (the implementer's was stamped `-dirty`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Keep the implementer's recording (stamp would lie about its build).                                                                                                  |
| 9   | 2026-10-01 | No-stake verifier in its own Chromium: 9 of 10 claims **held**; `by:"timeout"` is unreachable while a tail is attached (an attached tail keeps the session alive, by design). Of its surprises, six are fixed in this cycle, being its own classes or regressions: the refusal after a human end names a different, live session and invites a reopen; search and map spin forever after an end; a human flip-flop (activate, switch away, switch back) loses the `activatedBeforeWritten` flag; the human's chat shows the agent-directed safeguard text with an overflowing path; `--body-file <dir>` is an internal error; the ended End session button keeps its old title. The rest are filed to [scriptorium-chat-and-toast-nits](../items/scriptorium-chat-and-toast-nits.md) (kit modal focus trap, `--doc` choices, phone width, Compare tooltip by keyboard).                                             | Fix all (the focus trap is kit-wide and predates the cycle); fix none (two are regressions of this cycle's own features).                                            |
| 10  | 2026-10-01 | Second no-stake verifier on the six fixes: five **held**, and nothing from the first round regressed. One more small round for four findings in this cycle's own features: the #117 flag still fires after the human typed in the version (a false message to both parties); a tail re-armed after a human end drops `by` and invites a reopen; the human's safeguard lines don't name the document; an unreadable `--body-file` is `internal` (the directory case's sibling). Filed to [scriptorium-chat-and-toast-nits](../items/scriptorium-chat-and-toast-nits.md): `internal` with no restore hint after a crash, and search spinning on a killed daemon (both predate the cycle's ended state). **Incident:** the verifier's crash test picked a PID with `grep server.ts` and killed one of Cole's StoryStudio atlas daemons; reported to Cole, and briefs now require matching a PID by our own session id. | Close the cycle with the typed case open (it tells both parties something false); fix the crash-path findings here (pre-existing, outside the appetite).             |
| 11  | 2026-10-01 | Third no-stake verifier (brief forbade killing anything it did not start; it killed nothing): all four final fixes **held**, and the regression pass held. Its five findings are smaller or predate the cycle (a bare `tail` that retries forever after an end, same-named documents, a double `saved` on ⌘S, a folder-unreadable body file, `cursor: -1`): filed, per the appetite. acc batch re-recorded once more on the final build (`5236d930`, stamps only; census 0 disagreements). Cycle closed.                                                                                                                                                                                                                                                                                                                                                                                                            | A fourth fix round (the appetite: three items shipped and driven; the rest is filed with its repro).                                                                 |

## Outcome

Closed 2026-10-01. All three items shipped, and three no-stake verifiers drove
them in their own headless Chromium on the committed build under a scratch home.
The last round's every claim held. Gate at the final integration: 3188 pass, 0
fail.

**Shipped.**

- **#117, the version race.** `version-new --body-file <path>` and `--stdin`
  create a version already holding the agent's text, so the new-version toast
  never offers an unwritten copy. Verified with Activate clicked 36–80 ms after
  the toast. The skill teaches the one-step form.
  - The older two-step form still works and is still racy. When the human
    activates an unwritten copy, the `active.outside` event carries
    `activatedBeforeWritten: true`, and its agent text says what happened and
    not to create another version. The flag is decided by content, not a time
    window: it survives switching versions back and forth, and clears once
    anyone writes the version.
  - Outside-write lines in the human's chat are their own short lines, naming
    the document; the agent-directed text stays on the tail event.
  - Refusals: `--body-file` and `--stdin` together, an empty body, a directory
    and an unreadable file are `usage` (2); a missing file is `not_found` (5)
    for `version-new`. `say`/`task`/`note`/`note-edit` keep `usage` (2) for a
    missing file (row 7) and now name their own verb.
- **#116, Diff with one version.** Compare is disabled when nothing can differ
  (one version, no unsaved edits, file unchanged on disk), with "Only one
  version — nothing to compare". Every other route in says the same, never
  "identical".
- **End session.** A top-bar button, reachable by keyboard, opens a confirmation
  modal that warns about unsaved edits; confirming ends the session through the
  daemon (Cole's rulings).
  - `closed` carries `by: human | agent | timeout`, and the session manifest
    records it.
  - The agent's tail, live or re-armed with `--session`, ends on `by: "human"`
    with "the human ended this session on purpose; do not reopen it unless they
    ask". A refusal on that session says the same and names the right session.
  - The page reads "Session ended" and stops retrying. Content stays viewable,
    and every control that needs the daemon is disabled or says the session
    ended. Closing the tab ends nothing.

**Release:** 5.1.0, a minor: the End session commits are `feat`, so
release-please bumps the minor (the plan said "patch"; corrected at the
release). New optional flags (`version-new --body-file/--stdin`), additive
fields (`closed.by`, `activatedBeforeWritten`, manifest `ended`), and one new
surface→daemon command (`session.end`). No caller-visible code changes meaning.
Close #116 and #117 when released.

**Falsified or corrected.**

- Cole's first instinct, that the page needed no change after an end, missed
  that ending stops the daemon itself (row 3).
- The first #117 fix tracked the unwritten copy until activation, then until a
  write. A human flip-flop, then a human typing in the version, each made the
  flag lie; it is now cleared by any change to the content (rows 9–10).
- An implementer's first cut changed three existing verbs' exit codes inside a
  patch (row 7).

**Learned.**

- Three verifier rounds each found real defects in the previous round's fixes,
  shrinking from six to four to none in scope. Asking for "one shape the author
  did not think of" per claim is what found the flip-flop and the typed case.
- **A verifier killed a process that was not ours** (one of Cole's StoryStudio
  atlas daemons) by picking a PID with `grep server.ts`. Briefs that may kill a
  process now require matching it by our own session id; the third round's brief
  carried that rule and killed nothing.

**Carried over** (filed, none scheduled):
[scriptorium-chat-and-toast-nits](../items/scriptorium-chat-and-toast-nits.md),
which gains the three verifiers' remainder: the kit modal's focus trap, a bare
`tail` that retries forever after an end, same-named documents with identical
lines, a double `saved` on ⌘S, crash-path refusals with no restore hint, and
phone width. The `say`/`task`/`note` exit-code alignment is in
[spell-refusal-envelope-nits](../items/spell-refusal-envelope-nits.md).

## Sessions
