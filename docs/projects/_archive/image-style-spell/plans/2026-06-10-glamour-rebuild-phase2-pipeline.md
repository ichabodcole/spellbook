# Glamour Rebuild — Plan 2: Pipeline middle (Analysis, Direction, Prompts)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Analysis, Direction, and Prompts phases to React
components, add forward-only phase auto-advance, and add the correct-vs-augment
feedback distinction — making the input→understanding→prompts half of the
glamour pipeline fully usable in the new surface.

**Architecture:** Builds directly on Plan 1's foundation (branch
`feat/glamour-rebuild-foundation`). Same model: server is source of truth and
broadcasts full state over WebSocket; React phase components render typed state
and send typed `ClientToServer` messages; the agent drives via `/cmd`. The three
new phase components follow the exact pattern established by `Gather.tsx`. A
shared `FeedbackControl` adds the "that's not quite right" (correct) vs "yes,
and…" (augment) split that the dogfood proved was needed.

**Tech Stack:** Bun, React 18, TypeScript, Tailwind v4 (already wired in Plan
1).

**Spec:** `docs/projects/image-style-spell/glamour-rebuild-design.md` **Prior
plan:**
`docs/projects/image-style-spell/plans/2026-06-10-glamour-rebuild-foundation.md`

**House rules:** Bun only (`bun test`, no npm/jest/vite). Conventional commits
(release-please owns version). `npx prettier --write` changed files before
commit (biome pre-commit hook: no `any`, no non-null `!`, buttons need `type`).
All `send(...)` payloads must be valid `ClientToServer` members.

**Scope note (Occam):** Variants + Spec phases, the always-on in-surface
FeedbackBar (FEAT-3), terminal-handoff (FEAT-2), and feedback-event
consolidation are **out of scope** (Plan 3). This plan keeps the existing
per-scope feedback events and only _adds_ an optional `mode` to the direction
correction — the minimal change that delivers the user-facing correct/augment
distinction without a contract-wide refactor.

---

## Reference: what each phase does (from the existing protocol)

- **Analysis** — the agent has posted a per-influence `read` (via
  `influence.read`). The user reviews each influence's read and can comment
  per-influence (`analysis.comment`) or augment. Proceed nudge: **"synthesize
  the direction"**.
- **Direction** — the agent posts `direction` (`{understanding, revision}`). The
  user reads it and either corrects or augments it (`direction.correct`, now
  carrying `mode`). Proceed nudge: **"draft the prompts"**.
- **Prompts** — the agent posts `prompts` (`[{id,text}]`). The user comments
  per-prompt (`prompt.comment`) or overall (`prompts.comment`), then triggers
  generation (`generate`). Proceed nudge: **"draft the prompts"** (re-draft) and
  a **Generate** action.

Phase transition labels are free-text `nudge` labels; the agent infers intent
from the current phase.

---

## File Structure

```
plugins/spellbook/skills/glamour/
  scripts/server.ts            # MODIFY: forward-only phase auto-advance; pass mode on direction.correct
  surface/state/types.ts       # MODIFY: add mode? to direction.correct in ClientToServer
  surface/phases/
    PhaseRouter.tsx            # MODIFY: route analysis/direction/prompts to real components
    Analysis.tsx               # CREATE
    Direction.tsx              # CREATE
    Prompts.tsx                # CREATE
  surface/components/
    FeedbackControl.tsx        # CREATE — correct/augment two-button + text submit
  tests/
    phaseAdvance.test.ts       # CREATE
```

---

### Task 1: Forward-only phase auto-advance (server)

**Files:**

- Modify: `plugins/spellbook/skills/glamour/scripts/server.ts` (add an exported
  `advancePhase` helper near `VALID_PHASE` usage / the projections; call it
  inside the `direction`, `prompts`, `variant.add`, and `spec` command branches,
  and in the `influence.read` branch advance to `analysis`)
- Test: `plugins/spellbook/skills/glamour/tests/phaseAdvance.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/phaseAdvance.test.ts
import { test, expect } from "bun:test";
import { advancePhase } from "../scripts/server";

test("advancePhase moves forward only, never backward", () => {
  expect(advancePhase("gather", "analysis")).toBe("analysis");
  expect(advancePhase("analysis", "direction")).toBe("direction");
  expect(advancePhase("prompts", "variants")).toBe("variants");
  // never goes backward:
  expect(advancePhase("variants", "direction")).toBe("variants");
  expect(advancePhase("spec", "gather")).toBe("spec");
  // same phase is a no-op:
  expect(advancePhase("prompts", "prompts")).toBe("prompts");
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run:
`cd plugins/spellbook/skills/glamour && bun test tests/phaseAdvance.test.ts`
Expected: FAIL — `advancePhase` not exported.

- [ ] **Step 3: Implement `advancePhase` and wire it in**

In `server.ts`, add near the top-level helpers (after the `*ForAgent`
projections), using the imported `VALID_PHASE` as the canonical order (it is
already `["gather","analysis","direction","prompts","variants","spec"]`):

```ts
export function advancePhase(current: Phase, target: Phase): Phase {
  const ci = VALID_PHASE.indexOf(current);
  const ti = VALID_PHASE.indexOf(target);
  return ti > ci ? target : current;
}
```

Then, inside `handleAgentMsg`, after each artifact mutation, advance the phase
(forward-only) and let `broadcastState()` carry it:

- in the `influence.read` branch:
  `state.phase = advancePhase(state.phase, "analysis");` (before its
  `broadcastState()`)
- in the `direction` branch:
  `state.phase = advancePhase(state.phase, "direction");`
- in the `prompts` branch: `state.phase = advancePhase(state.phase, "prompts");`
- in the `variant.add` branch:
  `state.phase = advancePhase(state.phase, "variants");`
- in the `spec` branch: `state.phase = advancePhase(state.phase, "spec");`

Add `advancePhase` to the bottom `export { ... }` line so the test can import
it.

- [ ] **Step 4: Run tests**

Run: `cd plugins/spellbook/skills/glamour && bun test` Expected: PASS (existing
6 + phaseAdvance).

- [ ] **Step 5: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/tests/phaseAdvance.test.ts
git add plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/tests/phaseAdvance.test.ts
git commit -m "feat(glamour): forward-only phase auto-advance on artifact post"
```

---

### Task 2: `mode` on direction correction + `FeedbackControl` component

**Files:**

- Modify: `surface/state/types.ts` (add `mode?` to the `direction.correct`
  member of `ClientToServer`)
- Modify: `scripts/server.ts` (the `direction.correct` branch emits `mode`)
- Create: `surface/components/FeedbackControl.tsx`

- [ ] **Step 1: Extend the contract**

In `surface/state/types.ts`, change the `direction.correct` member of
`ClientToServer` from:

```ts
  | { type: "direction.correct"; text: string }
```

to:

```ts
  | { type: "direction.correct"; text: string; mode: "correct" | "augment" }
```

- [ ] **Step 2: Server passes `mode` through**

In `server.ts`, the `direction.correct` branch currently:

```ts
} else if (t === "direction.correct") {
  if (typeof msg.text !== "string") return;
  emitEvent({ type: "direction.correct", text: msg.text });
}
```

Change the `emitEvent` to include a validated mode (default `"correct"` for
backward compatibility):

```ts
} else if (t === "direction.correct") {
  if (typeof msg.text !== "string") return;
  const mode = msg.mode === "augment" ? "augment" : "correct";
  emitEvent({ type: "direction.correct", text: msg.text, mode });
}
```

- [ ] **Step 3: Write the `FeedbackControl` component**

```tsx
// surface/components/FeedbackControl.tsx
import { useState } from "react";

export type FeedbackMode = "correct" | "augment";

// Two-mode feedback: "that's not quite right" (correct) vs "yes, and…" (augment).
// onSubmit receives the chosen mode + the text; parent decides which message to send.
export function FeedbackControl({
  onSubmit,
}: {
  onSubmit: (mode: FeedbackMode, text: string) => void;
}) {
  const [mode, setMode] = useState<FeedbackMode>("augment");
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim()) return;
    onSubmit(mode, text.trim());
    setText("");
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("augment")}
          className={`text-xs px-3 py-1 rounded border ${mode === "augment" ? "bg-violet-600 text-white border-violet-600" : "border-[#2e2640] text-slate-300"}`}
        >
          yes, and…
        </button>
        <button
          type="button"
          onClick={() => setMode("correct")}
          className={`text-xs px-3 py-1 rounded border ${mode === "correct" ? "bg-amber-600 text-white border-amber-600" : "border-[#2e2640] text-slate-300"}`}
        >
          that's not quite right
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          mode === "augment"
            ? "add more — another lens, a detail to include…"
            : "what's off, and what you'd rather…"
        }
        className="w-full bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 text-sm text-slate-200 outline-none"
        rows={3}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white disabled:opacity-40"
      >
        send feedback
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests + bundle check**

Run: `cd plugins/spellbook/skills/glamour && bun test` → existing pass (7 now).
Then a serve check (bundle still compiles):
`cd scripts && bun cli.ts open --no-open`, port from `bun cli.ts info`,
`curl -s -o /dev/null -w "%{http_code}" localhost:PORT/` → 200, then the
`/_bun/.../*.js` → 200, then `bun cli.ts close`. (FeedbackControl isn't rendered
yet — Task 4 uses it — but it must compile.)

- [ ] **Step 5: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/state/types.ts plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/surface/components/FeedbackControl.tsx
git add plugins/spellbook/skills/glamour/surface/state/types.ts plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/surface/components/FeedbackControl.tsx
git commit -m "feat(glamour): correct/augment mode on direction feedback + FeedbackControl"
```

---

### Task 3: Analysis phase component

**Files:**

- Create: `surface/phases/Analysis.tsx`
- Modify: `surface/phases/PhaseRouter.tsx` (route `analysis` → `<Analysis>`)

- [ ] **Step 1: Write the Analysis component**

```tsx
// surface/phases/Analysis.tsx
import type { PhaseProps } from "./PhaseRouter";

export function Analysis({ state, send }: PhaseProps) {
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <h2 className="text-lg font-semibold text-violet-50">Analysis</h2>
      <p className="text-xs text-slate-500">
        The agent's read of each influence. Add a note to any — agree-and-add or
        correct.
      </p>
      <div className="space-y-3">
        {state.influences.map((inf) => (
          <div
            key={inf.id}
            className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-3 flex gap-3"
          >
            <img
              src={inf.src}
              alt={inf.name}
              className="w-24 h-24 object-cover rounded shrink-0"
            />
            <div className="flex-1 space-y-1">
              <p className="text-sm text-slate-200">
                {inf.read || (
                  <span className="text-slate-500">
                    …awaiting the agent's read…
                  </span>
                )}
              </p>
              <input
                defaultValue={inf.note}
                placeholder="your note on this one…"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v)
                    send({ type: "analysis.comment", id: inf.id, text: v });
                }}
                className="w-full bg-transparent border-b border-[#2a2238] text-xs text-slate-300 outline-none py-1"
              />
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          send({ type: "nudge", label: "synthesize the direction" })
        }
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white"
      >
        Synthesize the direction
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Route it in PhaseRouter**

In `PhaseRouter.tsx`, add `import { Analysis } from "./Analysis";` and add a
branch so `state.phase === "analysis"` renders
`<Analysis state={state} send={send} />`. Keep the existing gather branch and
the not-migrated placeholder for the rest. (Use a clean conditional — e.g.
convert the gather ternary into a small `phase`-switch returning the right
element.)

- [ ] **Step 3: Bundle check**

Run: `cd plugins/spellbook/skills/glamour && bun test` (7 pass) and the
serve/bundle check (curl `/` 200 + bundled JS 200) as in Task 2 Step 4.

- [ ] **Step 4: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/phases/Analysis.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git add plugins/spellbook/skills/glamour/surface/phases/Analysis.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git commit -m "feat(glamour): Analysis phase component"
```

---

### Task 4: Direction phase component (uses FeedbackControl)

**Files:**

- Create: `surface/phases/Direction.tsx`
- Modify: `surface/phases/PhaseRouter.tsx` (route `direction` → `<Direction>`)

- [ ] **Step 1: Write the Direction component**

```tsx
// surface/phases/Direction.tsx
import type { PhaseProps } from "./PhaseRouter";
import { FeedbackControl } from "../components/FeedbackControl";

export function Direction({ state, send }: PhaseProps) {
  const { understanding, revision } = state.direction;
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-violet-50">Direction</h2>
        {revision > 0 && (
          <span className="text-[11px] text-slate-500">
            revision {revision}
          </span>
        )}
      </div>
      <div className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-4 text-sm text-slate-200 whitespace-pre-wrap">
        {understanding || (
          <span className="text-slate-500">
            …the agent is composing its read…
          </span>
        )}
      </div>
      <FeedbackControl
        onSubmit={(mode, text) =>
          send({ type: "direction.correct", text, mode })
        }
      />
      <button
        type="button"
        onClick={() => send({ type: "nudge", label: "draft the prompts" })}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white"
      >
        Draft the prompts
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Route it in PhaseRouter**

Add `import { Direction } from "./Direction";` and a
`state.phase === "direction"` branch rendering
`<Direction state={state} send={send} />`.

- [ ] **Step 3: Bundle check + end-to-end feedback smoke**

Run `bun test` (7 pass) and the serve/bundle check. Then verify the
correct/augment wire: with a session open, set the phase and post a direction
via the agent, then confirm the contract compiles and a `direction.correct` with
`mode` is accepted — minimally, confirm the bundle JS is 200 (the
FeedbackControl now renders). (Full click-through is manual; the type + server
handler are covered by compile + the server change in Task 2.)

- [ ] **Step 4: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/phases/Direction.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git add plugins/spellbook/skills/glamour/surface/phases/Direction.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git commit -m "feat(glamour): Direction phase component with correct/augment feedback"
```

---

### Task 5: Prompts phase component (+ Generate)

**Files:**

- Create: `surface/phases/Prompts.tsx`
- Modify: `surface/phases/PhaseRouter.tsx` (route `prompts` → `<Prompts>`)

- [ ] **Step 1: Write the Prompts component**

```tsx
// surface/phases/Prompts.tsx
import { useState } from "react";
import type { PhaseProps } from "./PhaseRouter";

export function Prompts({ state, send }: PhaseProps) {
  const [overall, setOverall] = useState("");
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <h2 className="text-lg font-semibold text-violet-50">Prompts</h2>
      <p className="text-xs text-slate-500">
        The prompts the agent will generate from. Comment on any, or add an
        overall note, then generate.
      </p>
      <div className="space-y-2">
        {state.prompts.map((p, i) => (
          <div
            key={p.id}
            className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-3 space-y-1"
          >
            <div className="text-[11px] text-slate-500">prompt {i + 1}</div>
            <p className="text-sm text-slate-200 whitespace-pre-wrap">
              {p.text}
            </p>
            <input
              placeholder="comment on this prompt…"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v) {
                  send({ type: "prompt.comment", id: p.id, text: v });
                  e.target.value = "";
                }
              }}
              className="w-full bg-transparent border-b border-[#2a2238] text-xs text-slate-300 outline-none py-1"
            />
          </div>
        ))}
      </div>
      <textarea
        value={overall}
        onChange={(e) => setOverall(e.target.value)}
        placeholder="overall note on the set (optional)…"
        className="w-full bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 text-sm text-slate-200 outline-none"
        rows={2}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            if (overall.trim()) {
              send({ type: "prompts.comment", text: overall.trim() });
              setOverall("");
            }
          }}
          disabled={!overall.trim()}
          className="text-sm px-4 py-2 rounded-lg font-medium border border-[#2e2640] text-slate-200 disabled:opacity-40"
        >
          Send note
        </button>
        <button
          type="button"
          onClick={() => send({ type: "generate" })}
          className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white"
        >
          Generate
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Route it in PhaseRouter**

Add `import { Prompts } from "./Prompts";` and a `state.phase === "prompts"`
branch rendering `<Prompts state={state} send={send} />`. At this point
PhaseRouter routes gather/analysis/direction/prompts to real components;
variants/spec keep the placeholder (Plan 3).

- [ ] **Step 3: Bundle check**

Run `bun test` (7 pass) and the serve/bundle check (curl `/` 200 + bundled JS
200). Confirm all four migrated phases compile into the bundle.

- [ ] **Step 4: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/phases/Prompts.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git add plugins/spellbook/skills/glamour/surface/phases/Prompts.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git commit -m "feat(glamour): Prompts phase component with generate"
```

---

## Self-Review

**Spec coverage (Plan 2 portion):** phase auto-advance ✓ (Task 1);
correct/augment feedback ✓ (Task 2 + 4); Analysis ✓ (Task 3); Direction ✓ (Task
4); Prompts + generate ✓ (Task 5). **Deferred to Plan 3 (noted):** Variants +
Spec phases, VariantGrid/Lightbox/round-grouping/canonical-selection, variant
image-optimize wiring, the always-on FeedbackBar (FEAT-3) + terminal-handoff
(FEAT-2), feedback-event consolidation, controlled IntentField.

**Placeholder scan:** every step has complete code; no TBD/TODO. Bundle checks
are concrete curl commands.

**Type consistency:** all components use `PhaseProps`
(`{state, send:(ClientToServer)=>void}`) from `PhaseRouter`; `direction.correct`
now carries `mode` in both the contract (Task 2 Step 1) and the send call (Task
4); `analysis.comment`/`prompt.comment`/`prompts.comment`/`generate`/`nudge`
payloads all match existing `ClientToServer` members; `advancePhase` name
consistent between server export (Task 1 Step 3) and test import (Task 1 Step
1).

**Note for the implementer:** PhaseRouter is edited by Tasks 3, 4, and 5 in
sequence — each adds one route branch. Prefer refactoring its phase selection
into a single readable switch/lookup as the branches accumulate, rather than a
deep ternary chain (keep it the same behavior).
