---
date: 2026-06-27
spell: magpie
spell_version: conjuration rebuild (cantrip→conjuration; pre-release, plugin 1.12.x)
agent: general-purpose subagent (Opus 4.8)
task: "magpie this board — pull each asset out as its own file" (a 30-element branding board), driven cli-side with no human on the surface
---

## Setup

Cold agent given only the board path + the intent + a pointer to read **only**
`SKILL.md`. Rule: if it had to read source / other docs / `cli help` to proceed,
log it as a gap. Isolated `TMPDIR`/`MAGPIE_HOME`; `--no-open`.

## Result

**End-to-end success, zero rule-2 violations** — never read `scripts/*`,
`surface/*`, or ran `cli help`. open → source → discover (30 elements,
auto-Slice) → extract (30/30) → extract --remove (30/30) → export (30 assets,
well-formed `assets/`+`crops/`+`manifest.json`+`gallery.html`) → close. The
SKILL.md was sufficient to complete the task. But the documented happy path
produced a subtly wrong result, and two doc promises weren't backed by the tool.

## The questions (the gold)

- **Q:** What's the default `--alpha`, and what is "alpha-eligible"?
  `extract --remove` (no ids) ran rembg's label on **all 30** incl.
  `palette_colors`, `typography_aa`, `screenshot_ui` — despite the doc saying
  three times those "stay whole." → **gap:** the default policy + the
  eligibility set were undocumented, **and** the cli didn't actually enforce
  eligibility — it wrote a mislabeled `rembg` version (really the raw crop,
  since remove.py kept those whole) for the kept-whole types and made it chosen.
  The doc's promise and the cli's behavior disagreed.
- **Q:** discover is told to "surface the spend" — what did it cost? → **gap:**
  `discover.ts` computes `cost_usd`, but `cmdDiscover` dropped it before
  printing; the agent was told to surface a number the tool never emitted.
- **Q:** How do I drive this headless (no human sealing phases)? → **gap:** the
  doc is written around reacting to user imperatives on the tail; a self-driving
  agent must infer the verb sequence from the loop table. (It did; minor.)
- **Q:** Must I advance the phase before removeBg / export? → **gap:** phases
  are framed as "seals → feeds the next," implying gates; they're UI context —
  the verbs work in any phase. The agent hesitated.
- **Q:** Which version does export bundle? → **gap:** export silently took the
  chosen version; the rule ("chosen") is implied by "chosen assets" but not
  stated outright.

## Disposition

| Finding                                                | On-route?               | Action                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extract --remove` alpha'd/mislabeled kept-whole types | yes (wrong deliverable) | **FIXED (cli):** `cmdExtract` now skips alpha-forbidden types when removing — they stay as the crop; no redundant `rembg` version. **Doc:** stated the default (`auto`) + the eligible vs kept-whole sets in "Background removal" + the `removeBg` loop row. |
| discover didn't surface cost                           | yes                     | **FIXED (cli):** `cmdDiscover` now prints `— $X.XXXX` from `manifest.cost_usd`. Doc promise now backed.                                                                                                                                                      |
| no headless sequence                                   | marginal                | judgment-only — the loop table doubles as the sequence; not worth a separate walkthrough (co-presence is the primary mode).                                                                                                                                  |
| phases read as gates                                   | marginal                | the `phase.advance` row already says "context, not an action"; left as-is (adding more would over-explain).                                                                                                                                                  |
| export version-selection unstated                      | marginal                | "chosen assets" in the export row is adequate; left as-is.                                                                                                                                                                                                   |
| `source` doesn't echo sha/size                         | low                     | left as-is — `state` confirms; not worth widening every verb's stdout.                                                                                                                                                                                       |

## Decay signals

None — the model completed the task from the doc. The one behavioral defect was
a real bug (eligibility not enforced), not over-explanation. No rule is now
stale; if anything this reinforces "Architect for the reader's context" (the doc
made a promise the route didn't keep) and "Start minimal" (the kept-whole
eligibility was load-bearing and had to be made explicit, not cut).
