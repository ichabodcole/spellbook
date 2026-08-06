# Session — mind-mapper Round 7: metadata, filter & polish (2026-07-22)

**Team:** prospero (lead), daedalus (engine), circe (surface), cassandra (gate)
— subagent mode. **Branch:** `feature/mind-mapper-round7` (cut at convene off
develop @ b5c99c8, same day Round 6 merged). **Plan:** `plan-round7.md`.
**Source:** drive6-findings.md triage (Cole "close out and implement").

## What was built

- **Tags — the controlled folksonomy** (finding #1): freeform `tags: string[]`
  on nodes AND pending proposals, stored as a target-keyed `node_tags` table
  (verbatim twin of `node_actions` — so tags carry pre-ratify and re-home onto
  the minted node for free). `/tags/:targetId` route + `tags <targetId>` CLI +
  `tags.set` event + tags-on-propose (single + batch). Surface: tag chips (node
  card row + detail), add-tag input, and the **reuse-suggestion autocomplete**
  (client-derived over existing tags — the "controlled" is entirely surface; the
  engine stores raw strings, never a registry).
- **Faceted filter** (finding #8): a `filteredMap` memo terminal to the derive
  chain (AFTER visibleMap, so it doesn't distort the lens BFS) — Status / Tier /
  Tags facets, AND-across / OR-within. Status derives from the pending flag (no
  literal status field); rejected never renders so no rejected facet on canvas.
- **Ratify tier-picker** (finding #7, the bug): a proposed node with an
  unrecognized tier no longer dead-ends — flat "Ratify as canon/thread/
  story-local" fallback items when the suggestion isn't a valid ruling. **Lead
  casting-draft fix**: killed `suggestedTier:"cast"` (my error) AND clarified
  "background" is a steeping stance, not a tier (daedalus's second-trap catch).
- **Directional select** (#2): children (outgoing) / parents (incoming) /
  connected (both), from directed edges; a both-direction edge counts for both.
- **Backlinks** (#6): a "Referenced by" section in the doc viewer, pure client
  derivation from the evidence forward-links (auto-maintained, no engine).
- **Markdown doc rendering** (#9): extracted the chat's private markdown +
  span-flash into a shared `<Markdown>` component; the doc viewer renders
  markdown with the evidence highlight landing (chat unchanged).
- **Submap-create on pending** (#5): the pending-group case via the surface's
  first ratify-batch call (one top-level ruling sidesteps per-proposal tier);
  empty-container gesture deferred to the intent-composer round.
- **Stable-port** (#4): `open --port <N>` (the daemon already binds it; CLI-only
  wiring) so a reap+restart keeps the URL stable.

## Method notes

Ratify round corrected 5 things pre-build: tags route naming (`/tags/:targetId`,
not `/nodes/:id/tags` — target is node-or-proposal), the stable-port server code
already existing (build CLI-only), the backlinks read-field being unnecessary
(client-derive), the markdown viewer being an extraction not a reuse, and a
SECOND invalid tier ("background") in the casting-draft beyond my "cast". P2
integrated with **zero wire-guess failures** (5th round running; daedalus's 5
wire facts all held). **Gate failed once** — on a real silent-data-loss bug the
1139 tests missed: `propose-node/edge --stdin` dropped a top-level `tags` key
(the CLI body-builder didn't forward it, though the route + batch did — the
mirror-drift trap in CLI form). Fixed (b42488d) + the missing cli.test row; cold
re-drive passed. daedalus flagged a refactor candidate: `node_actions` +
`node_tags` are now identical twins — a third target-keyed metadata field
justifies factoring the shared lifecycle.

## Commits

daedalus `cbcbe16 05bce6e ff1e381 6106ba3 0ea6e53 b42488d` · circe
`9f9ca6f e233858 01f6b90 5a361ef 0c01de5 f3e2c8d`. Suite: **1140 pass / 0
fail**; mind-mapper tsc-clean.

## For Cole at dogfood drive #7

- **Tags**: I tag nodes as I create them (and you can add/edit); tag chips show
  the "what kind of thing is this," and the add-tag input suggests existing tags
  (the controlled folksonomy).
- **Filter** (toolbar): slice the canvas by Status (proposed/ratified), Tier, or
  Tags — the "just show me the ratified ones" you wanted.
- **Ratify anything**: the dead-end is fixed — a proposed node always offers a
  ratify path (and I now tag subjects `canon`, not the invalid "cast").
- **Select children / parents** (right-click) — directional now.
- **Docs render as markdown** with a "Referenced by" backlinks list.
- **Group pending nodes into a submap** in one gesture (ratify-batch under the
  hood).
- The daemon can bind a **stable port** now (drive resilience).

## Deferred (own rounds next)

The **async job queue** (drive-6 #3 — off-canvas sidebar, status/sub-tasks,
ownership/`claimed_by`, multi-agent on-ramp) is the next round. **Images**
(`proposal-images.md`) queued after. The empty-submap-under-a-node gesture folds
into the job-queue/intent-composer round. Carried: force view, derive layer +
embeddings (tag reconciliation + spotlight are consumers), OKF/Operator
importer, data-adjustment taxonomy.
