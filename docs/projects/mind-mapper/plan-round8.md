# Round 8 plan — surface polish: shadcn overlays + unified action model

**Source:** `drive7-findings.md` (drive #7, human gate on the R7 build). Six
findings, all surface-only. **Branch:** `feature/mind-mapper-round8` (cut at
convene off develop @ R7 tip). **Seats:** prospero (lead — skeleton, seams,
land, gate host), circe (surface — sole build owner). **No daedalus** — see
"What's absent." Gate: cassandra (cold drive).

This is a **near-solo round** (circe owns every slice), so the plan collapses to
one skeleton ending in a lead↔circe ratify pass rather than separate lane files.
The value here isn't cross-seat seam negotiation — it's circe **falsifying the
lead's diagnoses** (the mergeLayout mechanism, the shadcn approach) before
building on them.

## How this plan is authored

Lead owns this skeleton + the seam claims + the gate. circe owns the
implementation and ratifies/falsifies each claim below before moving its card to
doing. Merge to develop is Cole's gate (a focused mini-drive) + Cole's push.

## What we're building (the 6 findings → one round)

The through-line is **#3: port overlay UI to shadcn primitives.** Every other
finding is either carried by that port or rides adjacent to it:

- **#1 Tier picker uniform** — suggested tier = fast-pick, other tiers ALWAYS
  offered (kills the "mis-tagged nodes get more options" inversion).
- **#2 One action model, two homes** — extract the context-menu action set to a
  single source; render it in the right-click menu AND the detail panel; add a
  "Select ▸" flyout for the directional-select trio.
- **#3 shadcn overlay port** — DropdownMenu / ContextMenu / Popover / Dialog for
  every hand-rolled overlay; fixes the filter-menu and group/nest-modal dismiss
  bugs for free.
- **#4 Backlinks-as-navigation** — VALIDATED, **no build** (both layout asks
  self-retracted: the panel already pushes + centers). Listed for completeness.
- **#5 Ratify position-carry** — stop the node jumping on ratify (carry its
  canvas position across the proposal→node id remint) + a "Tidy" re-layout
  button.
- **#6 Multi-select → right-click** — group/nest via a selection-aware context
  menu (click a node = designate the submap parent); fixes the modal
  deselect-coupling + selection-snapshot bug.

## Shared interfaces — ratify on the vine, then fill

Each is a **CLAIM (awaiting circe)** — a falsifiable hypothesis the owner
corrects before building. Load-bearing ones get promoted to `seams.md` after
ratify.

### SEAM 1 — grow the existing shadcn-on-Base-UI layer `(CLAIM — awaiting circe)`

**Claim:** the vendored shadcn-on-Base-UI layer **already exists** —
`src/mind-mapper/surface/ui/` has `context-menu.tsx` + `alert-dialog.tsx` (+
button/badge/textarea) on `@base-ui/react ^1.6.0` (adoption card t-609741be;
alb-frontend `new-york` / cssVariables conventions, Radix→Base-UI). So this
round **grows** that layer, it doesn't start it: add the primitives the findings
need that aren't vendored yet — a **Menu/DropdownMenu** (for the filter control
and the action menus), a **Popover** if wanted, a **Dialog** (for the group/nest
modal — alert-dialog exists but the modal likely wants plain Dialog), and the
**submenu** parts (Base UI `ContextMenu`/`Menu` submenu) for the "Select ▸"
flyout. **Falsify if:** Base UI is missing a primitive a finding needs, or the
existing vendored components need a breaking change to support the new usage.
Name each primitive you vendor/extend this round.

### SEAM 2 — the shared action-model `(CLAIM — awaiting circe)`

**Claim:** the current `NodeContextMenu`/`nodeMenu.ts` action set extracts to a
single declarative model — an `ActionItem[]` carrying
`{ label, icon?, run, enabled, tier?, submenu? }` — rendered by (a) the
right-click menu, (b) the detail panel, (c) the multi-select menu, from ONE
source. No behavior change vs today's menu; the extraction is mechanical.
**Falsify if:** an action's handler is entangled with menu-only state such that
a shared model can't carry it without leaking, OR the detail panel needs a
materially different item set than the popup (in which case name the split).
**Rationale:** two hand-written copies WILL drift — the exact mirror-drift class
the R7 gate caught (CLI body vs route). One source is the invariant.

### SEAM 3 — mergeLayout position-carry across ratify `(CLAIM — awaiting circe)`

**Claim (lead's diagnosis — verify before building):** ratify jumps a node
because `mergeLayout(prev, fresh)` (GraphCanvas.tsx:311) keys position by node
id, and ratify mints a NEW node id (proposal→node), so the ratified node reads
as brand-new → takes a fresh dagre slot that collides. Fix: on the
`node.ratified {id, proposalId}` event, alias the proposal id's last-known
position onto the minted id **before** `mergeLayout` runs (seed `prevById` with
`mintedId → prevPositionOf(proposalId)`). **Falsify if:** the event/render
ordering means the pending node's position isn't available at the moment the
minted node first renders (e.g. the map refresh and the event don't share a
tick), OR positions are already carried some other way and the real cause is
different. **circe: confirm the ordering with a real repro before committing to
this fix.** **Naming note:** GraphCanvas already has an in-code "finding #5"
comment (a _prior_ render-race fix on the same function) — cite this as
"position-carry-across-ratify" to disambiguate.

### SEAM 4 — selection-aware context menu `(CLAIM — awaiting circe)`

**Claim:** a right-click with ≥2 nodes selected surfaces a multi-node action set
(group-into-zone, nest-into-submap; later bulk-ratify/bulk-tag), with the
right-clicked node as the designated parent/anchor for nest. Single-select keeps
today's menu. Uses React Flow's existing selection state + the current
context-menu trigger. **Falsify if:** React Flow's selection + the context-menu
trigger can't cleanly distinguish single vs multi at right-click time, or
designating the clicked node as parent conflicts with the existing
SubmapGroupModal parent-pick. **If 6A lands well, the group/nest MODAL may
retire entirely** (action resolves inline from the menu) — circe decides whether
the modal survives; if it does, it still needs the #6B fixes (shadcn Dialog
dismiss + selection snapshot at open).

## Build order (circe lane)

1. **P1 — shadcn primitive layer** (SEAM 1): vendor/confirm the primitives; the
   substrate everything else consumes.
2. **P2 — action model + menus** (SEAM 2, #1, #2, #6A): extract the shared
   action model; render via shadcn ContextMenu with the "Select ▸" flyout and
   the uniform tier picker; render the same model in NodeDetail (parity); add
   the selection-aware multi-select mode.
3. **P3 — overlays → shadcn** (#3, #6B): port the filter control (Popover /
   DropdownMenu) and the group/nest modal (Dialog + selection snapshot at open);
   dismiss bugs resolve with the primitives.
4. **P4 — layout** (SEAM 3 / #5): mergeLayout position-carry on ratify + a
   "Tidy" re-layout action.

Order is a dependency chain (P1 substrate first), but it's one owner — circe
sequences within it. TDD where the logic is pure (the action-model derivation,
the position-carry aliasing, the selection snapshot); the shadcn wiring is
render-level and verified at the gate.

## Verification gate

Cassandra cold drive after build. **Focus (Cole's call at drive-7 wrap): the
subgraph / group-nest flow (#6A)** — it's the one genuinely ambiguous design
call, so exercise multi-select → right-click → group/nest → parent-designation
end to end, plus the dismiss + selection-snapshot behavior. Also verify: ratify
no longer jumps a node (#5), the tier picker offers all tiers uniformly (#1),
and the filter menu dismisses on outside-click (#3). Full suite green + tsc
clean. Two-round shape (cold drive → falsifications → rework → cold re-drive) is
the safety net.

## What's ABSENT (assert the mirrors that don't exist)

- **No engine changes.** No `db.ts` / `server.ts` / `cli.ts` edits; no new
  routes (group/nest/anchor/zone/ratify all already exist); no migration; no
  `events.ts` addition (the `node.ratified` event #5 needs already exists and
  carries `proposalId`). **This is why daedalus is not seated.**
- **No Contract 9 amendment.** No wire shape changes — the whole round is
  client-side rendering + client-side layout. (If SEAM 3 somehow needs an engine
  field, that falsifies "surface-only" and pulls daedalus in — flag
  immediately.)
- **No #4 build.** Backlinks-as-navigation is validated as-is.

## Open questions

- Does the group/nest **modal survive** 6A, or does the action go fully inline
  in the context menu? (circe's call during P2/P3.)
- Does the shadcn port swallow the **whole** overlay surface this round, or do
  we scope it to the findings' overlays (filter, menus, group/nest modal) and
  leave others (search palette, ingestion tray) for a follow-on? Lean: scope to
  the findings' overlays; note any left un-ported so it's not silent.
