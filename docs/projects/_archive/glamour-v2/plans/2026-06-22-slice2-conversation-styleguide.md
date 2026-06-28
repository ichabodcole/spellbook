# Glamour v2 — Slice 2: Conversation + Grounding + Style Guide — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the co-presence heart to glamour-v2 — a grounded chat sidebar
(select-to-ground deixis), agent dialogue that lands in the conversation, and an
agent-assembled Style-guide view whose sections fill in (empty → forming →
agreed) — on top of the Slice-1 unified-library skeleton.

**Architecture:** Extend the existing single shared `types.ts` contract with
`messages[]` and `styleGuide[]` on `GlamourState`. Sending a chat message is an
**imperative** (server snapshots the current `selectedIds` as the message's
grounding set and emits a new `message.user` agent event); selecting tiles stays
**ambient** (Slice-1 discipline, unchanged). The agent posts dialogue via the
existing `say` verb (now appended to the conversation, not a dead toast) and
shapes the six style-guide sections via a new `section` command. The surface
gains a right-hand `Conversation` sidebar and a library/style **view toggle**;
the style guide is a read-mostly view that reflects section status. This slice
also folds in the deferred Slice-1 Minors.

**Tech Stack:** Bun ≥ 1.3.14, React 19 (bundled by Bun), bun-plugin-tailwind,
Tailwind v4 (CSS-first), lucide-react. No new dependencies.

## Global Constraints

- v2 lives at `plugins/spellbook/skills/glamour-v2/`; it stays **unlisted** (no
  `SKILL.md`, not in any synced listing) until the post-Slice-4 cutover. **V1
  (`plugins/spellbook/skills/glamour/`) is never touched by this slice.**
- **One shared contract:** all channels import `surface/state/types.ts`. Never
  hand-roll a message/event shape outside it.
- **`AGENT_EVENT_TYPES` is the frozen allowlist** of server→agent SSE event
  types. The only events emitted are members of this set. This slice adds
  exactly one new member: `"message.user"`.
- **Ambient vs. imperative:** board moves (`item.select` / `item.star` /
  `item.like`) mutate state + broadcast only — **no** agent event. Imperatives
  (`item.add`, `item.annotate`, and the new `message.send`) mutate state,
  broadcast, **and** `emitEvent` carrying the grounding context. `message.send`
  carries `ground` (a snapshot of `selectedIds`). Agent-origin commands (`say`,
  `section`, `intent`, `status`) broadcast state but emit **no** agent event
  (the agent already knows what it did).
- **Purity boundary:** pure reducers in `reduce.ts` never call `Date.now()` /
  `crypto`. The server constructs ids + timestamps and passes built records into
  reducers — mirror Slice-1's `makeItem({ createdAt })` pattern.
- **Daemon spawn cwd-pin** (Tailwind/bunfig reads cwd) is unchanged — no task
  here touches `cli.ts open`'s spawn.
- **Live Playwright e2e is mandatory and controller-run** (Task 8) before the
  whole-branch review — subagents have no live browser.
- **Formatting:** biome on changed `.ts`/`.tsx`/`.json`; prettier on `.md`.
  Pre-commit hooks enforce both.
- **Commit trailer** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Run tests with `bun test`** (not jest/vitest), from the repo root.

---

## File Structure

**Modified:**

- `plugins/spellbook/skills/glamour-v2/surface/state/types.ts` — add `Message`,
  `MessageKind`, `FeedbackMode`, `SectionStatus`, `SectionKey`, `StyleSection`;
  extend `GlamourState` with `messages` + `styleGuide`; add
  `defaultStyleGuide()` and extend `defaultState()`; extend `AgentCommand`
  (`say` gains `kind`; new `section`); add `ClientToServer` `message.send`; add
  `"message.user"` to `AGENT_EVENT_TYPES`; drop the dead `{type:"message"}`
  `ServerToClient` toast.
- `plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts` — add
  `addMessage`, `updateSection`; extend `applyAgentMsg` with a `section` case.
- `plugins/spellbook/skills/glamour-v2/scripts/server.ts` — handle
  `message.send` (build user message, snapshot ground, emit `message.user`);
  route agent `say` into the conversation; route `section`; make
  `connected`/`disconnected` **stream-only** (not replayed); the `say` toast
  path is removed.
- `plugins/spellbook/skills/glamour-v2/scripts/cli.ts` — add a `section` verb
  and a `--kind` flag on `say`; refresh `help`.
- `plugins/spellbook/skills/glamour-v2/surface/App.tsx` — add the right-hand
  `Conversation` sidebar, the library/style view toggle, wire `message.send`;
  remount `DetailsFlyout` with `key`; add a click-to-pick file input.
- `plugins/spellbook/skills/glamour-v2/surface/state/fileIntake.ts` — send the
  **actual** mime on raw fallback (the deferred mime-vs-bytes Minor); export a
  `pickFiles` helper for click-to-pick.
- `plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx` —
  drop the now-redundant item-reset effect + its biome-ignore (replaced by the
  `key` remount in `App.tsx`).
- Tests: `tests/types.test.ts`, `tests/reduce.test.ts`,
  `tests/daemon.integration.test.ts`.

**Created:**

- `plugins/spellbook/skills/glamour-v2/surface/components/MessageBubble.tsx` —
  one conversation message (who-alignment, kind styling, grounding chip).
- `plugins/spellbook/skills/glamour-v2/surface/components/Conversation.tsx` —
  the chat sidebar: message list + composer with grounding banner +
  correct/augment toggle.
- `plugins/spellbook/skills/glamour-v2/surface/components/StyleGuide.tsx` — the
  six-section style-guide view with status dots/badges, content, and prompts.
- `plugins/spellbook/skills/glamour-v2/tests/cli.test.ts` — unit coverage for
  the new CLI argument construction (the `section` verb + `say --kind`).

---

## Data-model design (the contract this slice locks in)

Carried-forward V1 mapping (proposal "Mining V1"): V1's narration kinds
(`info|working|result|error`) become **agent message kinds**; V1's spec modules
(`palette`, `consistency`) + `understanding` + `recreatePrompt` map onto the
**style-guide sections** (the mockup is authoritative for v2's section set:
`Understanding`, `Direction`, `Palette`, `Consistency`, `Re-cast prompts`,
`Canonical images`); V1's `mode: "correct" | "augment"` rides on the user's
grounded message. V1's `model` lives in generation metadata (`GenMeta`, Slice
3), not the style guide. `Canonical images` section exists now but is
**populated** in Slice 4 — Slice 2 fills its `content`/`status` only.

---

### Task 1: Extend the shared contract

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/state/types.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/types.test.ts`

**Interfaces:**

- Consumes (existing): `ItemKind`, `LibraryItem`, `GlamourState`, `LeanState`,
  `AgentCommand`, `ClientToServer`, `AGENT_EVENT_TYPES`, `defaultState`.
- Produces (later tasks rely on these exact shapes):
  - `type MessageKind = "info" | "working" | "result" | "error"`
  - `type FeedbackMode = "correct" | "augment"`
  - `type Message = { id: string; who: "user" | "agent"; kind: MessageKind; text: string; ground: string[]; mode: FeedbackMode | null; ts: number }`
  - `type SectionStatus = "empty" | "forming" | "agreed"`
  - `type SectionKey = "understanding" | "direction" | "palette" | "consistency" | "prompts" | "canonical"`
  - `type StyleSection = { key: SectionKey; label: string; status: SectionStatus; content: string; prompts: string[] }`
  - `GlamourState` gains `messages: Message[]` and `styleGuide: StyleSection[]`
  - `AgentCommand` gains
    `{ type: "section"; key: SectionKey; content?: string; status?: SectionStatus; prompts?: string[] }`;
    the `say` variant gains optional `kind?: MessageKind`
  - `ClientToServer` gains
    `{ type: "message.send"; text: string; mode: FeedbackMode | null }`
  - `AGENT_EVENT_TYPES` gains `"message.user"`
  - `defaultStyleGuide(): StyleSection[]`

- [ ] **Step 1: Write the failing tests**

Add to `plugins/spellbook/skills/glamour-v2/tests/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  AGENT_EVENT_TYPES,
  defaultState,
  defaultStyleGuide,
} from "../surface/state/types";

describe("Slice 2 contract", () => {
  test("defaultState seeds an empty conversation and a full style guide", () => {
    const s = defaultState("t", "i");
    expect(s.messages).toEqual([]);
    expect(s.styleGuide).toHaveLength(6);
    expect(s.styleGuide.map((x) => x.key)).toEqual([
      "understanding",
      "direction",
      "palette",
      "consistency",
      "prompts",
      "canonical",
    ]);
    expect(s.styleGuide.every((x) => x.status === "empty")).toBe(true);
  });

  test("defaultStyleGuide carries the mockup's display labels", () => {
    const labels = defaultStyleGuide().map((x) => x.label);
    expect(labels).toEqual([
      "Understanding",
      "Direction",
      "Palette",
      "Consistency",
      "Re-cast prompts",
      "Canonical images",
    ]);
  });

  test("message.user is the only new agent event type", () => {
    expect(AGENT_EVENT_TYPES).toContain("message.user");
    // Ambient board moves are never agent events.
    expect(AGENT_EVENT_TYPES).not.toContain("item.select");
    expect(AGENT_EVENT_TYPES).not.toContain("message.send");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/types.test.ts`
Expected: FAIL — `defaultStyleGuide` is not exported; `s.messages` is undefined.

- [ ] **Step 3: Implement the contract additions**

In `surface/state/types.ts`, add the new types after `GenMeta`/`LibraryItem`
(before `GlamourState`):

```ts
// Conversation. Agent message kinds carry V1's narration semantics
// (info | working | result | error); user messages are always "info".
export type MessageKind = "info" | "working" | "result" | "error";
export type FeedbackMode = "correct" | "augment";
export type Message = {
  id: string;
  who: "user" | "agent";
  kind: MessageKind;
  text: string;
  ground: string[]; // item ids grounding this message (snapshot of selectedIds); [] if none
  mode: FeedbackMode | null; // user feedback framing; null when not a correction/augmentation
  ts: number;
};

// The agent-assembled style guide. Section set + labels are the mockup's
// (the converged surface). Sections fill in: empty → forming → agreed.
export type SectionStatus = "empty" | "forming" | "agreed";
export type SectionKey =
  | "understanding"
  | "direction"
  | "palette"
  | "consistency"
  | "prompts"
  | "canonical";
export type StyleSection = {
  key: SectionKey;
  label: string;
  status: SectionStatus;
  content: string; // prose
  prompts: string[]; // populated for the "prompts" section; [] elsewhere
};
```

Extend `GlamourState`:

```ts
export type GlamourState = {
  title: string;
  intent: string;
  library: LibraryItem[];
  selectedIds: string[]; // linked set — the grounding set (unselect ≠ delete)
  messages: Message[];
  styleGuide: StyleSection[];
  status: { busy: boolean; text: string };
};
```

Extend `ClientToServer` (add the imperative; keep the rest):

```ts
  | { type: "item.annotate"; id: string; human: string } // imperative
  | { type: "message.send"; text: string; mode: FeedbackMode | null }; // imperative
```

Replace `ServerToClient` (drop the dead toast — `say` now lands in the
conversation, so the transient `message` type has no consumer):

```ts
// Server → browser (WebSocket). Full-state broadcast is the only frame.
export type ServerToClient = { type: "state"; state: GlamourState };
```

Extend `AgentCommand` (`say` gains `kind`; add `section`):

```ts
export type AgentCommand =
  | { type: "init"; title?: string; intent?: string }
  | { type: "intent"; text: string }
  | { type: "item.annotate"; id: string; agent: string }
  | { type: "say"; text: string; kind?: MessageKind }
  | {
      type: "section";
      key: SectionKey;
      content?: string;
      status?: SectionStatus;
      prompts?: string[];
    }
  | { type: "status"; busy: boolean; text?: string }
  | { type: "close" };
```

Add `"message.user"` to the frozen allowlist (before `"closed"`):

```ts
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "item.add",
  "item.annotate",
  "message.user",
  "closed",
] as const);
```

Add `defaultStyleGuide()` and use it in `defaultState()`:

```ts
export function defaultStyleGuide(): StyleSection[] {
  return [
    {
      key: "understanding",
      label: "Understanding",
      status: "empty",
      content: "",
      prompts: [],
    },
    {
      key: "direction",
      label: "Direction",
      status: "empty",
      content: "",
      prompts: [],
    },
    {
      key: "palette",
      label: "Palette",
      status: "empty",
      content: "",
      prompts: [],
    },
    {
      key: "consistency",
      label: "Consistency",
      status: "empty",
      content: "",
      prompts: [],
    },
    {
      key: "prompts",
      label: "Re-cast prompts",
      status: "empty",
      content: "",
      prompts: [],
    },
    {
      key: "canonical",
      label: "Canonical images",
      status: "empty",
      content: "",
      prompts: [],
    },
  ];
}

export function defaultState(title: string, intent: string): GlamourState {
  return {
    title,
    intent,
    library: [],
    selectedIds: [],
    messages: [],
    styleGuide: defaultStyleGuide(),
    status: { busy: false, text: "" },
  };
}
```

> `LeanState`/`LeanItem` need **no** change: only `src`+`text` are stripped (per
> `LeanItem`), and `messages`/`styleGuide` are small text the agent should see.
> Since `LeanState = Omit<GlamourState, "library"> & { library: LeanItem[] }`,
> the two new fields flow through automatically.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/types.test.ts`
Expected: PASS (all Slice-2 contract tests green; existing type tests still
green).

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/state/types.ts \
        plugins/spellbook/skills/glamour-v2/tests/types.test.ts
git commit -m "feat(glamour-v2): extend contract with conversation + style guide

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: State reducers for messages + sections

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`

**Interfaces:**

- Consumes: `GlamourState`, `Message`, `SectionKey`, `SectionStatus`,
  `AgentCommand` (from Task 1).
- Produces:
  - `addMessage(state: GlamourState, m: Message): void` — pushes a built
    message.
  - `updateSection(state, key: SectionKey, patch: { content?: string; status?: SectionStatus; prompts?: string[] }): boolean`
    — patches the matching section in place; returns `false` if no section has
    that key.
  - `applyAgentMsg` gains a `case "section"` that calls `updateSection`.

> `say` is **not** handled in `applyAgentMsg` — the server builds the `Message`
> (id + ts) and calls `addMessage`, exactly as Slice 1 leaves `say`/`close` to
> the server. `updateSection` is pure, so `section` belongs in `applyAgentMsg`.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`:

```ts
import {
  addMessage,
  applyAgentMsg,
  updateSection,
} from "../surface/state/reduce";
import { defaultState } from "../surface/state/types";

describe("conversation + style-guide reducers", () => {
  test("addMessage appends in order", () => {
    const s = defaultState("t", "i");
    addMessage(s, {
      id: "m1",
      who: "user",
      kind: "info",
      text: "hi",
      ground: ["ref-1"],
      mode: "augment",
      ts: 1,
    });
    addMessage(s, {
      id: "m2",
      who: "agent",
      kind: "result",
      text: "ok",
      ground: [],
      mode: null,
      ts: 2,
    });
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.messages[0].ground).toEqual(["ref-1"]);
  });

  test("updateSection patches only provided fields and returns true", () => {
    const s = defaultState("t", "i");
    const ok = updateSection(s, "palette", {
      content: "indigo + amber",
      status: "forming",
    });
    expect(ok).toBe(true);
    const palette = s.styleGuide.find((x) => x.key === "palette");
    expect(palette?.content).toBe("indigo + amber");
    expect(palette?.status).toBe("forming");
    expect(palette?.prompts).toEqual([]); // untouched
  });

  test("updateSection on an unknown key returns false and mutates nothing", () => {
    const s = defaultState("t", "i");
    // @ts-expect-error — exercising the runtime guard with an invalid key
    expect(updateSection(s, "nope", { content: "x" })).toBe(false);
    expect(s.styleGuide.every((x) => x.content === "")).toBe(true);
  });

  test("applyAgentMsg routes a section command through updateSection", () => {
    const s = defaultState("t", "i");
    applyAgentMsg(s, {
      type: "section",
      key: "prompts",
      status: "agreed",
      prompts: ["hand-inked, indigo twilight, amber accent"],
    });
    const prompts = s.styleGuide.find((x) => x.key === "prompts");
    expect(prompts?.status).toBe("agreed");
    expect(prompts?.prompts).toEqual([
      "hand-inked, indigo twilight, amber accent",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`
Expected: FAIL — `addMessage` / `updateSection` are not exported.

- [ ] **Step 3: Implement the reducers**

In `surface/state/reduce.ts`, add the imports for the new types and the two
helpers (place after `annotate`, before `itemsByKind`):

```ts
export function addMessage(state: GlamourState, m: Message): void {
  state.messages.push(m);
}

export function updateSection(
  state: GlamourState,
  key: SectionKey,
  patch: { content?: string; status?: SectionStatus; prompts?: string[] }
): boolean {
  const sec = state.styleGuide.find((s) => s.key === key);
  if (!sec) return false;
  if (patch.content !== undefined) sec.content = patch.content;
  if (patch.status !== undefined) sec.status = patch.status;
  if (patch.prompts !== undefined) sec.prompts = patch.prompts;
  return true;
}
```

Update the type import at the top of the file to include the new names:

```ts
import type {
  AgentCommand,
  GenMeta,
  GlamourState,
  ItemKind,
  LeanItem,
  LeanState,
  LibraryItem,
  Message,
  SectionKey,
  SectionStatus,
} from "./types";
```

Add a `section` case to `applyAgentMsg` (alongside `intent`/`item.annotate`/
`status`; the `say`/`close` no-op arm stays):

```ts
    case "section":
      updateSection(state, msg.key, {
        content: msg.content,
        status: msg.status,
        prompts: msg.prompts,
      });
      break;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`
Expected: PASS (new + existing reducer tests green).

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts \
        plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts
git commit -m "feat(glamour-v2): add message + style-guide section reducers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Server wiring — grounded messages, agent dialogue, sections

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/scripts/server.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`

**Interfaces:**

- Consumes: `addMessage`, `applyAgentMsg` (Task 2); `Message`, `AgentCommand`,
  `ClientToServer` (Task 1); existing `broadcast`, `broadcastState`,
  `emitEvent`, `randHex`.
- Produces (browser + agent observable behavior):
  - WS `{ type: "message.send", text, mode }` → appends a `who:"user"` message
    with `ground = [...state.selectedIds]`, broadcasts, and emits
    `emitEvent({ type:"message.user", text, ground, mode })`.
  - POST `/cmd { type:"say", text, kind? }` → appends a `who:"agent"` message
    (kind defaults `"info"`), broadcasts, emits **no** agent event.
  - POST `/cmd { type:"section", ... }` → routes through `applyAgentMsg`,
    broadcasts, emits **no** agent event.
  - `connected`/`disconnected` are streamed to live SSE clients but **not**
    stored in the replay log.

- [ ] **Step 1: Write the failing tests**

Add to `plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`.
Reuse the file's existing SSE-drain shape (read with `getReader()` against a
deadline). Add this helper near the top (after the imports) and the three tests:

```ts
// Drain /events from `since` until `needle` appears or the deadline passes.
async function drainEvents(
  base: string,
  since: number,
  needle: string,
  ms = 500
) {
  const r = await fetch(`${base}/events?since=${since}`);
  if (!r.body) throw new Error("/events returned no body");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => ({
          done: true as const,
          value: undefined,
        })),
      ]);
      if (value) text += dec.decode(value, { stream: true });
      if (done) break;
      if (text.includes(needle)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}
```

```ts
test("message.send appends a grounded user message and emits message.user", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  // Add an item and ground the conversation to it.
  ws.send(
    JSON.stringify({
      type: "item.add",
      item: { kind: "context", title: "g.md", text: "warm" },
    })
  );
  await Bun.sleep(120);
  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string }[] };
  };
  const id = s1.state.library[0].id;
  ws.send(JSON.stringify({ type: "item.select", ids: [id] }));
  await Bun.sleep(50);

  ws.send(
    JSON.stringify({ type: "message.send", text: "love this", mode: "augment" })
  );
  const text = await drainEvents(base, 0, '"type":"message.user"');
  expect(text).toContain('"type":"message.user"');
  expect(text).toContain('"love this"');
  expect(text).toContain(`"ground":["${id}"]`);

  const s2 = (await (await fetch(`${base}/state`)).json()) as {
    state: {
      messages: {
        who: string;
        text: string;
        ground: string[];
        mode: string | null;
      }[];
    };
  };
  const last = s2.state.messages.at(-1);
  expect(last?.who).toBe("user");
  expect(last?.ground).toEqual([id]);
  expect(last?.mode).toBe("augment");
  ws.close();
});

test("agent say appends an agent message; section updates the guide; neither emits an event", async () => {
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "say",
      text: "here is what I see",
      kind: "result",
    }),
  });
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "section",
      key: "palette",
      content: "indigo + amber",
      status: "forming",
    }),
  });
  await Bun.sleep(60);

  const s = (await (await fetch(`${base}/state`)).json()) as {
    state: {
      messages: { who: string; kind: string; text: string }[];
      styleGuide: { key: string; content: string; status: string }[];
    };
  };
  const agentMsg = s.state.messages.find((m) => m.who === "agent");
  expect(agentMsg?.kind).toBe("result");
  expect(agentMsg?.text).toBe("here is what I see");
  const palette = s.state.styleGuide.find((x) => x.key === "palette");
  expect(palette?.content).toBe("indigo + amber");
  expect(palette?.status).toBe("forming");

  // say/section are agent-origin → no agent events for them.
  const events = await drainEvents(base, 0, "__never__", 250);
  expect(events).not.toContain('"type":"say"');
  expect(events).not.toContain('"type":"section"');
});

test("connected/disconnected are not replayed from the event log", async () => {
  // Open and close a throwaway socket to generate presence churn.
  const a = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (a.onopen = () => res(null)));
  a.close();
  await Bun.sleep(80);
  const replay = await drainEvents(base, 0, "__never__", 250);
  expect(replay).not.toContain('"type":"connected"');
  expect(replay).not.toContain('"type":"disconnected"');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`bun test plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`
Expected: FAIL — `message.send` does nothing yet; `say` still broadcasts a toast
(no `messages` entry); `connected` appears in replay.

- [ ] **Step 3: Implement the server wiring**

In `scripts/server.ts`:

(a) Import `addMessage` (add to the existing `reduce` import block):

```ts
import {
  addItem,
  addMessage,
  annotate,
  applyAgentMsg,
  leanItem,
  leanState,
  makeItem,
  selectItems,
  setLike,
  setStar,
} from "../surface/state/reduce";
```

(b) Add a stream-only emit for presence, alongside `emitEvent`:

```ts
// Presence is transient: stream to live SSE clients but DO NOT store it in
// the replay log (a reconnecting agent should not re-see every past
// connect/disconnect). No id is assigned, so it never advances a tail cursor.
const emitTransient = (msg: Record<string, unknown>) => {
  const frame = enc.encode(`data: ${JSON.stringify(msg)}\n\n`);
  for (const c of sseClients) {
    try {
      c.enqueue(frame);
    } catch {
      /* gone */
    }
  }
};
```

(c) Route agent `say` into the conversation; leave the rest of `handleAgentMsg`
on the `applyAgentMsg` path (which now also covers `section`):

```ts
const handleAgentMsg = (msg: AgentCommand) => {
  if (msg.type === "say") {
    addMessage(state, {
      id: `m-${randHex(4)}`,
      who: "agent",
      kind: msg.kind ?? "info",
      text: msg.text,
      ground: [],
      mode: null,
      ts: Date.now(),
    });
    broadcastState();
    return;
  }
  if (msg.type === "close") {
    resolveDone({ code: 0, reason: "close" });
    return;
  }
  applyAgentMsg(state, msg);
  broadcastState();
};
```

(d) Handle `message.send` in `handleClientMsg` (add a case; it is imperative):

```ts
      case "message.send": {
        const ground = [...state.selectedIds];
        addMessage(state, {
          id: `m-${randHex(4)}`,
          who: "user",
          kind: "info",
          text: msg.text,
          ground,
          mode: msg.mode,
          ts: Date.now(),
        });
        broadcastState();
        emitEvent({ type: "message.user", text: msg.text, ground, mode: msg.mode });
        break;
      }
```

(e) Switch the two presence emits from `emitEvent` to `emitTransient`:

```ts
// websocket.open:
emitTransient({ type: "connected" });
```

```ts
// websocket.close:
emitTransient({ type: "disconnected" });
```

> Leave `ready` and `closed` on `emitEvent` (they must replay / flush).

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`bun test plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`
Expected: PASS (new + existing integration tests green).

- [ ] **Step 5: Run the full suite**

Run: `bun test plugins/spellbook/skills/glamour-v2/` Expected: PASS — all prior
tests still green (no regressions from the `ServerToClient` toast removal or
presence change).

- [ ] **Step 6: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/scripts/server.ts \
        plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts
git commit -m "feat(glamour-v2): grounded chat, agent dialogue, section commands

Server appends grounded user messages and emits message.user; agent say lands
in the conversation; section commands shape the style guide; connected and
disconnected are now stream-only (no replay churn).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: CLI verbs — `section` and `say --kind`

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/scripts/cli.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/cli.test.ts` (create)

**Interfaces:**

- Consumes: existing `parseArgs` (exported), `postCmd`, `main`.
- Produces:
  - `glamour-v2 say <text...> [--kind info|working|result|error]` → POSTs
    `{ type:"say", text, kind? }`.
  - `glamour-v2 section <key> [--status ..] [--content ..] [--prompts "a||b"]` →
    POSTs `{ type:"section", key, status?, content?, prompts? }`. `--prompts` is
    split on `||` into an array.

- [ ] **Step 1: Write the failing test**

`parseArgs` is already exported and pure. To test the `section` command
construction without a live daemon, refactor the message-building out of the
verb into a pure exported helper `buildSectionCmd`, and test it. Create
`plugins/spellbook/skills/glamour-v2/tests/cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildSectionCmd, buildSayCmd, parseArgs } from "../scripts/cli";

describe("cli command construction", () => {
  test("section: key + flags → typed command, prompts split on ||", () => {
    const { pos, flags } = parseArgs([
      "prompts",
      "--status",
      "agreed",
      "--prompts",
      "hand-inked, indigo||warm amber accent",
    ]);
    expect(buildSectionCmd(pos, flags)).toEqual({
      type: "section",
      key: "prompts",
      status: "agreed",
      prompts: ["hand-inked, indigo", "warm amber accent"],
    });
  });

  test("section: content only", () => {
    const { pos, flags } = parseArgs([
      "palette",
      "--content",
      "indigo + amber",
    ]);
    expect(buildSectionCmd(pos, flags)).toEqual({
      type: "section",
      key: "palette",
      content: "indigo + amber",
    });
  });

  test("say: text + kind", () => {
    expect(buildSayCmd(["here", "is", "what"], { kind: "result" })).toEqual({
      type: "say",
      text: "here is what",
      kind: "result",
    });
  });

  test("say: bare text defaults to no kind", () => {
    expect(buildSayCmd(["hi"], {})).toEqual({ type: "say", text: "hi" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/cli.test.ts` Expected:
FAIL — `buildSectionCmd` / `buildSayCmd` are not exported.

- [ ] **Step 3: Implement the builders + wire the verbs**

In `scripts/cli.ts`, add the two pure builders (near `parseArgs`, and export
them):

```ts
export function buildSayCmd(
  pos: string[],
  flags: Record<string, string | boolean>
): { type: "say"; text: string; kind?: string } {
  const cmd: { type: "say"; text: string; kind?: string } = {
    type: "say",
    text: pos.join(" "),
  };
  if (typeof flags.kind === "string") cmd.kind = flags.kind;
  return cmd;
}

export function buildSectionCmd(
  pos: string[],
  flags: Record<string, string | boolean>
): {
  type: "section";
  key: string;
  status?: string;
  content?: string;
  prompts?: string[];
} {
  const cmd: {
    type: "section";
    key: string;
    status?: string;
    content?: string;
    prompts?: string[];
  } = { type: "section", key: pos[0] };
  if (typeof flags.status === "string") cmd.status = flags.status;
  if (typeof flags.content === "string") cmd.content = flags.content;
  if (typeof flags.prompts === "string")
    cmd.prompts = flags.prompts.split("||").map((p) => p.trim());
  return cmd;
}
```

Update the `say` verb to use the builder, and add the `section` verb in `main`'s
switch:

```ts
    case "say":
      if (!pos.length) die("usage: say <text...> [--kind info|working|result|error]");
      await postCmd(session, buildSayCmd(pos, flags));
      break;
    case "section":
      if (!pos.length)
        die("usage: section <key> [--status ..] [--content ..] [--prompts a||b]");
      await postCmd(session, buildSectionCmd(pos, flags));
      break;
```

Refresh the `HELP` string — add the `--kind` note to `say` and a `section` line:

```ts
  say    <text...> [--kind ..]        post agent dialogue into the conversation
  section <key> [--status ..] [--content ..] [--prompts a||b]
                                     shape a style-guide section
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/cli.test.ts` Expected:
PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/scripts/cli.ts \
        plugins/spellbook/skills/glamour-v2/tests/cli.test.ts
git commit -m "feat(glamour-v2): add section verb and say --kind to the CLI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Conversation sidebar (MessageBubble + Conversation)

**Files:**

- Create:
  `plugins/spellbook/skills/glamour-v2/surface/components/MessageBubble.tsx`
- Create:
  `plugins/spellbook/skills/glamour-v2/surface/components/Conversation.tsx`

**Interfaces:**

- Consumes: `Message`, `FeedbackMode`, `LibraryItem` (types); `lucide-react`.
- Produces (App wires these in Task 7):
  - `MessageBubble({ message, library }: { message: Message; library: LibraryItem[] })`
  - `Conversation({ messages, library, grounded, onSend }: { messages: Message[]; library: LibraryItem[]; grounded: string[]; onSend: (text: string, mode: FeedbackMode | null) => void })`

> No live browser in a subagent. Verify with `bun build` (Step 4). Live behavior
> is checked in Task 8.

- [ ] **Step 1: Implement `MessageBubble.tsx`**

```tsx
import { CheckSquare } from "lucide-react";
import type { LibraryItem, Message } from "../state/types";

const KIND_TINT: Record<Message["kind"], string> = {
  info: "text-slate-200",
  working: "text-amber-300",
  result: "text-slate-100",
  error: "text-rose-300",
};

export function MessageBubble({
  message,
  library,
}: {
  message: Message;
  library: LibraryItem[];
}) {
  const isUser = message.who === "user";
  const groundTitles = message.ground
    .map((id) => library.find((i) => i.id === id)?.title)
    .filter((t): t is string => Boolean(t));

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {groundTitles.length > 0 && (
        <span className="mb-1 flex items-center gap-1 text-[10px] text-fuchsia-300/90">
          <CheckSquare className="h-3 w-3" />
          about: {groundTitles.join(", ")}
        </span>
      )}
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
          isUser ? "bg-fuchsia-600/20" : "bg-white/5"
        } ${isUser ? "text-slate-100" : KIND_TINT[message.kind]}`}
      >
        {message.text}
      </div>
      <span className="mt-0.5 text-[10px] text-slate-500">
        {isUser ? "you" : "agent"}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Implement `Conversation.tsx`**

```tsx
import { useState } from "react";
import type { FeedbackMode, LibraryItem, Message } from "../state/types";
import { MessageBubble } from "./MessageBubble";

export function Conversation({
  messages,
  library,
  grounded,
  onSend,
}: {
  messages: Message[];
  library: LibraryItem[];
  grounded: string[];
  onSend: (text: string, mode: FeedbackMode | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<FeedbackMode>("augment");
  const isGrounded = grounded.length > 0;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text, isGrounded ? mode : null);
    setDraft("");
  };

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-white/10 bg-slate-900/40">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-xs text-slate-500">
            talk about the style — drop files or images anytime.
          </p>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} library={library} />
          ))
        )}
      </div>

      <div className="border-t border-white/10 p-3">
        {isGrounded && (
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] text-fuchsia-300">
              grounded to {grounded.length} selected item
              {grounded.length > 1 ? "s" : ""}
            </span>
            <div className="flex gap-1">
              {(["augment", "correct"] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded px-2 py-0.5 text-[10px] ${
                    mode === m
                      ? "bg-fuchsia-600/40 text-fuchsia-100"
                      : "text-slate-500"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            isGrounded
              ? "say what you like about the selection…"
              : "talk about the style…"
          }
          className="h-16 w-full resize-none rounded bg-white/5 p-2 text-xs text-slate-200 outline-none ring-fuchsia-400/50 focus:ring-1"
        />
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Format**

Run:
`bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/components/MessageBubble.tsx plugins/spellbook/skills/glamour-v2/surface/components/Conversation.tsx`
Expected: no errors.

- [ ] **Step 4: Build-check the bundle**

Run:
`bun build plugins/spellbook/skills/glamour-v2/surface/index.html --outdir /tmp/glamour-v2-buildcheck`
Expected: builds without error (the new components compile; not yet imported by
`App.tsx` until Task 7, so this only proves they type-check standalone — import
them in a scratch line if the bundler tree-shakes them out, then remove it).

> If the bundler skips unimported files, instead verify with `bunx tsc --noEmit`
> scoped to the skill, or temporarily import the components in `App.tsx` for the
> check and revert. Do **not** commit an unused import.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/components/MessageBubble.tsx \
        plugins/spellbook/skills/glamour-v2/surface/components/Conversation.tsx
git commit -m "feat(glamour-v2): conversation sidebar (message bubbles + composer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Style-guide view

**Files:**

- Create:
  `plugins/spellbook/skills/glamour-v2/surface/components/StyleGuide.tsx`

**Interfaces:**

- Consumes: `StyleSection`, `SectionStatus` (types).
- Produces: `StyleGuide({ sections }: { sections: StyleSection[] })`.

- [ ] **Step 1: Implement `StyleGuide.tsx`**

```tsx
import type { SectionStatus, StyleSection } from "../state/types";

const DOT: Record<SectionStatus, string> = {
  agreed: "bg-emerald-400",
  forming: "bg-amber-400",
  empty: "bg-slate-600",
};
const BADGE: Record<SectionStatus, string> = {
  agreed: "bg-emerald-500/15 text-emerald-300",
  forming: "bg-amber-500/15 text-amber-300",
  empty: "bg-slate-700/40 text-slate-500",
};
const BORDER: Record<SectionStatus, string> = {
  agreed: "border-emerald-700/40",
  forming: "border-amber-700/40",
  empty: "border-slate-700/50",
};

export function StyleGuide({ sections }: { sections: StyleSection[] }) {
  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-5">
      {sections.map((s) => (
        <div
          key={s.key}
          className={`rounded-lg border bg-slate-800/30 px-4 py-3 ${BORDER[s.status]}`}
        >
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${DOT[s.status]}`} />
            <span className="text-sm font-medium">{s.label}</span>
            <span
              className={`ml-auto rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${BADGE[s.status]}`}
            >
              {s.status}
            </span>
          </div>

          {s.content && (
            <p className="mt-1.5 pl-3.5 text-xs leading-relaxed text-slate-300">
              {s.content}
            </p>
          )}

          {s.prompts.length > 0 && (
            <div className="mt-2 space-y-1.5 pl-3.5">
              {s.prompts.map((p) => (
                <p
                  key={p}
                  className="rounded border border-slate-700/50 bg-slate-900/60 px-2 py-1.5 font-mono text-[11px] text-slate-400"
                >
                  {p}
                </p>
              ))}
            </div>
          )}

          {s.status === "empty" && (
            <p className="mt-1 pl-3.5 text-[10px] text-slate-600">
              fills in as the conversation converges
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Format**

Run:
`bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/components/StyleGuide.tsx`
Expected: no errors.

- [ ] **Step 3: Build-check** (same caveat as Task 5 — verify it type-checks)

Run: `bunx tsc --noEmit -p plugins/spellbook/skills/glamour-v2` (if a tsconfig
is present) or include it via the Task 7 import.

- [ ] **Step 4: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/components/StyleGuide.tsx
git commit -m "feat(glamour-v2): style-guide view with section statuses

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: App integration + folded Slice-1 Minors

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/App.tsx`
- Modify: `plugins/spellbook/skills/glamour-v2/surface/state/fileIntake.ts`
- Modify:
  `plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx`

**Interfaces:**

- Consumes: `Conversation` (Task 5), `StyleGuide` (Task 6), existing `FacetBar`,
  `LibraryGrid`, `DetailsFlyout`, `useSession`, `processFiles`/`pickFiles`.
- Produces: the wired surface — center column switches between library and style
  guide via a header toggle; the `Conversation` sidebar is always present;
  `message.send` is wired; `DetailsFlyout` remounts per item; a click-to-pick
  upload control exists.

This task folds the deferred Slice-1 Minors:

1. **mime-on-raw-fallback** — `fileIntake` sends the actual encoded mime.
2. **click-to-pick upload** — a `pickFiles` helper + a button.
3. **DetailsFlyout key-remount** — `key={selected.id}` in App; drop the reset
   effect + its biome-ignore in `DetailsFlyout`.

- [ ] **Step 1: Fix the mime fallback + add `pickFiles` in `fileIntake.ts`**

Open `surface/state/fileIntake.ts`. Where the image is encoded, on the raw
fallback set the mime to the **actual** type written, not a hardcoded
`"image/webp"`. The shape (adapt to the file's exact variable names — read it
first):

```ts
// When canvas WebP encoding succeeds:
send({
  type: "item.add",
  item: { kind: "ref", title, src: webpDataUrl, mime: "image/webp" },
});

// On raw fallback (encoding unavailable): use the file's real type.
send({
  type: "item.add",
  item: {
    kind: "ref",
    title,
    src: rawDataUrl,
    mime: file.type || "application/octet-stream",
  },
});
```

Add a click-to-pick helper that reuses `processFiles`:

```ts
export function pickFiles(send: (m: ClientToServer) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "image/*,text/*,.md,.txt";
  input.onchange = () => {
    if (input.files) void processFiles(input.files, send);
  };
  input.click();
}
```

- [ ] **Step 2: Simplify `DetailsFlyout.tsx`** (remove the reset effect)

Remove the item-reset `useEffect` and its `biome-ignore` line (the App now
remounts the component per item via `key`, so the local `human`/`enlarged` state
resets naturally). Initialize state directly from props:

```tsx
const [human, setHuman] = useState(item.annotations.human);
const [enlarged, setEnlarged] = useState(false);
// (delete the useEffect that reset on item.id change + its biome-ignore comment)
```

Keep the unmount-cleanup effect for the debounce timer (that one is still
correct).

- [ ] **Step 3: Wire `App.tsx`**

Replace `App.tsx` with the integrated shell (center toggles library/style; chat
always on the right; flyout in library view; click-to-pick in the header):

```tsx
import { BookOpen, Images, Upload } from "lucide-react";
import { useState } from "react";
import { Conversation } from "./components/Conversation";
import { DetailsFlyout } from "./components/DetailsFlyout";
import { FacetBar } from "./components/FacetBar";
import { LibraryGrid } from "./components/LibraryGrid";
import { StyleGuide } from "./components/StyleGuide";
import { pickFiles, processFiles } from "./state/fileIntake";
import type { FeedbackMode, ItemKind } from "./state/types";
import { useSession } from "./state/useSession";

export function App() {
  const { state, send } = useSession();
  const [facet, setFacet] = useState<ItemKind | "all">("all");
  const [view, setView] = useState<"library" | "style">("library");
  const [dragging, setDragging] = useState(false);

  if (!state) return <div className="p-6 text-slate-400">connecting…</div>;

  const selected = state.library.find((i) => state.selectedIds.includes(i.id));
  const solid = state.styleGuide.filter((s) => s.status === "agreed").length;

  return (
    <div
      role="application"
      className="flex h-screen flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
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

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setView("library")}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
              view === "library"
                ? "bg-slate-700 text-slate-100"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Images className="h-3.5 w-3.5" /> Library
          </button>
          <button
            type="button"
            onClick={() => setView("style")}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
              view === "style"
                ? "bg-slate-700 text-slate-100"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <BookOpen className="h-3.5 w-3.5" /> Style guide
            <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[9px] text-slate-400">
              {solid}/{state.styleGuide.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => pickFiles(send)}
            className="ml-1 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200"
            aria-label="add files"
          >
            <Upload className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {state.status.busy && (
          <span className="text-xs text-amber-300">
            {state.status.text || "working…"}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {view === "library" ? (
            <>
              <FacetBar
                library={state.library}
                facet={facet}
                onPick={setFacet}
              />
              <LibraryGrid
                library={state.library}
                facet={facet}
                selectedIds={state.selectedIds}
                onSelect={(ids) => send({ type: "item.select", ids })}
              />
            </>
          ) : (
            <StyleGuide sections={state.styleGuide} />
          )}
        </main>

        {view === "library" && selected && (
          <DetailsFlyout
            key={selected.id}
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

        <Conversation
          messages={state.messages}
          library={state.library}
          grounded={state.selectedIds}
          onSend={(text: string, mode: FeedbackMode | null) =>
            send({ type: "message.send", text, mode })
          }
        />
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

- [ ] **Step 4: Format + build-check**

Run:
`bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/App.tsx plugins/spellbook/skills/glamour-v2/surface/state/fileIntake.ts plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx`
Then:
`bun build plugins/spellbook/skills/glamour-v2/surface/index.html --outdir /tmp/glamour-v2-buildcheck`
Expected: biome clean; bundle builds without error (Conversation, StyleGuide,
MessageBubble are now all reachable from `App.tsx`).

- [ ] **Step 5: Run the full suite**

Run: `bun test plugins/spellbook/skills/glamour-v2/` Expected: PASS — no
unit/integration regressions.

- [ ] **Step 6: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/App.tsx \
        plugins/spellbook/skills/glamour-v2/surface/state/fileIntake.ts \
        plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx
git commit -m "feat(glamour-v2): wire conversation + style-guide view into the shell

Adds the always-present chat sidebar, the library/style view toggle, and the
grounded message.send wiring. Folds Slice-1 deferred Minors: honest mime on raw
intake fallback, click-to-pick upload, and DetailsFlyout key-remount (dropping
the reset effect + its suppression).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Live end-to-end verification (controller-run)

> **Not a subagent task.** The controller runs this with a live daemon +
> Playwright after Task 7's review is clean, mirroring the Slice-1 Task-11
> approach. No code is written unless a defect is found (then a fix subagent is
> dispatched).

**Verification script:**

- [ ] Launch a fresh session:
      `bun plugins/spellbook/skills/glamour-v2/scripts/cli.ts open --title "Slice 2 e2e" --intent "verify the heart"`
- [ ] Drop a ref image + a context file (simulate a real drop via
      `browser_evaluate`, per Slice 1). Confirm tiles render.
- [ ] **Grounding:** click a tile → fuchsia selection ring appears; the chat
      composer shows the "grounded to 1 selected item" banner + the
      correct/augment toggle.
- [ ] **message.send:** type into the composer, press Enter → a `who:"user"`
      bubble appears with an "about: <title>" chip; `cli.ts tail` shows a
      `message.user` event carrying `text`, `ground:[<id>]`, and `mode`.
- [ ] **Ambient discipline:** selecting/​starring tiles emits **no** agent event
      in `tail` (only the chat send does).
- [ ] **Agent dialogue:** `cli.ts say "here is the read" --kind result` → an
      agent bubble appears live in the conversation (not a toast).
- [ ] **Style guide:**
      `cli.ts section palette --content "indigo + amber"     --status forming`
      then
      `section prompts --status agreed --prompts     "hand-inked, indigo||warm amber accent"`
      → toggle to the Style-guide view; the palette section shows amber
      "forming" badge + content; prompts section shows green "agreed" badge +
      the two mono prompt boxes; header counter reads `1/6`.
- [ ] **click-to-pick:** the header "Add" button opens a file picker.
- [ ] **Resume:** `cli.ts close`, then `cli.ts open --restore <session-id>` →
      messages, style-guide sections, and library all return; files
      re-materialized.
- [ ] **Presence:** reconnecting a tail (`tail --since 0`) does **not** replay a
      flood of `connected`/`disconnected` frames.
- [ ] Confirm no zombie processes (`ps` / no lingering daemon after `close`).

Record findings in the SDD ledger; dispatch one fix subagent for any
Critical/Important. Then proceed to the whole-branch review (opus), per
subagent-driven-development.

---

## Self-Review

**Spec coverage** (proposal Slice 2 = "Conversation + grounding + style guide"):

- Chat sidebar → Tasks 5, 7. ✅
- Select-to-ground deixis (selection = what the next message is about) → server
  snapshots `selectedIds` as `ground` on `message.send` (Task 3); composer
  banner + chip (Tasks 5, 7). ✅
- Agent-assembled Style-guide view, status empty→forming→agreed → Tasks 1, 2,
  3, 6. ✅
- V1 carry-forwards mapped: narration kinds → `MessageKind` (Task 1); spec
  modules + understanding + recreatePrompt → style-guide sections (Tasks 1, 6);
  correct-vs-augment → `mode` on `message.send` (Tasks 1, 3, 5). ✅ (`model` →
  deferred to `GenMeta` in Slice 3, noted.)
- Deferred Slice-1 Minors: mime fallback, click-to-pick, DetailsFlyout remount,
  connected/disconnected replay churn, inert toast sink (removed) → Tasks 3, 7.
  ✅ (`LibraryGrid` useCallback intentionally **not** done — YAGNI micro-perf;
  left as a Slice-1 ledger note.)

**Placeholder scan:** No "TBD"/"handle edge cases"/uncoded steps. The one soft
spot is the `fileIntake.ts` edit (Step 1 of Task 7) — the implementer must read
the file's exact variable names first; the shape and the required change (honest
mime on fallback) are specified concretely.

**Type consistency:** `Message`, `StyleSection`, `SectionKey`, `FeedbackMode`,
`MessageKind` names are identical across Tasks 1–7. `message.send` (client) vs
`message.user` (agent event) are deliberately distinct and used consistently.
`section`/`say` command shapes match between `types.ts` (Task 1), `reduce.ts`
(Task 2), `server.ts` (Task 3), and `cli.ts` (Task 4).

**Out of scope (correctly deferred):** generation/media-forge, focus lens, round
grouping (Slice 3); project-styles tray, canonical-image population (Slice 4).
The `canonical` section exists but is only status/content-fillable here.
