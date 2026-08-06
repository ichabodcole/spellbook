# Memory — mind-mapper Round 5 built + gate-passed (2026-07-21)

Same-day as drive #4 + the Round 4 merge: Round 5 convened, built, and cold-gate
PASSED on `feature/mind-mapper-round5` (1038 tests green). Implements the
drive-4 cluster Cole approved.

Shipped: **subgraphs / node-anchored submaps** (the headline — `anchor_node_id`
additive column, inclusive tagged `/state` + client-side submap derive +
breadcrumb, `POST /nodes/:id/anchor` with cycle guard, `ratify()` untouched);
**select-connected**; **shared-connection spotlight lens** (own dim channel +
new edge-dim plumbing); **intent-composer affordances** (right-click add-node,
drag-to-connect via batch, UI zone-create closing the first-zone-CLI-only gap +
group-selected-in); **CLI batch-propose + message-read** (casting-friction
fixes); **zone move-in endpoint** (`POST /proposals/:id/zone`, the inverse of
promote); **split stall-window** (150s received→stalled / 60s thinking→idle);
**ESC bug fix**.

Method: ratify falsified the plan's submap-scoping lean — both owners
independently landed on the R3 zones precedent (inclusive snapshot + client
derive, `?anchor` CLI-only), the breadcrumb parent-walk being the clincher.
circe falsified "spotlight fits the lens machinery." daedalus rejected the stall
liveness-gate (a connected tail proves transport not agent liveness). Zero
wire-guess failures at P2. Gate failed once on a casting-draft prose gap
(stall-window still said ~60s after SW1 split it — the "changing a number the
doc already states is the most dangerous gap" lesson), lead-fixed, cold re-drive
passed.

Branch awaits **Cole's dogfood drive #5 (human gate) + merge ruling** —
subgraphs first. Deferred to own proposals: media/images, live force view,
multi-agent runtime.

Details:
`docs/projects/mind-mapper/sessions/2026-07-21-round5-subgraphs-build.md`.
