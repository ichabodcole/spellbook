# Session — mind-mapper Round 6: drive-5 fixes + tooling + UX (2026-07-22)

**Team:** prospero (lead), daedalus (engine), circe (surface), cassandra (gate)
— subagent mode. **Branch:** `feature/mind-mapper-round6` (cut at convene off
develop @ 4e4571f, same day Round 5 merged). **Plan:** `plan-round6.md`.
**Source:** drive5-findings.md triage (Cole "Sounds good").

## What was built

- **ratify-batch** (finding #10, my own top casting-friction):
  `POST /proposals/ratify-batch {ruling, ids, anchors?}` → `{idMap, ratified}` —
  the twin of propose-batch. Auto-partitions nodes-before-edges, resolves edge
  endpoints + anchors via the idMap, no auto-includes, atomic (one txn,
  emit-after-commit). `ratify --anchor` = a one-id ratify-batch. Required
  extracting **`buildRatify`** from `ratify()` with THREE deferred lanes (db
  apply / fs writeDoc / changelog+emit) — ratify touches the filesystem twice,
  all rollback-leaky, the propose-batch buildProposal lesson recurring.
- **Node/proposal deletion** (finding #7): `DELETE /nodes/:id[?force=1]` with a
  typed `NodeCitedError` 409 (edges + submap children as the citing set); force
  cascades but **re-parents children to top-level, not cascade-delete**
  (non-destructive — the children are real knowledge). `DELETE /proposals/:id`
  thin. Both human + agent (equal-capability). The litter-clearing path.
- **`proposal.rejected` event** (finding #3 root cause): reject previously
  emitted NOTHING — the reason rejected nodes lingered on the board. Now thin
  `{id}`. Both owners found this independently at ratify.
- **Surface bug fixes**: **edge-follows-ratify** (finding #8 — the alarming one;
  pending edges re-point through `resultNodeId` in mapWithPending so they don't
  dangle+vanish when an endpoint ratifies); **batch-render merge-by-id**
  (finding #5 — the layout effect merges instead of wholesale-replacing across a
  proposal.added burst; bonus: preserves manual drag positions); **long-title
  menu clamp** (finding #3b).
- **Surface UX**: **delete UI** (context-menu Delete + cited-guard confirm
  dialog + thin-event local reconciliation); **reject-reducer** (drops on
  proposal.rejected, live, no refetch); **processing render** (PROC — pending
  author:"user" node shows a "curating" state); **ingestion tray** (QUEUE —
  IngestionTray over pending author:"user" proposals); **submap-create gesture**
  (SUBMAP-CREATE — select ≥2 ratified nodes → group under a parent via per-node
  anchor, the surface's first /nodes/\* write).

## Method notes

Ratify round again earned its keep: **both owners independently found reject
emits no bus event** — the true root cause of finding #3, which reframed the fix
from a surface patch to a `proposal.rejected` event. Circe corrected two lead
mis-scopings (EF derives from `resultNodeId` already on the wire, not an event
map; SUBMAP-CREATE must scope to ratified nodes since anchor is
real-nodes-only). Daedalus's buildRatify factoring found a THIRD deferred lane
(fs writeDoc) beyond the two the plan named. Rulings: deletion re-parents rather
than cascade-deletes submap children; PROC/QUEUE stay client-only with the
shared future `claimed_by` work-queue field named-not-built. P2 integrated with
zero wire-guess failures (fourth round running). **Gate PASSED first cold
drive** (all 6 scenarios). Advisory nit: uneven CLI exit codes across error
paths (parse the `error` key, don't branch on exit code) — a persisting pattern,
not merge-blocking.

## Commits

Plan `…`→ratified · daedalus `bfa513c b92aa83 f8fa6e0 037130f` · circe
`8377a78 33ff84e c05dc31 48a345a a73ff57`. Suite: **1087 pass / 0 fail**;
mind-mapper tsc-clean.

## For Cole at dogfood drive #6

- **Delete** a node/proposal from the right-click menu (finally) — deleting a
  connected/anchored node warns first (edges + submap children counts), force
  re-parents the children to top-level rather than nuking them. Your lingering
  raw instruction-nodes are now clearable.
- **Rejected nodes leave the canvas live** now (the lingering bug is fixed).
- **Ratify a whole cluster at once** — I have ratify-batch now, so reconnecting
  a graph is one call, not the fiddly dance from drive #5.
- **Group ratified nodes into a submap** from the UI (select ≥2 → "submap").
- **Add-node** now shows a "curating" state, and there's an **ingestion tray**
  for in-flight adds.
- The **edge-vanishing-on-ratify** and **nodes-disappearing-after-batch** bugs
  from drive #5 are both fixed.
- Advisory (mine): CLI error exit codes are uneven — a follow-up cleanup, not a
  drive-6 blocker.

## Deferred (own later proposals)

Round 7 = **images** (`proposal-images.md`, written). Carried: force view,
multi-agent runtime (the ingestion queue is its first use case; the `claimed_by`
seam is named for it), derive layer + embeddings, OKF/Operator importer,
data-adjustment taxonomy.
