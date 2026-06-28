# Magpie — Phase Spine (design)

_2026-06-27 · a cross-cutting scaffold that runs the whole surface, decided
before the bg-removal gallery so the gallery lands into a phase._ _Mockup:
`prototype/phase-stepper-mockup.html` (top-bar form is the keeper)._

## Why

Magpie is a **facilitated, multi-phase process**, not a set of loose modes. The
user needs to always know **where they are, what's sealed, and what's left** —
and to deliberately **seal a phase** ("looks good → next"), which is the
alignment point between human and agent. Without it, you finish slicing and have
no way to say "I'm good here, move on," and no map of what comes after.

Borrowed kernel (inspiration, not a model): **glamour's progression map**. We
take only the "phases + done/where/left" glance; we drop glamour's any-order
fill and focus-lens — magpie is strictly **linear** (one active phase at a
time).

## The spine

```
Intake  →  Slice  →  Remove  →  Export
drop +     fine-tune  remove      bundle +
discover   the cuts   backgrounds download
```

Each phase is an **open-up → close-down** exercise: diverge (do the work), then
converge (the **confirm-and-advance gate**). The confirmed output of a phase is
a **named artifact that seeds the next**: Slice → confirmed crops → Remove's
input; Remove → chosen cutouts → Export's input. The agent is the
**facilitator** (does the work, helps converge); the user is the
**decision-maker** (judges, seals).

## Form: top-bar stepper

A horizontal stepper `Intake → Slice → Remove → Export`, left-to-right. **Not**
a sidebar — glamour's sidebar earned its place by holding standing content
(prose/swatches/prompts) you consult; magpie's phases hold no standing content
(each phase's substance is its own main view), so the marker is purely linear
_state_, and a top bar renders linearity more honestly. We have the real estate.

Tri-state, in magpie's palette:

| Status       | Treatment                  | Meaning                        |
| ------------ | -------------------------- | ------------------------------ |
| **sealed**   | gold ✓ + artifact sublabel | a captured artifact (treasure) |
| **active**   | indigo, filled             | the exercise you're in         |
| **upcoming** | muted                      | ahead of you                   |

Plus an **"N / 4 sealed"** counter. The sealed step's sublabel carries its
artifact summary ("6 confirmed crops ✓") so "what's captured" stays glanceable
without a sidebar.

## Behavior

- **Linear cursor.** State holds a single `phase` cursor. Status is _derived_:
  phases before the cursor are sealed, the cursor is active, after is upcoming.
- **Forward = conversational, not a persistent gate.** There is NO standing
  "seal this phase" button (it greeted you on entry — premature — and made
  sealing a fixture). Advancement is **conversational**: you tell the agent
  "looks good, let's move on" and the agent advances (an agent-side
  `phase.set`); the agent — as facilitator, sensing readiness — may also offer a
  one-click **inline CTA** in chat ("Ready for background removal? [Move to
  Remove →]"), which is just a shortcut for saying it. The CTA dispatches the
  client `phase.advance` (cursor → next + emits the hand-off to the agent). This
  is the [conversation-primary principle]: conversation is the primary
  capability; buttons are shortcuts for conversational acts, never the only
  path. Entering a phase still triggers nothing automatic.
- **Back-nav = pushed context (not an action).** Clicking an earlier sealed step
  re-points the cursor backward (`phase.set`), re-opening the later phases for
  edits (a re-slice after you'd moved on is allowed — it just un-seals what's
  ahead). This **emits to the agent** — a phase switch is a deliberate
  relocation, not ambient editing, so the agent gets it as context for what's
  coming (re-cuts likely), even though there's nothing to _do_. Rare → never
  spammy. Happy path is forward; back is secondary.
- **Intake is special.** No user gate — it auto-advances to Slice the moment
  discovery returns elements (you just drop a board; there's nothing to
  "approve").

## Contract

```ts
export type PhaseKey = "intake" | "slice" | "remove" | "export";
export const PHASES: readonly PhaseKey[] = [
  "intake",
  "slice",
  "remove",
  "export",
];

// MagpieState gains:
phase: PhaseKey; // the linear cursor; defaultState → "intake"
```

**Messages:**

- `phase.advance` (ClientToServer, **imperative**) — seal the active phase, move
  the cursor to the next, emit `phase.advance { phase }` to the agent (the NEW
  phase). No-op at the last phase. Fired by an agent-offered CTA click.
- `phase.set { phase }` (ClientToServer, **imperative — pushed as context**) —
  back-nav / jump; mutate + broadcast + log a gesture + emit
  `phase.set { phase }` to the agent (a deliberate relocation; preps the agent
  for re-cuts, no action required).
- `phase.set { phase }` (AgentCommand) — the agent advancing/moving the cursor
  on the user's conversational request ("looks good, let's go"). Mutate +
  broadcast, NO self-emit (it's the agent's own move).

**Actionable agent messages (conversational advancement):** `Message` gains an
optional `action?: { label: string; command: ClientToServer }`. An agent message
(`say`) may carry a CTA; clicking it dispatches `command` (e.g.
`phase.advance`). This is the generalizable "button = a shortcut for a
conversational act" affordance — reusable beyond advance. The agent surfaces
CTAs at its discretion, never as a fixture.

**Mutators (reduce.ts):**

- `advancePhase(s): PhaseKey | null` — cursor → next; null if already last.
- `setPhase(s, phase): boolean` — set the cursor; reports change; validates
  against PHASES.

**Auto-intake:** the server's `elements.set` handler advances the cursor from
`intake` → `slice` once elements are present (discovery completed).

**Agent events:** `AGENT_EVENT_TYPES` gains `"phase.advance"` AND `"phase.set"`,
each with payload `{ phase: PhaseKey }` (where we moved to / stepped back to).
The agent reads everything else from `/state`.

## Render-by-phase

`MagpieShell` switches its body on `state.phase`:

- **intake** → the Dropzone (no source) / ScanningView (source, discovering) —
  today's pre-elements views.
- **slice** → today's BreakdownCanvas + slices rail (NO standing gate —
  advancement is conversational / an agent CTA in the thread).
- **remove** → the bg-removal gallery (built in the gallery tasks; **stub** for
  now).
- **export** → the asset-bundle view (**stub** for now).

The stepper renders above the body whenever a board exists. Remove/Export ship
as labeled stubs so the scaffold is dogfoolable before their bodies are built.

## Out of scope (later)

- The Export phase body (asset selection + bundle download) — its own task.
- The Remove phase body — the bg-removal gallery tasks (already planned).
- Proactive readiness detection (the agent deciding _when_ to offer the advance
  CTA) — the affordance exists; the agent's judgment of "looks ready" is a
  recipe refined during dogfood, not app logic.
