# Memory — mind-mapper dogfood drive #6 + Round 6 merge (2026-07-22)

Drive #6 (board `music-session-6`: Carlos Niño connections + instrumentation +
Laraaji; 24 nodes / 26 edges cast via ONE propose-batch) was the **human gate
for Round 6** — passed. Round 6 features verified live: **delete** cleared 3 raw
speech-to-text instruction-nodes (`proposal.deleted` each; the refine-a-human-
node flow: research → DELETE raw → propose curated), **propose-batch at scale**
(50 proposals, one call), the **read** verb, ratify. **Round 6 merged to
develop** (`b5c99c8`, single squash, 1087 tests; push is Cole's — develop 12
ahead).

**8 drive-6 findings** (`drive6-findings.md`), all DESIGN + one bug:

1. **Tags / controlled folksonomy** — the loose-emergent-schema principle
   crystallizing; freeform tags, agent-as-curator (reuse-suggest + synonym
   reconcile, never lock a taxonomy).
2. Directional select (children/parents/both — edges are directed).
3. **Async JOB QUEUE** [BIG, Cole "very important"] — off-canvas sidebar, status
   - sub-tasks, automate-over-discipline, many-jobs-one-deliverable, and
     OWNERSHIP/claiming (= the `claimed_by` seam daedalus named in R6; Cole
     independently arrived at it). The multi-agent runtime's substrate.
4. Daemon-restart resilience (stable-port; the daemon got reaped twice this
   session — tail self-healed, browser can't).
5. Submap-create on PENDING (Round-6 built it ratified-only → invisible on an
   all-pending exploration board; fix via intent-composer + ratify-then-anchor).
6. Backlinks (docs show "referenced by" nodes — pure derivation from evidence,
   auto-maintained; aligns with Operator doc-linking).
7. BUG: a proposed node with an unrecognized tier has NO ratify action (dead
   end) — fix: tier-picker fallback. Half my casting error (I mis-tag subjects
   `suggestedTier:"cast"`; valid tiers are **canon/thread/story-local** — use
   canon).
8. Faceted filter (status/tier/tag) — same system as #1 (tags = data, filter =
   view); status-filter is a zero-engine client derive.

**Sequencing (recommended, pending Cole):** next round = metadata/filter/polish
(#7 bug + #1 tags + #8 filter + #2/#5/#6/#4); then the **job queue (#3)** its
own round; **images** (`proposal-images.md`) queued after. At next drive start,
rebuild dist + restart daemon on the new build.

Details: `docs/projects/mind-mapper/drive6-findings.md`.
