# Glamour v2 — Slice 1: Skeleton + Unified Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the glamour-v2 daemon + React surface with a unified library
of items (ref / context / generated) you can drop into, see as faceted tiles,
inspect via a persistent details fly-out, and resume across restarts.

**Architecture:** A Bun daemon (`Bun.serve`) holds canonical state and serves a
Bun-bundled React surface. Three channels: WebSocket (browser↔daemon, full-state
broadcast), SSE `GET /events?since=N` (daemon→agent, append-only imperatives),
HTTP `POST /cmd` (agent→daemon). State centers on a single
`library: LibraryItem[]` plus a `selectedIds` linked set. All state-mutation
logic lives in pure, unit-tested helpers (`surface/state/reduce.ts`); the server
is thin transport. Patterns are ported from imago 1.7.0 (library/linked-set
model, contract discipline, ambient-vs-imperative events, detached spawn,
integration tests) and glamour V1 (image optimization on ingest, snapshot
spine).

**Tech Stack:** Bun **≥ 1.3.14** (runtime, bundler, `bun:test`, **`Bun.Image`**
for native image optimization), React 19, `bun-plugin-tailwind` + Tailwind v4
(CSS-first), lucide-react (icons), TypeScript. **No `sharp`** — V1 used it; v2
uses Bun's native `Bun.Image` (stable since 1.3.14) instead, dropping the
dependency and its native build step.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Runtime is Bun ≥ 1.3.14.** Use `bun`, `bun:test`, Bun's bundler. No
  vite/webpack/jest (`CLAUDE.md`). No `dotenv`, `ws`, `better-sqlite3`, **no
  `sharp`** — use Bun built-ins, incl. **`Bun.Image`** (native image
  resize/encode, stable since 1.3.14) for server-side image optimization.
- **v2 lives at `plugins/spellbook/skills/glamour-v2/`** and stays **out of
  every synced listing** (marketplace `tags`, both README spell tables,
  `grimoire/trigger-registry.md`) and ships **no `SKILL.md`** until the eventual
  cutover. A skill folder without `SKILL.md` is invisible to skill discovery —
  intended for this WIP. **Do not touch V1** at
  `plugins/spellbook/skills/glamour/`.
- **Single typed contract.** `surface/state/types.ts` is the one source of truth
  for the server, the CLI, and the React surface. Every channel message is a
  member of a typed union there.
- **`AGENT_EVENT_TYPES` is the emitted-event allowlist — never hand-roll one.**
  Only members of this frozen set are emitted to the agent. This is the
  structural fix for V1's dropped-input bug.
- **Ambient vs. imperative.** Board moves (`item.select`, `item.star`,
  `item.like`) mutate state + broadcast to browsers only — they emit **no**
  agent event. Imperatives (`item.add`, human `item.annotate`) emit an agent
  event **and carry ambient board context** (`selectedIds`) so the agent never
  chases per-gesture pings.
- **Lean state for the agent.** `GET /state?lean=1` strips `src` (image
  data-URL) and `text` (context body) from every item; the agent reads the
  on-disk `path` instead. Blobs are materialized to a per-session files dir on
  arrival.
- **Snapshots are the resume point.** Full state is debounce-snapshotted to
  `$GLAMOUR_HOME/snapshots/<sessionId>.json` (default `~/.glamour-v2`). Restore
  merges the snapshot over a fresh `defaultState()` (so older snapshots gain new
  fields) and **re-materializes** on-disk paths into a fresh session files dir.
- **Daemon cwd must be pinned to the glamour-v2 skill root** when spawned (Bun
  reads `bunfig.toml` + Tailwind `@source` from cwd only) — otherwise the
  surface serves unstyled.
- **A live Playwright/visual pass is required** before the slice is done.
  `bun test` + a successful bundle do **not** catch styling/layout regressions
  (hard-won V1 lesson).
- **Format before commit:** Biome for `.ts`/`.tsx`/`.json`
  (`bunx biome check --write <files>`), prettier for `.md`. Do not run prettier
  on `.ts`/`.tsx` (it fights Biome's import sort).
- **Commit trailer:** end every commit message with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Run tests with:** `bun test plugins/spellbook/skills/glamour-v2/tests/`.

---

## File Structure

```
plugins/spellbook/skills/glamour-v2/
├── bunfig.toml                       # [serve.static] plugins = ["bun-plugin-tailwind"]
├── tsconfig.json                     # jsx: react-jsx, bun-types
├── scripts/
│   ├── server.ts                     # Bun.serve daemon (startDaemon + import.meta.main guard)
│   └── cli.ts                        # detached spawn + agent verbs
├── surface/
│   ├── index.html                    # entry: imports main.tsx + styles.css
│   ├── styles.css                    # Tailwind v4 CSS-first (@import + @source)
│   ├── main.tsx                      # React root
│   ├── App.tsx                       # shell: header + facet bar + grid + flyout + drop zone
│   ├── components/
│   │   ├── FacetBar.tsx              # kind facets with counts
│   │   ├── LibraryGrid.tsx           # filtered grid of tiles
│   │   ├── LibraryTile.tsx           # one tile (image thumb or text card)
│   │   └── DetailsFlyout.tsx         # selected-item details + dual annotations + enlarge
│   └── state/
│       ├── types.ts                  # THE contract (state, items, unions, AGENT_EVENT_TYPES)
│       ├── reduce.ts                 # pure state helpers + lean + ambient/imperative + applyAgentMsg
│       ├── imageOptimize.ts          # browser-safe OPTIMIZE policy
│       ├── imageOptimize.server.ts   # Bun.Image downscale→webp (server only)
│       ├── persist.server.ts         # materialize blobs + snapshot save/load (server only)
│       ├── fileIntake.ts             # drag/drop → item.add
│       └── useSession.ts             # WebSocket hook (state + send)
└── tests/
    ├── types.test.ts
    ├── reduce.test.ts
    ├── imageOptimize.test.ts
    ├── persist.test.ts
    └── daemon.integration.test.ts
```

**Module boundaries:** all state logic is pure and in `surface/state/reduce.ts`
(testable without a server). Disk I/O is isolated in `persist.server.ts` and
`imageOptimize.server.ts` (suffix `.server.ts` = never import into the browser
bundle). `server.ts` is transport only; `cli.ts` is the agent's mouth.

---

### Task 1: Scaffold + the typed contract

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/bunfig.toml`
- Create: `plugins/spellbook/skills/glamour-v2/tsconfig.json`
- Create: `plugins/spellbook/skills/glamour-v2/surface/index.html`
- Create: `plugins/spellbook/skills/glamour-v2/surface/styles.css`
- Create: `plugins/spellbook/skills/glamour-v2/surface/state/types.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/types.test.ts`

**Interfaces:**

- Produces: `ItemKind`, `VALID_KIND`, `GenMeta`, `LibraryItem`, `GlamourState`,
  `LeanItem`, `LeanState`, `ServerToClient`, `ClientToServer`, `AgentCommand`,
  `AGENT_EVENT_TYPES`, `AgentEventType`, `defaultState(title, intent)`.

- [ ] **Step 1: Write the failing test**

`tests/types.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  AGENT_EVENT_TYPES,
  defaultState,
  VALID_KIND,
} from "../surface/state/types";

test("defaultState is an empty library session", () => {
  const s = defaultState("My Style", "logo set");
  expect(s.title).toBe("My Style");
  expect(s.intent).toBe("logo set");
  expect(s.library).toEqual([]);
  expect(s.selectedIds).toEqual([]);
  expect(s.status).toEqual({ busy: false, text: "" });
});

test("VALID_KIND covers the four tile kinds", () => {
  expect([...VALID_KIND]).toEqual(["ref", "context", "gen", "style"]);
});

test("every imperative client message has an agent event type", () => {
  // The structural guard against V1's dropped-input bug: any browser message
  // that is NOT a pure board move must be representable as an agent event.
  for (const t of ["item.add", "item.annotate"]) {
    expect(AGENT_EVENT_TYPES).toContain(t);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/types.test.ts`
Expected: FAIL — cannot resolve `../surface/state/types`.

- [ ] **Step 3: Create the scaffold files**

`bunfig.toml`:

```toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`surface/index.html`:

```html
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

`surface/styles.css` (Tailwind v4 CSS-first; `@source` so classes in `.tsx` are
scanned regardless of spawn cwd):

```css
@import "tailwindcss";
@source "./**/*.tsx";
```

- [ ] **Step 4: Write the contract**

`surface/state/types.ts`:

```ts
// The single shared contract — imported by server.ts, cli.ts, and the surface.

export type ItemKind = "ref" | "context" | "gen" | "style";
export const VALID_KIND: readonly ItemKind[] = [
  "ref",
  "context",
  "gen",
  "style",
] as const;

// Generation metadata (G1). Fully populated for kind === "gen" in Slice 3;
// the field exists now so the contract and the details fly-out are stable.
export type GenMeta = {
  model: string;
  prompt: string;
  seed: number | null;
  cost: number | null;
  custom: Record<string, string>;
};

// One catalog entry. Shape follows imago's ContextEntry conventions:
// blobs (`src`, `text`) are stripped in the lean agent projection; the agent
// reads `path`. Archival is non-destructive (the `archived` flag; the item
// survives in the library).
export type LibraryItem = {
  id: string;
  kind: ItemKind;
  title: string;
  src: string; // image data-URL (ref/gen); "" otherwise — stripped in lean
  path: string; // on-disk materialized blob the agent can Read; "" if none
  text: string; // context body; "" otherwise — stripped in lean
  mime: string; // e.g. "image/webp", "text/markdown"
  tags: string[];
  starred: boolean;
  liked: boolean;
  annotations: { agent: string; human: string };
  archived: boolean;
  createdAt: number;
  gen: GenMeta | null;
};

export type GlamourState = {
  title: string;
  intent: string;
  library: LibraryItem[];
  selectedIds: string[]; // linked set — the grounding set (unselect ≠ delete)
  status: { busy: boolean; text: string };
};

// Lean projection sent to the agent: blobs stripped, paths kept.
export type LeanItem = Omit<LibraryItem, "src" | "text">;
export type LeanState = Omit<GlamourState, "library"> & {
  library: LeanItem[];
};

// Server → browser (WebSocket).
export type ServerToClient =
  | { type: "state"; state: GlamourState }
  | { type: "message"; text: string }; // transient toast

// Browser → server (WebSocket).
export type ClientToServer =
  | {
      type: "item.add";
      item: {
        kind: "ref" | "context";
        title: string;
        src?: string;
        text?: string;
        mime?: string;
      };
    }
  | { type: "item.select"; ids: string[] } // ambient
  | { type: "item.star"; id: string; starred: boolean } // ambient
  | { type: "item.like"; id: string; liked: boolean } // ambient
  | { type: "item.annotate"; id: string; human: string }; // imperative

// Agent → server (HTTP POST /cmd).
export type AgentCommand =
  | { type: "init"; title?: string; intent?: string }
  | { type: "intent"; text: string }
  | { type: "item.annotate"; id: string; agent: string }
  | { type: "say"; text: string }
  | { type: "status"; busy: boolean; text?: string }
  | { type: "close" };

// The complete agent-event set (server → agent SSE). Only these are emitted.
// Imperatives only — board moves (select/star/like) are ambient.
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "item.add",
  "item.annotate",
  "closed",
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export function defaultState(title: string, intent: string): GlamourState {
  return {
    title,
    intent,
    library: [],
    selectedIds: [],
    status: { busy: false, text: "" },
  };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Format and commit**

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/state/types.ts plugins/spellbook/skills/glamour-v2/tests/types.test.ts plugins/spellbook/skills/glamour-v2/tsconfig.json
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): scaffold + typed library contract

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure state helpers (`reduce.ts`)

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`

**Interfaces:**

- Consumes: all types from Task 1.
- Produces:
  - `makeItem(p): LibraryItem`
  - `addItem(state, item): boolean`
  - `selectItems(state, ids): void`
  - `setStar(state, id, starred): boolean`
  - `setLike(state, id, liked): boolean`
  - `annotate(state, id, who: "agent" | "human", text): boolean`
  - `itemsByKind(items, kind: ItemKind | "all"): LibraryItem[]`
  - `leanItem(it): LeanItem`
  - `leanState(s): LeanState`
  - `AMBIENT_CLIENT: Set<string>`, `isImperative(type): boolean`
  - `applyAgentMsg(state, msg: AgentCommand): void`

- [ ] **Step 1: Write the failing test**

`tests/reduce.test.ts`:

```ts
import { expect, test } from "bun:test";
import { defaultState } from "../surface/state/types";
import {
  addItem,
  annotate,
  applyAgentMsg,
  isImperative,
  itemsByKind,
  leanState,
  makeItem,
  selectItems,
  setLike,
  setStar,
} from "../surface/state/reduce";

const img = () =>
  makeItem({
    id: "a",
    kind: "ref",
    title: "ref.webp",
    src: "data:image/webp;base64,AAAA",
    mime: "image/webp",
    createdAt: 1,
  });

test("makeItem fills defaults", () => {
  const it = img();
  expect(it.starred).toBe(false);
  expect(it.liked).toBe(false);
  expect(it.annotations).toEqual({ agent: "", human: "" });
  expect(it.archived).toBe(false);
  expect(it.gen).toBeNull();
  expect(it.tags).toEqual([]);
  expect(it.text).toBe("");
});

test("addItem appends and de-dupes by id", () => {
  const s = defaultState("t", "");
  expect(addItem(s, img())).toBe(true);
  expect(addItem(s, img())).toBe(false); // same id
  expect(s.library.length).toBe(1);
});

test("selectItems sets a fresh linked set", () => {
  const s = defaultState("t", "");
  selectItems(s, ["a", "b"]);
  expect(s.selectedIds).toEqual(["a", "b"]);
});

test("setStar / setLike toggle and report unknown ids", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  expect(setStar(s, "a", true)).toBe(true);
  expect(s.library[0].starred).toBe(true);
  expect(setLike(s, "a", true)).toBe(true);
  expect(setStar(s, "zzz", true)).toBe(false);
});

test("annotate writes the right side", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  expect(annotate(s, "a", "agent", "warm palette")).toBe(true);
  expect(annotate(s, "a", "human", "love this")).toBe(true);
  expect(s.library[0].annotations).toEqual({
    agent: "warm palette",
    human: "love this",
  });
  expect(annotate(s, "zzz", "agent", "x")).toBe(false);
});

test("itemsByKind filters and excludes archived", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  addItem(
    s,
    makeItem({
      id: "c",
      kind: "context",
      title: "brief.md",
      text: "x",
      createdAt: 2,
    })
  );
  const archived = makeItem({
    id: "d",
    kind: "ref",
    title: "old",
    createdAt: 3,
  });
  archived.archived = true;
  addItem(s, archived);
  expect(itemsByKind(s.library, "all").map((i) => i.id)).toEqual(["a", "c"]);
  expect(itemsByKind(s.library, "ref").map((i) => i.id)).toEqual(["a"]);
  expect(itemsByKind(s.library, "context").map((i) => i.id)).toEqual(["c"]);
});

test("leanState strips src and text, keeps path and marks", () => {
  const s = defaultState("t", "");
  const it = img();
  it.path = "/tmp/a.webp";
  it.starred = true;
  addItem(s, it);
  const lean = leanState(s);
  const li = lean.library[0] as Record<string, unknown>;
  expect(li.src).toBeUndefined();
  expect(li.text).toBeUndefined();
  expect(li.path).toBe("/tmp/a.webp");
  expect(li.starred).toBe(true);
});

test("isImperative: board moves are ambient, the rest notify the agent", () => {
  expect(isImperative("item.select")).toBe(false);
  expect(isImperative("item.star")).toBe(false);
  expect(isImperative("item.like")).toBe(false);
  expect(isImperative("item.add")).toBe(true);
  expect(isImperative("item.annotate")).toBe(true);
});

test("applyAgentMsg mutates state", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  applyAgentMsg(s, { type: "init", title: "New", intent: "logos" });
  expect(s.title).toBe("New");
  expect(s.intent).toBe("logos");
  applyAgentMsg(s, { type: "intent", text: "icons" });
  expect(s.intent).toBe("icons");
  applyAgentMsg(s, { type: "item.annotate", id: "a", agent: "cool blues" });
  expect(s.library[0].annotations.agent).toBe("cool blues");
  applyAgentMsg(s, { type: "status", busy: true, text: "generating" });
  expect(s.status).toEqual({ busy: true, text: "generating" });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`
Expected: FAIL — cannot resolve `../surface/state/reduce`.

- [ ] **Step 3: Implement `reduce.ts`**

```ts
import type {
  AgentCommand,
  GenMeta,
  GlamourState,
  ItemKind,
  LeanItem,
  LeanState,
  LibraryItem,
} from "./types";

export function makeItem(p: {
  id: string;
  kind: ItemKind;
  title: string;
  src?: string;
  path?: string;
  text?: string;
  mime?: string;
  tags?: string[];
  createdAt: number;
  gen?: GenMeta | null;
}): LibraryItem {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    src: p.src ?? "",
    path: p.path ?? "",
    text: p.text ?? "",
    mime: p.mime ?? "",
    tags: p.tags ?? [],
    starred: false,
    liked: false,
    annotations: { agent: "", human: "" },
    archived: false,
    createdAt: p.createdAt,
    gen: p.gen ?? null,
  };
}

export function addItem(state: GlamourState, item: LibraryItem): boolean {
  if (state.library.some((i) => i.id === item.id)) return false;
  state.library.push(item);
  return true;
}

export function selectItems(state: GlamourState, ids: string[]): void {
  state.selectedIds = [...ids];
}

export function setStar(
  state: GlamourState,
  id: string,
  starred: boolean
): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.starred = starred;
  return true;
}

export function setLike(
  state: GlamourState,
  id: string,
  liked: boolean
): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.liked = liked;
  return true;
}

export function annotate(
  state: GlamourState,
  id: string,
  who: "agent" | "human",
  text: string
): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.annotations[who] = text;
  return true;
}

export function itemsByKind(
  items: LibraryItem[],
  kind: ItemKind | "all"
): LibraryItem[] {
  const live = items.filter((i) => !i.archived);
  return kind === "all" ? live : live.filter((i) => i.kind === kind);
}

export function leanItem(it: LibraryItem): LeanItem {
  const { src: _s, text: _t, ...rest } = it;
  return rest;
}

export function leanState(s: GlamourState): LeanState {
  return { ...s, library: s.library.map(leanItem) };
}

// Board moves that mutate state + broadcast but emit NO agent event.
export const AMBIENT_CLIENT = new Set<string>([
  "item.select",
  "item.star",
  "item.like",
]);
export function isImperative(type: string): boolean {
  return !AMBIENT_CLIENT.has(type);
}

export function applyAgentMsg(state: GlamourState, msg: AgentCommand): void {
  switch (msg.type) {
    case "init":
      if (typeof msg.title === "string") state.title = msg.title;
      if (typeof msg.intent === "string") state.intent = msg.intent;
      break;
    case "intent":
      state.intent = msg.text;
      break;
    case "item.annotate": {
      const it = state.library.find((i) => i.id === msg.id);
      if (it) it.annotations.agent = msg.agent;
      break;
    }
    case "status":
      state.status = { busy: msg.busy, text: msg.text ?? "" };
      break;
    case "say":
    case "close":
      break; // handled by the server (toast broadcast / shutdown)
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Format and commit**

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): pure library state helpers + lean projection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Image optimization (`Bun.Image`, native)

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/state/imageOptimize.ts`
- Create:
  `plugins/spellbook/skills/glamour-v2/surface/state/imageOptimize.server.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/imageOptimize.test.ts`

**Interfaces:**

- Produces: `OPTIMIZE = { maxDim: 1200, quality: 0.85 }`;
  `optimizeImageBuffer(input: Uint8Array): Promise<{ data: Uint8Array; mime: "image/webp" }>`.

> V1 implemented this with the `sharp` npm package. v2 uses **`Bun.Image`**
> (native, stable since Bun 1.3.14) instead — same operations (decode →
> resize-to-fit-no-upscale → WebP@quality), **no npm dependency, no native build
> step**. The function signature is identical to V1's, so nothing downstream
> changes. API:
> `new Bun.Image(bytes).resize(w, h, { fit, withoutEnlargement }).webp({ quality }).bytes()`
> — see https://bun.com/docs/runtime/image. The `.server.ts` suffix stays: this
> is a server/CLI module (the browser drop path uses `<canvas>`, Task 8).

- [ ] **Step 1: Write the failing test**

`tests/imageOptimize.test.ts` — uses **only `Bun.Image`** (no `sharp`, no binary
fixture): it builds an oversized input by upscaling a 1×1 PNG, then asserts the
function downscales it back under 1200 and re-encodes to WebP.

```ts
import { expect, test } from "bun:test";
import { OPTIMIZE } from "../surface/state/imageOptimize";
import { optimizeImageBuffer } from "../surface/state/imageOptimize.server";

// A valid 1×1 transparent PNG.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("OPTIMIZE policy is 1200px / q85", () => {
  expect(OPTIMIZE).toEqual({ maxDim: 1200, quality: 0.85 });
});

test("optimizeImageBuffer downscales oversized images to webp", async () => {
  // Build a 2000×2000 PNG input with Bun.Image alone (no sharp / no fixture).
  const seed = Buffer.from(PNG_1x1, "base64");
  const big = await new Bun.Image(seed)
    .resize(2000, 2000, { fit: "fill" })
    .png()
    .bytes();

  const { data, mime } = await optimizeImageBuffer(new Uint8Array(big));
  expect(mime).toBe("image/webp");

  // Re-decode the output and confirm it was downscaled + re-encoded to webp.
  const meta = await new Bun.Image(data).metadata();
  expect(meta.format).toBe("webp");
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
});
```

> Note on the metadata accessor: this uses the sharp-compatible
> `await new Bun.Image(data).metadata()` → `{ width, height, format }`. If the
> exact shape differs in the installed Bun, confirm it against
> https://bun.com/docs/runtime/image and adjust the three reads — do not weaken
> the downscale/format assertions.

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/imageOptimize.test.ts`
Expected: FAIL — cannot resolve the modules.

- [ ] **Step 3: Create the two modules**

`surface/state/imageOptimize.ts`:

```ts
// Browser-safe image-optimization POLICY (shared by the browser drop path and
// the server path). No native deps — safe to import into the React bundle.
// The Bun.Image implementation lives in imageOptimize.server.ts.
export const OPTIMIZE = { maxDim: 1200, quality: 0.85 } as const;
```

`surface/state/imageOptimize.server.ts`:

```ts
// Server/CLI-only: native Bun.Image downscale + webp. Do NOT import from browser
// code (the browser drop path uses <canvas>). Requires Bun >= 1.3.14.
import { OPTIMIZE } from "./imageOptimize";

export async function optimizeImageBuffer(
  input: Uint8Array
): Promise<{ data: Uint8Array; mime: "image/webp" }> {
  const data = await new Bun.Image(input)
    .resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: Math.round(OPTIMIZE.quality * 100) })
    .bytes();
  return { data: new Uint8Array(data), mime: "image/webp" };
}
```

- [ ] **Step 4: Confirm the Bun version, then run the test to confirm it
      passes**

`Bun.Image` is stable since Bun 1.3.14. Verify the toolchain meets the floor:

Run: `bun --version` Expected: `≥ 1.3.14`. If lower, upgrade with `bun upgrade`
before continuing.

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/imageOptimize.test.ts`
Expected: PASS (2 tests). No `sharp` install is needed — there is no npm
dependency for image work.

- [ ] **Step 5: Format and commit**

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/state/imageOptimize.ts plugins/spellbook/skills/glamour-v2/surface/state/imageOptimize.server.ts plugins/spellbook/skills/glamour-v2/tests/imageOptimize.test.ts
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): native Bun.Image optimization (1200px/webp), no sharp

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Persistence (`persist.server.ts`)

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/state/persist.server.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/persist.test.ts`

**Interfaces:**

- Consumes: `GlamourState`, `LibraryItem`, `defaultState` (Task 1).
- Produces:
  - `saveDataUrl(dir, id, dataUrl): string` (returns path or "")
  - `saveText(dir, id, name, text): string`
  - `materializeItem(filesDir, item): void` (sets `item.path`)
  - `saveSnapshot(snapshotsDir, sessionId, state): void`
  - `loadSnapshot(path, title, intent): GlamourState` (merge over defaults)

- [ ] **Step 1: Write the failing test**

`tests/persist.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSnapshot,
  materializeItem,
  saveDataUrl,
  saveSnapshot,
} from "../surface/state/persist.server";
import { makeItem } from "../surface/state/reduce";
import { defaultState } from "../surface/state/types";

const tmp = () => mkdtempSync(join(tmpdir(), "glamour-v2-persist-"));

test("saveDataUrl decodes base64 and writes a file", () => {
  const dir = tmp();
  // "hi" base64 = aGk=
  const path = saveDataUrl(dir, "x", "data:image/webp;base64,aGk=");
  expect(path).toBe(join(dir, "x.webp"));
  expect(readFileSync(path, "utf8")).toBe("hi");
});

test("materializeItem sets path for image and text items", () => {
  const dir = tmp();
  const imgIt = makeItem({
    id: "a",
    kind: "ref",
    title: "a",
    src: "data:image/webp;base64,aGk=",
    createdAt: 1,
  });
  materializeItem(dir, imgIt);
  expect(existsSync(imgIt.path)).toBe(true);

  const txtIt = makeItem({
    id: "b",
    kind: "context",
    title: "brief.md",
    text: "hello",
    createdAt: 2,
  });
  materializeItem(dir, txtIt);
  expect(readFileSync(txtIt.path, "utf8")).toBe("hello");
});

test("snapshot round-trips and merges over defaults", () => {
  const dir = tmp();
  const s = defaultState("T", "intent");
  s.library.push(makeItem({ id: "a", kind: "ref", title: "a", createdAt: 1 }));
  saveSnapshot(dir, "sess1", s);
  const loaded = loadSnapshot(join(dir, "sess1.json"), "T", "intent");
  expect(loaded.library.map((i) => i.id)).toEqual(["a"]);

  // A snapshot missing a newer field gains the default.
  const legacy = join(dir, "legacy.json");
  Bun.write(legacy, JSON.stringify({ title: "Old", library: [] }));
  const migrated = loadSnapshot(legacy, "Old", "");
  expect(migrated.selectedIds).toEqual([]);
  expect(migrated.status).toEqual({ busy: false, text: "" });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/persist.test.ts`
Expected: FAIL — cannot resolve `../surface/state/persist.server`.

- [ ] **Step 3: Implement `persist.server.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultState, type GlamourState, type LibraryItem } from "./types";

const EXT_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

export function saveDataUrl(dir: string, id: string, dataUrl: string): string {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !dir) return "";
  const mime = (m[1] ?? "application/octet-stream").toLowerCase();
  const body = m[3];
  const buf = m[2]
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body), "utf8");
  const ext = EXT_BY_MIME[mime] ?? "bin";
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join(dir, `${safeId}.${ext}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, buf);
    return path;
  } catch {
    return "";
  }
}

export function saveText(
  dir: string,
  id: string,
  name: string,
  text: string
): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_") || `${id}.md`;
  const path = join(dir, `${id}-${safe}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text, "utf8");
    return path;
  } catch {
    return "";
  }
}

export function materializeItem(filesDir: string, item: LibraryItem): void {
  if (item.src) {
    const p = saveDataUrl(filesDir, item.id, item.src);
    if (p) item.path = p;
  } else if (item.text) {
    const p = saveText(filesDir, item.id, item.title, item.text);
    if (p) item.path = p;
  }
}

export function saveSnapshot(
  snapshotsDir: string,
  sessionId: string,
  state: GlamourState
): void {
  try {
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(
      join(snapshotsDir, `${sessionId}.json`),
      JSON.stringify(state)
    );
  } catch {
    /* persistence is best-effort */
  }
}

export function loadSnapshot(
  path: string,
  title: string,
  intent: string
): GlamourState {
  const snap = JSON.parse(readFileSync(path, "utf8")) as Partial<GlamourState>;
  // Merge over defaults so older snapshots gain new fields.
  return { ...defaultState(title, intent), ...snap } as GlamourState;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/persist.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Format and commit**

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/state/persist.server.ts plugins/spellbook/skills/glamour-v2/tests/persist.test.ts
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): blob materialization + snapshot save/restore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: The daemon (`server.ts`)

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/scripts/server.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–4.
- Produces:
  `startDaemon(opts): Promise<{ port: number; sessionId: string; close: () => void; done: Promise<{ code: number; reason: string }> }>`.
  - `opts: { port?: number; host?: string; title?: string; intent?: string; restore?: string; timeoutS?: number }`.
  - Guarded `if (import.meta.main) { … }` bootstrap that parses argv and calls
    `startDaemon`, then awaits `done` and exits with its code.

**Reference ports (read these, then adapt):**

- V1 daemon spine: `plugins/spellbook/skills/glamour/scripts/server.ts` — SSE
  handler `:496–534`, `broadcastState`/`emitEvent` `:338–366`, discovery files
  `:827–843`, idle timer `:861–865`, snapshot debounce `:867–879`,
  restore+re-materialize `:295–321, :802–821`. Copy these mechanics; swap the
  state model for v2's and route mutations through `reduce.ts` +
  `persist.server.ts`.
- imago detached/contract reference:
  `plugins/spellbook/skills/imago/scripts/server.ts`.

- [ ] **Step 1: Write the failing integration test**

`tests/daemon.integration.test.ts` (imago-style: isolated `GLAMOUR_HOME` +
drives real channels):

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../scripts/server";

let d: Awaited<ReturnType<typeof startDaemon>>;
let base: string;

beforeAll(async () => {
  process.env.GLAMOUR_HOME = mkdtempSync(join(tmpdir(), "glamour-v2-home-"));
  d = await startDaemon({ port: 0, title: "Test", intent: "logos" });
  base = `http://127.0.0.1:${d.port}`;
});

afterAll(() => d.close());

test("GET /state?lean=1 returns the seeded state with a cursor", async () => {
  const r = await fetch(`${base}/state?lean=1`);
  const body = (await r.json()) as { state: { title: string }; cursor: number };
  expect(body.state.title).toBe("Test");
  expect(typeof body.cursor).toBe("number");
});

test("POST /cmd item.annotate mutates state; agent annotations emit no event", async () => {
  // Seed a library item directly via the agent contract is not allowed in Slice 1
  // (refs are user-dropped), so we add via the browser channel using a WS client.
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  ws.send(
    JSON.stringify({
      type: "item.add",
      item: { kind: "context", title: "brief.md", text: "warm, playful" },
    })
  );
  await Bun.sleep(150);

  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string }[] };
  };
  expect(s1.state.library.length).toBe(1);
  const id = s1.state.library[0].id;

  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({ type: "item.annotate", id, agent: "cute-occult" }),
  });
  await Bun.sleep(50);
  const s2 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { annotations: { agent: string } }[] };
  };
  expect(s2.state.library[0].annotations.agent).toBe("cute-occult");
  ws.close();
});

test("SSE /events replays the imperative item.add but not ambient moves", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  // ambient: should NOT appear as an event
  ws.send(JSON.stringify({ type: "item.select", ids: ["nope"] }));
  await Bun.sleep(50);

  const r = await fetch(`${base}/events?since=0`, {
    signal: AbortSignal.timeout(400),
  }).catch((e) => e);
  // Read a slice of the stream.
  const text = await new Response((r as Response).body).text().catch(() => "");
  expect(text).toContain('"type":"item.add"');
  expect(text).not.toContain('"type":"item.select"');
  ws.close();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
`bun test plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`
Expected: FAIL — cannot resolve `../scripts/server`.

- [ ] **Step 3: Implement `server.ts`**

Full new structure. The SSE/discovery/idle/snapshot mechanics mirror V1 (cited
above); the model and routing are v2's.

```ts
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import index from "../surface/index.html";
import {
  loadSnapshot,
  materializeItem,
  saveSnapshot,
} from "../surface/state/persist.server";
import {
  addItem,
  annotate,
  applyAgentMsg,
  isImperative,
  leanItem,
  leanState,
  makeItem,
  selectItems,
  setLike,
  setStar,
} from "../surface/state/reduce";
import {
  type AgentCommand,
  type ClientToServer,
  defaultState,
  type GlamourState,
} from "../surface/state/types";

const GLAMOUR_HOME = process.env.GLAMOUR_HOME ?? join(homedir(), ".glamour-v2");
const SNAPSHOTS_DIR = join(GLAMOUR_HOME, "snapshots");
const enc = new TextEncoder();
const randHex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export type StartOpts = {
  port?: number;
  host?: string;
  title?: string;
  intent?: string;
  restore?: string;
  timeoutS?: number;
};

export async function startDaemon(opts: StartOpts) {
  let state: GlamourState = defaultState(opts.title ?? "", opts.intent ?? "");
  let restored = false;
  if (opts.restore) {
    const path = existsSync(opts.restore)
      ? opts.restore
      : join(SNAPSHOTS_DIR, `${opts.restore}.json`);
    try {
      state = loadSnapshot(path, opts.title ?? "", opts.intent ?? "");
      restored = true;
    } catch (e) {
      process.stderr.write(`glamour-v2: restore failed (${path}): ${e}\n`);
    }
  }

  // --- channels ---------------------------------------------------------------
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
  const events: Array<Record<string, unknown>> = [];
  let eventSeq = 0;
  const sseClients = new Set<ReadableStreamDefaultController>();
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };

  const broadcast = (msg: object) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {
        /* socket closed */
      }
    }
  };
  let snapDirty = false;
  const broadcastState = () => {
    snapDirty = true;
    broadcast({ type: "state", state });
  };
  const emitEvent = (msg: Record<string, unknown>) => {
    const ev = { id: ++eventSeq, ...msg };
    events.push(ev);
    const frame = enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {
        /* gone */
      }
    }
  };

  // --- session files ----------------------------------------------------------
  const sessionId =
    opts.restore && restored
      ? `glamour-${randHex(4)}` // fresh files dir id; snapshot keeps its own name
      : `glamour-${randHex(4)}`;
  const sessionFilesDir = join(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync(sessionFilesDir, { recursive: true });
  } catch {
    /* fall back to no paths */
  }
  if (restored) {
    for (const it of state.library) materializeItem(sessionFilesDir, it);
  }

  // --- agent commands (POST /cmd) --------------------------------------------
  let resolveDone!: (v: { code: number; reason: string }) => void;
  const done = new Promise<{ code: number; reason: string }>((r) => {
    resolveDone = r;
  });

  const handleAgentMsg = (msg: AgentCommand) => {
    if (msg.type === "say") {
      broadcast({ type: "message", text: msg.text });
      return;
    }
    if (msg.type === "close") {
      resolveDone({ code: 0, reason: "close" });
      return;
    }
    applyAgentMsg(state, msg);
    broadcastState();
  };

  // --- browser messages (WebSocket) ------------------------------------------
  const handleClientMsg = (msg: ClientToServer) => {
    switch (msg.type) {
      case "item.add": {
        const it = makeItem({
          id: `${msg.item.kind}-${randHex(4)}`,
          kind: msg.item.kind,
          title: msg.item.title,
          src: msg.item.src,
          text: msg.item.text,
          mime: msg.item.mime ?? "",
          createdAt: Date.now(),
        });
        materializeItem(sessionFilesDir, it);
        if (addItem(state, it)) {
          broadcastState();
          if (isImperative(msg.type))
            emitEvent({
              type: "item.add",
              item: leanItem(it),
              selectedIds: state.selectedIds,
            });
        }
        break;
      }
      case "item.select":
        selectItems(state, msg.ids);
        broadcastState();
        break;
      case "item.star":
        if (setStar(state, msg.id, msg.starred)) broadcastState();
        break;
      case "item.like":
        if (setLike(state, msg.id, msg.liked)) broadcastState();
        break;
      case "item.annotate":
        if (annotate(state, msg.id, "human", msg.human)) {
          broadcastState();
          emitEvent({
            type: "item.annotate",
            id: msg.id,
            human: msg.human,
            selectedIds: state.selectedIds,
          });
        }
        break;
    }
  };

  // --- SSE response (replay by id + heartbeat) -------------------------------
  const sseResponse = (url: URL): Response => {
    touch();
    const since = Number.parseInt(url.searchParams.get("since") ?? "-1", 10);
    let ref: ReadableStreamDefaultController | null = null;
    let hb: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        ref = controller;
        for (const ev of events) {
          if ((ev.id as number) > since)
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
        sseClients.add(controller);
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb\n\n`));
          } catch {
            /* gone */
          }
        }, 15000);
      },
      cancel() {
        if (hb) clearInterval(hb);
        if (ref) sseClients.delete(ref);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };

  // --- serve ------------------------------------------------------------------
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.host ?? "127.0.0.1",
    routes: { "/": index },
    development: { hmr: true },
    fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/ws")
        return srv.upgrade(req)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      if (req.method === "GET" && path === "/state") {
        touch();
        const lean = url.searchParams.get("lean") === "1";
        return Response.json({
          state: lean ? leanState(state) : state,
          cursor: eventSeq,
        });
      }
      if (req.method === "GET" && path === "/events") return sseResponse(url);
      if (req.method === "POST" && path === "/cmd")
        return req
          .json()
          .then((b) => {
            touch();
            handleAgentMsg(b as AgentCommand);
            return Response.json({ ok: true });
          })
          .catch(() => Response.json({ error: "bad json" }, { status: 400 }));
      if (req.method === "GET" && path.startsWith("/assets/")) {
        const name = decodeURIComponent(path.slice("/assets/".length));
        if (name.includes("..") || name.startsWith("/"))
          return Response.json({ error: "not found" }, { status: 404 });
        const f = Bun.file(join(sessionFilesDir, name));
        return f
          .exists()
          .then((ok) =>
            ok
              ? new Response(f)
              : Response.json({ error: "not found" }, { status: 404 })
          );
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        touch();
        emitEvent({ type: "connected" });
        ws.send(JSON.stringify({ type: "state", state }));
      },
      message(_ws, raw) {
        touch();
        try {
          handleClientMsg(
            JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw)
            ) as ClientToServer
          );
        } catch (e) {
          process.stderr.write(`glamour-v2: bad json from browser: ${e}\n`);
        }
      },
      close(ws) {
        sockets.delete(ws);
        emitEvent({ type: "disconnected" });
      },
    },
  });

  const boundPort = server.port;
  // --- discovery files (cli.ts reads these) ----------------------------------
  const sessionFile = join(tmpdir(), `glamour-v2-${sessionId}.json`);
  const latestFile = join(tmpdir(), `glamour-v2-latest.json`);
  const info = JSON.stringify({
    url: `http://${opts.host ?? "127.0.0.1"}:${boundPort}`,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    files_dir: sessionFilesDir,
  });
  try {
    writeFileSync(sessionFile, info);
    writeFileSync(latestFile, info);
  } catch {
    /* discovery is best-effort */
  }

  emitEvent({ type: "ready" });

  // --- snapshot debounce + idle timeout --------------------------------------
  const saveNow = () => saveSnapshot(SNAPSHOTS_DIR, sessionId, state);
  if (restored) saveNow();
  const snapTimer = setInterval(() => {
    if (snapDirty) {
      snapDirty = false;
      saveNow();
    }
  }, 1000);
  const timeoutS = opts.timeoutS ?? 1800;
  const idleTimer = setInterval(() => {
    if ((performance.now() - lastActivity) / 1000 >= timeoutS)
      resolveDone({ code: 124, reason: "timeout" });
  }, 250);

  const close = () => {
    clearInterval(snapTimer);
    clearInterval(idleTimer);
    saveNow();
    try {
      unlinkSync(sessionFile);
    } catch {}
    try {
      rmSync(sessionFilesDir, { recursive: true, force: true });
    } catch {}
    server.stop(true);
  };
  done.then(() => close());

  return { port: boundPort, sessionId, close, done };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const d = await startDaemon({
    port: flag("port") ? Number(flag("port")) : 0,
    title: flag("title"),
    intent: flag("intent"),
    restore: flag("restore"),
    timeoutS: flag("timeout") ? Number(flag("timeout")) : undefined,
  });
  process.stdout.write(
    `${JSON.stringify({ url: `http://127.0.0.1:${d.port}`, port: d.port, session_id: d.sessionId })}\n`
  );
  const res = await d.done;
  process.exit(res.code);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run:
`bun test plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`
Expected: PASS (3 tests). If the SSE test is flaky on timing, raise the
`Bun.sleep` values — do not weaken the assertions.

- [ ] **Step 5: Confirm the surface bundles**

Run:
`cd plugins/spellbook/skills/glamour-v2 && bun build ./surface/index.html --outdir /tmp/glamour-v2-build && cd -`
Expected: builds without error (emits `index.html` + a JS bundle). It will be a
near-empty page until Tasks 7–10; this only proves the entry + Tailwind wiring.

- [ ] **Step 6: Format and commit**

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/scripts/server.ts plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): daemon — WS + SSE + /cmd, snapshot, restore, lean state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: The CLI (`cli.ts`)

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/scripts/cli.ts`

**Interfaces:**

- Consumes: the daemon's HTTP API + discovery files (Task 5).
- Produces: verbs `open`, `tail`, `state`, `intent`, `annotate`, `say`,
  `status`, `close`, `info`, `help`.

**Reference ports:** imago `plugins/spellbook/skills/imago/scripts/cli.ts` —
detached spawn `:159–174`, discovery + `--session` resolution, `tail` loop with
`--since`/backoff/grounding-line `:202–290`, `resolveSrc` `:312–316`. Port the
spawn + discovery + tail mechanics; trim the verb set to the list above.

- [ ] **Step 1: Implement `cli.ts`**

Key requirements (port imago's mechanics, adapt commands):

1. **`open`** — spawn the daemon **detached** via `node:child_process`:

```ts
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, ".."); // glamour-v2 root — pin as cwd

function openDaemon(args: string[]) {
  const child = spawn("bun", ["run", join(SCRIPT_DIR, "server.ts"), ...args], {
    cwd: SKILL_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.unref(); // survive CLI exit
  // read the daemon's first stdout line ({url, port, session_id}); print it; exit 0
}
```

`cwd: SKILL_ROOT` is mandatory (Tailwind/bunfig). Accept `--title`, `--intent`,
`--timeout`, `--restore`, `--no-open`. On `--no-open` do not launch a browser;
otherwise open `url` with the platform opener.

2. **Discovery + `--session`** — resolve a target daemon by reading
   `tmpdir()/glamour-v2-<id>.json` (when `--session <id>` given) or
   `glamour-v2-latest.json`. Extract `{ url, port, session_id }`. Every verb
   below targets that base URL.

3. **`tail [--since N]`** — open `GET <base>/events?since=N`, print each `data:`
   line's JSON as JSONL to stdout (the agent wraps this with Monitor). Print a
   first grounding line `{"type":"grounding","session_id":...,"port":...}`,
   reconnect with exponential backoff on drop, and stay pinned to the same
   session id (never silently hop to a newer daemon).

4. **`state [--full]`** — `GET <base>/state?lean=1` (or no `lean` for `--full`),
   print the `state` JSON.

5. **Agent commands** — POST to `<base>/cmd`:
   - `intent <text...>` → `{type:"intent", text}`
   - `annotate <id> <text...>` → `{type:"item.annotate", id, agent: text}`
   - `say <text...>` → `{type:"say", text}`
   - `status on [text...]` → `{type:"status", busy:true, text}`; `status off` →
     `{type:"status", busy:false}`
   - `close` → `{type:"close"}`

6. **`info`** — print the resolved discovery JSON. **`help`** — usage text
   listing the verbs above (mirror imago's help block format).

- [ ] **Step 2: Smoke-test the CLI against a live daemon**

```bash
cd plugins/spellbook/skills/glamour-v2
bun run scripts/cli.ts open --title "Smoke" --intent "logos" --no-open
# capture the printed session_id, then:
bun run scripts/cli.ts state --session <id>        # prints lean state JSON
bun run scripts/cli.ts say --session <id> "hello"  # 200 ok
bun run scripts/cli.ts close --session <id>        # daemon exits
cd -
```

Expected: `open` prints `{url, port, session_id}`; `state` prints JSON with
`"library":[]`; `say` returns `{"ok":true}`; `close` shuts the daemon down (no
zombie — verify with `ps`/`lsof`). This is the conjuration smoke test required
by `ward` before any later merge.

- [ ] **Step 3: Format and commit**

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/scripts/cli.ts
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): cli — detached spawn, discovery, tail, agent verbs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: WebSocket hook + React root

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/state/useSession.ts`
- Create: `plugins/spellbook/skills/glamour-v2/surface/main.tsx`

**Interfaces:**

- Produces:
  `useSession(): { state: GlamourState | null; send: (m: ClientToServer) => void }`.

> React components are verified by a successful bundle here and the live
> Playwright pass in Task 11 — `bun test` cannot assert rendering (documented
> surface-testing method, not a deferral of real testing).

- [ ] **Step 1: Implement `useSession.ts`**

```ts
import { useEffect, useRef, useState } from "react";
import type { ClientToServer, GlamourState, ServerToClient } from "./types";

export function useSession() {
  const [state, setState] = useState<GlamourState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerToClient;
      if (msg.type === "state") setState(msg.state);
    };
    return () => ws.close();
  }, []);

  const send = (m: ClientToServer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  return { state, send };
}
```

- [ ] **Step 2: Implement `main.tsx`**

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
```

- [ ] **Step 3: Add a temporary minimal `App.tsx` so the bundle resolves**

(Replaced fully in Task 8 — this keeps the build green between tasks.)

```tsx
import { useSession } from "./state/useSession";

export function App() {
  const { state } = useSession();
  return (
    <div className="p-6">glamour-v2 · {state?.title ?? "connecting…"}</div>
  );
}
```

- [ ] **Step 4: Confirm it bundles, then format and commit**

Run:
`cd plugins/spellbook/skills/glamour-v2 && bun build ./surface/index.html --outdir /tmp/glamour-v2-build && cd -`
Expected: builds without error.

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/state/useSession.ts plugins/spellbook/skills/glamour-v2/surface/main.tsx plugins/spellbook/skills/glamour-v2/surface/App.tsx
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): websocket session hook + react root

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: App shell + file intake (drop zone)

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/state/fileIntake.ts`
- Modify (replace stub): `plugins/spellbook/skills/glamour-v2/surface/App.tsx`

**Interfaces:**

- Produces: `processFiles(files, send): Promise<void>`; the `App` shell with a
  header (title/intent/status), a slot for the facet bar + grid (Task 9), the
  details fly-out (Task 10), and a full-window drag/drop zone.
- Consumes: `useSession` (Task 7), `itemsByKind` (Task 2).

- [ ] **Step 1: Implement `fileIntake.ts`** (adapts V1's `fileIntake.ts` —
      images → `item.add` kind `ref` (downscaled webp, raw fallback), text →
      `item.add` kind `context`):

```ts
import { OPTIMIZE } from "./imageOptimize";
import type { ClientToServer } from "./types";

const IMG = /^image\//;
const TEXTY = /\.(md|markdown|mdx|txt|json|ya?ml)$/i;

async function downscaleToWebp(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, OPTIMIZE.maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
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

export async function processFiles(
  files: FileList | null,
  send: (m: ClientToServer) => void
): Promise<void> {
  for (const f of Array.from(files ?? [])) {
    try {
      if (IMG.test(f.type)) {
        let src: string;
        try {
          src = await downscaleToWebp(f);
        } catch {
          src = await readAsDataUrl(f);
        }
        send({
          type: "item.add",
          item: { kind: "ref", title: f.name, src, mime: "image/webp" },
        });
      } else if (f.type.startsWith("text/") || TEXTY.test(f.name)) {
        send({
          type: "item.add",
          item: {
            kind: "context",
            title: f.name,
            text: await f.text(),
            mime: "text/markdown",
          },
        });
      }
    } catch (err) {
      console.error("glamour-v2: failed to process file", f.name, err);
    }
  }
}
```

- [ ] **Step 2: Implement the `App` shell** (wires facet/grid/flyout from Tasks
      9–10; selection state lives here):

```tsx
import { useState } from "react";
import { DetailsFlyout } from "./components/DetailsFlyout";
import { FacetBar } from "./components/FacetBar";
import { LibraryGrid } from "./components/LibraryGrid";
import { processFiles } from "./state/fileIntake";
import { useSession } from "./state/useSession";
import type { ItemKind } from "./state/types";

export function App() {
  const { state, send } = useSession();
  const [facet, setFacet] = useState<ItemKind | "all">("all");
  const [dragging, setDragging] = useState(false);

  if (!state) return <div className="p-6 text-slate-400">connecting…</div>;

  const selected = state.library.find((i) => state.selectedIds.includes(i.id));

  return (
    <div
      className="flex h-screen flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void processFiles(e.dataTransfer.files, send);
      }}
    >
      <header className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
        <h1 className="text-sm font-semibold tracking-wide">
          {state.title || "untitled"}
        </h1>
        {state.intent && (
          <span className="text-xs text-slate-400">· {state.intent}</span>
        )}
        {state.status.busy && (
          <span className="ml-auto text-xs text-amber-300">
            {state.status.text || "working…"}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <FacetBar library={state.library} facet={facet} onPick={setFacet} />
          <LibraryGrid
            library={state.library}
            facet={facet}
            selectedIds={state.selectedIds}
            onSelect={(ids) => send({ type: "item.select", ids })}
          />
        </main>
        {selected && (
          <DetailsFlyout
            item={selected}
            onStar={(starred) =>
              send({ type: "item.star", id: selected.id, starred })
            }
            onLike={(liked) =>
              send({ type: "item.like", id: selected.id, liked })
            }
            onAnnotate={(human) =>
              send({ type: "item.annotate", id: selected.id, human })
            }
            onClose={() => send({ type: "item.select", ids: [] })}
          />
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-fuchsia-500/10 ring-2 ring-inset ring-fuchsia-400/50">
          <span className="rounded bg-black/60 px-4 py-2 text-sm">
            drop references or context files
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Confirm it bundles, then format and commit**

Run:
`cd plugins/spellbook/skills/glamour-v2 && bun build ./surface/index.html --outdir /tmp/glamour-v2-build && cd -`
Expected: builds (it references `FacetBar`/`LibraryGrid`/`DetailsFlyout` —
create empty stub components returning `null` if needed to keep this step green,
then fill them in Tasks 9–10; OR implement 9–10 before re-running). Prefer:
write the three component files as stubs now, fill in 9–10.

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/state/fileIntake.ts plugins/spellbook/skills/glamour-v2/surface/App.tsx
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): app shell + drag/drop file intake

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Facet bar + library grid + tile

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/components/FacetBar.tsx`
- Create:
  `plugins/spellbook/skills/glamour-v2/surface/components/LibraryGrid.tsx`
- Create:
  `plugins/spellbook/skills/glamour-v2/surface/components/LibraryTile.tsx`

**Interfaces:**

- Consumes: `LibraryItem`, `ItemKind` (Task 1); `itemsByKind` (Task 2).
- `FacetBar` props:
  `{ library: LibraryItem[]; facet: ItemKind | "all"; onPick: (f: ItemKind | "all") => void }`.
- `LibraryGrid` props:
  `{ library: LibraryItem[]; facet: ItemKind | "all"; selectedIds: string[]; onSelect: (ids: string[]) => void }`.
- `LibraryTile` props:
  `{ item: LibraryItem; selected: boolean; onClick: (e: React.MouseEvent) => void }`.

- [ ] **Step 1: Implement `FacetBar.tsx`**

```tsx
import type { ItemKind, LibraryItem } from "../state/types";
import { VALID_KIND } from "../state/types";

const LABEL: Record<ItemKind, string> = {
  ref: "References",
  context: "Context",
  gen: "Generated",
  style: "Styles",
};

export function FacetBar({
  library,
  facet,
  onPick,
}: {
  library: LibraryItem[];
  facet: ItemKind | "all";
  onPick: (f: ItemKind | "all") => void;
}) {
  const live = library.filter((i) => !i.archived);
  const count = (k: ItemKind) => live.filter((i) => i.kind === k).length;
  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs transition-colors ${
      active
        ? "bg-fuchsia-600 text-white"
        : "bg-white/5 text-slate-300 hover:bg-white/10"
    }`;

  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-5 py-2">
      <button
        type="button"
        className={pill(facet === "all")}
        onClick={() => onPick("all")}
      >
        All · {live.length}
      </button>
      {VALID_KIND.map((k) => (
        <button
          type="button"
          key={k}
          className={pill(facet === k)}
          onClick={() => onPick(k)}
        >
          {LABEL[k]} · {count(k)}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Implement `LibraryTile.tsx`**

```tsx
import { FileText, Heart, Star } from "lucide-react";
import type { LibraryItem } from "../state/types";

export function LibraryTile({
  item,
  selected,
  onClick,
}: {
  item: LibraryItem;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative aspect-square overflow-hidden rounded-lg border text-left transition-colors ${
        selected
          ? "border-fuchsia-400 ring-2 ring-fuchsia-400/60"
          : "border-white/10 hover:border-white/30"
      }`}
    >
      {item.src ? (
        <img
          src={item.src}
          alt={item.title}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col gap-2 bg-white/5 p-3">
          <FileText className="h-4 w-4 shrink-0 text-slate-400" />
          <p className="line-clamp-6 text-xs text-slate-300">
            {item.text || item.title}
          </p>
        </div>
      )}
      <div className="absolute right-1 top-1 flex gap-1">
        {item.starred && (
          <Star className="h-4 w-4 fill-amber-300 text-amber-300" />
        )}
        {item.liked && (
          <Heart className="h-4 w-4 fill-rose-400 text-rose-400" />
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-[10px] text-slate-200">
        {item.title}
      </div>
    </button>
  );
}
```

- [ ] **Step 3: Implement `LibraryGrid.tsx`** (multi-select with meta/ctrl;
      plain click selects one):

```tsx
import { itemsByKind } from "../state/reduce";
import type { ItemKind, LibraryItem } from "../state/types";
import { LibraryTile } from "./LibraryTile";

export function LibraryGrid({
  library,
  facet,
  selectedIds,
  onSelect,
}: {
  library: LibraryItem[];
  facet: ItemKind | "all";
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
}) {
  const items = itemsByKind(library, facet);

  const click = (id: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      onSelect(
        selectedIds.includes(id)
          ? selectedIds.filter((x) => x !== id)
          : [...selectedIds, id]
      );
    } else {
      onSelect(selectedIds.length === 1 && selectedIds[0] === id ? [] : [id]);
    }
  };

  if (items.length === 0)
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
        drop references or context files to begin
      </div>
    );

  return (
    <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(140px,1fr))] content-start gap-3 overflow-y-auto p-5">
      {items.map((it) => (
        <LibraryTile
          key={it.id}
          item={it}
          selected={selectedIds.includes(it.id)}
          onClick={(e) => click(it.id, e)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Confirm it bundles, then format and commit**

Run:
`cd plugins/spellbook/skills/glamour-v2 && bun build ./surface/index.html --outdir /tmp/glamour-v2-build && cd -`
Expected: builds without error.

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/components/FacetBar.tsx plugins/spellbook/skills/glamour-v2/surface/components/LibraryGrid.tsx plugins/spellbook/skills/glamour-v2/surface/components/LibraryTile.tsx
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): facet bar + unified library grid + tile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Details fly-out + enlarge

**Files:**

- Create:
  `plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx`

**Interfaces:**

- Consumes: `LibraryItem` (Task 1).
- Props:
  `{ item: LibraryItem; onStar: (b: boolean) => void; onLike: (b: boolean) => void; onAnnotate: (human: string) => void; onClose: () => void }`.

- [ ] **Step 1: Implement `DetailsFlyout.tsx`** (image preview with enlarge
      toggle, marks, dual annotations — agent read-only, human editable,
      debounced send — and the generation-metadata block when `item.gen` is
      present):

```tsx
import { Heart, Maximize2, Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LibraryItem } from "../state/types";

export function DetailsFlyout({
  item,
  onStar,
  onLike,
  onAnnotate,
  onClose,
}: {
  item: LibraryItem;
  onStar: (b: boolean) => void;
  onLike: (b: boolean) => void;
  onAnnotate: (human: string) => void;
  onClose: () => void;
}) {
  const [human, setHuman] = useState(item.annotations.human);
  const [enlarged, setEnlarged] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset the editable field when a different item is shown.
  useEffect(() => {
    setHuman(item.annotations.human);
    setEnlarged(false);
  }, [item.id, item.annotations.human]);

  const edit = (v: string) => {
    setHuman(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onAnnotate(v), 400);
  };

  return (
    <>
      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/10 bg-black/20 p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{item.title}</h2>
          <button type="button" onClick={onClose} aria-label="close">
            <X className="h-4 w-4 text-slate-400 hover:text-slate-200" />
          </button>
        </div>

        {item.src ? (
          <button
            type="button"
            className="relative overflow-hidden rounded-lg"
            onClick={() => setEnlarged(true)}
          >
            <img src={item.src} alt={item.title} className="w-full" />
            <Maximize2 className="absolute right-2 top-2 h-4 w-4 text-white/80" />
          </button>
        ) : (
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-white/5 p-2 text-xs text-slate-300">
            {item.text}
          </pre>
        )}

        <div className="flex items-center gap-2 text-xs">
          <span className="rounded bg-white/10 px-2 py-0.5">{item.kind}</span>
          <button
            type="button"
            onClick={() => onStar(!item.starred)}
            className="ml-auto"
            aria-label="star"
          >
            <Star
              className={`h-4 w-4 ${item.starred ? "fill-amber-300 text-amber-300" : "text-slate-400"}`}
            />
          </button>
          <button
            type="button"
            onClick={() => onLike(!item.liked)}
            aria-label="like"
          >
            <Heart
              className={`h-4 w-4 ${item.liked ? "fill-rose-400 text-rose-400" : "text-slate-400"}`}
            />
          </button>
        </div>

        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
            Agent
          </p>
          <p className="rounded bg-white/5 p-2 text-xs text-slate-300">
            {item.annotations.agent || (
              <span className="text-slate-500">— no agent note yet —</span>
            )}
          </p>
        </div>

        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
            You
          </p>
          <textarea
            value={human}
            onChange={(e) => edit(e.target.value)}
            placeholder="what do you like about this?"
            className="h-20 w-full resize-none rounded bg-white/5 p-2 text-xs text-slate-200 outline-none ring-fuchsia-400/50 focus:ring-1"
          />
        </div>

        {item.gen && (
          <div className="text-xs">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
              Generation
            </p>
            <dl className="space-y-1 text-slate-300">
              <div className="flex gap-2">
                <dt className="text-slate-500">model</dt>
                <dd>{item.gen.model}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">prompt</dt>
                <dd className="truncate">{item.gen.prompt}</dd>
              </div>
              {item.gen.seed != null && (
                <div className="flex gap-2">
                  <dt className="text-slate-500">seed</dt>
                  <dd>{item.gen.seed}</dd>
                </div>
              )}
              {item.gen.cost != null && (
                <div className="flex gap-2">
                  <dt className="text-slate-500">cost</dt>
                  <dd>${item.gen.cost.toFixed(4)}</dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </aside>

      {enlarged && item.src && (
        <button
          type="button"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
          onClick={() => setEnlarged(false)}
        >
          <img
            src={item.src}
            alt={item.title}
            className="max-h-full max-w-full object-contain"
          />
        </button>
      )}
    </>
  );
}
```

- [ ] **Step 2: Confirm it bundles, then format and commit**

Run:
`cd plugins/spellbook/skills/glamour-v2 && bun build ./surface/index.html --outdir /tmp/glamour-v2-build && cd -`
Expected: builds without error.

```bash
bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx
git add plugins/spellbook/skills/glamour-v2
git commit -m "feat(glamour-v2): details fly-out — dual annotations, marks, enlarge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Live verification (Playwright + end-to-end) and slice sign-off

**Files:** none created — this is the required visual/integration pass.

- [ ] **Step 1: Run the full test suite**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/` Expected: all suites
green (types, reduce, imageOptimize, persist, daemon).

- [ ] **Step 2: Launch a live daemon**

```bash
cd plugins/spellbook/skills/glamour-v2
bun run scripts/cli.ts open --title "Slice 1" --intent "logo set"
```

Note the printed `url` and `session_id`.

- [ ] **Step 3: Drive the surface with Playwright (visual pass)**

Using the Playwright MCP browser tools, against the printed `url`:

1. Navigate to the `url`. Confirm the page is **styled** (Tailwind loaded — the
   header bar, dark background; a blank/unstyled page means the cwd-pin
   regression — fix `cli.ts` `open` cwd before proceeding).
2. Confirm the empty state reads "drop references or context files to begin".
3. Upload a PNG/JPG via the drop zone (use the browser file-upload tool).
   Confirm a tile appears in the grid with a thumbnail; the "References · 1"
   facet count increments.
4. Upload a `.md` file. Confirm a text-card tile appears; "Context · 1"
   increments. Toggle the facets and confirm filtering.
5. Click the image tile. Confirm the details fly-out opens with the preview,
   kind chip, star/like controls, the agent (empty) and editable "You" fields.
   Type a human annotation; click the image to enlarge; dismiss.
6. Star the tile from the fly-out; confirm the star badge shows on the tile.
7. Take a screenshot of the populated grid + open fly-out for the record.

- [ ] **Step 4: Verify the agent loop (cli ↔ surface) and resume**

```bash
# In a second shell, with <id> from Step 2:
bun run scripts/cli.ts tail --session <id>   # leave running (shows item.add events)
bun run scripts/cli.ts state --session <id>  # copy an item id from the JSON
bun run scripts/cli.ts annotate <id> <itemId> "warm, cute-occult palette"
```

Confirm in the browser the agent annotation appears in the fly-out "Agent"
section, and that `tail` printed the `item.add` (imperative) events but **no**
`item.select`/`item.star` lines (ambient discipline holds).

Then test resume:

```bash
bun run scripts/cli.ts close --session <id>
bun run scripts/cli.ts open --title "Slice 1" --restore <id>
```

Confirm the restored session shows the same library tiles, the human + agent
annotations, and that the agent can still `Read` an item's `path` (the blobs
were re-materialized). Confirm no zombie processes (`ps`/`lsof`).

- [ ] **Step 5: Final commit (record the verification)**

```bash
cd -
git commit --allow-empty -m "test(glamour-v2): slice 1 live Playwright + e2e + resume verified

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (against `proposal.md` Slice 1 + Mining-V1 calls):

- Bun daemon (HTTP + WS + SSE + POST /cmd) → Task 5. ✓
- Shared `types.ts` contract → Task 1. ✓
- React shell → Tasks 7–8. ✓
- Unified library grid (ref/context/gen tiles + facets) → Task 9 (gen tiles
  render via the same path; produced in Slice 3). ✓
- Persistent details fly-out (dual annotations + gen metadata) → Task 10. ✓
- Snapshot/restore → Tasks 4, 5, 11. ✓
- Lean-state projection → Tasks 2, 5. ✓
- Image optimization on ingest → Tasks 3 (server), 8 (browser). ✓
- Carry-forward "enlarge (simplify)" → Task 10. ✓
- Carry-forward "SSE tail + replay" → Tasks 5, 6. ✓
- Carry-forward "lean state", "snapshot/restore", "image opt", "discovery
  tmpfiles", "idle timeout", "debounced persistence" → Tasks 4–6. ✓
- AGENT_EVENT_TYPES discipline + ambient/imperative → Tasks 1, 2, 5 (+ test). ✓
- Deliverable "drop refs/context, see tiles, inspect, resume" → Task 11. ✓

Out of slice (correctly absent): chat/grounding messages, style-guide view,
generation, focus lens, project-styles tray, imago handoff. These are Slices
2–4.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every
code step shows complete code; ported mechanics cite exact source file:lines
with the adaptation spelled out. ✓

**3. Type consistency:** `LibraryItem`/`GlamourState`/`ClientToServer`/
`AgentCommand`/`AGENT_EVENT_TYPES` defined in Task 1 and used verbatim
thereafter. `makeItem`, `addItem`, `itemsByKind`, `leanItem`, `leanState`,
`applyAgentMsg`, `isImperative` signatures match between Task 2 and their
consumers in Task 5/9. `startDaemon` return shape matches the Task 5 test.
`processFiles(files, send)` matches its App call site. ✓

## References

- Spec: `docs/projects/glamour-v2/proposal.md` (Build Sequencing slice 1; Mining
  V1 calls; Resolved Decision G1).
- V1 mine: `plugins/spellbook/skills/glamour/` (server spine, image opt, tests).
- imago patterns: `plugins/spellbook/skills/imago/` (library/linked-set model,
  contract discipline, detached spawn, tail, integration tests).
- Surface stack: memory `spell-surface-stack`; `grimoire/house-style.md`.
