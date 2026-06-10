# Glamour Rebuild — Plan 1: Foundation + Gather slice + narration

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up glamour's React+Bun surface foundation — shared typed
contract, lean state, a WebSocket client shell, the Gather phase migrated
end-to-end, and the agent→user narration channel — as working, tested software.

**Architecture:** The Bun daemon (`server.ts`) stays the source of truth and
keeps its current channels: **browser ↔ server over WebSocket** (full-state
snapshots down, typed user-action messages up) and **agent ↔ server over HTTP**
(`/state`, `/events` SSE, `/cmd`). We replace the single 1,425-line
inline-Alpine `template.html` with a Bun-bundled React app under `surface/`,
sharing one `types.ts` with the server. This plan does the foundation + one
phase (Gather) + narration; later plans repeat the pattern for the other phases
and protocol features.

**Tech Stack:** Bun (runtime + bundler + test), React 18, Tailwind v4 via
`bun-plugin-tailwind`, TypeScript.

**Spec:** `docs/projects/image-style-spell/glamour-rebuild-design.md`
**Correction to spec:** the browser channel is WebSocket + full-state snapshots
(no client-side SSE/reducer). The shared typed contract covers `State`, the
browser WS message unions, and the agent event-type set.

**House rules:** Bun only (`bun test`, `bun build` — no vite/jest/npm).
Conventional commits (release-please owns version). `npx prettier --write` on
changed `.md`/`.ts`/`.json` before commit (pre-commit hook enforces).

---

## File Structure

```
plugins/spellbook/skills/glamour/
  scripts/
    cli.ts            # MODIFY: `state` defaults to lean; add `narrate` verb
    server.ts         # MODIFY: import shared types; lean /state; narration state + handler; serve React bundle
  surface/            # NEW — the React app, Bun-bundled
    index.html        # entry
    main.tsx          # mount + WS wiring
    bunfig.toml       # (at skill root) tailwind plugin for the bundler
    state/
      types.ts        # ★ shared State + WS message unions + agent event set (server imports this)
      useSession.ts   # WS hook: holds state, sends actions
      imageOptimize.ts# downscale+webp util (ported from template.html)
    phases/
      PhaseRouter.tsx
      Gather.tsx
    components/
      DropZone.tsx
      InfluenceCard.tsx
      ContextCard.tsx
      IntentField.tsx
      NarrationFeed.tsx
    styles.css        # @import "tailwindcss" + theme tokens
  tests/
    types.test.ts
    leanState.test.ts
    imageOptimize.test.ts
    narration.test.ts
```

Note: `template.html` is left in place until the remaining phases are migrated
(later plans), then deleted. During this plan the server serves the React
bundle; `template.html` is dormant.

---

### Task 1: Shared types module (the contract)

**Files:**

- Create: `plugins/spellbook/skills/glamour/surface/state/types.ts`
- Test: `plugins/spellbook/skills/glamour/tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/types.test.ts
import { test, expect } from "bun:test";
import { AGENT_EVENT_TYPES, defaultState } from "../surface/state/types";

test("agent event set is complete and frozen", () => {
  // The exact set the server emits — the agent must listen for ALL of these.
  expect(AGENT_EVENT_TYPES).toContain("steer");
  expect(AGENT_EVENT_TYPES).toContain("direction.correct");
  expect(AGENT_EVENT_TYPES).toContain("variant.like");
  expect(Object.isFrozen(AGENT_EVENT_TYPES)).toBe(true);
});

test("defaultState seeds gather phase with empty collections", () => {
  const s = defaultState("Glamour", "");
  expect(s.phase).toBe("gather");
  expect(s.influences).toEqual([]);
  expect(s.narration).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/spellbook/skills/glamour && bun test tests/types.test.ts`
Expected: FAIL — cannot find module `../surface/state/types`.

- [ ] **Step 3: Write the types module**

```ts
// surface/state/types.ts
// The single shared contract. Imported by server.ts AND the React client.

export type Phase =
  | "gather"
  | "analysis"
  | "direction"
  | "prompts"
  | "variants"
  | "spec";
export const VALID_PHASE: readonly Phase[] = [
  "gather",
  "analysis",
  "direction",
  "prompts",
  "variants",
  "spec",
] as const;

export type Influence = {
  id: string;
  src: string;
  path: string;
  name: string;
  aspects: string[];
  starred: boolean;
  note: string;
  read: string;
};
export type Context = {
  id: string;
  name: string;
  text: string;
  path: string;
  starred: boolean;
  note: string;
};
export type Prompt = { id: string; text: string };
export type Variant = {
  id: string;
  src: string;
  prompt: string;
  label: string;
  round: number;
  liked: boolean;
  canonical: boolean;
};
export type SpecModule = {
  key: string;
  label: string;
  on: boolean;
  content: string;
};

// Agent→user narration: a one-way activity feed (NOT a chat).
export type NarrationKind = "info" | "working" | "result" | "error";
export type Narration = {
  id: string;
  kind: NarrationKind;
  text: string;
  ts: number;
};

export type GlamourState = {
  title: string;
  intent: string;
  phase: Phase;
  influences: Influence[];
  contexts: Context[];
  direction: { revision: number; understanding: string };
  prompts: Prompt[];
  variants: Variant[];
  round: number;
  status: { busy: boolean; text: string };
  narration: Narration[];
  spec: {
    understanding: string;
    modules: SpecModule[];
    recreatePrompt: string;
    model: string;
  };
};

// Server → browser (WebSocket). The browser handles exactly these.
export type ServerToClient =
  | { type: "state"; state: GlamourState }
  | { type: "message"; text: string }
  | { type: "submit" }
  | { type: "cancel" };

// The complete agent event set (server → agent SSE). The agent MUST listen for
// all of these — incompleteness here is what dropped user input in the dogfood.
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "intent.set",
  "influence.add",
  "influence.annotate",
  "influence.remove",
  "context.add",
  "context.annotate",
  "context.remove",
  "analysis.comment",
  "direction.correct",
  "prompt.comment",
  "prompts.comment",
  "variant.like",
  "variant.canonical",
  "feedback",
  "steer",
  "generate",
  "nudge",
  "spec.module",
  "submit",
  "closed",
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export function defaultState(title: string, intent: string): GlamourState {
  return {
    title,
    intent,
    phase: "gather",
    influences: [],
    contexts: [],
    direction: { revision: 0, understanding: "" },
    prompts: [],
    variants: [],
    round: 0,
    status: { busy: false, text: "" },
    narration: [],
    spec: {
      understanding: "",
      modules: [
        { key: "palette", label: "palette", on: false, content: "" },
        {
          key: "consistency",
          label: "consistency rules",
          on: false,
          content: "",
        },
        {
          key: "motifs",
          label: "motifs / iconography",
          on: false,
          content: "",
        },
        { key: "dosdonts", label: "do / don't", on: false, content: "" },
      ],
      recreatePrompt: "",
      model: "",
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/spellbook/skills/glamour && bun test tests/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour/surface/state/types.ts plugins/spellbook/skills/glamour/tests/types.test.ts
git commit -m "feat(glamour): shared typed state + event contract for surface rebuild"
```

---

### Task 2: Server adopts shared types + adds `narration` + spec-module `content`

**Files:**

- Modify: `plugins/spellbook/skills/glamour/scripts/server.ts` (replace inline
  types block `:70-132`; spec defaults `:212-225`; add narration handling)

- [ ] **Step 1: Write the failing test**

```ts
// tests/narration.test.ts
import { test, expect } from "bun:test";
import { defaultState } from "../surface/state/types";

test("state carries a narration array and content-bearing spec modules", () => {
  const s = defaultState("X", "");
  expect(Array.isArray(s.narration)).toBe(true);
  expect(s.spec.modules[0]).toHaveProperty("content");
});
```

- [ ] **Step 2: Run to verify it passes already (types side) then wire the
      server**

Run: `cd plugins/spellbook/skills/glamour && bun test tests/narration.test.ts`
Expected: PASS (types already provide this from Task 1). This guards the shape;
the server wiring below is verified by Task 3's integration check.

- [ ] **Step 3: Replace the server's inline types with imports**

In `server.ts`, delete the local
`type Phase / Influence / Context / Prompt / Variant / SpecModule / GlamourState`
declarations and the local `defaultState` and `VALID_PHASE`, and import them:

```ts
// near the top imports of server.ts
import {
  type GlamourState,
  type Influence,
  type Context,
  type Variant,
  type Phase,
  type Narration,
  type NarrationKind,
  VALID_PHASE,
  defaultState,
} from "../surface/state/types";
```

Remove the now-duplicated `defaultState` function body and the `SpecModule`
literal list (defaultState now comes from types.ts). Keep
`influenceForAgent`/`contextForAgent`.

- [ ] **Step 4: Add the `narrate` agent command + spec-module `content` merge**

In `handleAgentMsg` (`server.ts:407`), add a branch (place after the `status`
branch ~`:472`):

```ts
} else if (t === "narrate") {
  const kind = (["info", "working", "result", "error"] as const).includes(msg.kind as NarrationKind)
    ? (msg.kind as NarrationKind) : "info";
  if (typeof msg.text === "string" && msg.text) {
    state.narration.push({ id: newId("n"), kind, text: msg.text, ts: Date.now() });
    broadcastState();
  }
```

In the existing `spec` branch (`server.ts:460-471`), extend module merge to
accept `content`:

```ts
if (Array.isArray(s.modules)) {
  for (const m of s.modules as Array<Record<string, unknown>>) {
    const mod = state.spec.modules.find((x) => x.key === m.key);
    if (!mod) continue;
    if (typeof m.on === "boolean") mod.on = m.on;
    if (typeof m.content === "string") mod.content = m.content;
  }
}
```

- [ ] **Step 5: Run the existing suite to confirm no regression**

Run: `cd plugins/spellbook/skills/glamour && bun test` Expected: PASS (existing
tests + new). If `defaultState` is imported in any existing test, it still
resolves via `server.ts`'s re-export (`server.ts:882`) — keep that export line.

- [ ] **Step 6: Commit**

```bash
git add plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/tests/narration.test.ts
git commit -m "feat(glamour): server uses shared types; add narration + spec-module content"
```

---

### Task 3: Lean `/state` projection + cli default

**Files:**

- Modify: `server.ts:545-549` (the `GET /state` handler) + add a
  `variantForAgent` projection near `:271`
- Modify: `scripts/cli.ts` (the `state` verb `:175-180` → request `?lean=1` by
  default, `--full` opts out)
- Test: `tests/leanState.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/leanState.test.ts
import { test, expect } from "bun:test";
import { leanState } from "../scripts/server";
import { defaultState } from "../surface/state/types";

test("leanState strips inlined image/text src from agent view", () => {
  const s = defaultState("X", "");
  s.influences.push({
    id: "i1",
    src: "data:image/webp;base64,AAAA",
    path: "/tmp/i1.webp",
    name: "a",
    aspects: [],
    starred: false,
    note: "",
    read: "",
  });
  s.variants.push({
    id: "v1",
    src: "data:image/png;base64,BBBB",
    prompt: "p",
    label: "L",
    round: 1,
    liked: false,
    canonical: false,
  });
  s.contexts.push({
    id: "c1",
    name: "c.md",
    text: "hello",
    path: "/tmp/c1.md",
    starred: false,
    note: "",
  });
  const lean = leanState(s);
  expect((lean.influences[0] as any).src).toBeUndefined();
  expect((lean.variants[0] as any).src).toBeUndefined();
  expect((lean.contexts[0] as any).text).toBeUndefined();
  // identifying fields survive
  expect(lean.influences[0].path).toBe("/tmp/i1.webp");
  expect(lean.variants[0].label).toBe("L");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/spellbook/skills/glamour && bun test tests/leanState.test.ts`
Expected: FAIL — `leanState` is not exported.

- [ ] **Step 3: Implement `leanState` and use it in the route**

Add near the projections in `server.ts` (~`:281`):

```ts
function variantForAgent(v: Variant): Omit<Variant, "src"> {
  const { src: _drop, ...rest } = v;
  return rest;
}
export function leanState(s: GlamourState) {
  return {
    ...s,
    influences: s.influences.map(influenceForAgent),
    contexts: s.contexts.map(contextForAgent),
    variants: s.variants.map(variantForAgent),
  };
}
```

Change the `GET /state` handler (`server.ts:545-549`) to honor `?lean=1`:

```ts
if (req.method === "GET" && path === "/state") {
  const lean = url.searchParams.get("lean") === "1";
  const payload = lean ? leanState(state) : state;
  return new Response(JSON.stringify({ state: payload, cursor: eventSeq }), {
    headers: { "Content-Type": "application/json" },
  });
}
```

Add `leanState` to the export line at the bottom of `server.ts` (`:882`).

- [ ] **Step 4: Default the cli `state` verb to lean**

In `cli.ts`, the `cmdState` function (`cli.ts:175-180`) — request lean unless
`--full`:

```ts
async function cmdState(session?: string, full = false) {
  const s = requireSession(session);
  const { status, data } = await api(
    s.port,
    "GET",
    `/state${full ? "" : "?lean=1"}`
  );
  if (status !== 200) die(`state failed (HTTP ${status})`);
  printJson(data);
}
```

And in `main`'s `state` case (`cli.ts:355`):
`await cmdState(session, flags.full === true);`

- [ ] **Step 5: Run tests + manual smoke**

Run: `cd plugins/spellbook/skills/glamour && bun test tests/leanState.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/spellbook/skills/glamour/scripts/server.ts plugins/spellbook/skills/glamour/scripts/cli.ts plugins/spellbook/skills/glamour/tests/leanState.test.ts
git commit -m "feat(glamour): lean /state projection (drops inlined src); cli state defaults lean"
```

---

### Task 4: `imageOptimize` shared util

**Files:**

- Create: `surface/state/imageOptimize.ts`
- Test: `tests/imageOptimize.test.ts`

The browser drop path keeps using a canvas (DOM) downscale; this module holds
the **shared parameters + a Node/Bun-runnable resize** (via `sharp`) so the same
policy applies to agent-posted variants later. This task adds the util + its
test; wiring variant optimization into the cli is a later-plan task.

- [ ] **Step 1: Add sharp as a dependency**

Run: `cd /Users/colereed/Projects/Spellbook && bun add sharp` Expected: `sharp`
appears in root `package.json` dependencies.

- [ ] **Step 2: Write the failing test**

```ts
// tests/imageOptimize.test.ts
import { test, expect } from "bun:test";
import { optimizeImageBuffer, OPTIMIZE } from "../surface/state/imageOptimize";

test("optimize policy constants are sane", () => {
  expect(OPTIMIZE.maxDim).toBe(1200);
  expect(OPTIMIZE.quality).toBeGreaterThan(0.5);
});

test("optimizeImageBuffer downscales a large image to webp under maxDim", async () => {
  const sharp = (await import("sharp")).default;
  const big = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: "#888" },
  })
    .png()
    .toBuffer();
  const { data, mime } = await optimizeImageBuffer(big);
  expect(mime).toBe("image/webp");
  const meta = await sharp(data).metadata();
  expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1200);
  expect(data.byteLength).toBeLessThan(big.byteLength);
});
```

- [ ] **Step 3: Run to verify it fails**

Run:
`cd plugins/spellbook/skills/glamour && bun test tests/imageOptimize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the util**

```ts
// surface/state/imageOptimize.ts
// Shared image-optimization policy: ≤1200px longest edge, webp. Used by the
// browser drop path (canvas) and the agent variant path (sharp, server/cli).
export const OPTIMIZE = { maxDim: 1200, quality: 0.85 } as const;

// Bun/Node path (sharp). The browser path stays canvas-based in DropZone.
export async function optimizeImageBuffer(
  input: Uint8Array
): Promise<{ data: Uint8Array; mime: "image/webp" }> {
  const sharp = (await import("sharp")).default;
  const data = await sharp(input)
    .resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: Math.round(OPTIMIZE.quality * 100) })
    .toBuffer();
  return { data: new Uint8Array(data), mime: "image/webp" };
}
```

- [ ] **Step 5: Run to verify it passes**

Run:
`cd plugins/spellbook/skills/glamour && bun test tests/imageOptimize.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/spellbook/skills/glamour/surface/state/imageOptimize.ts plugins/spellbook/skills/glamour/tests/imageOptimize.test.ts package.json bun.lock
git commit -m "feat(glamour): shared image-optimize util (sharp) for variant path"
```

---

### Task 5: React build scaffold + WS client shell

**Files:**

- Create: `surface/index.html`, `surface/main.tsx`, `surface/styles.css`,
  `surface/state/useSession.ts`, `surface/phases/PhaseRouter.tsx`
- Create: `plugins/spellbook/skills/glamour/bunfig.toml`
- Modify: `server.ts` — serve the bundled app via Bun HTML import (routes), drop
  `template.html` string-injection for now

> Confirm current Bun + Tailwind-v4 bundler wiring against docs at build time
> (context7: "bun-plugin-tailwind", "Bun.serve routes html import"); the config
> below is the known-good shape.

- [ ] **Step 1: React deps**

Run:
`cd /Users/colereed/Projects/Spellbook && bun add react react-dom && bun add -d @types/react @types/react-dom bun-plugin-tailwind tailwindcss`
Expected: deps in root `package.json`.

- [ ] **Step 2: bunfig.toml (Tailwind plugin for the bundler)**

```toml
# plugins/spellbook/skills/glamour/bunfig.toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
```

- [ ] **Step 3: styles.css + index.html + main.tsx**

```css
/* surface/styles.css */
@import "tailwindcss";
:root {
  color-scheme: dark;
}
body {
  margin: 0;
}
```

```html
<!-- surface/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Glamour</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body class="bg-[#140f1d] text-slate-200">
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

```tsx
// surface/main.tsx
import { createRoot } from "react-dom/client";
import { PhaseRouter } from "./phases/PhaseRouter";
import { useSession } from "./state/useSession";
import "./styles.css";

function App() {
  const { state, send, status } = useSession();
  if (!state) return <div className="p-6 text-slate-400">connecting…</div>;
  return <PhaseRouter state={state} send={send} connectionStatus={status} />;
}
createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 4: useSession WS hook**

```tsx
// surface/state/useSession.ts
import { useEffect, useRef, useState, useCallback } from "react";
import type { GlamourState, ServerToClient } from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

export function useSession() {
  const [state, setState] = useState<GlamourState | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    const url = `ws://${location.host}/ws`;
    let stop = false;
    const connect = () => {
      const sock = new WebSocket(url);
      ws.current = sock;
      sock.onopen = () => setStatus("open");
      sock.onclose = () => {
        setStatus("closed");
        if (!stop) setTimeout(connect, 800);
      };
      sock.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerToClient;
        if (msg.type === "state") setState(msg.state);
      };
    };
    connect();
    return () => {
      stop = true;
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: Record<string, unknown>) => {
    ws.current?.readyState === WebSocket.OPEN &&
      ws.current.send(JSON.stringify(msg));
  }, []);

  return { state, send, status };
}
```

- [ ] **Step 5: PhaseRouter (Gather only for now)**

```tsx
// surface/phases/PhaseRouter.tsx
import type { GlamourState } from "../state/types";
import { Gather } from "./Gather";

export type PhaseProps = {
  state: GlamourState;
  send: (msg: Record<string, unknown>) => void;
};

export function PhaseRouter({
  state,
  send,
  connectionStatus,
}: PhaseProps & { connectionStatus: string }) {
  return (
    <div className="min-h-screen">
      {connectionStatus !== "open" && (
        <div className="bg-amber-700/40 text-amber-100 text-xs px-3 py-1">
          {connectionStatus}…
        </div>
      )}
      {state.phase === "gather" ? (
        <Gather state={state} send={send} />
      ) : (
        <div className="p-6 text-slate-400">
          phase “{state.phase}” — not migrated yet (Plan 2)
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Serve the bundle from server.ts**

Add at the top of `server.ts`: `import index from "../surface/index.html";` In
`Bun.serve({...})`, add a `routes` field and keep `fetch` for the API/WS:

```ts
server = Bun.serve({
  port,
  hostname: host,
  routes: { "/": index },
  development: { hmr: true },
  fetch: (req, srv) => {
    /* existing /ws, /state, /events, /cmd, /assets — unchanged;
                            remove the GET "/" branch (routes handles it) */
  },
  websocket: {
    /* unchanged */
  },
});
```

Remove the `pageHtml` string-replacement block (`server.ts:794-797`) and the
`GET "/" → pageHtml` branch (`server.ts:534-538`); the client derives the WS URL
from `location.host`, so `__WS_URL__`/`__TITLE__`/`__SESSION_ID__` injection is
no longer needed.

- [ ] **Step 7: Verify build + serve**

Run: `cd plugins/spellbook/skills/glamour/scripts && bun cli.ts open --no-open`
Then:
`curl -s localhost:$(bun cli.ts info | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).port)')/ | grep -q '<div id="root">' && echo OK`
Expected: `OK` (server serves the React HTML shell). Then `bun cli.ts close`.

- [ ] **Step 8: Commit**

```bash
git add plugins/spellbook/skills/glamour/surface plugins/spellbook/skills/glamour/bunfig.toml plugins/spellbook/skills/glamour/scripts/server.ts package.json bun.lock
git commit -m "feat(glamour): React+Bun surface scaffold + WS client shell; serve bundle"
```

---

### Task 6: Gather phase + components (end-to-end slice)

**Files:**

- Create: `surface/phases/Gather.tsx`,
  `surface/components/{DropZone,InfluenceCard,ContextCard,IntentField}.tsx`

This proves the full loop: drop → optimize (canvas) → WS send → server state →
snapshot back → render. Mirrors the current `template.html` Gather behavior
(drop images→influences, text→contexts, intent field, "read the influences"
nudge) but as components. Fixes **BUG-4** (proceed allowed with context-only)
and **UX-1** (items listed + annotatable inline).

- [ ] **Step 1: DropZone (canvas optimize, ported)**

```tsx
// surface/components/DropZone.tsx
import { OPTIMIZE } from "../state/imageOptimize";

const IMG = /^image\//;
async function downscaleToWebp(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, OPTIMIZE.maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/webp", OPTIMIZE.quality);
  if (!url.startsWith("data:image/webp")) throw new Error("no webp");
  return url;
}
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function DropZone({
  send,
}: {
  send: (m: Record<string, unknown>) => void;
}) {
  async function handle(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      if (IMG.test(f.type)) {
        let src: string;
        try {
          src = await downscaleToWebp(f);
        } catch {
          src = await readAsDataUrl(f);
        }
        send({ type: "influence.add", influence: { src, name: f.name } });
      } else if (
        f.type === "text/markdown" ||
        f.name.endsWith(".md") ||
        f.type.startsWith("text/")
      ) {
        send({
          type: "context.add",
          context: { text: await f.text(), name: f.name },
        });
      }
    }
  }
  return (
    <label
      onDrop={(e) => {
        e.preventDefault();
        handle(e.dataTransfer.files);
      }}
      onDragOver={(e) => e.preventDefault()}
      className="block border border-dashed border-[#2e2640] rounded-xl p-6 text-center text-slate-400 cursor-pointer hover:border-violet-500/40"
    >
      drop images or context files, or click to pick
      <input
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          handle(e.target.files);
          e.currentTarget.value = "";
        }}
      />
    </label>
  );
}
```

- [ ] **Step 2: InfluenceCard + ContextCard (inline annotate — fixes UX-1)**

```tsx
// surface/components/InfluenceCard.tsx
import type { Influence } from "../state/types";
export function InfluenceCard({
  inf,
  send,
}: {
  inf: Influence;
  send: (m: Record<string, unknown>) => void;
}) {
  return (
    <div className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-2">
      <img
        src={inf.src}
        alt={inf.name}
        className="w-full h-28 object-cover rounded"
      />
      <input
        defaultValue={inf.note}
        placeholder="add a note…"
        onBlur={(e) =>
          send({
            type: "influence.annotate",
            id: inf.id,
            patch: { note: e.target.value },
          })
        }
        className="mt-1 w-full bg-transparent text-xs text-slate-300 outline-none"
      />
      {inf.read && (
        <p className="mt-1 text-[11px] text-slate-400">{inf.read}</p>
      )}
    </div>
  );
}
```

```tsx
// surface/components/ContextCard.tsx
import type { Context } from "../state/types";
export function ContextCard({
  ctx,
  send,
}: {
  ctx: Context;
  send: (m: Record<string, unknown>) => void;
}) {
  return (
    <div className="bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 flex items-center gap-2">
      <span className="text-xs text-slate-300 flex-1 truncate">{ctx.name}</span>
      <input
        defaultValue={ctx.note}
        placeholder="note…"
        onBlur={(e) =>
          send({
            type: "context.annotate",
            id: ctx.id,
            patch: { note: e.target.value },
          })
        }
        className="bg-transparent text-[11px] text-slate-400 outline-none w-24"
      />
    </div>
  );
}
```

- [ ] **Step 3: IntentField + Gather (proceed allowed with EITHER influences or
      contexts — fixes BUG-4)**

```tsx
// surface/components/IntentField.tsx
import type { GlamourState } from "../state/types";
export function IntentField({
  state,
  send,
}: {
  state: GlamourState;
  send: (m: Record<string, unknown>) => void;
}) {
  return (
    <textarea
      defaultValue={state.intent}
      placeholder="what do you want out of this?"
      onBlur={(e) =>
        e.target.value !== state.intent &&
        send({ type: "intent.set", text: e.target.value })
      }
      className="w-full bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 text-sm text-slate-200 outline-none"
      rows={3}
    />
  );
}
```

```tsx
// surface/phases/Gather.tsx
import type { PhaseProps } from "./PhaseRouter";
import { DropZone } from "../components/DropZone";
import { InfluenceCard } from "../components/InfluenceCard";
import { ContextCard } from "../components/ContextCard";
import { IntentField } from "../components/IntentField";

export function Gather({ state, send }: PhaseProps) {
  const canProceed = state.influences.length > 0 || state.contexts.length > 0; // BUG-4: either is enough
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <IntentField state={state} send={send} />
      <DropZone send={send} />
      <div className="grid grid-cols-3 gap-2">
        {state.influences.map((i) => (
          <InfluenceCard key={i.id} inf={i} send={send} />
        ))}
      </div>
      <div className="space-y-1">
        {state.contexts.map((c) => (
          <ContextCard key={c.id} ctx={c} send={send} />
        ))}
      </div>
      <button
        disabled={!canProceed}
        onClick={() => send({ type: "nudge", label: "read the influences" })}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white disabled:opacity-40"
      >
        Read the influences
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Manual end-to-end smoke**

Run: `cd plugins/spellbook/skills/glamour/scripts && bun cli.ts open` (opens
browser). Drop an image and a `.md`, type intent, confirm both appear; in
another terminal `bun cli.ts state` (lean) shows the influence/context with
`path` set and no `src`. Click "Read the influences"; `bun cli.ts tail` shows
the `nudge`. Then `bun cli.ts close`. Expected: all present; proceed button
enabled with context only (BUG-4 fixed).

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour/surface
git commit -m "feat(glamour): Gather phase as React components (context-only intake; inline annotate)"
```

---

### Task 7: NarrationFeed + `narrate` cli verb (agent→user channel)

**Files:**

- Create: `surface/components/NarrationFeed.tsx`
- Modify: `surface/phases/PhaseRouter.tsx` (render the feed)
- Modify: `scripts/cli.ts` (add `narrate` verb)

- [ ] **Step 1: NarrationFeed component**

```tsx
// surface/components/NarrationFeed.tsx
import type { Narration } from "../state/types";
const COLOR: Record<string, string> = {
  info: "text-slate-300",
  working: "text-violet-300",
  result: "text-emerald-300",
  error: "text-rose-300",
};
export function NarrationFeed({ items }: { items: Narration[] }) {
  if (!items.length) return null;
  return (
    <div className="fixed bottom-0 inset-x-0 max-h-40 overflow-y-auto bg-[#0f0b17]/95 border-t border-[#2a2238] p-2 text-xs space-y-1">
      {items.slice(-12).map((n) => (
        <div key={n.id} className={COLOR[n.kind] ?? "text-slate-300"}>
          {n.kind === "working" ? "⋯ " : n.kind === "error" ? "✗ " : "• "}
          {n.text}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Render it in PhaseRouter**

In `PhaseRouter.tsx`, add
`import { NarrationFeed } from "../components/NarrationFeed";` and render
`<NarrationFeed items={state.narration} />` just before the closing `</div>` of
the root.

- [ ] **Step 3: Add the `narrate` cli verb**

In `cli.ts` HELP (`:323`) add a line:
`narrate [--kind info|working|result|error] <text...>`. In `main`'s switch
(after the `say` case `:440`):

```ts
case "narrate": {
  if (!pos.length) die("usage: narrate [--kind ..] <text...>");
  const kind = typeof flags.kind === "string" ? flags.kind : "info";
  await postCmd(session, { type: "narrate", kind, text: pos.join(" ") });
  break;
}
```

- [ ] **Step 4: Manual smoke**

Run: `cd plugins/spellbook/skills/glamour/scripts && bun cli.ts open` Then:
`bun cli.ts narrate --kind working "reading your context now…"` Expected: the
line appears in the bottom activity feed in the browser. `bun cli.ts close`.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour/surface plugins/spellbook/skills/glamour/scripts/cli.ts
git commit -m "feat(glamour): agent→user narration feed + cli narrate verb"
```

---

## Self-Review

**Spec coverage (Phase 1 portion):** shared typed contract ✓ (Task 1); server
adopts types + narration + spec-module content ✓ (Task 2); lean state ✓ (Task
3); image-optimize util ✓ (Task 4, variant wiring deferred to Plan 2 as noted);
React+Bun build + WS client ✓ (Task 5); Gather end-to-end + BUG-4 + UX-1 ✓ (Task
6); agent→user narration ✓ (Task 7). **Deferred to Plan 2 (intentional,
noted):** other phases, feedback bar + consolidation, terminal-handoff, phase
auto-advance, variant optimization wiring, animated spinner (BUG-3),
overlay-dismiss (BUG-2 lives in old template, removed when phases migrate),
canonical selection UI (UX-6). **Not in this plan's scope** per spec phasing.

**Placeholder scan:** no TBD/TODO; every code step has complete code; the two
"confirm against Bun docs" notes are explicit verification steps, not missing
content.

**Type consistency:** `GlamourState`, `Influence`, `Context`, `Variant`,
`Narration`, `NarrationKind` all flow from `surface/state/types.ts`;
`leanState`/`variantForAgent` names consistent across Task 3 def + test; `send`
signature `(msg: Record<string, unknown>) => void` consistent across
`useSession`, `PhaseProps`, and every component; `narrate` command shape matches
between cli (Task 7) and server handler (Task 2).

**Open dependency:** Task 5 flags confirming current Bun/Tailwind-v4 bundler
wiring against docs — the one place the toolchain API could have shifted.
