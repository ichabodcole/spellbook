# Session — mind-mapper Round 5: subgraphs + drive-4 cluster (2026-07-21)

**Team:** prospero (lead), daedalus (engine), circe (surface), cassandra (gate)
— subagent mode. **Branch:** `feature/mind-mapper-round5` (cut at convene off
develop @ 29e27df, same day Round 4 merged). **Plan:** `plan-round5.md`.
**Source:** drive4-findings.md triage (Cole approved the cluster, "Sounds
right!").

## What was built

- **Subgraphs / node-anchored submaps** (the headline, Cole wants it testable):
  `nodes.anchor_node_id` additive column; `/state.nodes[]` stays INCLUSIVE with
  `anchorNodeId` on every node + server-derived `submapChildCount`;
  `/state?anchor=` is a CLI/agent narrow only; `POST /nodes/:id/anchor` with an
  ancestor-walk cycle guard; thin `node.anchored` event; `ratify()` untouched
  (anchoring is post-ratify, real-nodes-only). Surface: client-side submap
  derive (`submapView`/`breadcrumbTrail`) slotted between zone and lens,
  double-click / "Enter submap" to drill, a `top ▸ …` breadcrumb, "has submap"
  folder badge.
- **Select-connected** (#3): a NodeCommand unioning depth-1 neighbors into the
  selection (shared `neighborhood.ts`).
- **Shared-connection spotlight lens** (#4): client-side intersection + a NEW
  dim channel (not `highlightIds`) + new GraphCanvas edge-dim plumbing; a
  `SpotlightToggle`, map-view only, ≥2 selected.
- **Intent-composer affordances** (#8): right-click add-node (free-text,
  author:"user"; its `proposal.added` is the agent's refine cue),
  drag-to-connect (`onConnectEnd` → `propose-batch` node+edge in one call),
  zone-create (empty zone always mintable from the UI — closes the drive-3
  first-zone-CLI-only gap — + "group N selected into a zone" via the new move-in
  endpoint).
- **CLI batch-propose + message-read** (#10, my own casting-friction fixes):
  `POST /proposals/batch` with local-ref resolution in one transaction (kills
  the N-subprocess casting script); `GET /message/:id` + `read`/`message` verb.
- **Zone move-in** (IC-c): `POST /proposals/:id/zone` — the inverse of promote,
  giving zones an in-door to match the out-door.
- **Stall-window split** (#2): `MIND_MAPPER_STALL_TTL_MS` (150s,
  received→stalled) split from `MIND_MAPPER_ACTIVITY_TTL_MS` (60s,
  thinking→idle) — the false-stall fix; the tail-liveness gate was measured
  feasible but rejected (a connected tail proves transport, not agent,
  liveness).
- **ESC bug** (#11): the `<kbd>` became a real button + a window-level Escape
  handler.

## Method notes

Ratify round falsified the plan's own submap-scoping lean — **both owners
independently** landed on the R3 zones precedent (inclusive tagged snapshot +
client derive; `?anchor` CLI-only), the breadcrumb parent-walk being the
clinching argument (server-scoping would hide the ancestors). circe also
falsified "spotlight fits the lens machinery" (lens hides, spotlight dims —
needs its own dim channel + new edge-dim plumbing). daedalus rejected the
liveness-gate on correctness. P2 integrated with **zero wire-guess failures**
(the four load-bearing wire facts were accurate). Gate **failed once** — on a
casting-draft prose gap (stall-window still said ~60s for both timers after SW1
split them), the "a round that changes a number the doc already states leaves
the most dangerous gap" lesson; lead fixed the prose (d7d911b), cold re-drive
passed. circe caught a live React-Flow multi-select echo loop (SC is the first
programmatic multi-select) and fixed it with a pending-gate.

## Commits

Plan `…`→ratified · daedalus `4ba229a 0d508ce 14d201a 4ef6fad d953d89` · circe
`f4d620c dff10fa 5217f7f 438ffe0 81acc62` · casting-draft gate fix `d7d911b`.
Suite: **1038 pass / 0 fail**; mind-mapper tsc-clean.

## For Cole at dogfood drive #5

- **Subgraphs**: double-click a node with a "has submap" badge (or the "Enter
  submap" menu item) to drill in; breadcrumb back up. A childless node's
  double-click is a deliberate no-op. Create-into-submap is post-ratify (a
  sketch inside a submap lands top-level until I ratify + anchor it — the
  casting loop's job). A submap is dropped on a zone switch (one drill-context
  at a time).
- **Add-node**: right-click empty canvas → free-text (dictation-first) box; the
  node appears immediately as a pending proposal (positioned by layout, not the
  click point — placement-honesty), and I refine it.
- **Drag-to-connect**: drag a connection off a node's handle onto empty canvas →
  the same add-node box, with the edge pre-drawn (the dead drag is now live).
- **First zone is mintable from the UI** now; you can also multi-select pending
  proposals and group them into a zone.
- **Select-connected** + the **spotlight lens** (Flashlight toggle, ≥2 nodes
  selected) are on the canvas.
- Advisory nit (not gate-failing): `read`/`message` CLI exits 0 on an unknown-id
  404 — minor, a drive-5 polish candidate.

## Deferred (own later proposals)

Media/images (#1), live force view (#7 — reference impl assessed), multi-agent
runtime (#9). Carried: derive layer + embeddings (now with the spotlight lens as
its first consumer), OKF/Operator importer, data-adjustment taxonomy.
