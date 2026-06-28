# Glamour dry-run (v3) — full end-to-end on the restored 3-pane studio

Live agent-driven dry run of the rebuilt studio (Plans 1–4) on the Hollowbrook
world, **2026-06-10**. Goal: walk the entire experience (gather → analysis →
direction → prompts → variants → spec → submit) and catch anything missing or
broken before merging the branch. Agent drove the agent side via `cli.ts` while
the user drove the browser; the agent monitored the event tail live.

## Fixed during the run

- **[BLOCKER, fixed] ⓘ variant prompt overlay couldn't be dismissed** — a
  re-port of the old template's BUG-2: the overlay was a plain `<div>` painting
  over its own toggle button. Fixed to a click-to-dismiss `<button>` above the
  controls (`b9a24bb`), verified with Playwright.
- **[refinement, done] Round grouping in Variants** — the static "Round 0"
  header was misleading and all rounds piled into one grid. Now grouped by
  generation round with per-round headers (`round N · M images`) + a per-card
  round badge; all rounds stay visible (`0fccfb7`).
- **[refinement, done] Spec gallery choice indicators** — gallery cards now show
  non-interactive ♥ (liked), ★ (canonical), and a round-number badge so the
  final page reflects the choices the user made (`0fccfb7`).

## Findings for SKILL.md (agent behavior — next phase)

These are **agent methodology**, not surface bugs. They belong in glamour's
SKILL.md when it is written (inscribe phase 3).

1. **The agent must be push-based — Monitor the event tail, do not poll on
   request.** Early in the run the agent only checked events when the user
   prompted it, leaving the user watching a spinner. Fix: wrap `cli.ts tail`
   with the `Monitor` tool (filter to proceed/feedback events:
   `nudge|feedback|steer|generate|submit|cancel|note|direction.correct`) so the
   agent reacts the instant the user acts.
2. **The `submit` / `closed` handoff signal is unreliable — recover the final
   spec from the snapshot.** `submit` shuts the daemon down, and the final SSE
   frames race the shutdown, so the agent's tail often never sees `submit`/
   `closed` (confirmed: tail's last event was a `spec.module` toggle; submit
   never arrived). **Data is NOT lost** — the full final state is written to
   `~/.glamour/snapshots/<session_id>.json`. SKILL.md rule: treat _daemon-gone_
   (tail stream ends / discovery file removed) as the end-of-session signal and
   read the final spec from that snapshot; never depend on the live `submit`
   event. (Optional future server hardening: graceful flush before
   `server.stop`.)
3. **Prompts must be self-contained visual descriptions.** Strip invented proper
   nouns the image model has no training reference for (character names, place
   names like "Hollowbrook" / "The Edge"); describe what is visually in frame
   instead. If a name must appear, specify it as visible signage ("a sign
   reading 'Hollowbrook'"). No context-bleed between prompts — each prompt
   restates all the visual context it needs (don't assume a later prompt
   inherits an earlier one's description). Carry the STYLE + PALETTE blocks
   verbatim across prompts for cross-subject consistency; `--ref` is for
   same-character poses, not style.

## Minor / by-design

- After `submit`, refreshing the page → "page cannot be reached" (the daemon is
  gone — the session is genuinely over). The "Session ended" overlay is the
  intended terminal state; the page is one-shot. Acceptable; could show a static
  ended page if we ever want refresh-safety.
- The top-level intent box is optional — the user put rich direction into an
  influence annotation note instead, which the agent read and used. Fine.

## Outcome

The full pipeline ran end-to-end with a human in the browser and the agent
responding live (push-based): rich gather intake (3 influences + 3 context docs

- aspect/star/note annotations), real per-image reads, a synthesized direction,
  a prompts revise loop, four variant regenerate rounds, and a distilled spec
  exported via submit (recovered from the snapshot). One blocker found and fixed
  mid-run; two refinements completed; three agent-methodology findings captured
  for SKILL.md. Branch `feat/glamour-rebuild-foundation` deemed ready to merge.
