---
date: 2026-08-24
spell: grapevine
rule: none yet
disposition: judgment-only
---

# A flag is global because the tool's docs make it global

## The situation

Applying the acc conformance standard to grapevine (working session on the
`standard-grapevine` vine, acc + trellis, Cole monitoring). The parser accepted
all 26 flags on every verb — one global registry — while help described per-verb
sets. The standard ruled that shape out as accepted-and-ignored (its DT-1
finding), leaving a choice: declare the flags honestly global (true of the
parser, false of the behaviour), or move the parser to per-verb sets (a breaking
change for callers passing flags cross-verb).

## What the familiar concluded

Neither pole survives contact with the tool's own contract. grapevine's SKILL.md
explicitly instructs agents to pass `--as`/`--from` on **every** verb (a fresh
shell per command means `GRAPEVINE_FROM` never persists). A caller following the
tool's own documentation must not be rejected for it — so `--as`/`--from` are
contractually global regardless of how the parser is organised, and the other 24
flags go per-verb.

## What the mage wanted instead

No disagreement — acc (leading the session) accepted it and is adding it to the
standard, credited to the session. Recorded here because the judgment came from
a source neither pole considered.

## The distilled judgment

**The shipped docs are a source of truth about the interface that neither the
parser nor the command table holds.** If the documentation a tool ships tells
callers to pass a flag everywhere, that flag is part of the contract, and a
declaration contradicting the docs is wrong even when it matches the code.
Corollary used in the same session: a breaking parser change is cheap exactly
when the callers are agents reading help fresh each session — measured here as
107 pre-existing tests passing unmodified.

## Binding

- **Rule affected:** none — judgment only (candidate input to house-style if a
  second spell walks it; bounty will, when its global registry is fixed).
- **Repeal criterion:** n/a.
