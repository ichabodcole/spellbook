# Grapevine shadcn — the brief

**Created:** 2026-09-05 · **Author:** Cole Reed + Claude Code (orchestrator) ·
**Mode:** loose — a brief, not a plan; this file doubles as the proposal.
**Branch:** `feat/grapevine-shadcn`, cut from develop at the grapevine
conversion's landing (`8fe85c1`).

## Why

The grapevine conversion (landed 2026-09-05) says it uses "vendored shadcn
primitives". It does not, and neither does mind-mapper. There is **no
`components.json` anywhere in the repo**; the `shadcn` skill's project probe
reports framework "Manual", zero components. What we have are hand-written
look-alikes: shadcn's class vocabulary and alias names, but variants as a plain
lookup instead of `cva`, a dep-free `cn()` that does not conflict-resolve, no
`render` prop, no `data-icon`, partial ports of the overlays. Cole's direction
for the conversion was _shadcn components instead of our own custom ones_, and
the honest state is _our own custom components with shadcn names_.

Two more reasons this is its own branch, now:

1. The next branch (`feat/grapevine-ux`, scoped in
   [the backlog item](../../backlog/2026-09-05-grapevine-watch-human-parity-and-archive-hiding.md))
   composes ContextMenu, Dialog, Field, Switch/ToggleGroup and Popover. Building
   those by hand a second time is the wrong direction.
2. The provenance headers on the hand-rolled files are already stale: nine
   comments cite `watch.html` selectors and that file no longer exists; others
   cite a sweep ticket and a message number. Registry-managed files get their
   headers rewritten on update anyway, so the fix is a rule, not a cleanup.

## The mission

Make grapevine's surface a **real shadcn project** — CLI-managed, registry
source, `base` flavor on `@base-ui/react`, Tailwind v4 — with **no change in
behaviour** and the smallest honest change in look. Then write the rules this
establishes into house-style so they stop living in code comments.

**Fidelity ruling: behaviour-identical, tokens-identical.** Every row of
`docs/projects/grapevine-conversion/behaviour-inventory.md` holds. The surface
keeps its tokens and L1 aliases, so colours do not change; registry recipes may
change radii, paddings, focus rings and font weights, and that is accepted —
record each visible difference with a before/after screenshot in the journal
rather than fighting the recipe back to the old look.

## Technical direction

**Use the `shadcn` skill (`.claude/skills/shadcn/`) for every step.** Run its
CLI through `bunx --bun shadcn@latest`; run `docs <component>` and read the
returned URLs before writing against any component. Its Critical Rules apply to
the feature components too (className for layout not styling; `gap-*` not
`space-*`; `size-*`; `data-icon`; Field/FieldGroup for form layout; Empty for
empty states; Alert for callouts; Separator; Badge).

**The one real unknown, and it comes first: where `components.json` lives and
how imports resolve.** The CLI writes `@/components/ui/x` and `@/lib/utils`
imports from an alias it reads from tsconfig `paths`. This repo has no `paths`
and every surface uses relative imports. Discover, then decide, with this rule:
the smallest alias footprint that keeps `bun run build grapevine`, the
import-boundary wards and `spell-css-scope-ward` green, and that a second spell
could copy without colliding. The expected answer is a `components.json` at
`src/grapevine/` pointing at `surface/styles.css` and `surface/ui`, with a
per-spell tsconfig carrying the `paths` — but measure it; if the CLI cannot be
made to write into a sub-tree cleanly, say so and propose the alternative before
building around a workaround. Record the decision and the options not taken in
the decision log.

**The dep cap is lifted for exactly what the registry needs:**
`class-variance-authority`, `clsx`, `tailwind-merge`. _(Amended 2026-09-05,
measured against shadcn 4.21: the registry imports `cn` from shadcn's own npm
package **`cn`** and writes no `lib/utils.ts`, and `add` does not install cva.
The real cap is **`cn` + `class-variance-authority`** — neither clsx nor
tailwind-merge is a direct dependency. See the decision log.)_
`src/kit/lib/cn.ts` stays as it is — mind-mapper and glamour depend on its
non-merging semantics and changing it is a behaviour change to spells outside
this branch. Grapevine gets the CLI's own `lib/utils.ts` (`cn` = clsx +
twMerge). Note in the journal that the kit extraction project inherits the
question of which `cn` the kit ships.

**Components:** regenerate the five (`button`, `badge`, `input`, `textarea`,
`alert-dialog`) from the registry, and add the set the UX branch will compose:
`context-menu`, `dialog`, `field`, `switch`, `toggle-group`, `popover`,
`separator`, `empty`. Grapevine's own variants (`primary`, `accent`, `joined`,
`count`) are re-expressed the way the skill's customization guide says —
extending the `cva` config, never a parallel lookup — only where a stock variant
does not already serve. Delete the hand-rolled files; the registry files replace
them at the same paths.

**Styling:** `styles.css` keeps its three opening lines and its token layers.
The L1 alias block grows to whatever names the installed set consumes (the
skill's customization guide lists them); every alias is a `var()` onto a kit or
grapevine token, never a value. `source(none)` + `@source "./"` stay.

**Comments:** strip provenance from every file under `surface/ui/` — where it
came from, which ticket, which message, which `watch.html` selector. A header
says only what a reader needs to use the file now. Do the same for `components/`
where a comment cites `watch.html`. The two rules that are worth keeping — _a
variant replaces a recipe, never fights one_ and _the dep cap and its three
exceptions_ — go into `grimoire/house-style.md` once, and the components do not
restate them.

**Verification:**

- `bunx --bun shadcn@latest info` from the config's directory reports the
  config, the base, and the installed components — that is the acceptance test
  for "set up correctly". Paste its output in the session record.
- Drive the inventory (all 72 rows; type, don't fill; the fixed-port proxy from
  the first load — the verify journal in the conversion project documents both).
  A no-stake verify agent will drive it again.
- Before/after screenshots of every visible state, in the journal, with each
  visible difference named and attributed to a recipe.
- `bun run gate` green, unpiped; `bun scripts/dist-check.ts` exit 0; `dist/`
  rebuilt in the same commit as any source change; the `ward` skill run.
- Bundle size before/after (the three `dist/` files) — cva + twMerge cost
  something; record it.

**Conventions that bite:** biome before every commit; story chapters (config +
aliases → primitives regenerated → variants and feature components → comments
and house-style → wards); trailer lines; no push, no merge.

## Records

- `docs/projects/grapevine-shadcn/decision-log.md` — live.
- `docs/projects/grapevine-shadcn/shadcn-journal.md` — the process, in order,
  for the agent who does this to bounty, digestify, mind-mapper, or the kit:
  what you had to discover and how, what the CLI did that you did not expect,
  every gotcha with symptom and fix, and what you would tell the next agent.
- `docs/projects/grapevine-shadcn/sessions/2026-09-05-the-setup.md` at the end.

## Done means

- `components.json` exists, the CLI's `info` sees it and every installed
  component, and `add` works from that directory.
- No hand-rolled primitive remains under `surface/ui/`; no provenance header
  remains.
- Every inventory row holds; visible differences are enumerated with
  screenshots.
- house-style carries the variant rule and the dep-cap rule.
- Gate green, dist-check green, wards run, records written.
