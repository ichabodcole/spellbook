# Two spells went through the same relocation and came out with different surface hygiene

**Added:** 2026-08-31 · **Found by:** `cassandra`, driving imago's board during
Sprint 01's 1c local-sim · **Scope:** imago surface, ~4 lines — but the finding
is about the **scaffold**, not imago · **Severity:** low individually,
**structural collectively**

## The measurement

astrolabe and imago both relocated to `src/<spell>/` in the same sprint, days
apart, following the same contracts. astrolabe's `index.html` carries two
deliberate guards that imago's does not:

| guard                                                           | astrolabe                        | imago                                      |
| --------------------------------------------------------------- | -------------------------------- | ------------------------------------------ |
| empty favicon placeholder (`<link rel="icon" href="data:," />`) | ✅ **with a comment saying why** | ❌                                         |
| pre-boot inline `<style>` for the dark canvas                   | ✅                               | ❌ (rides on Tailwind classes on `<body>`) |

**Consequences, both observed in the drive:** every imago board open logs a
**404 console error** for `/favicon.ico`, so a console-error check on imago is
red on arrival. And a slow or failed CSS load **flashes white** before the dark
canvas paints.

## Why this is filed as a scaffold finding rather than an imago bug

astrolabe's favicon line ships with a comment explaining that it exists to stop
the browser default-probing `/favicon.ico` before React mounts. **That knowledge
lived in one spell's HTML and did not travel** — not through Contract 2, not
through the relocation, not through a scaffold. Two spells made the same move
and only one arrived with the guards.

There will be six more relocations (glamour, magpie, bounty, digestify,
grapevine, and whatever comes next). **Fixing imago's four lines and stopping
there guarantees the seventh spell has the same gap.**

## Acceptance

- [ ] imago's `index.html` gains both guards.
- [ ] The knowledge lands somewhere a relocation reads — the surface scaffold,
      Contract 2, or `house-style.md`. **Which one is the grimoire seat's
      call**, and the choice matters more than the patch.
- [ ] Optional, and only if a second instance argues for it: a check that a
      relocated surface opens with zero console errors. **Do not build it for
      one spell.**

> Related:
> `docs/backlog/2026-08-31-astrolabe-quiet-disclosure-has-no-aria-expanded.md` —
> the same shape in the accessibility family, also found by a drive and also a
> case where one spell knows something its siblings do not.
