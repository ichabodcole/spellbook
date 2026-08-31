# imago's shipped daemon cannot start without a network: `sharp` is not in the artifact

**Filed:** 2026-08-30 · **Status:** open · **Severity:** live defect in the
**released** v2.2.0 plugin, not a plan concern · **Found by:** the gap analysis
of `spell-kit`'s dev plan, then reproduced against the installed artifact

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

1. **`sharp` → `Bun.Image`** ⭐ — **MEASURED 2026-08-30: a drop-in replacement,
   byte-identical output.** Same call, same encoder settings, Bun 1.4.0:

   | Input                      | `sharp`                    | `Bun.Image`                    |    Δ |
   | -------------------------- | -------------------------- | ------------------------------ | ---: |
   | synthetic PNG 3000×2000    | 1200×800 · 1,788 B · 31 ms | 1200×800 · **1,788 B** · 28 ms | 0.0% |
   | synthetic WebP             | 1200×800 · 1,788 B · 34 ms | 1200×800 · **1,788 B** · 30 ms | 0.0% |
   | real `mascot.webp` 280×247 | 280×247 · 24,750 B · 18 ms | 280×247 · **24,750 B** · 14 ms | 0.0% |

   Not merely equivalent dimensions — **identical byte counts**, marginally
   faster, and both correctly declined to enlarge the undersized source.

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

- [ ] `bun --no-install scripts/server.ts` starts from a copy of the skill
      folder with no `node_modules` up-tree.
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
