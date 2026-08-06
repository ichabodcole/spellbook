# Mind-mapper Phase 0 spike — research to passed spike in one day — 2026-07-16

## Context

The mind-mapper proposal (2026-06-30) had stalled at "next steps: landscape
analysis." This session ran the entire pre-V1 arc: landscape analysis → fragment
consolidation → user research → architecture resolution → the Phase 0 spike
itself (anthill team: prospero lead, circe surface, daedalus engine, on
`feature/mind-mapper-spike`) → spike closed **passed** by Cole.

## What Happened

**Morning — research and design.** Deep-research landscape analysis
(`landscape-analysis.md`): loose emergent schemas validated, selection-as-
context peer-reviewed (Sensecape), transitive context injection identified as
the documented failure mode, canon-contradiction detection found to be unclaimed
by any shipping tool. Consolidated the two Operator fragments into the canonical
precursor (v4). Then a grapevine user interview with **bobbin** (the
story-loom/Hollowbrook agent) — `user-research-story-loom.md` — which forced the
session's biggest decision: **map-as-view over map-as-store**, resolved by Cole
as map-as-view **with a staging lifecycle** (source → staging → knowledge; nodes
are claims-within-docs). Substrate stances landed the same hour: plain property
graph, graphology, bun:sqlite + FTS5(+vec later), asserted/derived edge
provenance.

**Same-day substrate luck:** the interview surfaced Operator's missing
links/backlinks as the foundational primitive — and Operator's team scoped,
consumer-consulted (bobbin + this project as registered consumers), and mostly
**built** doc-linking v1 the same day (channel `operator-doc-linking`;
create-stub-and-link is now the named primitive the mapper's ratification
write-path will call).

**Afternoon/evening — the spike.** Tight anthill session, four drive-feedback
rounds with Cole. Every round produced rulings (see proposal "Phase 0 Spike —
Findings"): conversation sidebar not query bar; context rail + in-surface doc
viewer with span-highlight click-through; focus lens as addressable view-state
(agent-writable in V1); node right-click context menu; **shadcn/Base UI vendored
component layer** (adopt-as-consumed; retrofit sweep with principled skips);
edge grammar (directed claims, reverse pairs with distinct labels,
`direction:"both"` symmetric); canvas search with live highlight/dim
(equal-capabilities counterpart of agent search verbs).

## Notable Discoveries

- **Equal-capabilities is generative:** two agent-side primitives (the lens,
  `focusRequest`) fell out of building _human_ affordances — the V1 agent's
  "look here" verbs got landing pads for free.
- **Driving beats planning for surface work:** all seven rulings came from Cole
  touching the surface, none from documents.
- Scars (now seams Contracts 5–7 + seat docs): `src/`-relocated surfaces need
  the daemon cwd pinned to `src/<spell>/`; routes bake at boot while data reads
  live; span anchors must be whitespace-tolerant (formatters reflow committed
  markdown); shadcn-on-Base-UI is a port, not a copy; a dep-free `cn()` means
  variants replace recipes.

## Changes Made

- `plugins/spellbook/skills/mind-mapper/` — daemon (`server.ts`), `cli.ts`,
  tests, stub dataset + docs.
- `src/mind-mapper/surface/` — React Flow canvas, game-board layout, context
  rail, doc viewer, conversation sidebar, focus lens, search palette, vendored
  `ui/` (button/badge/textarea/context-menu).
- `docs/projects/mind-mapper/` — proposal heavily updated (rulings + findings
  section), `landscape-analysis.md`, `user-research-story-loom.md` (new).
- `.anthill/dev/` — seat syntheses + seams Contracts 5–7.
- Root: `tsconfig.json` gains DOM libs (merge-note for astrolabe branch);
  `@base-ui/react` added; `.bounty-session` gitignored.

## Next Steps

- V1 planning via `anthill:plan` (phases sketched in proposal findings).
- Dogfood rounds as a first-class phase (real brain-dump; Hollowbrook with
  bobbin). Force-layout mode = parked experiment card.
- Merge-coordination note: astrolabe branch hits the tsconfig + cwd-pin
  refinements (seams Contract 5) at merge.
- Triage bounty-board feedback in GitHub issues (Cole flagged post-finalize).
- From the dual finalize review (both verdicts: ready to merge): V1 should add a
  committed test pinning Contract 6 (span whitespace-tolerance is currently
  browser-proved only), implement Contract 1's release-mode resolution (spike is
  dev-only by declared carve-out), and watch the `types.ts` closed unions
  (Tier/NodeKind/DocKind) — the most likely place a fixed taxonomy ossifies
  against the loose-schema stance when V1 negotiates from the StubMap baseline.
