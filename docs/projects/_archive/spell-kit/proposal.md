# Spell Kit — a dev platform for sharing code between spells, proven by slices

**Status:** Draft (rewritten 2026-08-30 after scope correction) **Created:**
2026-08-30 **Author:** Cole Reed + Claude Code

> **This is an MVP slice, not an extraction.** The deliverable is the
> **capability** to share code between spells — surface, backend, and styling —
> proven by the smallest thing that actually proves each. It is explicitly
> **not** the work of extracting everything extractable, nor of designing the
> right abstractions. That is a later project.
>
> **Superseded:** the first draft was built around "extract a shared surface
> kit." A [gap analysis](./gap-analysis.md) found seven blocking defects in its
> phasing, and Cole then corrected the scope: _"the problem we're trying to
> solve with this project is having the functionality and capability to do
> that."_ The gap analysis is kept verbatim as the record; its findings are
> carried into the slices below rather than annotated onto a dead plan.

---

## Overview

Eight spells, one build process, and **zero imports crossing a spell boundary**
— verified. Every attempt to share has therefore been a copy, and the copies
have drifted into contradictions: three implementations of one image-optimize
step, two making mutually exclusive claims about the same `Bun.Image` API; a
`useSession` capability ratchet where the older copies are strictly buggier;
`openBrowser` in 8 copies and 4 spellings, two broken on Windows.

**The blocker is not that nobody has done the extraction. It is that there is
nowhere to put shared code and no proven path for it to reach a shipped spell.**
This project builds that path and proves it works, on the smallest possible
example of each kind.

## Problem Statement

There are three distinct sharing capabilities, and **none of them exists**:

1. **Shared surface code** — impossible today, because a spell's surface is only
   bundled once it has been relocated and built. One spell (mind-mapper) has
   been; seven have not.
2. **Shared backend code** — impossible today, because `scripts/*.ts` ships as
   **source** and executes at a destination that never ran `install`. Anything
   it imports must physically be there.
3. **Shared styling** — impossible today, because every spell's tokens are
   copied into its own `styles.css`, and nothing defines a base to override.

Each has a different mechanism and a different failure mode. **A project that
proves one and assumes the others is worth very little**, because the assumed
ones are where the surprises are.

## The rule this project runs on

> **Spend effort where it proves a capability. Spend none where it does not.**

Concretely: prefer the **most boring** available shared module, not the most
valuable one. `printJson` is byte-identical across **five** spells — there is no
abstraction to invent, so sharing it tests the platform and nothing else. The
chat sidebar (1,281 lines across 4 spells) is the _valuable_ extraction and
exactly the wrong first one: its four copies are four architectures, so
extracting it is a design project wearing a platform project's clothes.

**Where design work is genuinely load-bearing to a proof, spend it. Where it is
not, bank the ruling and move on.**

## Proposed Solution — four slices, each with a falsifiable proof

### Slice 1 — Both spells build

imago is ported onto the pipeline mind-mapper built and shipped — which
establishes the mechanism and the packaging, **not** that any consumer ran it
([RC](./design-resolution.md)): surface relocated to `src/imago/surface/`,
`resolveMode()` + dev-only dynamic import, committed `dist/`, `build.ts`
generalized to serve both spells.

**This slice contains the one genuinely hard structural problem, and it is
platform work, not design work.** imago's shipped `server.ts` makes **five**
imports from `../surface/`, three of them runtime value imports — including the
494-line `types.ts` its own comment calls _"the single contract."_ mind-mapper's
`server.ts` makes **zero**, so the precedent does not cover this.

**Direction (see [R1](./design-resolution.md)):** the contract is not surface
code — it is the daemon's wire protocol, misfiled. It moves into the shipped
folder, and the surface becomes a consumer. **astrolabe already does exactly
this** (`surface/components/*.tsx` →
`import type … from "../../scripts/state"`), so the pattern is in-house and
proven. This is not an imago quirk: **glamour has 5 such imports and magpie
12**, so solving it once is platform work for three spells. _(magpie's figure
was **8** here until 2026-08-31; re-measured at `df545a2` it is **12** across
three files, nine of them value imports — larger than imago's five. Sprint 03's
Phase 6 carries the current count.)_

> **Proof:** both spells build; both daemons serve `dist/` in release mode; the
> installed artifact runs with no surface source present.

### Slice 2 — Shared code between CLIs and daemons

**The hard half, and the reason it is in scope: deferring the mechanism is
deferring the project.** Take one boring module — `printJson`, byte-identical in
five spells — and have **two spells' shipped `scripts/` import one
implementation.**

This forces the **emission ruling**, which [RB](./design-resolution.md) has
already made decidable: source-readability is not a reason to avoid building, so
the choice turns on its real cost — a build step in the backend's dev loop —
rather than on a value that did not survive testing.

> **Proof:** two spells' CLIs emit identical JSON from one implementation, and
> **the installed artifact still runs** — which is the whole question.

### Slice 3 — Shared code between surfaces

One boring module, imported by both surfaces. Free by comparison: the bundler
erases the import, so nothing extra reaches the artifact. It is in scope because
**"free" is a prediction until something runs.**

> **Proof:** both surfaces import it; both `dist/` build; neither artifact grows
> a source file.

### Slice 4 — Shared styling, with override

The proof is the **pipeline**, not the palette: _a base set of styles, and an
app that overrides them._ [R3](./design-resolution.md) rules the architecture
(L0 base tokens · L1 `var()`-referenced shadcn aliases · L2 spell overrides · L3
spell domain). **This slice builds only the part that proves it works.**

| Needed to prove it                                 | NOT needed                           |
| -------------------------------------------------- | ------------------------------------ |
| `kit/theme/` ships a base — a handful of L0 tokens | the full ~16-token L0 reconciliation |
| mind-mapper consumes the base                      | mind-mapper's three token renames    |
| imago **overrides** at least one base token        | the 95-site `accent`→`brand` rename  |
| **one kit component that uses a kit token**        | imago's 24-value light palette       |

> **⚠ The kit component is the load-bearing part of this slice.** Overriding a
> token in a spell's own markup proves nothing about the kit, and the `@source`
> hazard — a kit outside every current Tailwind scan root — **fails silently**,
> emitting zero utilities with no error. A tokens-only proof passes while
> leaving the real mechanism untested.

**Light and dark come nearly free on the base and are expensive only on imago.**
mind-mapper already ships both palettes and already exercises mode-override, so
the base can carry both at almost no cost and mind-mapper proves that half for
nothing. Giving _imago_ a light palette is 24 values of real design work that
proves nothing additional — so it is out.

> **Proof:** one kit component renders with mind-mapper's values in mind-mapper
> and with imago's overridden value in imago, from one implementation.

## Scope

**In scope:** the four slices. Seam C — amending `grimoire/house-style.md`,
which still reads _"The build (there isn't one)"_ while v2.2.0 has shipped one —
because every slice is misread by a fresh agent while canon contradicts the
tree. A ward for whatever invariant the emission ruling produces.

**Out of scope — banked, not forgotten:**

- **K2** (chat sidebar, context sidebar) — the point of the platform, and a
  later project. 2,840 lines across 4 spells each.
- **The kit's breadth.** `presence`/`activity`/`buildInfo`, `useSession`,
  `fileIntake`, `kit/ui/`'s seven primitives — all correctly identified, none
  built here.
- **The reconciliations.** presence boolean-vs-count; the
  `LibraryItem`/`ContextEntry`/`GroundRef` context type; `muted` vs `ink-dim`.
  **These are the same shape of problem — _"one concept, several
  implementations, pick one"_ — and that is the later project's actual work.**
- magpie / glamour / astrolabe adoption · digestify / bounty / grapevine
  (surface rewrites, not relocations) · the repo-wide typecheck gate ·
  cross-harness distribution.

**Deliberately re-scoped from the first draft:** imago's 137 typecheck errors
and its missing `tsconfig.json` are _not_ bundled into the port — they are
independent of it and belong with the census's Tier 3 fix. Its two
`${CLAUDE_PLUGIN_ROOT}` sites go back to the 21-site backlog item they were cut
from.

## Impact & Risks

**Benefits:** a second spell builds, proving the pipeline generalizes — which
`spell-surface-pipeline` asked for and never got. Three sharing capabilities go
from "assumed possible" to demonstrated. Canon stops contradicting the tree. And
the later extraction project starts from a working platform instead of a
hypothesis.

**Risks:**

- _Design work leaks in through Slice 4._ Mitigated by the table above and by
  the standing rule: if a reconciliation becomes a blocker, bank the ruling and
  narrow the proof.
- _Slice 2's ruling is made hastily because it blocks everything._ It is the
  only irreversible decision here. RB removed the bad reason; it should still be
  made on the kit's real shape, not on schedule pressure.
- _Slice 1's seam is larger than it looks._ Five imports, and 10 of imago's 11
  test files import `../surface/`. This is the slice most likely to overrun.
- _mind-mapper regresses._ It is the largest spell, currently **zero** typecheck
  errors, and every slice touches it. Its suite is the guard.

**Complexity:** Medium, concentrated almost entirely in Slice 1's seam.

## Success Criteria

Falsifiable, and small enough to check in an afternoon:

1. **imago and mind-mapper both build**, and both serve `dist/` in release mode.
2. **Two spells' shipped `scripts/` import one shared module**, and the
   installed artifact still runs.
3. **Two surfaces import one shared module**, and neither artifact grows a
   source file.
4. **One kit component renders correctly in both spells**, with imago overriding
   at least one base token.
5. The **emission ruling is made and warded** — not deferred, not defaulted
   into.
6. `house-style.md` describes the build that exists.
7. **mind-mapper's suite and typecheck stay green** — zero new errors.

**Explicitly not a success criterion:** the amount of code shared. Four modules
that prove four capabilities beat four hundred lines that prove one.

---

**Related Documents:**

- [Design resolution](./design-resolution.md) — R1 (the seam), R3 (theming), RB
  (the emission trade). **The rulings live there; this document is the shape.**
- [Gap analysis](./gap-analysis.md) — the seven blocking findings, kept verbatim
- [Shared code and the build boundary](../../investigations/2026-08-29-shared-code-and-the-build-boundary.md)
  ·
  [Cross-harness spell distribution](../../investigations/2026-08-30-cross-harness-spell-distribution.md)
- [`spell-surface-pipeline`](../spell-surface-pipeline/proposal.md) — the
  standard this ratchets; its [plan](../spell-surface-pipeline/plan.md) records
  what actually shipped
- `.anthill/dev/seams.md` — Contracts 1, 2, 4. **Prefer these over the pipeline
  plan.**

---

## Notes

**Two scope corrections are worth recording, because the reasoning is not
recoverable from the outcome.**

**The first draft optimised for value; this one optimises for proof.** Both the
gap analysis and the drafting agent kept reaching for the highest-value
extractions — chat sidebar, `useSession`, the full theme reconciliation — which
are also the highest-design-debate ones. For a capability project that is
backwards: the correct first extraction is the most boring one available.
_(Cole, 2026-08-30: "we don't need to actually get to the point where we've done
the work of extracting everything that's extractable.")_

**"Surface-first is corner-free" was a real claim that failed, and its
replacement is narrower.** The first draft asserted phases 1–2 could not violate
the shared-import invariant because surface work cannot. The gap analysis
produced the counterexample — imago's backend imports its surface, so relocating
it violates the invariant immediately. **The surviving version is a property of
packages, not phases:** bundled-only packages never reach the artifact and are
free; anything a shipped `scripts/*.ts` imports is not. That is why Slice 2
exists rather than being deferred.
