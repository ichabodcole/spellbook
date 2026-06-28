# Glamour v2 — Slice 3: Generation + Focus Lens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add probe generation (agent posts media-forge results as first-class
`gen` items with round/batch grouping + typed per-generation metadata) and the
zoom/focus co-presence lens (full gallery → focused mini-gallery → enlarged
single, scoped by either party, with an agent contextual-ask drawer and
prev/next + arrow-key traversal) to glamour-v2.

**Architecture:** Generation stays **entirely agent-side** — the daemon never
calls media-forge. The agent shells out to the `media-forge` CLI, then posts
each result to the daemon via a new `gen.add` agent command carrying the image
(as an optimized data-URL) + typed `GenMeta` (`model`, `prompt`, `seed`, `cost`,
`custom`, `round`). The human "ask for a batch" is a `generate` **imperative**
(emits a `generate` agent event carrying the grounding set). The **focus lens**
is pure surface state on `GlamourState` (`scope` / `focusSet` / `focusOwner` /
`focusNote`); human focus is **ambient** (`focus.set` / `focus.clear`), the
agent pushes focus via `focus.push` (agent-origin, no event), which opens a
violet contextual-ask drawer. Image optimization moves to the **server/CLI**
side (the agent has no `<canvas>`) via the existing `optimizeImageBuffer`
(`Bun.Image`).

**Tech Stack:** Bun ≥ 1.3.14 (`Bun.Image` for server/CLI image optimization),
React 19 (bundled by Bun), bun-plugin-tailwind, Tailwind v4 (CSS-first),
lucide-react. External tool dependency: the `media-forge` CLI (agent-side only —
no code in this repo calls it; the daemon only receives results). No new npm
dependencies.

## Global Constraints

- v2 lives at `plugins/spellbook/skills/glamour-v2/`; it stays **unlisted** (no
  `SKILL.md`, not in any synced listing) until the post-Slice-4 cutover. **V1
  (`plugins/spellbook/skills/glamour/`) is never touched by this slice.**
- **One shared contract:** all channels import `surface/state/types.ts`. Never
  hand-roll a message/event shape outside it.
- **`AGENT_EVENT_TYPES` is the frozen allowlist** of server→agent SSE event
  types. The only events emitted are members of this set. This slice adds
  exactly one new member: `"generate"`.
- **Ambient vs. imperative:** board moves — `item.select` / `item.star` /
  `item.like` **and the new `focus.set` / `focus.clear`** — mutate state +
  broadcast only, **no** agent event. Imperatives — `item.add`, `item.annotate`,
  `message.send`, **and the new `generate`** — also `emitEvent`. Agent-origin
  commands (`say`, `section`, `gen.add`, `gen.cost`, `focus.push`, `intent`,
  `status`) broadcast state but emit **no** agent event.
- **The daemon never calls media-forge.** Generation is agent-side, out of band.
  The daemon only receives already-produced images via `gen.add`.
- **Image optimization is server/CLI-side for gen items.** The `media-forge`
  output is a full-size raster; the CLI `gen` verb optimizes it with
  `optimizeImageBuffer` (`Bun.Image`, server/CLI-only) before posting, so the
  daemon stores an already-optimized webp data-URL (exactly as the browser drop
  path pre-optimizes via `<canvas>`). Do NOT import `imageOptimize.server.ts`
  from browser code.
- **Non-destructive library.** Round is a per-item batch index the agent stamps;
  there is **no** V1-style "clear variants" (which deleted). New batches advance
  the round number; old gen items stay (archivable later, Slice 4).
- **Purity boundary:** pure reducers in `reduce.ts` never call `Date.now()` /
  `crypto`. The server builds ids + timestamps and passes built records into
  reducers — mirror the `makeItem({ createdAt })` pattern.
- **Live Playwright e2e is mandatory and controller-run** (final task) before
  the whole-branch review — subagents have no live browser. The e2e seeds gen
  items via the CLI `gen --file` path using a tiny local fixture image (no real
  media-forge call — the daemon/CLI receive path is what's under test).
- **Formatting:** biome on changed `.ts`/`.tsx`/`.json`; prettier on `.md`.
- **Commit trailer** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Run tests with `bun test`** (not jest/vitest), from the repo root.

---

## File Structure

**Modified:**

- `surface/state/types.ts` — `GenMeta` gains `round: number`; `GlamourState`
  gains `scope` / `focusSet` / `focusOwner` / `focusNote` (+ `FocusScope` /
  `FocusOwner` types); `ClientToServer` gains `generate` / `focus.set` /
  `focus.clear`; `AgentCommand` gains `gen.add` / `gen.cost` / `focus.push`;
  `AGENT_EVENT_TYPES` gains `"generate"`; `defaultState()` seeds the focus
  fields.
- `surface/state/reduce.ts` — add `setFocus`, `clearFocus`, `setGenCost`; extend
  `applyAgentMsg` with `focus.push` + `gen.cost`; add `focus.set` /
  `focus.clear` to `AMBIENT_CLIENT`.
- `surface/state/imageOptimize.server.ts` — add `optimizeImageDataUrl(dataUrl)`
  (decode → `optimizeImageBuffer` → re-encode webp data-URL) for the CLI gen
  path.
- `scripts/server.ts` — handle `gen.add` (build gen item, materialize,
  broadcast, no event), `generate` (imperative, emit with ground), `focus.set` /
  `focus.clear` (ambient); `gen.cost` / `focus.push` ride the existing
  `applyAgentMsg` path.
- `scripts/cli.ts` — add `gen`, `gen-cost`, and `focus` verbs (+ pure builders);
  refresh `help`.
- `surface/components/LibraryGrid.tsx` — scope-aware columns (3-col all / 2-col
  focus) + filter to `focusSet` when focused; a violet "generated" badge + round
  label on gen tiles.
- `surface/components/DetailsFlyout.tsx` — show `round` in the generation
  metadata block.
- `surface/App.tsx` — wire focus state (banner, "focus these", "back to full
  library"), the agent focus drawer, the Generate button, and the enlarged
  lightbox view.

**Created:**

- `surface/components/FocusBar.tsx` — the focus banner (owner-tinted: you vs
  agent) with the zoom-out control; rendered above the grid when
  `scope==="focus"`.
- `surface/components/FocusDrawer.tsx` — the violet agent contextual-ask drawer
  (shown when `scope==="focus" && focusOwner==="agent" && focusNote`).
- `surface/components/Lightbox.tsx` — the enlarged single-image view with
  prev/next controls + left/right arrow-key traversal through the current set,
  with wrap-around.
- `tests/focus.test.ts` — (folded into `reduce.test.ts`/`cli.test.ts` instead;
  see tasks — no standalone file needed).

---

## Data-model design (what this slice locks in)

V1 mining (proposal "Mining V1"): V1's
`Variant {id, src, prompt, label, round, liked, canonical}` maps onto v2's
`LibraryItem{ kind:"gen", gen: GenMeta }` — `liked` is already `item.liked`;
`prompt`/`model`/`seed`/`cost` live in `GenMeta` (G1, captured **per
generation**, replacing V1's cumulative `cost` string); `round` moves into
`GenMeta`. V1's global `round` counter + `variants.clear` (which **deleted**)
are **dropped** — the v2 library is non-destructive, so the agent simply stamps
an incrementing `round` per batch and the UI groups by it. V1's `canonical`
(single-select) is **out of scope here** — canonical images belong to the style
guide and land in Slice 4. The focus lens + agent drawer + generated-image
metadata display come from the converged mockup.

---

### Task 1: Extend the contract (generation + focus lens)

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/state/types.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/types.test.ts`

**Interfaces:**

- Consumes: existing `ItemKind` (has `"gen"`), `GenMeta`, `GlamourState`,
  `LeanState`, `ClientToServer`, `AgentCommand`, `AGENT_EVENT_TYPES`,
  `defaultState`, `defaultStyleGuide`.
- Produces:
  - `GenMeta` gains `round: number`.
  - `type FocusScope = "all" | "focus"`
  - `type FocusOwner = "you" | "agent" | null`
  - `GlamourState` gains `scope: FocusScope`, `focusSet: string[]`,
    `focusOwner: FocusOwner`, `focusNote: string`.
  - `ClientToServer` gains `{ type: "generate" }`,
    `{ type: "focus.set"; ids: string[] }`, `{ type: "focus.clear" }`.
  - `AgentCommand` gains
    `{ type: "gen.add"; src: string; prompt: string; model: string; round: number; seed?: number; cost?: number; label?: string; custom?: Record<string, string> }`,
    `{ type: "gen.cost"; id: string; cost: number }`,
    `{ type: "focus.push"; ids: string[]; note?: string }`.
  - `AGENT_EVENT_TYPES` gains `"generate"`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_EVENT_TYPES, defaultState } from "../surface/state/types";

describe("Slice 3 contract", () => {
  test("defaultState seeds an unfocused lens", () => {
    const s = defaultState("t", "i");
    expect(s.scope).toBe("all");
    expect(s.focusSet).toEqual([]);
    expect(s.focusOwner).toBeNull();
    expect(s.focusNote).toBe("");
  });

  test("generate is the only new agent event; focus moves stay ambient", () => {
    expect(AGENT_EVENT_TYPES).toContain("generate");
    expect(AGENT_EVENT_TYPES).not.toContain("focus.set");
    expect(AGENT_EVENT_TYPES).not.toContain("focus.clear");
    expect(AGENT_EVENT_TYPES).not.toContain("focus.push");
    expect(AGENT_EVENT_TYPES).not.toContain("gen.add");
    expect(AGENT_EVENT_TYPES).not.toContain("gen.cost");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/types.test.ts`
Expected: FAIL — `s.scope` is undefined; `"generate"` not in the allowlist.

- [ ] **Step 3: Implement the contract additions**

In `surface/state/types.ts`, add `round` to `GenMeta`:

```ts
export type GenMeta = {
  model: string;
  prompt: string;
  seed: number | null;
  cost: number | null;
  custom: Record<string, string>;
  round: number; // batch index the agent stamps; UI groups gen items by it
};
```

Add the focus-lens types (place near the other type aliases, before
`GlamourState`):

```ts
// The zoom/focus co-presence lens. Either party can scope the set.
export type FocusScope = "all" | "focus";
export type FocusOwner = "you" | "agent" | null;
```

Extend `GlamourState`:

```ts
export type GlamourState = {
  title: string;
  intent: string;
  library: LibraryItem[];
  selectedIds: string[];
  messages: Message[];
  styleGuide: StyleSection[];
  scope: FocusScope;
  focusSet: string[]; // item ids in the focused set; empty when scope === "all"
  focusOwner: FocusOwner; // who scoped the focus
  focusNote: string; // agent's contextual question for the focus drawer; "" otherwise
  status: { busy: boolean; text: string };
};
```

Extend `ClientToServer` (add after `message.send`):

```ts
  | { type: "generate" } // imperative — emits a generate event carrying the grounding set
  | { type: "focus.set"; ids: string[] } // ambient — human scopes a focus set
  | { type: "focus.clear" }; // ambient — human zooms back out
```

Extend `AgentCommand` (add before `status`):

```ts
  | {
      type: "gen.add";
      src: string; // an ALREADY-optimized webp data-URL (CLI does the optimization)
      prompt: string;
      model: string;
      round: number;
      seed?: number;
      cost?: number;
      label?: string;
      custom?: Record<string, string>;
    }
  | { type: "gen.cost"; id: string; cost: number } // backfill cost once media-forge finalizes it
  | { type: "focus.push"; ids: string[]; note?: string } // agent scopes a focus set + asks
```

Add `"generate"` to the frozen allowlist (before `"closed"`):

```ts
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "item.add",
  "item.annotate",
  "message.user",
  "generate",
  "closed",
] as const);
```

Seed the focus fields in `defaultState()` (add alongside the existing fields):

```ts
    scope: "all",
    focusSet: [],
    focusOwner: null,
    focusNote: "",
```

> `LeanState`/`LeanItem` need no change — the new scalar/array fields aren't
> omitted, so they flow through the lean projection automatically.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/types.test.ts`
Expected: PASS (new + existing type tests green).

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/state/types.ts \
        plugins/spellbook/skills/glamour-v2/tests/types.test.ts
git commit -m "feat(glamour-v2): extend contract with generation metadata + focus lens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Focus + gen-cost reducers

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`

**Interfaces:**

- Consumes: `GlamourState`, `FocusOwner`, `AgentCommand` (Task 1).
- Produces:
  - `setFocus(state, ids: string[], owner: "you" | "agent", note?: string): void`
    — `scope="focus"`, `focusSet=[...ids]`, `focusOwner=owner`,
    `focusNote=note ?? ""`.
  - `clearFocus(state): void` — `scope="all"`, `focusSet=[]`, `focusOwner=null`,
    `focusNote=""`.
  - `setGenCost(state, id: string, cost: number): boolean` — sets `it.gen.cost`
    on a gen item; `false` if no such item or it has no `gen`.
  - `applyAgentMsg` gains `focus.push` (→ `setFocus(state, ids, "agent", note)`)
    and `gen.cost` (→ `setGenCost`).
  - `AMBIENT_CLIENT` gains `"focus.set"` and `"focus.clear"`.

> `gen.add` is server-handled (builds id/ts + optimizes/materializes) — it is
> NOT in `applyAgentMsg`. `focus.push` and `gen.cost` are pure → they belong
> here.

- [ ] **Step 1: Write the failing tests**

Add to `tests/reduce.test.ts`:

```ts
import {
  applyAgentMsg,
  clearFocus,
  setFocus,
  setGenCost,
} from "../surface/state/reduce";
import { defaultState } from "../surface/state/types";

describe("focus + gen-cost reducers", () => {
  test("setFocus scopes the lens with owner + note; clearFocus resets it", () => {
    const s = defaultState("t", "i");
    setFocus(s, ["g1", "g2"], "agent", "which reads most like X?");
    expect(s.scope).toBe("focus");
    expect(s.focusSet).toEqual(["g1", "g2"]);
    expect(s.focusOwner).toBe("agent");
    expect(s.focusNote).toBe("which reads most like X?");
    clearFocus(s);
    expect(s.scope).toBe("all");
    expect(s.focusSet).toEqual([]);
    expect(s.focusOwner).toBeNull();
    expect(s.focusNote).toBe("");
  });

  test("setFocus defaults note to empty string", () => {
    const s = defaultState("t", "i");
    setFocus(s, ["g1"], "you");
    expect(s.focusNote).toBe("");
  });

  test("setGenCost updates a gen item's cost; false for unknown/non-gen", () => {
    const s = defaultState("t", "i");
    s.library.push({
      id: "gen-1",
      kind: "gen",
      title: "r1",
      src: "",
      path: "",
      text: "",
      mime: "image/webp",
      tags: [],
      starred: false,
      liked: false,
      annotations: { agent: "", human: "" },
      archived: false,
      createdAt: 1,
      gen: {
        model: "m",
        prompt: "p",
        seed: null,
        cost: null,
        custom: {},
        round: 1,
      },
    });
    expect(setGenCost(s, "gen-1", 0.011)).toBe(true);
    expect(s.library[0].gen?.cost).toBe(0.011);
    expect(setGenCost(s, "nope", 0.5)).toBe(false);
  });

  test("applyAgentMsg routes focus.push and gen.cost", () => {
    const s = defaultState("t", "i");
    applyAgentMsg(s, { type: "focus.push", ids: ["a"], note: "pick one" });
    expect(s.scope).toBe("focus");
    expect(s.focusOwner).toBe("agent");
    expect(s.focusNote).toBe("pick one");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`
Expected: FAIL — `setFocus` / `clearFocus` / `setGenCost` not exported.

- [ ] **Step 3: Implement the reducers**

In `surface/state/reduce.ts`, extend the type import with `FocusOwner`, then add
(place after `updateSection`):

```ts
export function setFocus(
  state: GlamourState,
  ids: string[],
  owner: "you" | "agent",
  note = ""
): void {
  state.scope = "focus";
  state.focusSet = [...ids];
  state.focusOwner = owner;
  state.focusNote = note;
}

export function clearFocus(state: GlamourState): void {
  state.scope = "all";
  state.focusSet = [];
  state.focusOwner = null;
  state.focusNote = "";
}

export function setGenCost(
  state: GlamourState,
  id: string,
  cost: number
): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it || !it.gen) return false;
  it.gen.cost = cost;
  return true;
}
```

Add two cases to `applyAgentMsg` (alongside `section`):

```ts
    case "focus.push":
      setFocus(state, msg.ids, "agent", msg.note ?? "");
      break;
    case "gen.cost":
      setGenCost(state, msg.id, msg.cost);
      break;
```

Extend `AMBIENT_CLIENT`:

```ts
export const AMBIENT_CLIENT = new Set<string>([
  "item.select",
  "item.star",
  "item.like",
  "focus.set",
  "focus.clear",
]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts \
        plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts
git commit -m "feat(glamour-v2): focus + gen-cost reducers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Server/CLI data-URL optimization helper

**Files:**

- Modify:
  `plugins/spellbook/skills/glamour-v2/surface/state/imageOptimize.server.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/imageOptimize.test.ts`

**Interfaces:**

- Consumes: existing
  `optimizeImageBuffer(input: Uint8Array): Promise<{ data: Uint8Array; mime: "image/webp" }>`.
- Produces: `optimizeImageDataUrl(dataUrl: string): Promise<string>` — decodes a
  `data:image/...;base64,...` URL, optimizes the bytes, returns a
  `data:image/webp;base64,...` URL. Throws if the input isn't a base64 data-URL.

> This is what the CLI `gen` verb uses to turn a full-size media-forge image
> into a stored-ready optimized data-URL (the agent has no `<canvas>`).

- [ ] **Step 1: Write the failing test**

Add to `tests/imageOptimize.test.ts` (reuse the suite's existing pattern for
producing a real raster — if it already builds a PNG buffer for the
`optimizeImageBuffer` test, reuse that helper to make the data-URL):

```ts
import { optimizeImageDataUrl } from "../surface/state/imageOptimize.server";

test("optimizeImageDataUrl returns a webp data-URL from a raster data-URL", async () => {
  // Build a small real PNG via Bun.Image (or reuse the suite's existing fixture).
  const png = await new Bun.Image(
    // 2x2 red PNG, base64
    Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP8z8Dwn4EIwDiqEAAlYwQ/4n9V0wAAAABJRU5ErkJggg=="
      ),
      (c) => c.charCodeAt(0)
    )
  )
    .png()
    .bytes();
  const inputDataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;

  const out = await optimizeImageDataUrl(inputDataUrl);
  expect(out.startsWith("data:image/webp;base64,")).toBe(true);
  // round-trips to decodable webp bytes
  const b64 = out.slice("data:image/webp;base64,".length);
  expect(b64.length).toBeGreaterThan(0);
});

test("optimizeImageDataUrl rejects a non-data-URL", async () => {
  await expect(
    optimizeImageDataUrl("https://example.com/x.png")
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/imageOptimize.test.ts`
Expected: FAIL — `optimizeImageDataUrl` not exported.

- [ ] **Step 3: Implement the helper**

Append to `surface/state/imageOptimize.server.ts`:

```ts
// Decode a base64 data-URL, optimize the raster, re-encode as a webp data-URL.
// Used by the CLI `gen` verb (the agent posts a media-forge image with no
// browser <canvas> available). Throws on a non-base64-data-URL input.
export async function optimizeImageDataUrl(dataUrl: string): Promise<string> {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("optimizeImageDataUrl: expected a base64 data-URL");
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  const { data } = await optimizeImageBuffer(bytes);
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return `data:image/webp;base64,${btoa(bin)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/imageOptimize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/state/imageOptimize.server.ts \
        plugins/spellbook/skills/glamour-v2/tests/imageOptimize.test.ts
git commit -m "feat(glamour-v2): optimizeImageDataUrl for the server/CLI gen path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Server wiring — gen.add, generate, focus

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/scripts/server.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`

**Interfaces:**

- Consumes: `addItem`, `makeItem`, `applyAgentMsg` (now handling
  `focus.push`/`gen.cost`), `setFocus`, `clearFocus` (Task 2);
  `materializeItem`; `randHex`, `broadcast`, `broadcastState`, `emitEvent`.
- Produces (browser + agent observable behavior):
  - POST
    `/cmd { type:"gen.add", src, prompt, model, round, seed?, cost?, label?, custom? }`
    → builds a `kind:"gen"` `LibraryItem` with a full `GenMeta`, materializes
    it, broadcasts. Emits **no** agent event (agent-origin).
  - WS `{ type:"generate" }` → emits
    `emitEvent({ type:"generate", ground: [...selectedIds] })`. No state change.
  - WS `{ type:"focus.set", ids }` → `setFocus(state, ids, "you")` + broadcast,
    no event. WS `{ type:"focus.clear" }` → `clearFocus(state)` + broadcast, no
    event.
  - `gen.cost` / `focus.push` ride the existing `applyAgentMsg` +
    `broadcastState` path already in `handleAgentMsg` (no event).

- [ ] **Step 1: Write the failing tests**

Add to `tests/daemon.integration.test.ts` (reuse the file's existing
`drainEvents` helper from Slice 2):

```ts
test("gen.add creates a kind:gen item with full metadata; emits no event", async () => {
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "gen.add",
      src: "data:image/webp;base64,AAAA",
      prompt: "indigo twilight, vine framing",
      model: "nano-banana",
      round: 1,
      seed: 42817,
      label: "r1 · A",
    }),
  });
  await Bun.sleep(60);
  const s = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { kind: string; gen: Record<string, unknown> | null }[] };
  };
  const gen = s.state.library.find((i) => i.kind === "gen");
  expect(gen).toBeTruthy();
  expect(gen?.gen?.model).toBe("nano-banana");
  expect(gen?.gen?.round).toBe(1);
  expect(gen?.gen?.seed).toBe(42817);
  // agent-origin → no event for gen.add
  const events = await drainEvents(base, 0, "__never__", 250);
  expect(events).not.toContain('"type":"gen.add"');
});

test("gen.cost backfills an existing gen item's cost", async () => {
  const s0 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string; kind: string }[] };
  };
  const id = s0.state.library.find((i) => i.kind === "gen")?.id as string;
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({ type: "gen.cost", id, cost: 0.011 }),
  });
  await Bun.sleep(50);
  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string; gen: { cost: number } | null }[] };
  };
  expect(s1.state.library.find((i) => i.id === id)?.gen?.cost).toBe(0.011);
});

test("generate emits a generate event carrying the grounding set; focus moves are ambient", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  ws.send(
    JSON.stringify({
      type: "item.add",
      item: { kind: "ref", title: "r.png", src: "data:image/webp;base64,AAAA" },
    })
  );
  await Bun.sleep(120);
  const lib = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string; kind: string }[] };
  };
  const refId = lib.state.library.find((i) => i.kind === "ref")?.id as string;
  ws.send(JSON.stringify({ type: "item.select", ids: [refId] }));
  await Bun.sleep(40);
  ws.send(JSON.stringify({ type: "generate" }));
  const ev = await drainEvents(base, 0, '"type":"generate"');
  expect(ev).toContain('"type":"generate"');
  expect(ev).toContain(`"ground":["${refId}"]`);

  // focus.set / focus.clear mutate state but emit no event
  ws.send(JSON.stringify({ type: "focus.set", ids: [refId] }));
  await Bun.sleep(40);
  const sf = (await (await fetch(`${base}/state`)).json()) as {
    state: { scope: string; focusSet: string[]; focusOwner: string | null };
  };
  expect(sf.state.scope).toBe("focus");
  expect(sf.state.focusOwner).toBe("you");
  const after = await drainEvents(base, 0, "__never__", 250);
  expect(after).not.toContain('"type":"focus.set"');
  ws.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`bun test plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`
Expected: FAIL — `gen.add` does nothing; `generate`/`focus.set` unhandled.

- [ ] **Step 3: Implement the server wiring**

In `scripts/server.ts`:

(a) Extend the `reduce` import block with `clearFocus`, `setFocus`:

```ts
import {
  addItem,
  addMessage,
  annotate,
  applyAgentMsg,
  clearFocus,
  leanItem,
  leanState,
  makeItem,
  selectItems,
  setFocus,
  setLike,
  setStar,
} from "../surface/state/reduce";
```

(b) Handle `gen.add` in `handleAgentMsg` (before the `applyAgentMsg`
fall-through; it builds id/ts + materializes, so it can't be a pure reducer):

```ts
if (msg.type === "gen.add") {
  const it = makeItem({
    id: `gen-${randHex(4)}`,
    kind: "gen",
    title: msg.label ?? `round ${msg.round}`,
    src: msg.src,
    mime: "image/webp",
    createdAt: Date.now(),
    gen: {
      model: msg.model,
      prompt: msg.prompt,
      seed: msg.seed ?? null,
      cost: msg.cost ?? null,
      custom: msg.custom ?? {},
      round: msg.round,
    },
  });
  materializeItem(sessionFilesDir, it);
  if (addItem(state, it)) broadcastState();
  return;
}
```

> `gen.cost` and `focus.push` need no special-casing — they fall through to the
> existing `applyAgentMsg(state, msg); broadcastState();` tail of
> `handleAgentMsg`.

(c) Handle the three new client messages in `handleClientMsg`:

```ts
      case "generate":
        emitEvent({ type: "generate", ground: [...state.selectedIds] });
        break;
      case "focus.set":
        setFocus(state, msg.ids, "you");
        broadcastState();
        break;
      case "focus.clear":
        clearFocus(state);
        broadcastState();
        break;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`bun test plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `bun test plugins/spellbook/skills/glamour-v2/` Expected: PASS — no
regressions.

- [ ] **Step 6: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/scripts/server.ts \
        plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts
git commit -m "feat(glamour-v2): gen.add receive path, generate imperative, focus moves

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: CLI — gen, gen-cost, focus verbs

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/scripts/cli.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/cli.test.ts`

**Interfaces:**

- Consumes: `parseArgs`, `postCmd`, `optimizeImageDataUrl` (Task 3).
- Produces:
  - `parseCustom(s: string | boolean | undefined): Record<string, string> | undefined`
    — parses `"k=v,k2=v2"` into a record; `undefined` if absent.
  - `buildGenCmd(src: string, flags): { type:"gen.add"; src; prompt; model; round; seed?; cost?; label?; custom? }`
    — pure; assembles the command from a resolved `src` + flags.
  - `buildGenCostCmd(pos, flags): { type:"gen.cost"; id; cost }`.
  - `buildFocusCmd(pos, flags): { type:"focus.push"; ids; note? }`.
  - Verbs:
    `gen (--url|--file|--src) --prompt --model --round [--seed] [--cost] [--label] [--custom k=v,..]`;
    `gen-cost <id> --cost <n>`; `focus <id...> [--note ..]`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/cli.test.ts`:

```ts
import {
  buildFocusCmd,
  buildGenCmd,
  buildGenCostCmd,
  parseArgs,
  parseCustom,
} from "../scripts/cli";

describe("slice 3 cli builders", () => {
  test("buildGenCmd assembles gen.add with parsed numerics + custom", () => {
    const { flags } = parseArgs([
      "--prompt",
      "indigo twilight",
      "--model",
      "nano-banana",
      "--round",
      "2",
      "--seed",
      "42817",
      "--cost",
      "0.011",
      "--label",
      "r2 · A",
      "--custom",
      "guidance=7,steps=30",
    ]);
    expect(buildGenCmd("data:image/webp;base64,ZZ", flags)).toEqual({
      type: "gen.add",
      src: "data:image/webp;base64,ZZ",
      prompt: "indigo twilight",
      model: "nano-banana",
      round: 2,
      seed: 42817,
      cost: 0.011,
      label: "r2 · A",
      custom: { guidance: "7", steps: "30" },
    });
  });

  test("buildGenCmd omits absent optionals", () => {
    const { flags } = parseArgs([
      "--prompt",
      "p",
      "--model",
      "m",
      "--round",
      "1",
    ]);
    expect(buildGenCmd("data:image/webp;base64,ZZ", flags)).toEqual({
      type: "gen.add",
      src: "data:image/webp;base64,ZZ",
      prompt: "p",
      model: "m",
      round: 1,
    });
  });

  test("buildGenCostCmd parses id + numeric cost", () => {
    const { pos, flags } = parseArgs(["gen-7", "--cost", "0.02"]);
    expect(buildGenCostCmd(pos, flags)).toEqual({
      type: "gen.cost",
      id: "gen-7",
      cost: 0.02,
    });
  });

  test("buildFocusCmd takes positional ids + optional note", () => {
    const { pos, flags } = parseArgs([
      "g1",
      "g2",
      "--note",
      "which reads most like X?",
    ]);
    expect(buildFocusCmd(pos, flags)).toEqual({
      type: "focus.push",
      ids: ["g1", "g2"],
      note: "which reads most like X?",
    });
  });

  test("parseCustom splits k=v pairs; undefined when absent", () => {
    expect(parseCustom("a=1,b=2")).toEqual({ a: "1", b: "2" });
    expect(parseCustom(undefined)).toBeUndefined();
    expect(parseCustom(true)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/cli.test.ts` Expected:
FAIL — builders not exported.

- [ ] **Step 3: Implement the builders + verbs**

In `scripts/cli.ts`, add (near the other builders; export all):

```ts
export function parseCustom(
  v: string | boolean | undefined
): Record<string, string> | undefined {
  if (typeof v !== "string") return undefined;
  const out: Record<string, string> = {};
  for (const pair of v.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function buildGenCmd(
  src: string,
  flags: Record<string, string | boolean>
): {
  type: "gen.add";
  src: string;
  prompt: string;
  model: string;
  round: number;
  seed?: number;
  cost?: number;
  label?: string;
  custom?: Record<string, string>;
} {
  const cmd: ReturnType<typeof buildGenCmd> = {
    type: "gen.add",
    src,
    prompt: typeof flags.prompt === "string" ? flags.prompt : "",
    model: typeof flags.model === "string" ? flags.model : "",
    round:
      typeof flags.round === "string" ? Number.parseInt(flags.round, 10) : 0,
  };
  if (typeof flags.seed === "string")
    cmd.seed = Number.parseInt(flags.seed, 10);
  if (typeof flags.cost === "string") cmd.cost = Number.parseFloat(flags.cost);
  if (typeof flags.label === "string") cmd.label = flags.label;
  const custom = parseCustom(flags.custom);
  if (custom) cmd.custom = custom;
  return cmd;
}

export function buildGenCostCmd(
  pos: string[],
  flags: Record<string, string | boolean>
): { type: "gen.cost"; id: string; cost: number } {
  return {
    type: "gen.cost",
    id: pos[0],
    cost:
      typeof flags.cost === "string"
        ? Number.parseFloat(flags.cost)
        : Number.NaN,
  };
}

export function buildFocusCmd(
  pos: string[],
  flags: Record<string, string | boolean>
): { type: "focus.push"; ids: string[]; note?: string } {
  const cmd: { type: "focus.push"; ids: string[]; note?: string } = {
    type: "focus.push",
    ids: pos,
  };
  if (typeof flags.note === "string") cmd.note = flags.note;
  return cmd;
}

// Resolve a gen image source to an OPTIMIZED webp data-URL (the daemon stores
// it as-is). --url downloads; --file reads; --src is an existing data-URL.
async function resolveGenSrc(
  flags: Record<string, string | boolean>
): Promise<string> {
  if (typeof flags.url === "string") {
    const res = await fetch(flags.url);
    if (!res.ok) die(`gen: failed to fetch --url (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const mime = res.headers.get("content-type") ?? "image/png";
    return optimizeImageDataUrl(`data:${mime};base64,${btoa(bin)}`);
  }
  if (typeof flags.file === "string") {
    const bytes = new Uint8Array(await Bun.file(flags.file).arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return optimizeImageDataUrl(`data:image/png;base64,${btoa(bin)}`);
  }
  if (typeof flags.src === "string") return optimizeImageDataUrl(flags.src);
  die("gen: one of --url, --file, or --src is required");
}
```

Add the imports at the top of `cli.ts`:

```ts
import { optimizeImageDataUrl } from "../surface/state/imageOptimize.server";
```

Wire the verbs in `main`'s switch:

```ts
    case "gen": {
      if (!flags.prompt || !flags.model || !flags.round)
        die("usage: gen (--url|--file|--src) --prompt .. --model .. --round N [--seed N] [--cost N] [--label ..] [--custom k=v,..]");
      const src = await resolveGenSrc(flags);
      await postCmd(session, buildGenCmd(src, flags));
      break;
    }
    case "gen-cost":
      if (!pos.length || typeof flags.cost !== "string")
        die("usage: gen-cost <id> --cost <n>");
      await postCmd(session, buildGenCostCmd(pos, flags));
      break;
    case "focus":
      if (!pos.length) die("usage: focus <id...> [--note ..]");
      await postCmd(session, buildFocusCmd(pos, flags));
      break;
```

Refresh `HELP` with the three verbs:

```ts
  gen    (--url|--file|--src) --prompt .. --model .. --round N [--seed N] [--cost N] [--label ..] [--custom k=v,..]
                                     post a generated image (optimized client-side)
  gen-cost <id> --cost <n>           backfill a generated image's cost
  focus  <id...> [--note ..]         scope the focus lens to these items + ask
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/cli.test.ts` Expected:
PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/scripts/cli.ts \
        plugins/spellbook/skills/glamour-v2/tests/cli.test.ts
git commit -m "feat(glamour-v2): gen, gen-cost, and focus CLI verbs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Focus-lens surface — FocusBar, FocusDrawer, scope-aware grid, gen tile

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/components/FocusBar.tsx`
- Create:
  `plugins/spellbook/skills/glamour-v2/surface/components/FocusDrawer.tsx`
- Modify:
  `plugins/spellbook/skills/glamour-v2/surface/components/LibraryGrid.tsx`

**Interfaces:**

- `FocusBar({ owner, count, note, onZoomOut }: { owner: FocusOwner; count: number; note: string; onZoomOut: () => void })`
  — the focus banner; owner-tinted (violet for agent, fuchsia for you) with a
  "back to full library" control. Renders nothing if `owner` is null.
- `FocusDrawer({ note, count }: { note: string; count: number })` — the violet
  agent contextual-ask drawer; renders nothing if `note` is empty.
- `LibraryGrid` gains two props: `scope: FocusScope` and `focusSet: string[]`.
  When `scope==="focus"`, it shows only `focusSet` items in a 2-column grid;
  otherwise the existing faceted 3-column grid. Gen tiles get a violet
  "generated" badge + a "round N" label.

> Build-check only (no live browser in a subagent). Live behavior is the
> controller's e2e (final task).

- [ ] **Step 1: Implement `FocusBar.tsx`**

```tsx
import { Crosshair, Grid3x3 } from "lucide-react";
import type { FocusOwner } from "../state/types";

export function FocusBar({
  owner,
  count,
  note,
  onZoomOut,
}: {
  owner: FocusOwner;
  count: number;
  note: string;
  onZoomOut: () => void;
}) {
  if (!owner) return null;
  const tint =
    owner === "agent"
      ? "bg-violet-600/25 text-violet-200 border-violet-500/40"
      : "bg-fuchsia-600/20 text-fuchsia-200 border-fuchsia-500/40";
  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-4 py-1.5 text-xs">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${tint}`}
      >
        <Crosshair className="h-3.5 w-3.5" />
        {owner === "agent" ? "Agent focused" : "You focused"} · {count} item
        {count === 1 ? "" : "s"}
      </span>
      {note && (
        <span className="text-[11px] italic text-slate-400">{note}</span>
      )}
      <button
        type="button"
        onClick={onZoomOut}
        className="ml-auto flex items-center gap-1 rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-slate-500 hover:text-white"
      >
        <Grid3x3 className="h-3 w-3" /> back to full library
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Implement `FocusDrawer.tsx`**

```tsx
import { ArrowRight, Bot } from "lucide-react";

export function FocusDrawer({ note, count }: { note: string; count: number }) {
  if (!note) return null;
  return (
    <div className="flex items-start gap-2.5 border-t border-violet-700/40 bg-violet-950/30 px-4 py-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-600">
        <Bot className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-300/80">
          Agent · about these {count}
        </div>
        <div className="mt-0.5 text-xs leading-snug text-slate-200">{note}</div>
      </div>
      <span className="ml-auto mt-0.5 flex shrink-0 items-center gap-1 text-[10px] italic text-slate-500">
        respond in chat <ArrowRight className="h-3 w-3" />
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Read `LibraryGrid.tsx`, then make it scope-aware + add the gen
      badge**

Read `surface/components/LibraryGrid.tsx` first (it currently filters by facet
and renders `LibraryTile`s in a 3-column grid). Make these exact changes,
adapting to the file's real variable names:

- Add `scope: FocusScope` and `focusSet: string[]` to the props type (import
  `FocusScope` from `../state/types`).
- Compute the displayed items: when `scope === "focus"`, show
  `library.filter((i) => focusSet.includes(i.id) && !i.archived)`; otherwise the
  existing `itemsByKind(library, facet)` faceted list.
- Set the grid columns by scope: focus → `grid-cols-2 gap-4`, all →
  `grid-cols-3 gap-3` (keep whatever container classes already exist; only the
  column/gap classes are scope-driven).
- On each gen tile (`item.kind === "gen"`), render a violet badge reading
  `generated` and, when `item.gen` is present, a `round {item.gen.round}` label.
  If tiles are rendered via a `LibraryTile` child that doesn't expose a slot for
  this, add the badge in `LibraryGrid` as an overlay on the tile wrapper, or
  thread a small `badge` through — keep it minimal and match the file's existing
  tile structure. Reference badge classes:
  `className="rounded-full bg-violet-600/80 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white"`.

> Keep the existing real-`<button>` tiles and click-to-select behavior intact
> (no `noStaticElementInteractions` suppression).

- [ ] **Step 4: Format + build-check**

Run:
`bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/components/FocusBar.tsx plugins/spellbook/skills/glamour-v2/surface/components/FocusDrawer.tsx plugins/spellbook/skills/glamour-v2/surface/components/LibraryGrid.tsx`
Then statically verify the components type-check (props reference real fields on
`FocusOwner`/`FocusScope`/`LibraryItem`). Run
`bun test plugins/spellbook/skills/glamour-v2/` to confirm no regressions.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/components/FocusBar.tsx \
        plugins/spellbook/skills/glamour-v2/surface/components/FocusDrawer.tsx \
        plugins/spellbook/skills/glamour-v2/surface/components/LibraryGrid.tsx
git commit -m "feat(glamour-v2): focus banner, agent drawer, scope-aware grid + gen badge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Enlarged lightbox with prev/next + arrow-key traversal

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/components/Lightbox.tsx`
- Modify:
  `plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx`

**Interfaces:**

- `Lightbox({ items, index, onIndex, onClose }: { items: LibraryItem[]; index: number; onIndex: (i: number) => void; onClose: () => void })`
  — full-screen enlarged view of `items[index]`; prev/next buttons + left/right
  arrow-key traversal that **wraps** around `items`; Escape closes. Renders
  nothing if `items` is empty or the current item has no `src`.
- `DetailsFlyout` gains a `round` row in the generation metadata block.

> This folds the parked "lightbox gallery traversal" enhancement: cycle the
> whole current set from wherever you opened it, via controls and arrow keys.

- [ ] **Step 1: Implement `Lightbox.tsx`**

```tsx
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect } from "react";
import type { LibraryItem } from "../state/types";

export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: LibraryItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const item = items[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft")
        onIndex((index - 1 + items.length) % items.length);
      else if (e.key === "ArrowRight") onIndex((index + 1) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex, onClose]);

  if (!item || !item.src) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85">
      <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-300">
        <span>
          {index + 1} / {items.length} · {item.title}
        </span>
        <button type="button" onClick={onClose} aria-label="close lightbox">
          <X className="h-5 w-5 hover:text-white" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-between gap-2 px-2">
        <button
          type="button"
          onClick={() => onIndex((index - 1 + items.length) % items.length)}
          aria-label="previous"
          className="rounded-full bg-white/10 p-2 hover:bg-white/20"
        >
          <ChevronLeft className="h-6 w-6 text-white" />
        </button>
        <img
          src={item.src}
          alt={item.title}
          className="max-h-full max-w-full object-contain"
        />
        <button
          type="button"
          onClick={() => onIndex((index + 1) % items.length)}
          aria-label="next"
          className="rounded-full bg-white/10 p-2 hover:bg-white/20"
        >
          <ChevronRight className="h-6 w-6 text-white" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the `round` row to `DetailsFlyout.tsx`**

In the generation metadata `<dl>` block (which already renders model / prompt /
seed / cost), add a `round` row after `model` (it is always present on a gen
item):

```tsx
<div className="flex gap-2">
  <dt className="text-slate-500">round</dt>
  <dd>{item.gen.round}</dd>
</div>
```

- [ ] **Step 3: Format + build-check**

Run:
`bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/components/Lightbox.tsx plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx`
Statically verify type-correctness; run
`bun test plugins/spellbook/skills/glamour-v2/`.

- [ ] **Step 4: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/components/Lightbox.tsx \
        plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx
git commit -m "feat(glamour-v2): enlarged lightbox with prev/next + arrow-key traversal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: App integration — wire focus, generate, lightbox

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/App.tsx`

**Interfaces:**

- Consumes: `FocusBar`, `FocusDrawer`, `Lightbox` (Tasks 6–7); the scope-aware
  `LibraryGrid`; `useSession.send`.
- Produces: the fully wired surface — focus banner + zoom-out, "focus these" on
  a selection, the agent focus drawer, a Generate button, and
  click-a-tile-to-open the enlarged lightbox cycling the current visible set.

- [ ] **Step 1: Read `App.tsx`, then wire the new pieces**

Read the current `App.tsx` (it already has the library/style view toggle, the
`Conversation` sidebar, `DetailsFlyout` with `key`, drag/drop, and the header).
Make these additions, adapting to the real variable names:

1. **Local lightbox state:**
   `const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);`

2. **The current visible set** (drives both the grid and lightbox traversal):

```tsx
const visible =
  state.scope === "focus"
    ? state.library.filter((i) => state.focusSet.includes(i.id) && !i.archived)
    : state.library.filter(
        (i) => !i.archived && (facet === "all" || i.kind === facet)
      );
```

3. **FocusBar above the grid** (library view only), wired to `focus.clear`:

```tsx
{
  state.scope === "focus" && (
    <FocusBar
      owner={state.focusOwner}
      count={state.focusSet.length}
      note={state.focusOwner === "you" ? "" : state.focusNote}
      onZoomOut={() => send({ type: "focus.clear" })}
    />
  );
}
```

4. **A "focus these" affordance** when there is a multi-selection in the library
   view — a small bar above the grid:

```tsx
{
  state.scope === "all" && state.selectedIds.length > 0 && (
    <div className="flex items-center gap-2 border-b border-white/10 bg-fuchsia-950/20 px-4 py-1.5 text-[11px]">
      <span className="text-fuchsia-300">
        {state.selectedIds.length} selected
      </span>
      <button
        type="button"
        onClick={() => send({ type: "focus.set", ids: state.selectedIds })}
        className="flex items-center gap-1 rounded-full border border-fuchsia-500/40 px-2.5 py-1 text-fuchsia-200 hover:bg-fuchsia-600/20"
      >
        <Crosshair className="h-3 w-3" /> focus these
      </button>
      <button
        type="button"
        onClick={() => send({ type: "item.select", ids: [] })}
        className="ml-auto text-slate-500 hover:text-slate-300"
      >
        clear
      </button>
    </div>
  );
}
```

5. **Pass `scope`/`focusSet` to `LibraryGrid`** (and keep existing props).

6. **A Generate button** in the header control group (next to Add), emitting the
   `generate` imperative:

```tsx
<button
  type="button"
  onClick={() => send({ type: "generate" })}
  className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200"
  aria-label="generate a batch"
>
  <Sparkles className="h-3.5 w-3.5" /> Generate
</button>
```

7. **The FocusDrawer** just above the `Conversation`'s composer area — render it
   inside the right column when an agent focus is active. Simplest placement:
   render it in the App's right region above `Conversation`, or pass it through.
   Place it directly before `<Conversation … />`:

```tsx
{
  state.scope === "focus" && state.focusOwner === "agent" && (
    <FocusDrawer note={state.focusNote} count={state.focusSet.length} />
  );
}
```

(If the flex layout makes the drawer read better stacked with the chat, wrap the
drawer + `Conversation` in a `flex flex-col` column — keep the 360px width.)

8. **Open the lightbox on tile click → enlarge.** The grid already selects on
   click; add an enlarge entry point. Simplest: when a tile is the sole selected
   item, the `DetailsFlyout`'s existing enlarge button opens the lightbox.
   Replace the fly-out's local `enlarged` flow by lifting it: pass an
   `onEnlarge` callback to `DetailsFlyout` that sets `lightboxIndex` to the
   selected item's index within `visible`. (If you prefer to keep
   `DetailsFlyout` self-contained, instead add a dedicated enlarge affordance on
   the selected tile.) Then render the lightbox:

```tsx
{
  lightboxIndex !== null && visible[lightboxIndex] && (
    <Lightbox
      items={visible}
      index={lightboxIndex}
      onIndex={setLightboxIndex}
      onClose={() => setLightboxIndex(null)}
    />
  );
}
```

> Decision for the implementer: wire `onEnlarge` from `DetailsFlyout` (it
> already has a `Maximize2` button) up to
> `setLightboxIndex(visible.findIndex(i => i.id === selected.id))`, and have
> `DetailsFlyout` call `onEnlarge` instead of its internal `setEnlarged(true)`.
> Remove the fly-out's now-dead internal enlarged overlay only if you fully
> replace it; otherwise leave the internal overlay and add a separate grid-level
> enlarge. Keep ONE enlarge path — do not ship two.

Add the lucide imports actually used (`Crosshair`, `Sparkles`).

- [ ] **Step 2: Format + build-check the bundle**

Run:
`bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/App.tsx`
Then:
`bun build plugins/spellbook/skills/glamour-v2/surface/index.html --outdir /tmp/glamour-v2-buildcheck`
Expected: bundle builds cleanly (all new components reachable). Run
`bun test plugins/spellbook/skills/glamour-v2/` — no regressions.

- [ ] **Step 3: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/App.tsx
git commit -m "feat(glamour-v2): wire focus lens, generate, and lightbox into the shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Live end-to-end verification (controller-run)

> **Not a subagent task.** The controller runs this with a live daemon +
> Playwright after Task 8's review is clean. No real media-forge call — the gen
> receive path is exercised via `cli.ts gen --file <fixture>` with a tiny local
> PNG, which is the daemon/CLI surface under test.

**Verification script:**

- [ ] Create a tiny fixture PNG (e.g. write a 2×2 PNG to `/tmp/glam-fix.png`).
- [ ] Launch a fresh session:
      `bun …/cli.ts open --title "Slice 3 e2e" --intent "generation + focus"`.
- [ ] Drop a couple of ref images; confirm tiles render.
- [ ] **gen receive path:**
      `cli.ts gen --file /tmp/glam-fix.png --prompt "indigo     twilight" --model nano-banana --round 1 --seed 42817 --label "r1 · A"`
      (×2, same round). Confirm two **gen** tiles appear with the violet
      "generated" badge + "round 1" label; the details fly-out shows
      model/prompt/seed/round and `cost` as "—" until backfilled.
- [ ] **gen.cost backfill:** `cli.ts gen-cost <id> --cost 0.011` → the fly-out
      cost updates live.
- [ ] **generate imperative:** select a ref tile, click **Generate** →
      `cli.ts     tail` shows a `generate` event carrying `ground:[<refId>]`.
      (Selecting/ starring still emits no event.)
- [ ] **human focus:** select 2 tiles → "focus these" → grid switches to the
      2-col focused set, fuchsia "You focused · 2 items" banner; "back to full
      library" restores the full grid. No `focus.set` event in `tail`.
- [ ] **agent focus + drawer:**
      `cli.ts focus <id1> <id2> --note "which reads most     like the house style?"`
      → grid focuses, violet "Agent focused" banner, and the violet FocusDrawer
      shows the question with "respond in chat".
- [ ] **lightbox traversal:** open the enlarged view on a tile → left/right
      arrow keys and prev/next buttons cycle through the current visible set
      (wrapping); Escape closes.
- [ ] **resume:** `close` then `open --restore <id>` → gen items (with round +
      cost), focus state, and library all return; files re-materialized.
- [ ] Confirm no zombie processes after `close`.

Record findings in the SDD ledger; dispatch one fix subagent for any
Critical/Important. Then the whole-branch review (opus), per
subagent-driven-development.

---

## Self-Review

**Spec coverage** (proposal Slice 3 = "Generation + focus lens"):

- media-forge probe generation → agent-side; daemon `gen.add` receive path
  (Tasks 1, 4) + CLI `gen` with client-side optimization (Tasks 3, 5). ✅
- round / batch grouping → `GenMeta.round`, stamped per batch, grouped/labeled
  in the grid; non-destructive (no clear) (Tasks 1, 6). ✅
- generated-image metadata (G1) →
  `GenMeta {model, prompt, seed, cost, custom, round}`, displayed in the
  fly-out; `gen.cost` async backfill (Tasks 1, 2, 4, 5, 7). ✅
- zoom/focus co-presence lens (full → mini-gallery → enlarged), human- and
  agent-initiated → `scope`/`focusSet`/`focusOwner`, `focus.set`/`focus.clear`
  (ambient) + `focus.push` (agent), scope-aware grid, FocusBar, Lightbox (Tasks
  1, 2, 4, 6, 7, 8). ✅
- focus-mode agent drawer → `FocusDrawer` on `focusNote` (Tasks 6, 8). ✅
- "ask for a batch" → `generate` imperative + button (Tasks 1, 4, 8). ✅
- Parked lightbox-traversal enhancement → `Lightbox` prev/next + arrow keys,
  wrapping (Task 7). ✅
- V1 mining: `Variant`→`gen` `LibraryItem`; per-gen cost replaces cumulative
  string; `round` carried; `canonical` correctly **deferred to Slice 4**. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/uncoded steps. The two
read-then-edit spots (`LibraryGrid` in Task 6, `App.tsx` in Task 8) name the
exact changes + reference classes; the implementer adapts to real variable
names, which the brief calls out explicitly. The Task-8 enlarge-path decision is
stated as a single binding choice ("keep ONE enlarge path") to avoid ambiguity.

**Type consistency:** `FocusScope`/`FocusOwner`,
`scope`/`focusSet`/`focusOwner`/ `focusNote`, `GenMeta.round`, and the command
shapes (`gen.add`/`gen.cost`/ `focus.push`/`focus.set`/`focus.clear`/`generate`)
are identical across Tasks 1–8. `generate` (client imperative) vs the `generate`
agent event share the name deliberately (the event echoes the command, carrying
`ground`). Builders in Task 5 match the `AgentCommand` shapes in Task 1.

**Out of scope (correctly deferred):** canonical-image selection +
project-styles tray (Slice 4); any daemon-side media-forge call (architecturally
agent-side forever); a generate prompt-composer UI (the human grounds via
selection + chat — `generate` carries the grounding set).
