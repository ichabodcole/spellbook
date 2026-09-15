# `spell-css-scope-ward` invents a phantom class from a CSS hex escape, and blames the wrong spell

**Filed:** 2026-09-02 · **Status:** FIXED 2026-09-03 — fix landed at `1131558`
(parser + detector, cassandra non-author, 5 routes) and **the arrival case RAN
at `9f2cbd4` + the Phase 2 surface patch (sha256 8d49f9ff…)**: with glamour in
the ward's population and four hex escapes in its shipped CSS, the fixed ward is
9 / 0 and the pre-fix ward file swapped into the same tree reds CROSS-SPELL with
exactly the filed message (_glamour carries 1 class(es) only astrolabe uses:
32_). The original symptom reproduced and closed in one tree; the arrival run is
repeated at the Phase 2 sha by the non-author. · **Found by:** circe, rehearsing
glamour's relocation · **Latent since the ward was written**

## The failure

With glamour arriving **fully conforming** to Contract 21, the ward reds:

```
glamour carries 1 class(es) only astrolabe uses: 32
```

glamour cannot have received anything from astrolabe under `source(none)`. The
class `32` does not exist.

## The mechanism, traced end to end

1. glamour uses `2xl:w-[26rem]` and `2xl:grid-cols-5` — a **leading-digit**
   Tailwind variant.
2. CSS cannot start an identifier with a digit, so it escapes it as `\32 ` —
   **hex, terminated by a SPACE**: `.\32 xl\:w-\[26rem\]`.
3. The ward's `harvest()` regex `/\.((?:\\.|[A-Za-z0-9_-])+)/g` **stops at that
   space**, yields `\32`, and unescapes it to the phantom class `32`.
4. `usedIn(glamourText, "32")` is false — glamour's own `max-h-32` is rejected
   by the candidate-boundary lookarounds — while `usedIn(astrolabeText, "32")`
   is **true**, because `src/astrolabe/surface/state/useReflectAttention.ts`
   carries a bare `32`.

**So the ward blames astrolabe for a class glamour never received.**

## Why nobody hit it before

**glamour is the first spell in the roster to use a leading-digit variant** —
measured: astrolabe, imago, magpie and mind-mapper have **zero** such selectors;
glamour has four. The defect has been latent since the ward shipped and only
this shape exposes it.

## Reconciled 2026-09-03, before the fix landed — the blame was under-counted

**The red names astrolabe AND MAY NAME mind-mapper.** `usedIn(text, "32")`
matches a bare `32` token in the source text of **both** (astrolabe:
`useReflectAttention.ts`; mind-mapper: two hits — measured by a blank-context
cold read of the surface lane, not by the author). Which spell the message names
depends on iteration order, so a reader holding this file's original "blames
astrolabe" would confirm one spell and be puzzled by the other.

**The emitted form, measured through the real plugin** (`bun-plugin-tailwind`
under `Bun.build`, the same call `src/build.ts` makes): `2xl:grid-cols-5` ships
as `.\32 xl\:grid-cols-5` — hex escape, **one space terminator**. The four
landed spells ship **zero** hex escapes (astrolabe 199 / imago 346 / magpie 262
/ mind-mapper 388 class selectors, identical under the old and the fixed
harvester), so the fix cannot move any existing spell's set, and the instrument
cell that pins it is the only thing exercising the branch until glamour arrives.

## The fix is in the WARD, not in glamour

`classSelectors` / `harvest` must consume the `\<hex>` escape **including its
space terminator** as part of the identifier. **Done:** `harvest()` now matches
a hex escape plus its optional whitespace as one unit and unescapes it to its
code point; the instrument cell _"reads a leading-digit variant as ONE class,
not a phantom"_ reds on the old harvester and is the route a calibrator reverts.

⚠ **This will red on arrival when glamour ports**, and the red will name the
wrong spell — so anyone meeting it without this file will "fix" astrolabe.

_(Unrelated note from the same rehearsal, worth keeping: `@source "./**/*.tsx"`
and `@source "./"` differ by exactly one rule — glamour's `<body>` background
`.bg-\[\#140f1d\]`, which lives in `index.html`. The glob silently drops it.)_
