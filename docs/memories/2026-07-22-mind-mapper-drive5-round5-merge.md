# Memory — mind-mapper dogfood drive #5 + Round 5 merge (2026-07-22)

Drive #5 (board `music-session-5`: Carlos Niño / LA spiritual-jazz; artist +
threads + the Photay/An Offering collaboration cast via propose-batch) was the
**human gate for Round 5** — passed. **Subgraphs proven end-to-end** live: a
Carlos Niño discography submap (albums + the & Friends ensemble anchored under
the artist), double-click to drill in, breadcrumb out. **Round 5 merged to
develop** (`4e4571f`, single squash, 1038 tests green; push is Cole's — develop
10 ahead). Round-5 features dogfooded working: propose-batch (built the whole
graph in single calls), the `read` verb (killed drive-4's tail-scraping), the
150s stall window (zero false-stalls), right-click add-node, reject, anchoring.

**10 drive-5 findings** (`drive5-findings.md`), all triaged for Round 6:

- **Bugs:** #8 ratify orphans pending edges (they point at the pre-ratify id →
  dangle/vanish; surface must re-point on `node.ratified`), #5 canvas batch-add
  render glitch (grid-toggle recovers), #3 rejected-node lingers + long-title
  context-menu overflow.
- **Casting/CLI:** #10 **ratify-batch** (the twin of propose-batch — the drive's
  standout agent-friction) + `ratify --anchor`; #7 **node deletion** (human +
  agent, delete event, provenance-aware).
- **UX:** #1 add-node **processing phase** (raw→curated in place; the free-text
  box is a command channel), #4 **ingestion queue** (= first concrete use case
  for the multi-agent runtime), #6 **human submap-create affordance** (zone-gap
  pattern), #2 context-doc facilitator touchpoint.

**Sequencing (Cole "Sounds good"):** Round 6 = the fixes + tooling/UX cluster;
**Round 7 = images** (#9, recurring ask every drive) — its own proposal written
at this wrap (`proposal-images.md`) + build + drive.

Details: `docs/projects/mind-mapper/drive5-findings.md`,
`docs/projects/mind-mapper/sessions/2026-07-21-round5-subgraphs-build.md`.
