# Mind-mapper V1: ratified plan → passed acceptance test, same evening as the spike

**Date:** 2026-07-17

Built mind-mapper V1 end-to-end via anthill (plan skeleton → seam ratify → P1–P4
with verify gates): real sqlite+markdown persistence (map-as-view),
ingest/propose/ratify/search/lens engine + CLI verbs, live surface (ReviewQueue,
real conversation bus, agent lens, force toggle), release-mode build. V1
acceptance test PASSED by a cold agent (ingest → map → converse → ratify → doc
holds the sentence → restart → still true). Two gate drives found real bugs
(schema-migration 500, thin-event reducer mismatch, silent FTS non-population).
On `feature/mind-mapper-v1`, awaiting Cole's drive + merge.

**Key files:** `plugins/spellbook/skills/mind-mapper/scripts/`,
`src/mind-mapper/surface/`, `docs/projects/mind-mapper/plan.md`,
`.anthill/dev/seams.md` (Contracts 8–9)

**Docs:** `docs/projects/mind-mapper/sessions/2026-07-17-v1-build-full-loop.md`
