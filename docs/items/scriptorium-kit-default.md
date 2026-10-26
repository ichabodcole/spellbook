---
type: item
title: The kit Scriptorium becomes the default
description:
  "The flip, as one revertable commit: the kit path is the default, sessions
  convert as they open, prefs are shared, the flag goes, an escape hatch keeps
  the shipped app reachable until the deletion, and acc's census and the CLI
  golden move with it."
status: stable
lifecycle: done
id: 01a15b3a-2716-70a6-872a-d30f3aad2a2c
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium]
cycle: 2026-10-cutover
parent: feature/workspace-kit
from: cycle/2026-10-cutover
---

# The kit Scriptorium becomes the default

The shell cycle closed parity, but the kit path still runs only with
`SCRIPTORIUM_KIT=1`. This item flips it. The survey of 2026-10-20 measured the
change at about 120 lines of source, mostly removals in
`src/scriptorium/backend/kit/app.ts`, plus about 40 for the escape hatch.

- **The default.** Both entries' `run()` go to the kit path. `kitSessionsRoot`
  becomes `$SCRIPTORIUM_HOME/sessions`, so the converter turns each shipped
  session into the kit's shape as it opens, keeping the original as
  `manifest.pre-migrate.json`. Prefs and logs sit beside it, shared.
- **What goes:** the flag, the dry-run flag and the real-home check,
  `refuseScriptorium`, and every mention of `SCRIPTORIUM_KIT` or `path:"kit"` in
  the launcher, help, summary, `--version` and refusal hints. The hard-link and
  outside-root checks stay.
- **The escape hatch (ruling 6).** `SCRIPTORIUM_SHIPPED=1` runs the shipped path
  until the deletion. It is refused, with a usage error and a hint, once a
  session in the home is in the kit's shape (ruling 2 of the cycle). The shipped
  tests that drive the launcher (`daemon.integration`, `cli-contract`,
  `tail-handoff.integration`, `dev-styled` and `migrate.integration`'s shipped
  arm) take the variable.
- **acc and the golden move in the same commit.** At the flip the golden goes
  red (45 verbs become 56), and acc against the shipped census stays green
  though two of its verbs are gone and 13 are uncovered (measured). So the
  census is re-recorded into the skill folder, the `notCoveredByBatch` and
  `recordedNotAdvertised` assertions move from `backend/kit/acc.test.ts` into
  the house ward, that test goes, and the golden is re-captured. A revert of the
  one commit then brings the shipped default back whole.

Prefs carry over as ruling 5 says: `theme`, `doc:view` and `panes:open` keep
their shapes (a shipped `compare` view reads as rendered); the two layout keys
are left behind, which is the one-time reset of pane sizes.

## Definition of done

- [x] With no variable set, `open` runs the kit Scriptorium on
      `$SCRIPTORIUM_HOME/sessions`, and nothing the human or the agent sees
      names `SCRIPTORIUM_KIT` or `path:"kit"`.
- [x] A dry run on a fresh copy of the real home, on the final code, converts
      and restores every session, and keeps every original manifest byte for
      byte.
- [x] In a real browser, on a copy, a converted session keeps the theme, the
      view mode and the open columns, and the pane sizes reset.
- [x] The hatch works on an unconverted home and is refused (exit 2, with a
      hint) once a session is in the kit's shape.
- [x] acc runs on the re-recorded census, the house ward fails a census that
      misses or invents a verb, and the CLI golden is re-captured.
- [x] The flip is one commit; reverting it on a scratch branch restores the
      shipped default with the gate green.

## Done and verified

The flip is `60ef6f8f` (source, tests, census, ward and golden), with the
rebuilt `dist` in `50c3afa3`.

- **The hatch** is `src/scriptorium/backend/hatch.ts`, asked by both entries.
  "In the kit's shape" is the shipped reader's own test (`appName`, or a
  `createdAt` that is not a number), read from each `manifest.json`, so a
  session started on the flipped build closes the hatch as a converted one does
  (ruling 2). Unreadable manifests are not counted.
- **The dry run**, on a copy of `~/.scriptorium` taken at 14:45 (65 sessions):
  in process, 65 of 65 converted and restored again without a migrate; through
  the launchers, 65 opened, 65 closed cleanly by their own id, none killed,
  every chat carries the conversion line. Every `manifest.pre-migrate.json` is
  byte-identical to its original, and nothing else changed. The hatch was then
  refused on that copy (exit 2), and worked on a fresh unconverted one.
- **The browser check**, on a copy: the converted session opened dark (the
  browser preferred light), with Rendered pressed and both columns open; the
  layout was the kit's default 22/50/28 rather than the shipped 25.6/48.8/25.5,
  and a collapsed context column reopened at 25.6%, the carried `panes:open`.
- **acc**: the census was re-recorded on the flipped CLI into the skill folder
  (56 records, identical to the kit census it replaces). The house ward now
  fails a census whose verbs are not the CLI's; digestify, which advertises no
  verb list, is named as the one exception. `backend/kit/acc.test.ts` is gone.
- **The golden**: re-captured (56 verbs), with `dangling` and `workspace`
  dropped from the hand corpus and a row added for each kit-only verb. The
  documented fixture follows the SKILL item.
- **Choices**: the page title loses "(kit path)", since the tab is what the
  human sees. A `kit/sessions` folder left by the flag is not read or moved; the
  real home has none. The kit's `refuseScriptorium` field is left for the
  deletion.
- **The revert**: `git revert 60ef6f8f` plus a rebuild gives a tree
  byte-identical to `23dd202c`, and the gate is green on it.
