# circe's lane — mind-mapper Round 4 surface

Authored against `plan-round4.md`'s **Ratified decisions & lead rulings** (the
authoritative section; claim texts above it are superseded hypotheses) and
Contract 9 as amended through R3. All paths are under `src/mind-mapper/surface/`
unless noted. House TDD discipline: pure logic gets a module + test; component
wiring stays thin over the tested module and is verified live (the
GraphCanvas.test.ts precedent — no DOM test infra in this suite, deliberately).

## P1 — zero engine dependency (this dispatch)

Build order: S1 → G1 (my adopted order; S1 touches the same App region G1's
choke point lives in, so landing it first keeps G1's diff clean).

### S1 — always-open search input (ratified: kill the `open` flag)

The palette stops being a summoned overlay and becomes permanent board chrome at
its existing perch; the always-present input is its own clickable twin (house
rule survives without the icon button).

1. **`App.tsx` state** — `search: {open, query}` collapses to a plain
   `query: string` state (`App.tsx:153` today). Everything that read
   `search.open` re-reads as "query non-empty" or goes away:
   - the keyboard effect (`App.tsx:316–327`): ⌘K / "/" now **focus** (+ select)
     the permanent input via a shared `searchInputRef` instead of setting
     `open: true`. The `typing` guard keeps "/" usable in other inputs; ⌘K from
     inside the input is a harmless re-focus.
   - the remote-hits debounce effect (`App.tsx:379`): gate on `q` only.
   - the `palette` memo (`App.tsx:414`): drops its open-gate — null iff no state
     or blank query (canvas highlight/dim semantics unchanged: no query, no
     dim).
   - `pickSearchResult`: clears the query (result list collapses) + blurs the
     input, then focuses the picked element as today.
   - the search icon `Button` (`App.tsx:959–975`) **dies** — the input renders
     at that exact perch instead, inheriting the FocusBar `top-14` dodge the
     button carried (the palette itself was hardcoded `top-4`; the dodge moves
     with the permanence).
2. **`SearchPalette.tsx`** —
   - gains `inputRef` (from App) and `belowBar: boolean` (the `panelBelowBar`
     idiom) for the `top-4`/`top-14` dodge; the mount-time autofocus effect dies
     (a permanent input must not steal focus at app boot).
   - `onClose` dies. Escape **clears the query and blurs** instead (ratified);
     the `esc` kbd hint stays honest — esc still dismisses the results.
   - results section already renders only when `query` is truthy — unchanged;
     the empty-query palette is just the input bar.
3. **Tests** — no existing test pins the open/close toggle (searchRows.test.ts
   is row resolution, untouched). Verification is live: input present at boot,
   ⌘K and "/" focus it, Escape clears+blurs, FocusBar dodge, pick still
   focuses/zone-switches.

### G1 — selection→ground on send (ratified: open doc = rail selection)

1. **`state/groundBundle.ts` (new, pure)** —
   `groundBundle(selectedIds: string[], openDocId: string | null): string[]`.
   Union: bare selected node/proposal ids (order preserved, deduped) +
   `doc:<openDocId>` appended when a doc is open. Returns `[]` when empty —
   App's `sendMessage` already normalizes `[]` → omitted (today's behavior,
   unchanged). Grammar per Contract 9: bare id = node OR pending-proposal ref,
   `doc:` prefix = doc ref; no `proposal:` prefix minted.
   - TDD (`state/groundBundle.test.ts`): empty/empty → `[]`; nodes-only;
     doc-only; union order (nodes first, doc ref last); dedupe of repeated
     selection ids; no `doc:` entry when openDocId is null.
2. **`App.tsx` choke point** — `onSend` (`App.tsx:1051`) currently sends
   `selection.map(n => n.id)`; becomes
   `groundBundle(selection.map(n => n.id), openDoc?.doc.id ?? null)`.
   `selection` already includes pending synthetics (proposal ids ride free — the
   ratified "canvas selection already rides" clause, verified).
3. **Round-trip for free** — `state/groundRefs.ts` already resolves `doc:<id>`
   refs for MessageBubble chips; live-verify the doc chip renders on the sent
   message.
4. **Candidate (not built):** the composer's ground-chip preview shows node
   selection only — the open doc rides `ground` without a preview chip.
   Honest-preview chip is a P2/drive-4 candidate, not in the ratified scope.

## P2 — engine-wire consumption (blocked on Contract 9 R4 amendments)

**Do not start until daedalus lands the wire + Contract 9 amendments (the
zero-wire-guess bar).** Sketch, grounded to the rulings:

1. **R1 menu chassis** — extract `IdeaNode`'s context menu into a shared
   `NodeContextMenu` (new component; CardGrid cards wrap it too — same chassis
   A1 needs). Ratify/Reject wired to the queue's `POST /proposals/:id/ruling`;
   ratify-from-menu = accept at `suggestedTier` (look up proposal row by
   synthetic id); mirror Claim-D asymmetry (user sketches offer withdraw only);
   `ruleProposal` parses `body.error` verbatim into the notice bar
   (promoteProposal precedent); in-zone refusal renders from the typed 409
   `{error:"zoned", zoneId}` — surface the refusal honestly, don't hide the
   verb.
2. **A1 action slots** — render `actions?` from BOTH `state.nodes[]` and
   `state.proposals[]` in the chassis, under the standard verbs, visually marked
   agent-suggested; click seeds the composer with `seed` + target as ground
   (never auto-sends — `seedComposer` path); show 4 + scroll (cap the visible,
   never the list); reducer handles `actions.set {targetId, actions}`
   (full-array payload) + ratify re-homing onto the minted node id.
3. **ACT1 stalled state** — `stalled` gets its own STATIC attention-tinted
   branch ("agent may be stuck") — must NOT wear the thinking pulse
   (false-liveness), and the client THINKING_TTL backstop must not clear it to
   blank; per-clear-trigger effect discipline (seat doc, P2 thinking pulse
   lesson).
4. **K1 kind badge** — null kind = NO badge (absence, not "unclassified"); guard
   the lookups (`KIND_ICON[null]` crashes the rail today); style
   asserted-by-author vs agent-set from `kindAuthor` on `state.docs[]`;
   `readDoc` envelope loosens to `string|null`.
5. **B1 footer** — short commit + age from `/state.buildInfo` (spread at the
   handler, not in `ProjectState` — the presence precedent; check server.ts, not
   state.ts); absent buildInfo = no footer (dev mode / old daemon).

## Verification

`bun test` full-suite green before each commit; biome on changed files; live
drive under a scratch `MIND_MAPPER_HOME` daemon (never a teammate's), with
`SPELLBOOK_SURFACE_MODE=dev` so a stale dist/ can't shadow the changes.
