# magpie hand-rolls scale math around a `Bun.Image` option that does exist

**Added:** 2026-08-30 · **Status:** **CLOSED 2026-08-31 — RESOLVED BY DELETION,
NOT BY FIX** · **Found by:** settling the census's image-optimize contradiction
by running it · **Scope:** magpie, ~10 lines · **Severity:** low — **no
behavioural defect**, the code is correct; it is just unnecessary, and the
comment justifying it is false

## CLOSED — the file was deleted, not corrected (spell-kit sprint 03, magpie's surface port)

**Nothing in this file was fixed. The subject of the complaint no longer
exists.** During magpie's surface relocation (`c6a6e9a`), `circe` found that
`magpie/surface/state/imageOptimize.ts` and `imageOptimize.server.ts` had **zero
importers repo-wide** and deleted them rather than relocating dead code. The
false comment went with them.

**VERIFIED HERE (thoth, 2026-08-31):** `git ls-files` returns no
`magpie/**/imageOptimize*`, and a repo-wide grep for `imageOptimize` across
`plugins/spellbook/skills/magpie/` and `src/magpie/` returns zero hits.

⛔ **This is a MOOT closure, not a fix, and the difference is where it sends the
next agent.** "We fixed it" points at a corrected comment to learn from; "the
subject was deleted" points nowhere, and saying so is the whole value of the
distinction. Specifically:

- **The measurement in this file is still true and still useful.**
  `withoutEnlargement` **does** exist on `Bun.Image` resize — measured on Bun
  1.4.0, a 32×32 source resized to 9000×9000 with
  `{ fit: "inside", withoutEnlargement: true }` returns 32×32. Anyone writing
  new downscale code should use it. That fact did not die with the file.
- **The filed defect — a comment asserting the option does not exist — is gone
  from the tree**, so there is nothing left to correct and no fix to review.
- **The reason it was filed still stands:** it was filed _"so the false comment
  does not spread"_, and the identical false claim had already been removed from
  imago's header during the `sharp` → `Bun.Image` swap. Deleting magpie's copy
  closes the last known instance. **If a third copy appears, re-file — do not
  reopen this**, because the file it described is not coming back.

_The original report follows, unedited, as the record of what was measured._

---

## The comment is wrong

`magpie/surface/state/imageOptimize.server.ts:18-19`:

> _"Downscale only — never enlarge a small asset (**Bun.Image resize has no
> withoutEnlargement option**, so we compute the target dims ourselves)."_

It has one. Measured on Bun 1.4.0 — resizing a 32×32 source to 9000×9000 with
`{ fit: "inside", withoutEnlargement: true }` returns **32×32**,
`enlarged? false`.

The census flagged this as an unresolved contradiction: **glamour passes the
option, magpie's comment says it does not exist, and at most one could be
right.** glamour is right.

## The simplification is byte-for-byte identical

magpie's ~10 lines — `metadata()`, `maxSide`, a `scale` ratio, a conditional
`resize` — collapse to glamour's single chain. Both, on magpie's own constants
(`maxDim: 1600`, quality 85):

| Case                           | current             | one-liner               | identical        |
| ------------------------------ | ------------------- | ----------------------- | ---------------- |
| 3000×2000 (downscales)         | 1600×1067 · 3,130 B | 1600×1067 · **3,130 B** | ✅ byte-for-byte |
| 400×300 (must **not** enlarge) | 400×300 · 296 B     | 400×300 · **296 B**     | ✅ byte-for-byte |

```ts
// current: metadata() + scale math + conditional resize
// becomes:
const data = await new Bun.Image(input)
  .resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
    fit: "inside",
    withoutEnlargement: true,
  })
  .webp({ quality: Math.round(OPTIMIZE.quality * 100) })
  .bytes();
```

It also removes an `await metadata()` round-trip per image.

## Why this is worth filing rather than just fixing in passing

**A false comment is worse than no comment.** This one asserts a library
limitation that does not exist, and it is written persuasively enough that the
next author will believe it — the census did, and carried it forward as a live
open question. The value here is deleting the claim, not the ten lines.

## Also worth noting while in this file

`OPTIMIZE.maxDim` is **1600** in magpie and **1200** in imago and glamour, with
no recorded reason. Not necessarily wrong — magpie's domain is extracting assets
from a composite image, where more pixels plausibly matter — but it is an
undocumented divergence in a constant three spells share by copy. **Say why, or
converge.**

## Acceptance Criteria

- [ ] The scale math is replaced by the one-liner and the false comment is
      **deleted, not corrected in place**.
- [ ] `magpie`'s image tests still pass; output bytes unchanged.
- [ ] `maxDim: 1600` either carries a one-line reason or converges to 1200.

## Related

- [imago's daemon cannot start offline](./2026-08-30-imago-daemon-cannot-start-offline.md)
  — the same census finding, other end: imago uses `sharp` where magpie and
  glamour use `Bun.Image`. **Both close by adopting glamour's form.**
