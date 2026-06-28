# Slices 1–3 dogfood feedback — 2026-06-23

Hands-on testing pass on the live build (Slices 1–3) before Slice 4, run in a
co-presence session (Cole on the human surface, agent driving the agent side via
the CLI). This captures the feedback so it isn't lost and sorts it into a
build-ready punch-list.

## The principle that emerged

Across the session one design spine kept recurring: **strip action-oriented
chrome from the surface and let intent flow from the conversation and direct
manipulation.** Explicit "controls" (Generate button, Add button,
augment/correct toggle) pull the surface toward an app-like action interface and
away from the co-presence / co-creation premise the project is built on.

The corollary: as explicit controls are removed, the interface must carry more
**implicit presence** — liveness signals (an automatic "thinking" indicator),
spatial cohesion (controls live where the action visually is), and a legible
state — so the human never feels lost. This is the positive-space answer to the
original D1 risk ("does the human feel lost without an explicit stepper?"): the
answer is presence affordances, not a stepper.

**This principle should govern Slice 4's tray affordances too** — re-check the
Slice 4 plan against it before building (e.g. don't reintroduce top-bar buttons;
prefer conversational / in-context affordances).

## Bugs

- **B1 — Conversation sidebar has no scroll containment.** The conversation
  column isn't height-capped, so a long conversation grows the whole page
  instead of scrolling internally. Fix: cap to viewport height, give the message
  list its own `overflow-y-auto`, pin the composer at the bottom. The gallery
  already has this containment; the conversation column needs to match.

## Conversational cleanup (contract-touching)

- **C1 — Remove the Generate button.** Generation should be agent-discretion off
  the dialogue ("let's do another round" → agent reads intent → generates), not
  an explicit top-bar action. Removes the `generate` client→server command and
  likely its `generate` entry in `AGENT_EVENT_TYPES` (generation intent now
  arrives as a normal message the agent interprets). Also dissolves the
  "dead-feeling button" problem observed early in the session (clicking Generate
  gave no local feedback, so it got double-fired).
- **C2 — Remove the Add button.** The drag-drop zone is already the way in; a
  top-right Add button gets lost and reads as dissociated from the drop area.
  Keep drag-drop as the sole add mechanism. Principle: if an explicit add
  returns later, it belongs **inside the gallery/drop area**, not the top bar.
- **C3 — Remove augment/correct.** The toggle is confusing and unneeded — the
  grounding chip already shows what a message is "about," and the
  augment-vs-correct nuance is something natural language carries on its own.
  Removes `FeedbackMode`, the `mode` field on `Message`, the composer toggle,
  and the `mode` arg in the `message.send` payload. (Corroborated independently:
  the agent had earlier flagged the toggle as semantically muddy — it conflates
  feedback content with re-grounding.)
- **C4 — Add an explicit Send button.** Return-to-send stays; add a visible Send
  button beside the composer.
- **C5 — Automatic "thinking" indicator (send→reply).** When the human sends a
  message, the surface flips to a "thinking / processing" state **on its own**
  (client-driven, NOT an agent-set flag), and clears automatically when the
  agent's next message lands. It's a co-presence liveness signal ("my message
  sent, something's happening"), akin to a typing indicator when both parties
  are online. Visual idea: an equalizer / wave animation suggesting activity.
  - **Open design question:** relationship to the existing agent-driven `status`
    spinner (used for narrated work like "Generating round 1…"). Lean: keep both
    — auto-indicator for the send→reply gap, agent `status` for agent-initiated
    narrated activity — but unify them into a single visual language so they
    don't read as two unrelated widgets.

After C1 + C2 the top bar slims to identity + the Library/Style-guide toggle.

## Polish

- **P1 — Resizable conversation textarea.** No resize today; longer messages are
  cramped. Add `resize-y` (or auto-grow).
- **P2 — Responsive gallery columns.** The full-library grid is a fixed 3-col;
  good at medium widths, too sparse on a wide (27") monitor. Step it up at wide
  viewports — 3 at medium, 4 at `xl`, 5 at `2xl` — keeping thumbnails generously
  sized, just denser when there's room. Pure CSS, no contract change. Distinct
  from the parked S/M/L size toggle (which would layer a manual override on
  top).

## Parked (own design note — not in the cleanup pass)

- **Vision metadata on images.** Two related asks:
  1. **Auto-analyze on drop** — run a vision pass automatically when an image
     lands so its description is just there. (Today it's agent-initiated: the
     agent reads the image off disk via the lean-state path and writes the
     `agent` annotation, which already renders in the details fly-out. This was
     demoed live in-session — the loop works; only the automatic trigger is
     missing.) Small additive feature.
  2. **Re-reference by description, not pixels** — use the stored description as
     a cheap **text** proxy when grounding on an image again, so the agent reads
     "antique woodland ink-wash scene" instead of re-ingesting the full image.
     This touches the grounding + lean-state contract (an item could ground as
     text _or_ image) and is a genuine token / quick-reference win. Deserves a
     short design note before building — it changes what "grounding an image"
     means. Promote to its own slice when prioritized.

## Sequencing recommendation

Do the **conversational cleanup (B1, C1–C5, P1–P2) before Slice 4**, as a
focused "Slice 3.5" pass:

1. It's mostly subtractive → lands fast.
2. The scroll-bug fix + thinking-indicator improve the very surface we'd test
   Slice 4 in.
3. It commits us to the conversational-interface principle, which Slice 4's tray
   affordances should then follow — so re-check the Slice 4 plan against the
   principle before building, avoiding rework.
4. Keeps contract changes in separate reviewable waves: cleanup _simplifies_ the
   contract; Slice 4 _adds_ to it.

Vision metadata stays parked with its design note.
