---
type: item
title: mind-mapper stays out of the shipped plugin until its app is finished
description:
  mind-mapper's build (about 3 MB of dist, scripts and acc files, with no
  SKILL.md) ships in the plugin today; Cole ruled it stays out of 6.0.0 while
  its app experience is unfinished, without losing the build for development.
status: stable
lifecycle: done
id: 01a17017-0787-7167-b9c2-28362c500eb8
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-24 }
cycle: 2026-10-release-6
priority: high
from: cycle/2026-10-release-6
---

# mind-mapper stays out of the shipped plugin until its app is finished

Cole, 2026-10-24: "Keep it out, there is still work to do on finishing the app's
experience." `plugins/spellbook/skills/mind-mapper/` holds about 3 MB of
`dist/`, `scripts/` and acc files with no `SKILL.md`. In August Cole ruled that
leaving it undeclared was right, but whatever is under `plugins/spellbook/`
ships with the plugin, so the build reaches every adopter's install today.

## Definition of done

- [x] The 6.0.0 plugin contains nothing of mind-mapper, checked on what an
      install actually receives, not on the repo tree.
- [x] mind-mapper still builds, runs and tests for development.
- [x] `dist-check`, the wards and CI agree with where its build now lives.
- [x] Where it lives, and how it rejoins the plugin once finished, written down
      where the next person will look.

## Done and verified

**Where it lives:** `plugins/unreleased/skills/mind-mapper/` (launchers,
committed `dist/`, acc files), moved with `git mv` in `6a71d53b` as a pure
rename. The source comments that named the old address were updated and the
bundles rebuilt in `7fb23901`. The new ward is `dbb460bf`, and these docs follow
it. How it rejoins the plugin is in
[`plugins/unreleased/README.md`](../../plugins/unreleased/README.md).

**What an install receives, measured.** The plugin was installed from a local
marketplace (a clone of this repo) with `claude plugin marketplace add` and
`claude plugin install spellbook@spellbook-marketplace`, under a scratch `HOME`
and `CLAUDE_CONFIG_DIR`. The install cache is
`~/.claude/plugins/cache/spellbook-marketplace/spellbook/5.2.0/`.

| Commit              | `skills/` received                          | Size  | mind-mapper paths |
| ------------------- | ------------------------------------------- | ----- | ----------------- |
| `f137caac` (before) | the eight declared spells **+ mind-mapper** | 24 MB | 12                |
| `7fb23901` (after)  | the eight declared spells                   | 21 MB | 0                 |

Nothing else filters the install: the marketplace source is the folder
`./plugins/spellbook`, there's no files list or ignore rule, and release-please
only bumps the version in `plugin.json` (there's no packaging step). This was
not measured against a GitHub-hosted marketplace. That kind clones the whole
repo into `~/.claude/plugins/marketplaces/`, so `src/` and `plugins/unreleased/`
sit in that clone, as all of `src/` always has, but the installed plugin is the
copy of `./plugins/spellbook`.

**Deliberate choices:**

- **A sibling root at the plugin's depth, not `src/mind-mapper/dist` or a
  top-level `dev-spells/`.** The built `dist/` finds the surface source and the
  dev cwd by a fixed five-level `..` climb. A root at the same depth means the
  dist stays byte-identical, nothing at runtime changes, and releasing it is a
  `git mv` back. Either of the other locations would have meant editing those
  climbs now and again at release.
- **No packaging exclude.** Claude Code copies the whole source folder and has
  no include or exclude list, so an exclude doesn't exist to use. Untracking
  `dist/` would still ship `scripts/` and the acc files, and would break the
  release-mode run.
- **`src/deployRoots.ts` decides which root holds a spell, read off the tree.**
  The build, `dist-check`, `paths.ts` and the wards ask it, so a held-out spell
  is still built, dist-checked, acc-checked and warded.
- **The CLI reports `"version": "unknown"`** while the spell is held out. It
  reads the version from a plugin manifest the holding root doesn't have. That's
  its own documented fallback, and it's accurate, so the golden fixture records
  it. Giving the holding root a manifest would have meant a fake plugin with a
  version release-please doesn't bump.
- **roster-drift's mind-mapper pin is gone.** It asserts the shipped root only,
  and now no undeclared folder is left in the plugin.
