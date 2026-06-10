# Glamour rebuild — design spec

**Date:** 2026-06-10 · **Status:** approved design, pre-plan · **Spell:**
glamour (conjuration, mid-`inscribe` — no SKILL.md yet)

Rebuild of glamour's surface and agent⇄user protocol, driven by the live dogfood
run on the Hollowbrook world. Findings + full punch-list:
`docs/projects/image-style-spell/artifacts/glamour-dogfood-hollowbrook.md`.

## Context & goal

The dogfood proved the flow works end-to-end (gather → analysis → direction →
prompts → variants → spec, $0.38) but surfaced two structural problems: the
single 1,425-line inline-Alpine `template.html` is hard to edit safely, and the
**agent⇄user channel is the weakest part of the tool** — the agent silently
dropped three real user inputs (`direction.correct`, `steer`, `variant.like`)
because it consumed events through a hand-rolled allowlist.

Goal: rebuild glamour as a **component-structured, typed** surface on the house
runtime (React + Bun's bundler), with the agent⇄user protocol redesigned so
input can't be lost — and do it in a way that becomes a **reusable pattern for
the next agent** building a medium-complexity spell surface.

## Guiding principles

- **The agent is the target audience.** Optimize for agent-buildability: clear
  component boundaries, typed contracts, files small enough to hold in context,
  conventions discoverable from the scaffold. Defer structural calls to the
  building agent; reserve human input for product decisions.
- **Good-enough now, evolve on friction.** Choose the simplest structure that
  works; evolve when we hit friction, simplify when it feels over-built. The
  pattern is judged by: **easy to set up · easy to maintain · quick to change.**
- **Concrete-first (A→C).** Build glamour for real; factor reusable seams as
  they reveal themselves; extract the shared scaffold only _after_ glamour
  proves it — never abstract a framework in the air.
- **House-style intact.** Bun's own bundler — no vite/webpack. The distribution
  stays a trivially launchable artifact.

## Scope & phasing

- **Phase 1 — core (this spec implements):** React + Bun surface migration; the
  agent⇄user protocol redesign (complete typed event set, activity/narration
  feed, in-surface feedback, terminal-handoff signal); the P1 fixes the protocol
  depends on (lean `state`, complete event handling, phase auto-advance); the
  contained surface bugs (overlay dismiss, animated spinner, context-only
  intake); variant image optimization.
- **Phase 2 — polish (specced, sequenced after):** lightbox / aspect-ratio view,
  round grouping, canonical selection on spec, cost display, correct-vs-augment
  feedback framing in UI, annotation discoverability.
- **Phase 3 — extract:** factor the reusable "complex surface" scaffold out of
  glamour → promote to `grimoire/house-style.md` + the `agent-surface-bun`
  recipe via `ward` (a house-style convention change).

**Primary Phase 1 deliverable:** a glamour surface that is component-structured,
typed end-to-end (shared event/state types across server + client), small-file,
and centered on a robust agent⇄user protocol.

**Deliberate exclusions (YAGNI):** no full chat interface (narration is
one-way + structured feedback, not a conversation); no media-forge CLI changes
(the cost-in-generate-response ask is a separate repo — noted as a dependency).

## Architecture (React + Bun)

**Keystone: one shared types module both sides import.**
`surface/state/types.ts` holds the event unions and state shape. Server emit and
client reducer both consume it; an unhandled event type becomes a **compile
error**, not a silent drop. This is the structural fix for the lost-input bug.

Layout (small, focused files):

```
skills/glamour/
  scripts/
    cli.ts          # ~unchanged thin client; spawns the daemon
    server.ts       # slimmed daemon: Bun.serve /state /events /cmd + snapshots
  surface/                      # React app, bundled by Bun
    index.html                  # entry: <script type=module src=main.tsx> + Tailwind <link>
    main.tsx                    # mount + SSE wiring
    state/
      types.ts                  # ★ shared event + state types (server imports too)
      store.ts                  # typed reducer: SSE event → client state
      protocol.ts               # agent⇄user protocol (send / narrate / feedback) — reusable seam
      imageOptimize.ts          # shared downscale+webp util (drops + variants)
    phases/  Gather / Analysis / Direction / Prompts / Variants / Spec .tsx + PhaseRouter.tsx
    components/  DropZone, InfluenceCard, VariantGrid, Lightbox, NarrationFeed,
                 FeedbackBar, Spinner, …
```

**Build / launch (stays trivial):** `server.ts` uses Bun's HTML import
(`import index from "../surface/index.html"`) in its `Bun.serve` routes — Bun
bundles + transpiles automatically, HMR in dev. `cli.ts open` unchanged. Frozen
artifact via `bun build ./surface/index.html --outdir dist`. Tailwind moves off
the dev-only CDN to Bun-bundled Tailwind.

**Data flow** (today's model, typed + structured): server is source of truth
(state + snapshots); client hydrates from `GET /state` (lean projection for the
agent / full for the browser), applies `/events` SSE through the typed reducer;
user actions `POST /cmd`.

## Agent⇄user protocol (the heart)

1. **Typed, exhaustive event unions — the contract.** In `types.ts`: a
   `UserEvent` union (user→agent, everything the tail can receive) and an
   `AgentCommand` union (agent→server). Client reducer and agent tail consumer
   each `switch` exhaustively. No hand-rolled allowlists.
2. **Activity feed (agent→user narration).** Persistent append-only feed the
   agent writes to ("reading context…", "generating Lane B on nano, ~30s",
   "picked B over C because…"). Typed kinds: `info | working | result | error`.
   **Boundary: not a chat** — one-way, no threading, no real-time reply
   expectation. Replaces terminal-watching + ephemeral toast.
3. **In-surface feedback bar (non-terminating).** Always-available control: user
   types a note → sent to the agent with a **breadcrumb** (current phase + light
   context tag), **does not end the session**. Carries `mode`: **"that's not
   quite right" (correct)** vs **"yes, and…" (augment)** — fixes the framing
   that made `direction.correct` read as rejection. The note echoes into the
   activity feed so the user sees it land.
4. **Terminal-handoff banner + lean state.** When the agent must use a terminal
   question, it posts a `handoff` → prominent banner ("↪ questions in your
   terminal"), cleared on resolve. `GET /state?lean=1` (agent default via
   `cli.ts state`) omits inlined image `src`; browser hydrates full.

## Server & state changes

1. **Phase auto-advances on the canonical artifact** (forward-only; agent can
   still set explicitly): `direction` → direction, `prompts` → prompts, first
   `variant.add` of a round → variants, `spec` → spec. Deletes the stale-nudge /
   double-press class.
2. **Consolidate scattered feedback events (simplification).** Replace
   `feedback` + `analysis.comment` + `direction.correct` +
   `prompt.comment`/`prompts.comment` with **one** `feedback` event:
   `{ scope: phase, mode: "correct" | "augment", text, breadcrumb }`.
3. **Spec modules get content.** `{ key, label, on, content }`. `understanding`
   = core look paragraph; modules carry the structured sections (palette,
   consistency, motifs, do/don't) each with real text; `recreatePrompt` +
   `model` as today. A structured, re-castable spec instead of one blob.
4. **Lean state projection.** `GET /state?lean=1` omits inlined `src` from
   influences/variants (agent default); browser hydrates full.
5. **Image optimization on both ingestion paths.** Drops already downscale to
   ≤1200px + WebP @0.85 client-side (`downscaleToWebp`) — keep it, move it into
   the shared `imageOptimize` util. **New:** apply the same to **agent-posted
   variants** before inlining (the ~2 MB raw nano PNGs are the real state-bloat
   source). Likely tool: `sharp` (house precedent: toolbox screenshot-
   optimization). Serves the lean-state goal directly.
6. **Contained surface bugs built correct from the start** in the React
   components: overlay dismiss, animated spinner, context-only intake (proceed
   no longer gated on images).

Snapshot/restore stays as-is; Phase 1 smoke-tests `open --restore` (never
exercised in the dogfood).

## Testing & error handling

**Concentrate tests on pure, typed logic** (`bun test`):

- the **reducer** (`UserEvent` → state) — highest value; covers the
  dropped-event class by construction + merge correctness;
- **phase auto-advance** (forward-only, correct artifact → phase);
- **feedback consolidation** (scope/mode routing), **spec-module merge**, **lean
  projection** (src omitted), **image-optimize** (size/format);
- existing subprocess integration (`open` / `cmd` / `submit` / `cancel` /
  `timeout`).

React components stay thin (render typed state, emit typed commands) → no
brittle DOM tests; the wrapped logic is already covered.

**Error handling** (mostly retained): SSE reconnect w/ backoff; daemon-down →
clear failure; presigned-URL expiry handled by inline-on-post. **New:**
generation/network failures surface as an `error`-kind activity-feed entry, not
just terminal.

## Reusable seams (Phase 3 extraction candidates)

Built clean now, extracted after glamour proves them, judged against
easy-to-setup/maintain/change: `state/types.ts` + `state/protocol.ts` (typed
contract + send/narrate/feedback), the `server.ts` skeleton (Bun.serve + SSE +
snapshots), the Bun build/Tailwind config, the `imageOptimize` util, and the
`NarrationFeed` / `FeedbackBar` components.

## Dependencies & open items

- **media-forge** cost-on-generate-response (would feed the Phase 2 cost
  display) — separate repo, tracked in the gaps report, not built here.
- `sharp` as a glamour dependency for server-side variant optimization — confirm
  at build time vs a lighter alternative.

## Reference

- Dogfood findings + consolidated punch-list:
  `docs/projects/image-style-spell/artifacts/glamour-dogfood-hollowbrook.md`
- House decision (stack): memory `spell-surface-stack`
