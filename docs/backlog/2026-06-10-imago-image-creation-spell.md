# Imago — image creation/edit spell (conjuration school)

**Added:** 2026-06-10

A second image-oriented spell, distinct from `glamour`. Where glamour _captures
a style_ (the artifact is a re-castable style spec), **`imago`** _creates
images_ (the artifact is the image(s) themselves) through a **multimodal create
⟷ annotate ⟷ edit loop** with the agent.

Core idea: the user supplies intent multimodally — a text description, and/or
reference images to mix/combine, and/or nothing-but-words — the agent turns it
into a prompt and generates; the user reacts on a **canvas** (drag an image in,
draw/marker on it, "move this here, add that"); the agent feeds the annotated
image + instruction to a **reasoning-capable image-edit model** and returns a
new image. Generation and editing are one continuous back-and-forth, not two
spells.

## Naming / taxonomy decision (settled 2026-06-10)

- Name: **`imago`** (Latin "image/likeness") — a specific incantation, ergonomic
  as a CLI verb (`imago open`, `imago tail`). Rejected: `glamour-edit`/`-x`
  (breaks the one-word-per-spell house pattern); `conjure`/`evoke` (too
  school-level); `imago elisio` (_elisio_ = "elision/striking-out", wrong
  sense).
- Convention this establishes: **school = category, spell = incantation.**
  `imago` lives in the **conjuration** school (calling an image into being).
  `glamour` is really _illusion/enchantment_ (altering appearance) — optionally
  re-school it later; not required. No retro-rename of glamour.

## Design notes (for the eventual brainstorm)

- **Loop, not funnel.** Glamour is a linear pipeline converging on a spec.
  `imago` is a cycle (describe/reference → generate → annotate → regenerate/edit
  → …) with a persistent canvas + an evolving set of generations. Do NOT copy
  glamour's six-phase model wholesale.
- **Shared substrate, separate spell.** Reuse glamour's pieces by hand first
  (Bun daemon + `cli.ts`/`server.ts`, typed WS contract, 3-pane React shell,
  narration feed, feedback pill, media-forge routing brain, the dry-run agent
  rules). Extract the shared `agent-surface-bun` recipe to `grimoire` only
  _after_ imago proves what's genuinely shared (concrete-first A→C; ~2 spells
  now, extraction pays at 3+).
- **New, unproven pieces (the real work):** an **annotation canvas** (draw /
  markers / move-this on an image), **multimodal reference mixing**, and the
  **reasoning-model edit endpoint** (image + annotations + prompt → new image).

## ⚠ Do this before committing to the UX

- **Backend spike:** validate that an available model (nano-banana-2 / a
  reasoning image model via media-forge) reliably honors "move this / add that"
  from a _marked-up_ image + instruction. media-forge's `--ref`/edit/inpaint
  paths are currently **schema-grounded only**, never eval-grounded (see the
  media-forge gaps report). If that path is weak, the loop degrades to
  "regenerate from an updated prompt," which changes the surface design.

## References

- Substrate to reuse: `plugins/spellbook/skills/glamour/`
- Dry-run + agent-behavior findings that should carry over:
  `docs/projects/image-style-spell/artifacts/glamour-dryrun-v3-findings.md`
- Stack/threshold decision: memory `spell-surface-stack`
- media-forge routing brain + gaps:
  `plugins/spellbook/skills/glamour/references/`
