---
type: item
title: The README tells adopters what the plugin actually ships
description:
  "The repo README is the first page an adopter reads and it is wrong: the spell
  count, the authoring rituals it says the plugin installs, the old spell layout
  and docs line; the root DEV_KICKOFF.md and index.ts stub are stale too."
status: stable
lifecycle: done
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

- [x] Every claim in the README checked against the tree and the shipped plugin,
      and corrected where it is wrong.
- [x] The root `DEV_KICKOFF.md` and `index.ts` removed or moved, with Cole's
      yes, after checking that nothing references them.
- [x] A fresh reader with no repo context, given only the README, can say what
      installing the plugin gives them.

## Done and verified

The README is rewritten for an adopter in one commit on
`impl/readme-for-adopters`: what installing gives you (a table of the eight
shipped spells, each with what it conjures and a phrase that casts it), then how
to install it and what each spell needs, then where to read more. Contributor
material is cut to a short layout and a pointer to `AGENTS.md`. What an install
receives was checked with a simulated install on a scratch home: the eight spell
folders and the skills README, with no `inscribe`, `ward` or `mind-mapper`. The
spell table keeps its `Spell` and `Kind` columns, because
`grimoire/roster-drift.test.ts` reads them; dropping a row turns it red.

Two choices to know about. `media-forge`, which `imago` and `glamour` generate
through, is a private repository and not on npm, so the README says it isn't
published yet rather than linking it. And the second and third boxes stay open:
removing the root `DEV_KICKOFF.md` and `index.ts` waits for Cole's yes (nothing
needs either file; the one live mention is `"module": "index.ts"` in
`package.json`, which goes with it), and the fresh-reader test wants a reader
with no repo context, which the implementer is not.

A cold reader then read only the README, and a second commit answers what it
tripped on. Repo jargon is gone from the adopter part, and the closing epigraph
is cut. The README now says plainly that `/spellbook:<spell>` always casts a
spell, names a first spell to try, and gives one Bun minimum: 1.3.14, which
glamour's image code needs. A new paragraph says when each spell stops and where
its state lives. Its figures come from the SKILLs and the servers' defaults
(1800 s; bounty 7200 s; no idle close for grapevine or astrolabe by default).

**Fresh readers (lead, 2026-10-25).** Two cold readers were each given only the
README file and forbidden to look anything up. The first could say what
installing gives you, and tripped on eight points the fix round (`b1dcee22`)
answered. The second summarised it correctly (eight local browser apps the agent
drives, Bun 1.3.14+, the extra needs of imago, glamour and magpie, and digestify
as a first try). Its remaining confusions were spell names it didn't know and
two wordings the lead fixed (`52b4c98d`); per the land skill's limit of one
re-read, there was no third.

**Closing (lead, 2026-10-26).** Cole said yes to removing the root files: the
root `DEV_KICKOFF.md`, `index.ts` and the `"module": "index.ts"` line in
`package.json` are gone. He also raised the Bun minimum to 1.4.0, so the README
now gives that one figure, and the 6.0.0 upgrade note says so.
