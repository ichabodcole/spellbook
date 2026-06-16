# Backlog — imago unified context / text library

**Date:** 2026-06-16 · **Status:** backlog / design direction (cole) ·
**Spell:** imago · Extends
[unified-image-model](../projects/imago/unified-image-model-investigation.md)

- subsumes [skills/methodologies](./2026-06-16-imago-skills-methodologies.md).

## The pattern, generalized

We just unified **images**: generated / imported / reference are all one type
(`Variant`); "reference" is a **flag/view** (`refSelected`), not a separate
kind; they live in **one library**, browsable by facet. The same unification
wants to happen for **text / context**.

The realization: **styles, quick-prompts, and "skills" are all just text**
(documents) — even when they carry an image for _identity_, the underlying thing
is a document. Just as images have use-cases, text artifacts have use-cases:

| Text artifact      | What it is                                | Activation today        |
| ------------------ | ----------------------------------------- | ----------------------- |
| quick-prompt       | a one-shot instruction snippet            | pick → fills composer   |
| style              | a look (words + optional canonical image) | toggle → ambient active |
| skill (proposed)   | a process/methodology (longer)            | select → inject context |
| context (proposed) | a reusable context document               | —                       |

So: a library that **isn't just images** — it also holds text artifacts, each
with a _type_ and an optional identity image. Same "one medium, many views"
model the image library now uses.

## The prompts for this (what's wrong today)

- **Styles are siloed + behave differently.** They live in the reference
  drawer's "Styles" tab with a click-to-activate interaction distinct from how
  refs work — inconsistent UX for two things that are conceptually "selectable
  context."
- **Delete is destructive + irrecoverable** (the sharp one): cole deleted
  "anime" by accident and it was simply **gone** — no library, no undo. This is
  the exact `remove == destroy` mistake we fixed for references (where ✕ now
  _deselects_ and the asset stays in the library). Styles/prompts/skills should
  _deactivate or archive_, not destroy. **Worth fixing sooner than the full
  redesign.**
- The default style catalog (anime/painterly/photoreal/3d/watercolor/line art)
  has no way back once removed — a fresh-session reset is the only recovery.

## The direction

A **unified library that spans both media**: images AND text artifacts. Text
artifacts are documents with a `type` (quick-prompt / style / skill / context)
and an optional identity image. Likely lives in the **left sidebar**, probably
with a top-level **medium split (Images | Text)** so the two don't blur — mirror
of the image filter facets, one level up. Activation semantics per type (prompt
→ fills composer; style → ambient-active; skill → inject as context).

## Open questions (for when this is picked up)

- One library with a medium split (Images | Text), or two libraries? cole leans:
  same sidebar, a Text/Images split so they don't mix.
- Text-artifact `type` — fixed set (prompt/style/skill/context) or extensible?
- Activation generalization: "selected" (refs) vs "active" (styles) vs "applied"
  (skills) — do these collapse to one selection model with per-type semantics,
  or stay distinct?
- Identity image association (optional) for text artifacts — reuse the
  image-variant materialization?
- Migration of existing `styles[]` + `prompts[]` into the text library; and the
  **non-destructive-delete** fix (deactivate/archive, never destroy) — pull that
  forward as a standalone fix regardless of the larger redesign.

## Not now

cole flagged this as backlog/rethinking while finalizing the refs-as-assets PR.
The one piece worth pulling forward independently is the **destructive style
delete** (data-loss footgun) — see the
[skills](./2026-06-16-imago-skills-methodologies.md) note for the related "save
the thinking, not the click" principle.
