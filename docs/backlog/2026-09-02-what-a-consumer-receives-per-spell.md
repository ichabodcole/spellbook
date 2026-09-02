# What does a consumer receive, per spell, now that four spells ship built artifacts?

**Filed:** 2026-09-02 · **Status:** open · **Owner: COLE** — this is a product
and cost ruling, not a mechanical one · **Escalated from:**
`docs/projects/_archive/spell-kit/` (archived 2026-09-02; this item exists so
the question survives the move at its current size)

## Why this is filed now

The question is not new — it was raised 2026-08-10 when **one** spell shipped a
`dist/`. **spell-kit multiplied it by four and nobody re-stated it at the new
size**, so its only record of magnitude lived inside a project folder about to
be archived. A non-author audit caught that.

## The measurement

|                | `main` (v2.2.0) | `develop`   |
| -------------- | --------------- | ----------- |
| shipped plugin | **~5.6 MB**     | **~8.7 MB** |
| tracked files  | 251             | 179         |

**+55% download, ~72 fewer files.** Per spell: astrolabe 135 KiB → ~1.2 MB,
imago 470 KiB → ~1.4 MB, magpie 435 KiB → ~1.6 MB.

_(Rounded on purpose — ruling 2026-09-02: a number should be sized to the
decision it informs, and nobody installs or declines over bytes. Re-measure
before quoting; do not inherit these.)_

## What drives it

The bundled React/Tailwind surfaces — **the cost and the capability are the same
bytes.** A spell that ships its own built surface is a spell that runs where
nothing is installed, which is the property the whole arc bought.

## Three things that make the number bigger than it needs to be

1. **`mind-mapper` ships ~2.9 MB — roughly a third of the download — and cannot
   be invoked.** It has no `SKILL.md` and is reserved-not-released
   (`grimoire/trigger-registry.md`). Every consumer downloads it.
2. **Four spells are still unported**, so the roster will grow again — glamour
   is next (`docs/projects/glamour-conversion/`).
3. **Nothing lets a consumer take a subset.** The marketplace clones the whole
   `plugins/spellbook` subtree; it is all-or-nothing by construction.

## The actual question

**Is ~8.7 MB (and growing) an acceptable install, or does the packaging need to
change?** If it needs to change, the options are not obvious and none is cheap:
per-spell plugins, an opt-in subset, or excluding unreleased spells from the
shipped tree.

⚠ **Do not treat this as a bug to fix.** It may well be the right trade. It is
filed because it is **unruled**, and because until 2026-09-02 the number itself
appeared in no document a reader would find.
