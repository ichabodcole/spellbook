---
type: item
title: mind-mapper stays out of the shipped plugin until its app is finished
description:
  mind-mapper's build (about 3 MB of dist, scripts and acc files, with no
  SKILL.md) ships in the plugin today; Cole ruled it stays out of 6.0.0 while
  its app experience is unfinished, without losing the build for development.
status: stable
lifecycle: active
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

- [ ] The 6.0.0 plugin contains nothing of mind-mapper, checked on what an
      install actually receives, not on the repo tree.
- [ ] mind-mapper still builds, runs and tests for development.
- [ ] `dist-check`, the wards and CI agree with where its build now lives.
- [ ] Where it lives, and how it rejoins the plugin once finished, written down
      where the next person will look.
