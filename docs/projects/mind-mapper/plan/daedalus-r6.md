# daedalus — Round 6 engine lane

Grounded in `plan-round6.md` (Ratified decisions + Build order are
authoritative). Branch `feature/mind-mapper-round6`. Engine dir
`plugins/spellbook/skills/mind-mapper/scripts/`. TDD per slice; full suite green
(`bun test`, 1038+ at start) before each chapter commit; biome on changed ts.

## Build order (adopted, from the plan)

1. **buildRatify extraction** (shared prerequisite) — factor `ratify()` into a
   pure
   `buildRatify(db, docsDir, input, bus, resolveRef?) → { apply, writeDoc, changelogLine, emit, result }`
   (mirrors `buildProposal`). Single `ratify()` calls writeDoc + apply +
   changelog-append + emit inline — behavior-identical. Fold the
   **`proposal.rejected {id}`** emit into buildRatify's reject path (finding
   #4). Re-green ratify.test.ts + add a reject-emits test.
2. **RB — ratify-batch + `ratify --anchor`** —
   `ratifyBatch(db, bus, docsDir, {ruling, ids, anchors?})`. Auto-partition
   nodes-before-edges (look up each id's kind; no caller ordering). NO
   auto-include of unlisted edges. One top-level ruling; `reject` rejected
   outright. Edge endpoints + anchor refs resolve via idMap (proposalId→minted
   nodeId) first, then real node ids / result_node_id. All `apply()` in ONE
   `db.transaction()`; changelog appends +
   `node.ratified`/`edge.ratified`/`node.anchored` emits AFTER commit. idMap =
   collected `{proposalId→nodeId}`. `ratify <id> --anchor <parent>` = the
   single-call twin, implemented AS
   `ratifyBatch({ids:[id], anchors:[{node:id, parent}]})` — node-only falls out
   (an edge proposal has no idMap entry → anchor ref stays the proposal id →
   anchorGuard "unknown node"). **Anchor-guard nuance:** structural resolution
   (refs resolve to an idMap entry or a real node; no self-anchor) happens
   before the txn; the full `anchorGuard` (existence + cycle walk) runs INSIDE
   the txn after node inserts (minted rows don't exist pre-txn) — atomically
   equivalent, a throw rolls the txn back to zero rows and emits are post-commit
   so zero events leak.
3. **DEL — node/proposal deletion** — new `del.ts`:
   - `deleteNode(db, bus, id, force)` → null (unknown → 404) | throw
     `NodeCitedError({edges, children})` when unforced+cited (edges touching +
     children anchored under). `force` cascades in one txn: delete
     both-direction edges, re-parent children to top-level (clear
     `anchor_node_id`, NOT delete), delete owned
     sources/message_sources/node_actions, clear a lens pointing at it; LEAVE
     ratified proposals' `result_node_id` (history). emit `node.deleted {id}`.
   - `deleteProposal(db, bus, id)` → thin, NO guard: drop row + cascade its
     node_actions; emit `proposal.deleted {id}`. Works for pending/rejected/
     ratified (opaque draft edge deps fail safe at their own ratify).
4. **`proposal.rejected {id}`** — landed in step 1 (buildRatify reject path).

## Contract 9 R6 amendments (seams.md, BEFORE circe P2)

ratify-batch req/resp + idMap; `node.deleted`/`proposal.deleted`/
`proposal.rejected` EventKinds (3 new, union stays total); `resultNodeId`
already on the proposal wire (R5) for circe's EF — surface the note; NAME the
deferred `proposals.claimed_by` work-queue seam (PROC/QUEUE/#9 share it; not
built).

## casting-draft amendments

`ratify-batch` (id-list + anchors shape, the reconnect-in-one-call win),
`ratify --anchor`, `node delete`/`proposal delete` (+ clearing raw
instruction-nodes goes through DELETE, not reject), refine-a-human-node
semantics (raw `author:"user"` node = cue to research + DELETE-the-raw + propose
curated structure), and the #2 context-doc facilitator touchpoint.

## Tests (per slice)

- ratify.test.ts: existing re-green + `reject emits proposal.rejected`.
- ratify-batch.test.ts: node+edge partition/one-call/old→new map; edge resolves
  via idMap; NO auto-include (unlisted edge stays pending); anchors[]
  ratify-then-anchor; reject-in-batch rejected; atomicity (throwing batch → zero
  rows/events/changelog).
- del.test.ts: cited-guard counts; force cascade (edges gone, children
  re-parented to top-level not deleted, detritus gone, lens cleared, ratified
  proposal result_node_id intact); proposal-delete thin; delete a rejected
  proposal.
- server.test.ts + cli.test.ts: route + verb round-trips.

## As-built notes

_(fill during build)_
