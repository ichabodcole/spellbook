# Dogfood drive #7 — findings (2026-07-22)

Casting agent: prospero. Build under test: Round 7, `feature/mind-mapper-round7`
(tags/controlled-folksonomy, faceted filter, ratify tier-picker, directional
select, backlinks, markdown doc-view, submap-create-on-pending, stable-port).
Board: `music-session-6` (the Carlos Niño map from drive #6). Findings accrete;
triage at wrap.

## Live Round 7 confirmations (working in the wild)

- **Ratify tier-picker (finding-#7 fix)**: Cole ratified the Carlos Niño node —
  a `suggestedTier:"cast"` subject that had NO ratify action in drive #6. It's
  ratifiable now. The exact dead-end is fixed, verified live.
- **Stable-port**: daemon booted on fixed `--port 60700` (dogfooding finding
  drive-6 #4).

## 1. Ratify tier choice should be uniform, not richer-on-mistake (inverted affordance)

Cole: some nodes show MULTIPLE ratify options ("ratify as thread / canon /
story-local"), others only a SINGLE "ratify as thread" — why?

**Answer (the mechanic):** the menu keys on the node's `suggestedTier` (the tier
I proposed it at):

- **Valid suggested tier** (e.g. "thread") → the one-keystroke **"Ratify as
  thread"** fast-path (accept-at-suggestion). ONE option.
- **Invalid/absent suggested tier** (the "cast" subjects I mis-tagged) → the
  Round-7 RATIFYFIX **three-option fallback picker** (canon/thread/story-local),
  so they're not a dead-end. THREE options.

So the difference is purely my tier assignment — and it produces an **inverted
affordance**: the MIS-tagged nodes get MORE choice, the correctly-tagged ones
get exactly one (no override). A human who wants to ratify a "thread"-suggested
node as "canon" instead has **no one-click path** from the menu today (the
picker only appears as the invalid-tier fallback).

**Finding:** the tier choice should be **uniform** — the suggested tier is a
_default/fast-path_, but the human should ALWAYS be able to pick a different
tier. Design options: (a) always show the picker (suggested tier pre-highlighted
/ first) so every node offers all three; (b) keep the one-keystroke fast accept
AND add an "Ratify as…" submenu/expansion for the override. Lean (a-ish): the
fast single item stays for the suggested tier, plus the other tiers always
offered (so it's "1 highlighted + 2 others", never "1 only"). This removes the
"mistake = more options" inversion and gives the human tier control everywhere.
Surface-only (nodeMenu.ts — the RATIFYFIX narrowing), small. Bundle with the
job-queue round's polish, or a quick follow-on.

## 2. Action parity — detail panel = context menu, + flyout to reclaim vertical space

Cole: the node **detail panel** should carry the SAME actions the right-click
context menu has — it's missing some (ratify actions, directional select, etc.).
The detail panel is the nicer home for them: it has more working room. Have the
actions in **both** locations. Separately, on the compact right-click menu, the
list is getting tall — reach for a **flyout/submenu** to stop eating vertical
space, especially the **select cluster** (connected / children / parents), which
is the strongest flyout candidate (three items that belong together). Ratify may
collapse to one item anyway (see #1), so it's less of a space problem there.

**Finding:** two moves, both surface-only:

- **(a) Detail-panel action parity.** The context menu's action set (built in
  `NodeContextMenu.tsx` off `nodeMenu.ts` state) should be reused in
  `NodeDetail`, not re-implemented — extract a shared action-list model (the
  menu items + their handlers) so both surfaces render from ONE source (avoids
  the mirror-drift trap — two hand-written copies of the same action set WILL
  drift, exactly like the CLI-body/route drift the R7 gate caught). Detail panel
  gets the roomier layout; the popup stays compact.
- **(b) Flyout for grouped actions in the compact menu.** The directional-select
  trio (DIRSELECT) → a "Select ▸" submenu; candidate pattern for any future
  action cluster. Keeps the top-level menu short. Ratify: if #1 lands (suggested
  tier = fast-pick + 2 others always offered) it's small enough to stay inline,
  or fold into a "Ratify ▸" flyout if it grows.

Natural pairing: do #1 + #2 together as a **surface-polish round** (both are
`NodeContextMenu`/`NodeDetail`/`nodeMenu.ts`, no engine) — a clean small round
between here and the job queue, or the job-queue round's UI-polish lane. The
shared action-list extraction (a) is the load-bearing piece; the flyout (b) and
the tier-uniformity (#1) ride on it.

## 3. Filter menu doesn't dismiss on outside-click → adopt shadcn primitives for overlays

Cole: the **filter menu** opens but clicking outside doesn't close it — feels
like a bug (these overlays should dismiss on outside-click). Broader convention
ask: **where possible, use shadcn components** rather than hand-rolling overlay
UI, because they handle exactly this (outside-click dismiss, Escape, focus trap,
ARIA) for free — stand on the shoulders of the library instead of re-deriving
it.

**Finding (bug + substrate direction):**

- **The bug:** the facet-filter control (the `filteredMap` facet UI from R7) is
  a hand-rolled dropdown with no dismiss-on-outside-click / Escape. Same smell
  likely on the other bespoke popovers (the context menu itself, the tier
  picker, the add-tag input) — audit all of them for outside-click + Escape
  dismissal.
- **The direction:** adopt **shadcn primitives** for overlay UI — DropdownMenu /
  Popover / ContextMenu all ship the dismiss + focus behavior. This is the
  substrate for #1/#2: the flyout (b) becomes DropdownMenu's native submenu; the
  context menu becomes shadcn ContextMenu; the detail-panel parity reuses the
  same DropdownMenu items. So #3 isn't a _separate_ round — it's the RIGHT WAY
  to build the #1/#2 surface-polish round: **port the menus to shadcn
  primitives, and parity + flyout + dismiss all fall out of the migration.**
- **Prior art (don't research cold):** circe already ran a _shadcn-on-Base-UI_
  port investigation (noted in prospero.md candidates) — the mapper surface is
  the React+Bun+Tailwind-v4 scaffold, so shadcn is a known-viable fit here. That
  investigation is the seam-ratify input for this round; confirm the Tailwind-v4
  - Base-UI variant before the owner builds.

**Revised shape:** the surface-polish round is now **"port overlay UI to shadcn
primitives"** — dismiss-bug fix (#3) + action-list-as-shadcn-items reused across
menu & detail (#2a) + Select flyout as native submenu (#2b) + tier picker as
uniform items (#1). One coherent round, shadcn is the through-line. Still
surface-only, but bigger than "a quick follow-on" — it's a proper small round
(circe lane), seam-ratified against the prior port investigation.

## 4. Backlinks-as-navigation is a keeper (celebration — no build; two asks self-retracted)

**Celebration (validated feature — the durable part):** the R7 backlinks
("Referenced by" in the doc/detail view) are a hit — Cole reads a context (e.g.
"Laraaji Context") then clicks _through_ its backlinks to move around, and the
canvas centers the target as he goes. That's an emergent, valuable navigation
mode: **backlinks are a way to traverse the map, not just a reference list.**
This was circe's derive-it-client-side call (no engine) — it's paying off. Worth
protecting and leaning into in future navigation work.

**Two asks, both self-retracted on continued use — NO build here:**

- Push-sidebar (seq 37): the panel **already pushes** the canvas (doesn't
  overlay); the "map cut off" was just pan position.
- Pan-on-backlink (seq 39): clicking a backlink **already centers** the target
  node. Both behaviors already correct.
- Scar worth one line: a target briefly out of view reads as "the panel is
  covering the map" — no code change, but a reminder that viewport/panel
  coordination is where confusion lands; keep an eye on it as navigation grows.

**Round shape:** the surface round is #1–#3 (circe lane, no engine): shadcn
overlay port (#3) carrying tier-uniformity (#1) + menu/detail action parity &
Select flyout (#2). #4 contributes no build — pure validation. Coherent,
seam-ratified against circe's shadcn-port investigation; good candidate for the
standalone small round before the job queue.

## 5. Ratify jumps the node (loses its position, lands under another node) — id-remint breaks position-carry

Cole: ratifying a node (the flute thread) **repositions** it — sometimes
underneath another node, hard to find. Asks: (A) stop the reposition; (B) if
not, a way to re-layout everything so nothing's hidden.

**Root cause (confirmed in code — precise):** node positions are **not persisted
engine-side** (no x/y columns; db.ts has none). Layout is computed client-side
in `GraphCanvas.tsx`, and `mergeLayout(prev, fresh)` (GraphCanvas.tsx:311)
carries a node's on-screen position across re-renders **by matching node id**: a
known id keeps `existing.position`; a **new id takes the freshly-computed
dagre/force position** (line 318, `if (!existing) return f`). Ratify mints a NEW
node id (proposalId → node id — the `node.ratified` event carries both
`{id, proposalId}`), so to `mergeLayout` the ratified node is a **brand-new id**
with no `prev` match → it gets a fresh dagre slot instead of inheriting the
pending node's placement. And because every _other_ node kept its prev position
(not its dagre slot), the fresh node's dagre coordinate collides with whatever's
already there → "underneath another node." Exactly the report.

This is the **same pending-carry gap** R7 solved for tags/actions (re-home onto
the minted node at ratify) — but **position lives client-side**, so it wasn't in
that engine-side re-home. Position needs the same treatment, on the surface.

**Finding (A — the real fix, do this):** on a `node.ratified` event, **alias the
proposal id's last-known position onto the minted node id** before `mergeLayout`
runs (seed `prevById` with `mintedId → prevPositionOf(proposalId)`). Then a
ratified node keeps its exact on-screen spot — no jump, no collision.
Surface-only (`GraphCanvas.tsx` mergeLayout + the ratified-event handler that
has both ids). Small, well-scoped. **Naming collision to flag for
circe/daedalus:** GraphCanvas already has an in-code "finding #5" comment (the
mergeLayout render-race fix from a _prior_ round, line 301) — THIS drive-7
finding #5 is a _different_ thing that extends that same function; cite "drive7
#5 / position-carry-across-ratify" to disambiguate.

**Finding (B — complementary, cheap):** a **"Tidy / re-layout" action** (button
or command) that re-runs dagre/force over the whole map and resets positions —
the escape hatch when things pile up (after a bulk ratify, an import, or a
manual mess). Independent of (A); good to have regardless. (A) prevents the
pile-up; (B) cleans one up. Both surface-only.

Fits the same **surface round** as #1–#3 (all `GraphCanvas`/`NodeDetail`/menu,
circe lane) — position-carry (A) is the load-bearing one; tidy (B) is a nice
adjacent. Now a genuinely worthwhile little round: shadcn overlay port + tier
uniformity + action parity + Select flyout + ratify-position-carry + tidy.

## 6. Group/nest are lost in the top bar → make multi-select a right-click act; + modal/deselect coupling bug

Cole found the submap gestures (the **Group** / **Nest** buttons in the top
action bar) but they "get a little lost" and their labels aren't self-evident.
Two parts:

**6A — Multi-select actions belong in the right-click context menu
(discoverability + reflex).** Cole's mental model: right-click is where node
actions live, so when several nodes are selected, right-clicking (on the canvas
or on a node) should be where group/nest lives too — and **right-clicking a
specific node in the selection could designate it the parent/anchor** (a natural
way to pick the submap root). "Actions near the nodes, not up in a list of
buttons at the top." This is the **selection-aware context menu**: the same
`NodeContextMenu` gains a multi-select mode whose items are the multi-node
actions (group into zone, nest into submap, and later bulk-ratify / bulk-tag),
with the clicked node as the designated parent. **Directly extends #2 (action
parity + one action model) and #3 (shadcn ContextMenu).** Net effect: the
top-bar Group/Nest buttons can retire into the context menu (or stay as a
secondary path). Surface-only, circe lane.

**6B — Group/nest modal doesn't dismiss on outside-click — AND clicking the
canvas deselects the nodes the modal depends on (state-integrity bug).**
Concrete sequence: select 3 nodes → click Nest → modal opens (bound to those 3)
→ click the canvas → the canvas **deselects** the 3 nodes but the **modal stays
open**, now referencing a selection that no longer exists. Two coupled defects:

- _Dismiss:_ the modal is a hand-rolled overlay with no outside-click/Escape
  close — **same class as #3** (the shadcn overlay port covers **modals too**:
  Dialog/AlertDialog ship outside-click + Escape + focus-trap). Folds into #3.
- _Snapshot-vs-live selection:_ even with dismiss fixed, the real bug is the
  modal reads the **live** selection, which the canvas can empty underneath it.
  Fix: **snapshot the selected ids at modal-open** (immune to later deselect),
  OR close the modal when the selection it depends on clears. Cole's ask
  (outside-click closes it) satisfies the coupling because the deselect and the
  close happen together — clean. Log the snapshot point regardless; it's the
  underlying correctness issue, not just a dismiss nicety.
- Cole's own caveat: auto-closing a modal on stray outside-click _could_ be
  annoying if you didn't mean to lose the modal — BUT he notes that if 6A lands
  (multi-select → context menu), the whole flow changes feel and this modal may
  not even exist as a separate step (the action could resolve inline from the
  menu / a submenu), sidestepping the coupling entirely. So **6A partly moots
  6B** — worth doing 6A first and seeing whether the modal survives.

**Round shape (updated):** the surface round is now genuinely meaty but coherent
— one **shadcn-overlay-port + action-model** round, circe lane, no engine:

- overlays → shadcn primitives (#3): dropdowns, popovers, context menu, **and
  modals** — kills the filter-dismiss bug (#3) and the group/nest-modal-dismiss
  bug (#6B).
- one shared action model rendered in context menu + detail panel (#2a), with a
  **selection-aware multi-select mode** (#6A) and a **Select ▸ flyout** (#2b).
- tier picker uniform (#1); ratify **position-carry** (#5A) + **Tidy** re-layout
  (#5B); modal reads a **selection snapshot** (#6B). This is the "surface-polish
  round" — a clean standalone circe round before the job queue, seam-ratified
  against circe's shadcn-on-Base-UI port investigation.
