# Glamour Rebuild — Plan 3: Output phases (Variants, Spec) + agent⇄user channels

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the glamour surface migration — build the Variants and Spec
phases as real React components (grid + lightbox + like + round grouping +
canonical selection + cost), wire server-side variant image optimization, add
the two highest-value agent⇄user channels (in-surface FeedbackBar FEAT-3 +
terminal-handoff banner FEAT-2), and retire the dormant `template.html`.

**Architecture:** Builds on Plans 1+2 (branch
`feat/glamour-rebuild-foundation`). Same model: server is source of truth and
broadcasts full state over WebSocket; React phase components render typed state
and send typed `ClientToServer` messages; the agent drives via `POST /cmd`.
Variants/Spec follow the exact component pattern established by
Gather/Analysis/Direction/Prompts. Two new agent→user state fields (`cost`,
`handoff`) and one new browser→agent event (`note`) extend the shared contract.
Agent-posted variants are optimized server-side (sharp) before inlining — the
real state-bloat source.

**Tech Stack:** Bun, React 18, TypeScript, Tailwind v4, sharp (already a repo
dependency, used by `imageOptimize.server.ts`).

**Spec:** `docs/projects/image-style-spell/glamour-rebuild-design.md` **Prior
plans:**
`docs/projects/image-style-spell/plans/2026-06-10-glamour-rebuild-foundation.md`,
`docs/projects/image-style-spell/plans/2026-06-10-glamour-rebuild-phase2-pipeline.md`
**Dogfood findings:**
`docs/projects/image-style-spell/artifacts/glamour-dogfood-hollowbrook.md`

**House rules:** Bun only (`bun test`, no npm/jest/vite). Conventional commits
(release-please owns version). `npx prettier --write` changed files before
commit (biome pre-commit hook: no `any`, no non-null `!`, buttons need
`type="button"`). Every `send(...)` payload must be a valid `ClientToServer`
member; every agent command must be handled in `handleAgentMsg`.

**Scope note (Occam — what this plan deliberately does NOT do):**

- **No feedback-event consolidation.** The design floated merging `feedback` +
  `analysis.comment` + `direction.correct` + `prompt.comment` /
  `prompts.comment` into one event. That is a contract-wide refactor touching
  every working phase, and it is a _simplification_, not a correctness fix —
  `AGENT_EVENT_TYPES` already eliminates the dropped-input class structurally.
  Deferred until/unless we hit friction. The new `note` event (FEAT-3) is added
  **additively**; the existing per-scope events stay.
- **No sweeping "controlled inputs" refactor.** The existing inputs work (Gather
  already does context-only intake, BUG-4). We only add controlled inputs where
  a new component needs them.
- **Cost (FEAT-4)** is implemented minimally: a single agent-set display string
  (`state.cost`), not a structured per-job ledger.

---

## Reference: what each new phase does

- **Variants** — the agent posts generated images via `variant.add` (each with a
  `round`, `prompt`, `label`). The user reviews them grouped by round, **likes**
  the ones that land (`variant.like`), clicks any to **enlarge at true aspect**
  (lightbox — acute because nano-banana-2 returns wide 16:9 into square cards),
  and can **comment on a round** to steer the next generation (`steer`). Cost
  (if the agent set it) shows in the header. Proceed nudge: **"distill the
  spec"**.
- **Spec** — the agent posts the final spec via `spec` (`understanding`,
  `modules[]` with `content`, `recreatePrompt`, `model`). The user reads the
  look, toggles which **sections/modules** are included (`spec.module`), picks
  **the canonical image** from the variants (`variant.canonical`,
  single-select), and **finishes** (`submit`). Cost shows in the header.

Two always-on channels live in `PhaseRouter` across every phase:

- **FeedbackBar (FEAT-3)** — a floating "✎ feedback" control (bottom-right) that
  sends a `note` to the agent tagged with the current phase as a breadcrumb,
  **without ending the session**. Carries the correct/augment mode. The server
  echoes the note into the narration feed so the user sees it land.
- **Terminal-handoff banner (FEAT-2)** — a prominent top banner shown whenever
  `state.handoff` is non-empty ("↪ questions in your terminal"). The agent
  raises it (`handoff <text>`) before a terminal `AskUserQuestion` and clears it
  (`handoff --clear`) after.

---

## File Structure

```
plugins/spellbook/skills/glamour/
  scripts/server.ts            # MODIFY: async variant optimize; cost/handoff/note handlers; single-canonical; doc-comment
  scripts/cli.ts               # MODIFY: cost + handoff verbs; HELP
  scripts/template.html        # DELETE: dormant (server serves the Bun bundle since Plan 1)
  surface/state/types.ts       # MODIFY: cost+handoff on GlamourState; note in ClientToServer + AGENT_EVENT_TYPES; defaultState
  surface/components/
    Lightbox.tsx               # CREATE — full-screen, esc/click-out, true aspect
    FeedbackBar.tsx            # CREATE — always-on note channel (FEAT-3)
  surface/phases/
    Variants.tsx               # CREATE
    Spec.tsx                   # CREATE
    PhaseRouter.tsx            # MODIFY: route variants/spec; handoff banner; mount FeedbackBar
  tests/
    variantOptimize.test.ts    # CREATE
    canonical.test.ts          # CREATE
```

---

### Task 1: Server-side variant image optimization

**Why:** Agent-posted variants are raw ~2 MB nano PNGs inlined as data URLs —
the dominant state-bloat source (dogfood: 1.6 MB state dumps). Browser drops
already downscale client-side; variants don't. Apply the same policy
server-side.

**Files:**

- Modify: `plugins/spellbook/skills/glamour/scripts/server.ts`
- Test: `plugins/spellbook/skills/glamour/tests/variantOptimize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/variantOptimize.test.ts
import { expect, test } from "bun:test";
import sharp from "sharp";
import { optimizeVariantSrc } from "../scripts/server";

test("optimizeVariantSrc downscales a large PNG data-url to a webp data-url ≤1200px", async () => {
  const png = await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: "#c43c3c" },
  })
    .png()
    .toBuffer();
  const src = `data:image/png;base64,${png.toString("base64")}`;
  const out = await optimizeVariantSrc(src);
  expect(out.startsWith("data:image/webp;base64,")).toBe(true);
  const outBuf = Buffer.from(
    out.slice("data:image/webp;base64,".length),
    "base64"
  );
  const meta = await sharp(outBuf).metadata();
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
  expect(outBuf.byteLength).toBeLessThan(png.byteLength);
});

test("optimizeVariantSrc passes non-data-url src through unchanged", async () => {
  const url = "https://example.com/x.png";
  expect(await optimizeVariantSrc(url)).toBe(url);
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run:
`cd plugins/spellbook/skills/glamour && bun test tests/variantOptimize.test.ts`
Expected: FAIL — `optimizeVariantSrc` is not exported.

- [ ] **Step 3: Implement `optimizeVariantSrc` and make the variant path async**

In `server.ts`, add the import near the other surface-state imports (top of
file, with `import index from "../surface/index.html";` and the `types` import):

```ts
import { optimizeImageBuffer } from "../surface/state/imageOptimize.server";
```

Add the helper near the other top-level projection helpers (after
`variantForAgent` / `advancePhase`):

```ts
const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is;

// Downscale+webp an inlined variant data-url before it enters state (raw nano
// PNGs are the dominant state-bloat source). Non-data-url srcs (e.g. http) and
// any failure pass the original through unchanged — optimization is best-effort.
export async function optimizeVariantSrc(src: string): Promise<string> {
  const m = IMAGE_DATA_URL_RE.exec(src);
  if (!m) return src;
  try {
    const input = new Uint8Array(Buffer.from(m[1], "base64"));
    const { data } = await optimizeImageBuffer(input);
    return `data:image/webp;base64,${Buffer.from(data).toString("base64")}`;
  } catch {
    return src;
  }
}
```

Make `handleAgentMsg` async and optimize in the `variant.add` branch. Change the
signature:

```ts
async function handleAgentMsg(msg: Record<string, unknown>) {
```

In the `variant.add` branch, optimize before pushing:

```ts
} else if (t === "variant.add") {
  const raw2 = msg.variant as Record<string, unknown> | undefined;
  if (raw2 && typeof raw2.src === "string") {
    const src = await optimizeVariantSrc(raw2.src);
    state.variants.push({
      id: typeof raw2.id === "string" ? raw2.id : newId("v"),
      src,
      prompt: typeof raw2.prompt === "string" ? raw2.prompt : "",
      label: typeof raw2.label === "string" ? raw2.label : "",
      round: typeof raw2.round === "number" ? raw2.round : state.round,
      liked: false,
      canonical: false,
    });
    state.phase = advancePhase(state.phase, "variants");
    broadcastState();
  }
}
```

Update the `POST /cmd` handler to await the now-async handler. Change:

```ts
            .then((body) => {
              touch();
              handleAgentMsg(body as Record<string, unknown>);
              return new Response('{"ok":true}', {
```

to:

```ts
            .then(async (body) => {
              touch();
              await handleAgentMsg(body as Record<string, unknown>);
              return new Response('{"ok":true}', {
```

Add `optimizeVariantSrc` to the bottom `export { ... }` line (alongside
`htmlEscape, main, parsePortFromSessionId`).

- [ ] **Step 4: Run tests**

Run: `cd plugins/spellbook/skills/glamour && bun test` Expected: PASS (existing
7 + 2 new = 9).

- [ ] **Step 5: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/tests/variantOptimize.test.ts
git add plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/tests/variantOptimize.test.ts
git commit -m "feat(glamour): optimize agent-posted variants server-side before inlining"
```

---

### Task 2: Contract + server for the new channels (cost, handoff, note, single-canonical)

**Files:**

- Modify: `surface/state/types.ts`
- Modify: `scripts/server.ts`
- Modify: `scripts/cli.ts`
- Test: `plugins/spellbook/skills/glamour/tests/canonical.test.ts`

- [ ] **Step 1: Extend the contract (`types.ts`)**

Add two agent-set display fields to `GlamourState` (after
`narration: Narration[];`, before `spec:`):

```ts
cost: string;
handoff: string;
```

Add the `note` event to the `ClientToServer` union (place it after the
`direction.correct` member):

```ts
  | { type: "note"; text: string; scope: Phase; mode: "correct" | "augment" }
```

Add `"note"` to the `AGENT_EVENT_TYPES` frozen array (after
`"direction.correct"`):

```ts
  "note",
```

In `defaultState`, add the two fields (after `narration: [],`):

```ts
    cost: "",
    handoff: "",
```

- [ ] **Step 2: Write the failing test (single-canonical helper)**

```ts
// tests/canonical.test.ts
import { expect, test } from "bun:test";
import { applyCanonical } from "../scripts/server";
import type { Variant } from "../surface/state/types";

const mk = (id: string, canonical = false): Variant => ({
  id,
  src: "",
  prompt: "",
  label: "",
  round: 1,
  liked: false,
  canonical,
});

test("applyCanonical makes exactly one variant canonical", () => {
  const vs = [mk("a", true), mk("b"), mk("c")];
  applyCanonical(vs, "b", true);
  expect(vs.map((v) => v.canonical)).toEqual([false, true, false]);
});

test("applyCanonical can clear the canonical flag", () => {
  const vs = [mk("a"), mk("b", true)];
  applyCanonical(vs, "b", false);
  expect(vs.every((v) => !v.canonical)).toBe(true);
});

test("applyCanonical ignores an unknown id", () => {
  const vs = [mk("a", true)];
  applyCanonical(vs, "zzz", true);
  expect(vs[0].canonical).toBe(true);
});
```

- [ ] **Step 3: Run test, confirm it fails**

Run: `cd plugins/spellbook/skills/glamour && bun test tests/canonical.test.ts`
Expected: FAIL — `applyCanonical` not exported.

- [ ] **Step 4: Implement the helper + the new server handlers**

In `server.ts`, add the helper near the other top-level helpers (after
`advancePhase`):

```ts
// Enforce single-canonical: setting one true clears the rest; setting false
// just clears that one. Mutates in place. Unknown id is a no-op.
export function applyCanonical(
  variants: Variant[],
  id: string,
  on: boolean
): void {
  const target = variants.find((v) => v.id === id);
  if (!target) return;
  if (on) for (const v of variants) v.canonical = v.id === id;
  else target.canonical = false;
}
```

In `handleAgentMsg`, add `cost` and `handoff` agent-command branches (place them
after the `narrate` branch, before `message`):

```ts
} else if (t === "cost") {
  if (typeof msg.text === "string") {
    state.cost = msg.text;
    broadcastState();
  }
} else if (t === "handoff") {
  state.handoff = typeof msg.text === "string" ? msg.text : "";
  broadcastState();
```

In the `websocket.message` handler, replace the existing `variant.canonical`
branch:

```ts
          } else if (t === "variant.canonical") {
            const x = findVariant(msg.id as string);
            if (!x) return;
            x.canonical = msg.canonical === true;
            broadcastState();
            emitEvent({
              type: "variant.canonical",
              id: x.id,
              canonical: x.canonical,
            });
          }
```

with the single-canonical version:

```ts
          } else if (t === "variant.canonical") {
            const x = findVariant(msg.id as string);
            if (!x) return;
            applyCanonical(state.variants, x.id, msg.canonical === true);
            broadcastState();
            emitEvent({
              type: "variant.canonical",
              id: x.id,
              canonical: x.canonical,
            });
          }
```

Add the `note` browser→server branch (place it after the `steer` branch, before
`feedback`):

```ts
          } else if (t === "note") {
            // FEAT-3: always-on, non-terminating feedback channel. Echo into the
            // narration feed so the user sees it land, then forward to the agent
            // with the phase breadcrumb + mode.
            if (typeof msg.text !== "string" || !msg.text) return;
            const scope = VALID_PHASE.includes(msg.scope as Phase)
              ? (msg.scope as Phase)
              : state.phase;
            const mode = msg.mode === "correct" ? "correct" : "augment";
            state.narration.push({
              id: newId("n"),
              kind: "info",
              text: `you (${scope}): ${msg.text}`,
              ts: Date.now(),
            });
            broadcastState();
            emitEvent({ type: "note", text: msg.text, scope, mode });
          }
```

Add `applyCanonical` to the bottom `export { ... }` line.

Update the top-of-file protocol doc-comment to keep it accurate:

- In the "Agent commands" block add:
  ```
  //   {"type":"cost",          "text":".."}                    // cumulative spend display
  //   {"type":"handoff",       "text":".."}                    // "questions in terminal" banner ("" clears)
  ```
- In the "User events" block add:
  ```
  //   {"type":"note","text":"..","scope":"<phase>","mode":"correct|augment"}  // in-surface feedback (non-terminating)
  ```
- Next to `variant.canonical` note:
  `// single-select: setting one clears the rest`.

- [ ] **Step 5: Add the `cost` + `handoff` CLI verbs (`cli.ts`)**

In the `switch (verb)` block (after the `narrate` case), add:

```ts
    case "cost":
      if (!pos.length) die("usage: cost <text...>");
      await postCmd(session, { type: "cost", text: pos.join(" ") });
      break;
    case "handoff":
      await postCmd(session, {
        type: "handoff",
        text: flags.clear === true ? "" : pos.join(" "),
      });
      break;
```

In the `HELP` string, add under the spec/status lines:

```
  cost   <text...>                    cumulative spend display (e.g. "$0.38 · 8 imgs")
  handoff <text...> | handoff --clear raise/clear the "questions in terminal" banner
```

- [ ] **Step 6: Run tests + bundle check**

Run: `cd plugins/spellbook/skills/glamour && bun test` Expected: PASS (9 + 3
canonical = 12).

Bundle check (the contract change must still compile in the React bundle):
`cd plugins/spellbook/skills/glamour/scripts && bun cli.ts open --no-open`, read
the port from `bun cli.ts info`, then
`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:PORT/` → `200`, then
`bun cli.ts close`.

- [ ] **Step 7: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/state/types.ts plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/scripts/cli.ts plugins/spellbook/skills/glamour/tests/canonical.test.ts
git add plugins/spellbook/skills/glamour/surface/state/types.ts plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/scripts/cli.ts plugins/spellbook/skills/glamour/tests/canonical.test.ts
git commit -m "feat(glamour): cost + handoff fields, note channel, single-canonical selection"
```

---

### Task 3: Lightbox component

**Files:**

- Create: `surface/components/Lightbox.tsx`

- [ ] **Step 1: Write the component**

```tsx
// surface/components/Lightbox.tsx
import { useEffect } from "react";

// Full-screen image view at true aspect ratio. Dismiss via Escape or click-out
// (also addresses the old un-dismissable overlay, dogfood BUG-2).
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out"
    >
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-full object-contain rounded-lg"
      />
    </div>
  );
}
```

- [ ] **Step 2: Bundle check**

Run: `cd plugins/spellbook/skills/glamour && bun test` (12 pass) and the
serve/bundle check (curl `/` → 200) as in Task 2 Step 6. (Lightbox isn't
rendered yet — Tasks 4 + 5 use it — but it must compile.)

- [ ] **Step 3: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/components/Lightbox.tsx
git add plugins/spellbook/skills/glamour/surface/components/Lightbox.tsx
git commit -m "feat(glamour): Lightbox component (true-aspect, esc/click-out)"
```

---

### Task 4: Variants phase component

**Files:**

- Create: `surface/phases/Variants.tsx`
- Modify: `surface/phases/PhaseRouter.tsx` (route `variants` → `<Variants>`)

- [ ] **Step 1: Write the component**

```tsx
// surface/phases/Variants.tsx
import { useState } from "react";
import { Lightbox } from "../components/Lightbox";
import type { Variant } from "../state/types";
import type { PhaseProps } from "./PhaseRouter";

export function Variants({ state, send }: PhaseProps) {
  const [zoom, setZoom] = useState<Variant | null>(null);
  const rounds = [...new Set(state.variants.map((v) => v.round))].sort(
    (a, b) => a - b
  );
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-violet-50">Variants</h2>
        {state.cost && (
          <span className="text-xs text-emerald-300">{state.cost}</span>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Like the ones that land. Click an image for full size + true aspect.
        Comment on a round to steer the next generation.
      </p>
      {state.variants.length === 0 && (
        <p className="text-sm text-slate-500">
          …awaiting the first generation round…
        </p>
      )}
      {rounds.map((r) => (
        <div key={r} className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">
            round {r}
          </div>
          <div className="grid grid-cols-3 gap-3">
            {state.variants
              .filter((v) => v.round === r)
              .map((v) => (
                <div
                  key={v.id}
                  className="bg-[#1b1626] border border-[#2e2640] rounded-lg overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setZoom(v)}
                    className="block w-full cursor-zoom-in"
                  >
                    <img
                      src={v.src}
                      alt={v.label || v.prompt}
                      className="w-full h-32 object-cover"
                    />
                  </button>
                  <div className="p-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-400 truncate">
                      {v.label || "variant"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        send({
                          type: "variant.like",
                          id: v.id,
                          liked: !v.liked,
                        })
                      }
                      className={`text-xs px-2 py-0.5 rounded border ${v.liked ? "bg-rose-600 text-white border-rose-600" : "border-[#2e2640] text-slate-300"}`}
                    >
                      {v.liked ? "♥ liked" : "♡ like"}
                    </button>
                  </div>
                </div>
              ))}
          </div>
          <input
            placeholder={`note on round ${r} (steers the next generation)…`}
            onBlur={(e) => {
              const t = e.target.value.trim();
              if (t) {
                send({ type: "steer", text: `round ${r}: ${t}` });
                e.target.value = "";
              }
            }}
            className="w-full bg-transparent border-b border-[#2a2238] text-xs text-slate-300 outline-none py-1"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => send({ type: "nudge", label: "distill the spec" })}
        disabled={state.variants.length === 0}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white disabled:opacity-40"
      >
        Distill the spec
      </button>
      {zoom && (
        <Lightbox
          src={zoom.src}
          alt={zoom.label || zoom.prompt}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Route it in PhaseRouter**

Add `import { Variants } from "./Variants";` and, in `renderPhase`'s switch,
add:

```tsx
    case "variants":
      return <Variants state={state} send={send} />;
```

- [ ] **Step 3: Bundle check**

Run `bun test` (12 pass) and the serve/bundle check (curl `/` → 200).

- [ ] **Step 4: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/phases/Variants.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git add plugins/spellbook/skills/glamour/surface/phases/Variants.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git commit -m "feat(glamour): Variants phase (round grouping, like, lightbox, cost)"
```

---

### Task 5: Spec phase component

**Files:**

- Create: `surface/phases/Spec.tsx`
- Modify: `surface/phases/PhaseRouter.tsx` (route `spec` → `<Spec>`)

- [ ] **Step 1: Write the component**

```tsx
// surface/phases/Spec.tsx
import { useState } from "react";
import { Lightbox } from "../components/Lightbox";
import type { Variant } from "../state/types";
import type { PhaseProps } from "./PhaseRouter";

export function Spec({ state, send }: PhaseProps) {
  const [zoom, setZoom] = useState<Variant | null>(null);
  const { understanding, modules, recreatePrompt, model } = state.spec;
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-violet-50">Style spec</h2>
        {state.cost && (
          <span className="text-xs text-emerald-300">{state.cost}</span>
        )}
      </div>

      <section className="space-y-1">
        <h3 className="text-xs uppercase tracking-wide text-slate-500">
          the look
        </h3>
        <div className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-4 text-sm text-slate-200 whitespace-pre-wrap">
          {understanding || (
            <span className="text-slate-500">
              …the agent is distilling the spec…
            </span>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-slate-500">
          sections
        </h3>
        {modules.map((m) => (
          <div
            key={m.key}
            className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-3 space-y-1"
          >
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={m.on}
                onChange={(e) =>
                  send({
                    type: "spec.module",
                    key: m.key,
                    on: e.target.checked,
                  })
                }
              />
              {m.label}
            </label>
            {m.on && m.content && (
              <p className="text-xs text-slate-400 whitespace-pre-wrap pl-6">
                {m.content}
              </p>
            )}
          </div>
        ))}
      </section>

      {recreatePrompt && (
        <section className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-slate-500">
            recreate prompt{model && ` · ${model}`}
          </h3>
          <pre className="bg-[#140f1d] border border-[#2a2238] rounded-lg p-3 text-xs text-slate-300 whitespace-pre-wrap">
            {recreatePrompt}
          </pre>
        </section>
      )}

      {state.variants.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wide text-slate-500">
            pick the canonical image
          </h3>
          <div className="grid grid-cols-3 gap-3">
            {state.variants.map((v) => (
              <div
                key={v.id}
                className={`rounded-lg overflow-hidden border-2 ${v.canonical ? "border-violet-500" : "border-transparent"}`}
              >
                <button
                  type="button"
                  onClick={() => setZoom(v)}
                  className="block w-full cursor-zoom-in"
                >
                  <img
                    src={v.src}
                    alt={v.label || v.prompt}
                    className="w-full h-28 object-cover"
                  />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    send({
                      type: "variant.canonical",
                      id: v.id,
                      canonical: !v.canonical,
                    })
                  }
                  className={`w-full text-xs py-1 ${v.canonical ? "bg-violet-600 text-white" : "bg-[#1b1626] text-slate-300"}`}
                >
                  {v.canonical ? "★ canonical" : "set canonical"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={() => send({ type: "submit" })}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-emerald-600 text-white"
      >
        Finish &amp; hand back the spec
      </button>

      {zoom && (
        <Lightbox
          src={zoom.src}
          alt={zoom.label || zoom.prompt}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Route it in PhaseRouter**

Add `import { Spec } from "./Spec";` and, in `renderPhase`'s switch:

```tsx
    case "spec":
      return <Spec state={state} send={send} />;
```

Change the `default` case (no longer needed — all six phases are migrated) to
return `null`:

```tsx
    default:
      return null;
```

- [ ] **Step 3: Bundle check**

Run `bun test` (12 pass) and the serve/bundle check (curl `/` → 200). All six
phases now compile into the bundle.

- [ ] **Step 4: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/phases/Spec.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git add plugins/spellbook/skills/glamour/surface/phases/Spec.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git commit -m "feat(glamour): Spec phase (modules, recreate prompt, canonical selection)"
```

---

### Task 6: FeedbackBar (FEAT-3) + terminal-handoff banner (FEAT-2)

**Files:**

- Create: `surface/components/FeedbackBar.tsx`
- Modify: `surface/phases/PhaseRouter.tsx` (mount FeedbackBar + handoff banner)

- [ ] **Step 1: Write the FeedbackBar component**

```tsx
// surface/components/FeedbackBar.tsx
import { useState } from "react";
import type { ClientToServer, Phase } from "../state/types";

// FEAT-3: always-on, non-terminating feedback channel. Sends a `note` to the
// agent tagged with the current phase (breadcrumb) + correct/augment mode.
// Does NOT end the session. Server echoes it into the narration feed.
export function FeedbackBar({
  phase,
  send,
}: {
  phase: Phase;
  send: (m: ClientToServer) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"correct" | "augment">("augment");
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ type: "note", text: t, scope: phase, mode });
    setText("");
    setOpen(false);
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-3 right-3 z-40 text-xs px-3 py-2 rounded-full font-medium bg-violet-600 text-white shadow-lg"
      >
        ✎ feedback
      </button>
    );
  }
  return (
    <div className="fixed bottom-3 right-3 z-40 w-72 bg-[#1b1626] border border-[#2e2640] rounded-xl p-3 space-y-2 shadow-xl">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-500">note · {phase}</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-slate-500 text-xs"
        >
          ✕
        </button>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("augment")}
          className={`text-[11px] px-2 py-1 rounded border ${mode === "augment" ? "bg-violet-600 text-white border-violet-600" : "border-[#2e2640] text-slate-300"}`}
        >
          yes, and…
        </button>
        <button
          type="button"
          onClick={() => setMode("correct")}
          className={`text-[11px] px-2 py-1 rounded border ${mode === "correct" ? "bg-amber-600 text-white border-amber-600" : "border-[#2e2640] text-slate-300"}`}
        >
          not quite
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="a note to the agent — bug, idea, steer…"
        className="w-full bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 text-xs text-slate-200 outline-none"
        rows={3}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        className="w-full text-xs px-3 py-1.5 rounded-lg font-medium bg-violet-600 text-white disabled:opacity-40"
      >
        send
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Mount the banner + bar in PhaseRouter**

Add `import { FeedbackBar } from "../components/FeedbackBar";`. Update the
`PhaseRouter` return so the handoff banner renders above the connection banner,
and the FeedbackBar mounts after the NarrationFeed:

```tsx
return (
  <div className="min-h-screen">
    {state.handoff && (
      <div className="bg-violet-700/80 text-violet-50 text-sm px-4 py-2 text-center font-medium">
        ↪ {state.handoff}
      </div>
    )}
    {connectionStatus !== "open" && (
      <div className="bg-amber-700/40 text-amber-100 text-xs px-3 py-1">
        {connectionStatus}…
      </div>
    )}
    {renderPhase(state, send)}
    {state.narration.length > 0 && <div className="h-40" aria-hidden />}
    <NarrationFeed items={state.narration} />
    <FeedbackBar phase={state.phase} send={send} />
  </div>
);
```

- [ ] **Step 3: Bundle check**

Run `bun test` (12 pass) and the serve/bundle check (curl `/` → 200).

- [ ] **Step 4: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
npx prettier --write plugins/spellbook/skills/glamour/surface/components/FeedbackBar.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git add plugins/spellbook/skills/glamour/surface/components/FeedbackBar.tsx plugins/spellbook/skills/glamour/surface/phases/PhaseRouter.tsx
git commit -m "feat(glamour): always-on FeedbackBar (FEAT-3) + terminal-handoff banner (FEAT-2)"
```

---

### Task 7: Retire the dormant `template.html` + sync docs

**Files:**

- Delete: `scripts/template.html`
- Modify (if any stale reference exists): `scripts/server.ts`, `scripts/cli.ts`

- [ ] **Step 1: Confirm nothing references it**

Run:
`cd /Users/colereed/Projects/Spellbook && grep -rn "template.html" plugins/spellbook/skills/glamour`
Expected: matches only inside `scripts/template.html` itself (the file content).
If any `.ts` references it, that is dead code from before Plan 1 — remove the
referencing lines. (Server has served the Bun bundle via the `index` HTML import
since Plan 1, so there should be none.)

- [ ] **Step 2: Delete the file**

```bash
cd /Users/colereed/Projects/Spellbook
git rm plugins/spellbook/skills/glamour/scripts/template.html
```

- [ ] **Step 3: Run the full suite + final bundle check**

Run: `cd plugins/spellbook/skills/glamour && bun test` (12 pass) and the
serve/bundle check (curl `/` → 200, then `bun cli.ts close`).

- [ ] **Step 4: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
git commit -m "chore(glamour): remove dormant template.html (React bundle is the surface)"
```

---

## Self-Review

**Spec coverage (Plan 3 portion):**

- Variants phase (grid, round grouping UX-4, like, lightbox UX-5, cost FEAT-4) ✓
  (Tasks 3 + 4).
- Spec phase (modules-with-content, recreate prompt, canonical selection UX-6) ✓
  (Tasks 3 + 5).
- Variant image optimization (state-bloat fix) ✓ (Task 1).
- In-surface FeedbackBar FEAT-3 ✓ + terminal-handoff FEAT-2 ✓ (Task 6).
- Dismissable overlay BUG-2 ✓ (Lightbox, Task 3).
- Retire template.html ✓ (Task 7).

**Deliberately deferred (documented in Scope note):** feedback-event
consolidation (additive `note` instead); sweeping controlled-input refactor;
structured per-job cost ledger (single display string instead).

**Placeholder scan:** every step has complete code or a concrete command; no
TBD/TODO.

**Type consistency:**

- `optimizeVariantSrc` / `applyCanonical` names match between server export
  (Tasks 1, 2) and test imports.
- `note` carries `{ text, scope: Phase, mode: "correct" | "augment" }` in the
  contract (Task 2 Step 1), the server handler (Task 2 Step 4), and the
  FeedbackBar send (Task 6 Step 1).
- `cost` / `handoff` are `string` on `GlamourState`, set by the matching agent
  commands and read by Variants/Spec (`state.cost`) and PhaseRouter
  (`state.handoff`).
- All phase components use `PhaseProps` (`{ state, send }`).
- Every `send(...)` uses an existing/extended `ClientToServer` member
  (`variant.like`, `variant.canonical`, `steer`, `spec.module`, `nudge`,
  `submit`, `note`).

**PhaseRouter is edited by Tasks 4, 5, 6** — each adds one switch case or mounts
one element; the final state routes all six phases (`default` → `null`) and
mounts the handoff banner + FeedbackBar.
