# `spell-css-scope-ward` invents a phantom class from a CSS hex escape, and blames the wrong spell

**Filed:** 2026-09-02 · **Status:** FIX LANDED 2026-09-03 on
`feat/glamour-conversion` — parser + detector calibrated (cassandra, non-author,
5 routes: unit cell, terminator pin, tolerance control, a real hex-escaped leak
caught BY NAME while the old harvester stays blind). **⚠ ARRIVAL CASE NOT YET
RUN** — the original symptom (glamour arrives, the ward names
astrolabe/mind-mapper for a phantom `32`) needs glamour in the ward's
population, which happens at Phase 2. **Closer: the arrival run at the assembled
sha.** · **Found by:** circe, rehearsing glamour's relocation · **Latent since
the ward was written**

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
