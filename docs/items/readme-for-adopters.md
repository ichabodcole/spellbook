---
type: item
title: The README tells adopters what the plugin actually ships
description:
  "The repo README is the first page an adopter reads and it is wrong: the spell
  count, the authoring rituals it says the plugin installs, the old spell layout
  and docs line; the root DEV_KICKOFF.md and index.ts stub are stale too."
status: stable
lifecycle: active
id: 01a17017-06ad-7469-91c0-cde2c9ab864a
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-24 }
cycle: 2026-10-release-6
priority: high
from: cycle/2026-10-release-6
---

# The README tells adopters what the plugin actually ships

Found 2026-10-24 while checking develop for release readiness. The repo README
is the first page an adopter reads on GitHub, and several of its claims are
wrong for what 6.0.0 will ship:

- It says "all seven spells". There are eight declared spells (mind-mapper stays
  out of the plugin; see
  [mind-mapper-out-of-the-plugin](mind-mapper-out-of-the-plugin.md)).
- It says the plugin installs "plus the authoring rituals", and its repo layout
  puts `inscribe` and `ward` under `plugins/spellbook/skills/`. They are
  repo-only, in `.claude/skills/`.
- "How a spell works" shows the old layout (`scripts/*.test.ts`,
  `surface/ | assets/`, `references/`) and the old "structural tell", which the
  skills README has already retracted.
- The `docs/` line ("projects, backlog, sessions") is stale.
- At the repo root, `DEV_KICKOFF.md` is the August spell-hardening kickoff and
  `index.ts` is a `Hello via Bun` stub.

## Definition of done

- [ ] Every claim in the README checked against the tree and the shipped plugin,
      and corrected where it is wrong.
- [ ] The root `DEV_KICKOFF.md` and `index.ts` removed or moved, with Cole's
      yes, after checking that nothing references them.
- [ ] A fresh reader with no repo context, given only the README, can say what
      installing the plugin gives them.
