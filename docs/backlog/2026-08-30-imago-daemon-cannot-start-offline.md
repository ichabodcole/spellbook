<!-- CLOSED 2026-09-02. `sharp` no longer appears on ANY shipped imago path
     (measured: 0 files under plugins/spellbook/skills/imago/ import it; the one
     remaining consumer is tests/imageOptimize.test.ts). The daemon boots at an
     installed destination, offline.

     ⚠ The severity line said "live defect in the RELEASED v2.2.0 plugin". That
     was true of v2.2.0 and is no longer true of develop — which is exactly how
     a fixed item keeps reading as urgent. Found by a fresh agent reconstructing
     a release note from the tree, not by anyone working on imago. -->

# imago's shipped daemon cannot start without a network: `sharp` is not in the artifact

**Filed:** 2026-08-30 · **Status:** **CLOSED 2026-09-02 — FIXED** ·
**Severity:** was a live defect in the **released** v2.2.0 plugin, not a plan
concern · **Found by:** the gap analysis of `spell-kit`'s dev plan, then
reproduced against the installed artifact

## The measurement

```
$ cd ~/.claude/plugins/cache/spellbook-marketplace/spellbook/2.2.0/skills/imago/scripts
$ bun --no-install server.ts --timeout 3
error: Cannot find package 'sharp' from '.../imago/surface/state/imageOptimize.server.ts'
```

There is **no `node_modules` anywhere up-tree** from the installed plugin —
confirmed by walking every parent to `/`. So the daemon has two outcomes and
both are wrong:

- **offline / `--no-install`** → it does not start at all;
- **online** → Bun silently auto-installs `sharp@0.35.x`, **a native addon**, at
  the consumer, on first run.

## Why it reaches the daemon at all

`scripts/server.ts:36` **statically** imports `optimizeImageBuffer`, and
`surface/state/imageOptimize.server.ts:5` statically imports `sharp`. Nothing is
lazy, so the cost is paid at daemon boot whether or not an image is ever
processed.

## imago is the only spell that does this

The duplication census found three implementations of one image-optimize step:
**glamour and magpie use `Bun.Image`** — a Bun built-in, zero install — **and
imago alone uses `sharp`.** House canon is explicit: _"Prefer Bun built-ins over
libraries."_ mind-mapper has no image path at all.

So the fix is not a design question. **It is adopting what the other two spells
already do.**

> ⚠ **Building the backend does NOT fix this.** `sharp` ships a native `.node`
> binding that a JS bundler cannot inline. This defect is orthogonal to the
> emission ruling — it is a dependency choice, and it survives every option.

## The options

1. **`sharp` → `Bun.Image`** ⭐ — **a behaviourally equivalent drop-in. NOT
   byte-identical.** Same call, same encoder settings, Bun 1.4.0.

   > ### ⛔ This entry claimed "byte-identical output" and it was WRONG
   >
   > **Falsified 2026-08-31 by `daedalus`, on a 10-input corpus compared by
   > sha256.** 6 of 10 byte-identical, 4 of 10 differing — and the split is not
   > random: **identity held on every input that did not resample** (already
   > under `maxDim`, so encode-only) **and on every uniform-colour synthetic**
   > (any kernel yields the same pixels). It failed on **all four** inputs that
   > actually downscaled real image content. The two encoders use different
   > resampling kernels.
   >
   > **The original corpus was structurally incapable of finding this** — two
   > synthetics and one 280×247 image below `maxDim`. Nothing in it resampled
   > real content.
   >
   > **And the method could not have detected it either: this entry compared
   > byte COUNTS and reported byte IDENTITY.** One differing case
   > (`mm-v2-clickthrough.png`) produced **exactly 55,632 bytes from both
   > encoders with different content** — a length comparison collides on the
   > first real screenshot tried. _The claim was inherited verbatim by three
   > other documents and a board card before it was checked._

   **The corrected measurement** (daedalus, sha256 over bytes, 10 inputs):

   | Class                                       | Result                  |
   | ------------------------------------------- | ----------------------- |
   | no resample (source already under `maxDim`) | **byte-identical**, 4/4 |
   | uniform-colour synthetics                   | **byte-identical**, 2/2 |
   | real content, downscaled                    | **differs**, 4/4        |

   Decoded-pixel delta on the four differing cases: **mean 0.41–1.26 / 255**,
   max 31–69, with 0.36–4.26 % of samples over 8. Sizes within **±1 %** except
   one flat-shaded illustration at **+9.70 %**. Dimensions and container are
   identical on every input.

   **Why the swap is still correct:** nothing downstream depends on the bytes —
   `optimizeSrc` re-base64s whatever comes back (`server.ts:194`). **What is
   ruled out is a golden-file test** built on the assumption of identity.

   **The `withoutEnlargement` disagreement is settled: the option EXISTS.**
   Resizing a 32×32 to 9000×9000 with it set returned 32×32 (`enlarged? false`).
   **glamour is right; magpie's committed comment is wrong** — filed separately
   as
   [`magpie-hand-rolls-scale-math`](./2026-08-30-magpie-hand-rolls-scale-math-it-does-not-need.md).

   **Scope: one function, 12 lines, one call site** (`server.ts:194`) plus the
   test, which builds its own fixture with `sharp` and can use `Bun.Image` too.

2. **Make the import lazy** — `await import()` inside the handler, so only the
   image path pays. The daemon boots offline; the image path still needs a
   network on first use. A mitigation, not a fix.
3. **Ship `sharp` in the artifact** — contradicts the skill-directory
   distribution unit and adds a platform-specific binary per consumer.

## Acceptance Criteria

- [x] `bun --no-install scripts/server.ts` starts from a copy of the skill
      folder with no `node_modules` up-tree — **done 2026-08-31** (daedalus,
      VERIFIED HERE: `curl /state` → HTTP 200 from a copy with no `node_modules`
      on any parent path). ⚠ **The daemon boots; `/` still will not render** —
      three non-fatal bundler errors (`react-dom/client`,
      `react/jsx-dev-runtime`, `tailwindcss`) remain, because dev-mode still
      bundles the surface from source. **`sharp` was the only FATAL blocker, not
      the only one.** Serving from `dist/` is what closes the rest, and that is
      Sprint 01 proof 3.
- [x] ~~The `withoutEnlargement` question is settled **by running it**~~ —
      **done 2026-08-30**; the option exists and works. See option 1's table.
- [ ] A check exists that would have caught this — see the companion ward gap in
      [`spell-kit` R6 Ward 1](../projects/spell-kit/design-resolution.md), whose
      first phrasing measured relative specifiers only and was structurally
      blind to exactly this import.

## Notes

**This is why the spell-kit plan's DoD is right to demand a deps-free boot.**
The proposal already listed `sharp → Bun.Image` as one of "two dependency
decisions the port forces" — it just did not connect it to the proof. It is not
unbudgeted work; it is **scheduled work that was underweighted**, and it is due
before imago's Slice 1 proof can pass.

**Also note the direction of travel:** R1 relocates the `sharp` importer _into_
`scripts/` — moving it from a folder that stops shipping into the part that
ships and executes as source. The seam work makes this more load-bearing, not
less.
