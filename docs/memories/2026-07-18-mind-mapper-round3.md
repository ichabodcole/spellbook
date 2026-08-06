# Mind-mapper Round 3: exploration zones built and gate-passed

**Date:** 2026-07-18 · **Branch:** `feature/mind-mapper-zones` (awaiting Cole's
drive #3 + merge ruling)

One anthill round built drive-2's triage: exploration zones + promotion (sandbox
staging scopes, move-not-duplicate promote, ratification-at-the-boundary), the
no-default-project 409 lifecycle with pick-or-create landing (demo seed
dropped), pending-proposal search, doc-lens, card grid view, theme toggle (token
layer restructured), markdown chat with TreeWalker span-flash,
CTA-seeds-composer, and grapevine's send body chain (with a measured fix for the
piped-stdin hang that grapevine itself still ships — Track B). 920 tests green.

Method yield: both owners independently caught the zone-event-scoping bug at
ratify; P2 integration had zero wire-guess failures; the gate failed once on
casting-draft accuracy (undocumented edge shape) and passed on cold re-drive
after rework incl. an advisory intake warning ("opacity bounds what you reject,
not what you say"). Upstream: anthill #48 (commit tool can't stage deletions),
#49 (stage-late-land-fast convention).
