# Session — mind-mapper Round 3: exploration zones + drive-2 build (2026-07-18)

**Team:** prospero (lead), daedalus (engine), circe (surface), cassandra (gate)
— subagent mode. **Branch:** `feature/mind-mapper-zones` (cut at convene, off
develop @ db321c2). **Plan:** `plan-round3.md`. **Source:** drive2-findings.md
triage (dogfood drive #2's 15 findings).

## What was built

- **Exploration zones + promotion** (the headline, findings 3/8/10): sandbox
  scopes where everything is staging and mess is licensed — `zones` table,
  `proposals.zone_id`, zone verbs with guarded cascade delete, `promote` as
  move-not-duplicate with endpoint-order guards, ratification refused in-zone
  ("promote first — ratification is a main-queue act"). Surface: zone tab strip
  (renders only when zones exist), un-dashed zone board, Promote in the node
  menu, agent-follow across views.
- **Project lifecycle** (finding 1): no auto-mint, no demo seed; 409
  needs-project from every scoped endpoint (SSE pre-stream, WS refused);
  pick-or-create landing; stale-stored-id degrades honestly; `open --project`.
- **Pending-proposal search** (9) + palette honesty; **doc-lens** (5) with XOR
  lens row; **card grid view** (6) consuming the same visibleMap as the canvas;
  **theme toggle** (2) with the token layer restructured so light is written
  once; **markdown chat** (15) via micromark with TreeWalker span-flash;
  **CTA-seeds-composer** (14); **send body chain** (12) adopted from grapevine —
  with a measured correction: the piped-stdin default hangs forever under agent
  shells (grapevine ships this today — Track B item); empty-body exit 2 guards
  the edge.

## Method notes

Ratify round: circe and daedalus independently caught the round's
would-have-shipped-broken bug from opposite sides (zone event scoping vs reducer
coherence) → lead ruling: inclusive tagged `/state`, consumer-side segregation
as a load-bearing clause. P1 falsified (lazy Default minting + an unclaimed
demo-seed path) → 409 mechanism + seed dropped (lead ruling, flagged for Cole).
P2 integration: **zero wire-guess failures** — the Contract 9 amendments were
accurate on every consumed field. Gate: failed once on casting-draft accuracy
(undocumented edge stdin shape silently accepted), reworked (75abf96, incl. an
advisory intake warning — "opacity bounds what you reject, not what you say"),
cold re-drive passed.

## Commits

Plan `241f343`→`57b5156`/`92d94f5` · engine
`b3d5350 84f0c04 5f04ef1 4b68fc0 6609357 d39d816 4074007 ab9783c` · surface P1s
`5742400 a7f2167` · P2 `d23258f 9a93cf7 9e99ea3 68d129f bfb497d` · gate rework
`75abf96` · seams `b6c987e 547406b`. Suite: **920 pass / 0 fail**; mind-mapper
tsc-clean.

## For Cole at drive #3

- Demo-seed drop + no-default-project landing (ruled by lead from your stated
  design position — review the pick-or-create feel).
- Reject-in-zone doesn't exist (zone delete is the only in-zone disposal) —
  expected to surface as a want.
- First zone is CLI/conversational-only (tab strip appears once zones exist).
- The advisory edge-draft warning names expected keys, not offending ones.

## Deferred (unchanged)

Derive layer + embeddings (behind zones, now unblocked for round 4); Operator
pass-through importer; Track B house extraction (chat/rail/presence/CLI
conventions — four pillars).
