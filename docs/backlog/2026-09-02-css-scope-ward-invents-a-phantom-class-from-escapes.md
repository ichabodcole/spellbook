# `spell-css-scope-ward` invents a phantom class from a CSS hex escape, and blames the wrong spell

**Filed:** 2026-09-02 · **Status:** open · **Found by:** circe, rehearsing
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

## The fix is in the WARD, not in glamour

`classSelectors` / `harvest` must consume the `\<hex>` escape **including its
space terminator** as part of the identifier.

⚠ **This will red on arrival when glamour ports**, and the red will name the
wrong spell — so anyone meeting it without this file will "fix" astrolabe.

_(Unrelated note from the same rehearsal, worth keeping: `@source "./**/*.tsx"`
and `@source "./"` differ by exactly one rule — glamour's `<body>` background
`.bg-\[\#140f1d\]`, which lives in `index.html`. The glob silently drops it.)_
