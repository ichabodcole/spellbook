# Memory — mind-mapper Round 7 built + gate-passed (2026-07-22)

Same day as drive #6 + the Round 6 merge: Round 7 convened, built, cold-gate
PASSED on `feature/mind-mapper-round7` (1140 tests). Implements the drive-6
metadata/filter/polish cluster.

Shipped: **tags** (the controlled folksonomy — freeform `node_tags` table, twin
of node_actions so pending proposals carry + re-home on ratify;
`/tags/:targetId`

- `tags` verb + `tags.set`; chips + reuse-suggest autocomplete, agent-curated
  client-side); **faceted filter** (Status/Tier/Tags, `filteredMap` terminal
  after the lens, AND-across/OR-within, status via pending flag); **ratify
  tier-picker** (the dead-end bug — flat fallback items; + casting-draft killed
  "cast" AND "background" as invalid tiers); **directional select**
  (children/parents/both); **backlinks** (derived "Referenced by"); **markdown
  doc rendering** (extracted a shared `<Markdown>` from the chat);
  **submap-create on pending** (ratify-batch group); **stable-port**
  (`open --port`, server already binds).

Method: ratify corrected 5 things pre-build (tags route, port-already-binds,
backlinks-client-derive, markdown-is-extraction, the 2nd "background" tier
trap). Zero wire-guess at P2 (5th round). Gate failed once on a real silent bug
(1139 tests missed it): `propose-node/edge --stdin` dropped top-level `tags`
(CLI body-builder didn't forward it — the mirror-drift trap); fixed b42488d +
the missing cli.test row; cold re-drive passed. Refactor candidate (daedalus):
node_actions + node_tags are identical twins — a 3rd target-keyed metadata field
justifies factoring the shared lifecycle.

Branch awaits **Cole's dogfood drive #7 (human gate) + merge ruling**. Next:
async **job queue** (drive-6 #3), then **images** (`proposal-images.md`).

Details:
`docs/projects/mind-mapper/sessions/2026-07-22-round7-metadata-filter-build.md`.
