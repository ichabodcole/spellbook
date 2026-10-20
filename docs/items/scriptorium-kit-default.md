---
type: item
title: The kit Scriptorium becomes the default
description:
  "The flip, as one revertable commit: the kit path is the default, sessions
  convert as they open, prefs are shared, the flag goes, an escape hatch keeps
  the shipped app reachable until the deletion, and acc's census and the CLI
  golden move with it."
status: stable
lifecycle: backlog
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

- [ ] With no variable set, `open` runs the kit Scriptorium on
      `$SCRIPTORIUM_HOME/sessions`, and nothing the human or the agent sees
      names `SCRIPTORIUM_KIT` or `path:"kit"`.
- [ ] A dry run on a fresh copy of the real home, on the final code, converts
      and restores every session, and keeps every original manifest byte for
      byte.
- [ ] In a real browser, on a copy, a converted session keeps the theme, the
      view mode and the open columns, and the pane sizes reset.
- [ ] The hatch works on an unconverted home and is refused (exit 2, with a
      hint) once a session is in the kit's shape.
- [ ] acc runs on the re-recorded census, the house ward fails a census that
      misses or invents a verb, and the CLI golden is re-captured.
- [ ] The flip is one commit; reverting it on a scratch branch restores the
      shipped default with the gate green.
