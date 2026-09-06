---
date: 2026-09-05
spell: grapevine
rule: registry-primitives-variant-extends-recipe, surface-dep-cap
disposition: added-rule
---

# The registry owns the primitive file; the spell owns its variants and its manifest

## The situation

The grapevine conversion (2026-09-05) said it used "vendored shadcn primitives".
It used five hand-written look-alikes: shadcn's class vocabulary and file names,
variants as a plain lookup, a dependency-free `cn()` that does not
conflict-resolve, and a provenance header per file citing a page that no longer
existed. Cole's direction had been _shadcn components instead of our own custom
ones_. The setup branch (`docs/projects/grapevine-shadcn/`) made the surface a
real CLI-managed project — and the CLI's own project model, measured rather than
read, differed from the brief in three places: `add` refuses a directory with no
`package.json`; the 4.21 registry imports `cn` from shadcn's own npm package and
writes no `lib/utils.ts`; `add` installs `cn` but not
`class-variance-authority`.

## What the familiar concluded

Two candidate shapes for "the CLI writes into a sub-tree": a nested package with
its own lockfile (root untouched, but a fresh clone's root install never
installs it and the build reds), or a Bun workspace member with a hoisted-linker
pin (root manifest and lockfile change, the CLI's own monorepo model, one
install for everything). Recommended the second, and — because it changes how
the repo declares dependencies — stopped to ask rather than build on it. Also
concluded that the dep-cap sentence in the brief could not be written as given:
the cap has to name what the registry actually imports.

## What the mage wanted instead

No disagreement on the shape (the orchestrator ruled option two; Cole reviews
the root-manifest change at landing). The judgment the ruling added: **a spell
shipping into a host repo needs its own dep manifest** — a standing house
finding from the media-buffet library work — so the per-spell `package.json` is
not a cost of the CLI but the shape the house already wanted. And on the cap:
write the rule with the real names and keep the kit's `cn.ts` untouched, because
changing it is a behaviour change to spells outside the branch.

## The distilled judgment

**When a tool owns a file, the file carries nothing the tool will not rewrite.**
A registry-managed primitive has no provenance header, no hand-written sibling,
no linter suppression inside it — the next `add --overwrite` erases all three.
What the spell owns is expressed _in the tool's own extension point_ (a variant
inside the cva config, an alias in the token layer, a dependency in the spell's
manifest) and lives where the tool will keep it or where a `--diff` will show
it. And a cap, a path or a dependency list in a brief is a claim about a tool
version: measure it against the tool before writing it into canon.

## Binding

- **Rule affected:** spawned two rules in `house-style.md` —
  `registry-primitives-variant-extends-recipe` and `surface-dep-cap`.
- **Repeal criterion:** the first repeals when the kit ships the primitives
  itself (the kit extraction project) and spells stop holding a `surface/ui/`.
  The second repeals rule-by-rule: a ruling that names a fifth dependency
  rewrites the list; a registry that stops needing one of the four shrinks it.
