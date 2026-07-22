# circe — Round 7 lane (surface)

Owner: circe (surface). Branch `feature/mind-mapper-round7`. Board card
`t-r7-surface`. Authoritative rulings: `plan-round7.md` "Ratified decisions &
lead rulings". This lane fills that skeleton for the surface slice.

Two dispatches. **P1** (this build) = the four items with ZERO engine
dependency. **P2** = deferred until daedalus lands the R7 TAGS wire + writes the
Contract 9 R7 amendment.

---

## P1 — no engine dependency (BUILD NOW)

Build order: RATIFYFIX (the bug) → DIRSELECT (directed derive) → BACKLINKS (pure
derive + DocViewer section) → MDVIEW (the extraction). Each: TDD the pure logic,
full suite green before commit, biome on changed tsx/ts, semantic tokens both
themes, file-scoped commits.

### RATIFYFIX — ratify tier-picker fallback (finding #7; surface-only)

The bug: `nodeMenu.ts:50`
`ratifyAs = ACCEPT_RULINGS.has(suggestedTier) ? … : null` — an agent proposal
with an UNRECOGNIZED tier ("cast"/"background") resolves `ratifyAs === null`, so
`NodeContextMenu.tsx:107-136` renders the one-keystroke "Ratify as {ratifyAs}"
only when truthy, leaving a Reject-only dead end (the human can't accept the
agent's node at all).

Fix (ruled — FLAT items, NOT a submenu; the vendored context-menu has no Submenu
primitive): when `ruling.author === "agent" && ratifyAs === null`, render three
flat `ContextMenuItem`s — "Ratify as canon / thread / story-local" — each
calling `onRule(proposalId, tier)`. Keep the one-keystroke "Ratify as
{ratifyAs}" when the suggestion IS a valid ruling. `Ruling` already includes all
three tiers; `App.ruleProposal` (663) dispatches any of them. Surface-only.

Test: the pure `menuInfoFor` derive already emits `ratifyAs: null` for a
background/unknown tier (pinned by nodeMenu.test.ts). The fallback branch is a
render concern — verified live (a "cast"-tier proposal now shows the three
pickers). Add a nodeMenu test asserting an UNKNOWN tier (e.g. "cast") also
narrows to `ratifyAs: null` (the trigger condition the fallback keys on), so the
derive contract is pinned.

### DIRSELECT — directional select (finding #2; surface-only)

`neighborhood.ts` `lensSet` is undirected. Add a directed depth-1 derive:
children = OUTGOING (`edge.source === id → target`), parents = INCOMING
(`edge.target === id → source`), over `boardMap.edges` (the active submap slice
in App). **Ruling: a `direction:"both"` edge counts for BOTH children AND
parents** (a bidirectional edge makes the neighbor both).

- `neighborhood.ts`: new pure `directedSet(map, nodeId, "children"|"parents")`
  returning the node ∪ its directed depth-1 neighbors (both-edges
  bidirectional).
- `NodeContextMenu.tsx`: two new `NodeCommand` members ("Select children",
  "Select parents") + two `ContextMenuItem`s beside "Select connected".
- `App.handleNodeCommand`: two cases unioning `directedSet(submapMap, …)` into
  `setSelectedIds`.

TDD the directed derive incl. the both-direction case (both parents & children).

### BACKLINKS — doc "referenced by" (finding #6; surface-only, client-derive)

Ruled: ZERO engine (no read-field) — the agent already holds `/state`. Pure
`backlinksFor(docId, nodes, proposals)`:

- ratified = nodes whose `sources[]` include a `DocSourceRef` with that docId
  (via `isDocSource`).
- pending = proposals whose `status === "pending" && evidence.docId === docId`
  (a ratified proposal became a node already counted via sources; a rejected one
  is gone).
- return `{ ratified: {id,title}[], pending: {id,title}[] }` — the two kept
  distinct.

`DocViewer.tsx` gains a "Referenced by" section (ratified nodes + pending
proposals, visually distinguished). App passes `nodes`/`proposals` + an
`onNavigate(id)` callback = select + `followFocus` (inverse of the existing
node→doc `onOpenSource` jump; the search-pick precedent, App:577). Lives in a
new `state/backlinks.ts`, TDD'd.

### MDVIEW — markdown doc rendering (finding #9; surface-only; an EXTRACTION)

The markdown DOM + TreeWalker span-flash lives module-PRIVATE in
`MessageBubble.tsx:31-88` (`AgentMarkdown` / `wrapInstructions` / `unwrapMarks`
/ `<mark className="mm-span-mark">`). Extract into a shared `<Markdown>`
component (`Markdown.tsx`):

- `Markdown({ text, highlightSpan, scrollToHighlight, className })` — same
  micromark render + TreeWalker wrap/unwrap; `scrollToHighlight` scrolls the
  first mark into center after wrapping (DocViewer's old mount-scroll behavior);
  `className` extends `mm-markdown`.
- `MessageBubble` consumes it (no behavior change — chat renders identically +
  span-flash; no scroll, its scroll is scrollRequest-driven).
- `DocViewer` repoints off its raw `<pre>` + hand-rolled 3-segment highlight
  onto
  `<Markdown text={doc.content} highlightSpan={highlight} scrollToHighlight className="font-story text-sm leading-relaxed text-ink-dim">`.
  Trim the now redundant `normalize()` (leading-`#` strip + hard-unwrap —
  micromark renders paragraphs; header already shows the title) and the local
  `segments()`/ `escapeRegExp`. The `.mm-span-mark` styling matches DocViewer's
  old `bg-canon/25` mark, so the highlight look is preserved.

Both themes. Live-verify chat unchanged AND the doc renders markdown +
span-flash.

---

## P2 — BLOCKED on Contract 9 R7 tags wire (daedalus) — DO NOT START

Sketched only; dispatched separately after daedalus lands `node_tags` +
`tags.set` + the Contract 9 R7 amendment.

- **TAGS surface** — tag chips (own row on the node card + NodeDetail), an
  add-tag affordance, and reuse-suggestion autocomplete over existing tags
  (agent-curation is a surface concern; engine stores freeform strings).
  Consumes `state.nodes[].tags` / `state.proposals[].tags` +
  `PUT /tags/:targetId`.
- **FILTER** — a faceted filter control (Status / Tier / Tags) that HIDES
  non-matching nodes (distinct from spotlight's DIM). New `filteredMap` memo
  TERMINAL to the chain, AFTER `visibleMap` (ruled — filtering before the lens
  BFS distorts the neighborhood). AND-across-facets, OR-within. Status has no
  literal wire field: derive from `n.pending`/`n.processing`; "rejected" never
  renders on canvas (drop that facet). Tier = `n.tier`. Tags = the wire.
- **SUBMAPPEND** — pending-group case: select ≥2 pending proposals → pick parent
  → the surface's FIRST `ratify-batch` call
  `{ruling, ids, anchors:[{node, parent}]}` (one top-level ruling sidesteps the
  per-proposal tier problem). The "empty submap under a node" case is DEFERRED
  to the intent-composer round (can't anchor a pending node from the surface).

**Blocked on:** Contract 9 R7 tags wire (`node_tags` table, `tags.set` event,
`tags?` on `state.nodes[]`+`state.proposals[]`, `PUT/DELETE /tags/:targetId`) —
daedalus owns it, writes the amendment BEFORE this consumes it (zero-wire-guess,
held 4 rounds).
