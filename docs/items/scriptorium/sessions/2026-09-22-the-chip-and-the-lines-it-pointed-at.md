---
type: session
title: "The chip and the lines it pointed at — 2026-09-22"
description:
  Four rendered-mode selection defects Cole's real editing use surfaced, fixed
  in three passes against an independent verifier, plus the ruling that
  dismissing the chip clears the selection itself
tags: [scriptorium, selection, co-presence, verification]
status: stable
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# The chip and the lines it pointed at — 2026-09-22

Part of
[Scriptorium from real use](../../../cycles/2026-09-scriptorium-real-use.md) —
its first branch.

## What this was

Cole had been editing real documents in Scriptorium and wrote the defects up in
Operator (`Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`,
2026-09-20). Seven items became backlog; six became the cycle; the two selection
ones became this branch.

The symptom he could describe: in the **rendered** view, past some point in a
long document, the chat's context chip showed a different passage than the one
he had highlighted — often the last sentence of the document — or the selection
did not register at all. Raw mode was correct every time. He suspected a link,
because the misbehaviour started near one.

## What it actually was

`grimoire/house-style.md` (668 lines) reproduced it, and a probe over
`project()` + `alignRuns` located it without a browser: **run 317 of 987, source
line ~260 — a blockquote followed by a list, one paragraph BEFORE the link.**

Four causes, none of them the link:

1. **`alignRuns` was poisoned by inter-tag whitespace.** Its own comment claimed
   whitespace "simply fails to match and is skipped"; it does not. micromark
   writes three newline text nodes where the projection writes two, so the third
   was searched for and matched a soft line break _inside_ the next list item,
   moving the cursor past real text. The cursor never comes back, so **526 of
   987 runs** then aligned late or not at all. That is the "works before here,
   breaks after" boundary and the "chip shows the end of the document".
2. **A wrapped list item or quote line was one run.** Its source repeats the
   indent or `> ` on every line and its rendered text does not, so the node was
   not `exact` and any offset in it resolved to the whole paragraph. Found only
   by driving the fixed build in a browser.
3. **A run's leading whitespace was charged to the run before it** — and at
   plain offset 0 a `Math.max(0, …)` clamp shifted _every_ offset in the node by
   one. Found by the verifier, on a document whose first block is a task list.
4. **The chip kept state the selection did not.** `ChatComposer` held a
   `dropped` flag reset only on send, so after one X every later selection
   stayed hidden; the daemon — whose held selection `say` attaches — was never
   told; and `MarkdownView` deduped against its own memory of the last resolved
   range, so re-selecting the _same_ passage after a clear reported nothing.
   That last one is exactly Cole's "until I switch to raw mode and back":
   switching remounts the pane and wipes the memory.

## The ruling

Cole, asked whether the X should mean "send without this passage" (per-message,
as built) or "clear the selection" (as the fix made it):

> If you clear the context from the chat, that to me should basically be treated
> as clearing the selection.

and, on the split-view case the fix then opened:

> clicking in either clears the selection, it's the simpler ux pattern

His reason was the model, not the mechanism: one state means less juggling for
the human **and** the agent. The house rule that came out of it — a shared fact
gets one piece of state, mirrored to the daemon, and a second local flag that
hides it is the defect — is in
[the memory](../../../memories/2026-09-22-scriptorium-selection-and-the-chip.md)
and is worth proposing for `grimoire/house-style.md`.

Mechanically: `applySelectionEvent` returns the held selection and whether the
paint should be cleared; `clearSeq` is a command carrying no information about
_what_ was selected, so it cannot disagree with the selection it accompanies.
Both reviewers were asked to judge whether it was a second copy in disguise;
both said command, and said why.

## Review

**Reviewer census** (roster read from the session's available agent types, at
finalize): `feature-dev:code-reviewer` — Glob, Grep, LS, Read, NotebookRead,
WebFetch, TodoWrite, WebSearch, KillShell, BashOutput: **`BashOutput` without
`Bash`**, so it can read shells it cannot start — **rejected on capability
grounds**, it could not have run the suite or reproduced a defect.
`project-docs:gopher-dev` and `doc-reviewer` — "All tools", execution-capable
but shaped for other work. **`general-purpose`** (tools `*`) — chosen, briefed
for this branch, and fresh: neither of the two agents that had worked on it.

Three agents, in sequence, none reviewing its own work:

- **Implementer** — three passes, TDD, own browser drives.
- **Verifier** (no stake, twice) — drove the **committed** bundle in a real
  browser, compared chip lines against `sed -n` on 13 passages, reran its own
  reproductions rather than the implementer's, and tried to break it (repeated
  identical paragraphs, three identical quote+list blocks, nested lists, tables,
  setext headings, frontmatter).
- **Reviewer of record** — net diff only. Executed: `bun test` (2574 pass),
  `bunx biome check --error-on-warnings` (clean),
  `bun scripts/dist-check.ts --no-build` (ARMs 0/1/1b pass), a sweep of **all
  523 tracked markdown files** (183,375 runs: 0 ordering violations, 0
  round-trip mismatches), function-level extraction from the committed bundle to
  compare against source, and **mutation tests** of the new cells in scratchpad
  copies. Verdict: _Ready to merge — with fixes_.

**What each found that the previous one did not** is the argument for the shape.
The implementer's own tests passed while two defects stood; the verifier found
the offset-0 clamp and the sticky context-press flag; the reviewer found that
deleting `alignRuns`' back-off loop — the whole reason a placement is a pair —
left the suite **green**, and that the split-view clear had opened the inverse
of the bug it fixed. The orchestrator re-ran that mutation independently before
landing: **2 fail mutated, 74 pass restored.**

One test defect recurred in a new form and was called out both times: an
assertion that re-derives the value it is checking with the same arithmetic the
code uses. The task-list cells (`runOffset → toSource → src.slice`) are the
honest shape — they ask the **source** what is there.

## Verification

`bun run gate` on the final tree, run by the orchestrator: **2581 pass, 0
fail**, 195 files, ~200 s, exit 0, working tree clean afterwards — so the
committed `dist/` matches source. Zero unplaced runs on house-style (was 526).

## Known residuals, deliberately not fixed here

- **Inline code widens to its backticks** — selecting `inscribe` inside
  `` `inscribe` `` reports the whole span (192 of 3404 words on house-style).
  Pre-existing; **Cole ruled it not worth fixing**: the chip is a pointer to the
  region the agent should look at, not a quotation, and an extra pair of
  backticks costs nothing. Revisit only if a case appears where the widening
  loses meaning rather than adding punctuation.
- Filed as backlog from the review: the stale chip when a rendered selection
  cannot be placed, `e.button === 0 && e.ctrlKey` as macOS-only reasoning, the
  Escape-dismissed-menu residual, the duplicated `useRef` edge-detect idiom
  across both panes, and `align()` re-walking every text node on every
  `selectionchange`.
- Inline code spanning a source line break is still unplaceable (`null` for its
  own run only, ~1 in 1000). Unchanged from `develop`.

## Also learned, for the cycle

The session ran two `tail` watches to their 30-minute expiry. **Neither wake-up
came from Scriptorium**: the daemon's idle close cannot fire while a subscriber
is connected, and both were the harness `Monitor`'s own cap. Re-arming also
replays the session's earlier events. That is measured evidence for the cycle's
branch 5, where the temptation is to delete a timeout that was never firing.
Cole's session was closed on his instruction, not by a timer.
