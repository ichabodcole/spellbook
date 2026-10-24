---
type: session
title: "Polish cycle: small fixes before the release"
description:
  "Ran the polish cycle: 20 small items from Cole's trial, the verifiers and the
  Atlas comparison, each built by an implementer and checked by a no-stake
  verifier, then closed on a green gate."
tags: [kit, scriptorium, cycle]
status: stable
generated: { by: claude-opus-5-5, at: 2026-10-23 }
---

# Polish cycle: small fixes before the release

## Context

[The polish cycle](../../../cycles/2026-10-polish.md) cleared the small items
left after [the cutover](../../../cycles/2026-10-cutover.md), so the next
release ships without them. Cole approved 16 items, added
`kit-drop-keep-where-it-is`, and later pulled in three flaky-test items. The
lead orchestrated; each item went to an implementer in its own worktree, then to
a verifier who had no stake in it, and then onto `cycle/polish` by cherry-pick
or fast-forward.

## What Happened

- **Wave 1** (2026-10-22) ran six implementers in parallel: theme, context pane,
  document pane, links, daemon and shell. Each item took two or three verifier
  rounds. The ward batch and the Atlas polish followed.
- **The theme was held.** Mapping the kit's violet to rubric put rubric where it
  reads as danger or deletion: the stable chip, Cmd-clicked rows (which breaks
  E40) and the compare marks. Cole picked every replacement from an HTML mock-up
  page (Ruling 7). The kit got optional theme hooks that fall back to today's
  values, so other spells paint identical pixels.
- **The broken-links sign got two more rulings from its verifier's findings:**
  counted entries come first in its list, and the quiet mark carries a faint
  word.
- **Flaky tests became cycle work.** Cole pulled in `Frame.test`'s act() stall.
  Its cause was a test wrapper that handed the shell a new `send` on every
  render, so the page and the daemon bounced `open`/`state` frames at each other
  until unmount. Then the gate failed watch-dependent tests, and a first loop
  suggested the cycle had made them worse (9 of 20 against 3 of 20). Interleaved
  runs showed it hadn't (11 of 30 against 9 of 30). The real cause was a probe
  that said "watch live" because the listing scan, not the watch, had seen its
  file. The fix landed in this cycle (`kit-watch-tests-unproven-watch`).
- **The last gates were red from load.** `fseventsd` sat at about 100% CPU from
  other sessions' suites: 29 timeouts in one run, of which 12 of 13 files passed
  alone, and the 13th was flaky on `develop` at the same rate. Once Cole stopped
  the process loading it, the gate passed: 6234 pass, 0 fail, 624 s.

## Notable Discoveries

- **A build under `NODE_ENV=test` drops Tailwind's banner,** churning every
  spell's css and failing `dist-check` (which CI runs). An implementer's runner
  set it for browser checks and then ran the gate through the same runner. The
  common brief now says to set it only for browser and daemon runs.
- **Tailwind 4 keeps the light-mode `@supports` copy only for the first
  `color-mix()` in a rule,** so each mixed theme hook needs a rule of its own.
- **The verifier corrected "users aren't affected" for the watch race.** An
  agent can write within a watch's arm window, and `save()` never compares the
  original's hash, so a missed outside change can be overwritten silently. Filed
  as `kit-save-overwrites-unseen-change`.
- **A comparison loop on a shared machine measures the machine.** Run the two
  trees interleaved, and check `fseventsd`'s CPU before blaming a branch.

## Follow-up

Filed in triage under the feature:

- `kit-save-overwrites-unseen-change` (product)
- `spellbook-parallel-tests`: run the suite in parallel, after Story Studio's
  move from 180 s to 22 s
- `kit-links-check-watch-cells-timeout` and
  `scriptorium-suggestmeta-test-context-wait`, the remaining load flakes
- `kit-usedaemon-stable-functions-test`
- `kit-atlas-context-sort` (L5, for the next Story Studio sync)
- `kit-chat-image-drop` and `scriptorium-link-rules` (deferred by Cole)
- `kit-raw-save-converts-crlf`, `kit-lone-cr-line-endings` and
  `kit-context-menu-keyboard-access`

The kit changes were offered to Story Studio on kit-parity (message 48).

---

**Related Documents:**

- [Polish before the release](../../../cycles/2026-10-polish.md)
- [Workspace Kit follow-ups](../feature.md)
