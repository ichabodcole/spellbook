# Context Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse imago's `styles[]` + `prompts[]` into one passive
`ContextEntry` library, with every consumption site a linked set over it (✕ =
unlink; one guarded hard-delete) and a vertical Images|Context switcher.

**Architecture:** A single `library: ContextEntry[]` on `ImagoState` plus two
ordered id-list "linked sets" (`activeContextIds`, `quickPromptIds`). Server
handlers add/update/delete entries and link/unlink set membership; a restore
migration folds legacy `styles`/`prompts` in. The surface gets a vertical
switcher, a Context library pane, a reusable `LibraryPicker`, an active-context
tray mirroring references, and a migrated composer quick-prompts list.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun build`), React (Bun bundler),
the imago daemon (`scripts/server.ts`) + shared contract
(`surface/state/types.ts`).

**Design spec:** `docs/projects/imago/context-library-design.md` (read it
first).

## Global Constraints

- **Format with biome, not prettier:** run `bunx biome check --write` on changed
  `.ts`/`.tsx` from the **repo root** before committing.
- **Lint gate:** `bunx biome check --error-on-warnings` from the **repo root**
  (running from the imago dir gives false "ISSUES").
- **Test gate:** `bun test` (run from the imago dir
  `plugins/spellbook/skills/imago/`). `tsc` is NOT a repo gate (imago carries
  lib-context noise) — do not block on it.
- **Surface build check:**
  `bun build surface/main.tsx --outdir /tmp/imago-build` must succeed for
  surface tasks.
- **Two implementation modes by layer:** server/state/pure-helper tasks (1–4)
  are strict TDD (test → red → implement → green). Surface tasks (5–9) are
  _implement-against-the-live-component + Playwright-verify_ — the imago norm
  (no unit harness for the React canvas); each lists explicit live-verification
  steps.
- **Redeploy discipline:** contract/server changes need a daemon redeploy to
  take effect (`close --session <old>` + `open --restore <old>`); surface
  changes HMR live. Coordinate before disrupting cole's tab.
- **Commit trailer:** end commit messages with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** `feat/imago-context-library` (already created off `develop`).

---

## Phase A — Contract + server core (strict TDD)

> Note: this is a breaking contract migration. The integration suite
> (`server.integration.test.ts`) is temporarily red between Tasks 1 and 2 (the
> server still half-references old fields until Task 2). `state.test.ts` is Task
> 1's gate; the full `bun test` goes green at the end of Task 3.

### Task 1: Contract types + defaultState + lean projection

**Files:**

- Modify: `surface/state/types.ts` (types, `DEFAULT_*`, `defaultState`)
- Modify: `scripts/server.ts:154-179` (`styleForAgent` → `contextForAgent`,
  `leanState`)
- Test: `tests/state.test.ts`

**Interfaces:**

- Produces: `ContextKind`, `ContextSet`, `ContextEntry` (exported from
  `types.ts`); `ImagoState.library: ContextEntry[]`,
  `ImagoState.activeContextIds: string[]`,
  `ImagoState.quickPromptIds: string[]`; `defaultState()` seeding; `leanState()`
  mapping `library` (image stripped).
- Consumes: nothing (first task).

- [ ] **Step 1: Rewrite the pure-state tests (red).** In `tests/state.test.ts`,
      replace the two style/prompt `defaultState` tests (the
      `seeds the default style catalog` and `seeds the 3 default quick-prompts`
      tests) and the `fixtureWithBlobs` style block with the new model:

```ts
test("defaultState seeds the unified library (prompts + styles) and linked sets", () => {
  const s = defaultState("t");
  const prompts = s.library.filter((e) => e.kind === "prompt");
  const styles = s.library.filter((e) => e.kind === "style");
  expect(prompts.map((p) => p.id)).toEqual(["describe", "palette", "lighting"]);
  expect(styles.map((st) => st.name)).toEqual([
    "anime",
    "painterly",
    "photoreal",
    "3d",
    "watercolor",
    "line art",
  ]);
  // deterministic, reproducible style ids
  expect(styles.map((st) => st.id)).toEqual([
    "style-anime",
    "style-painterly",
    "style-photoreal",
    "style-3d",
    "style-watercolor",
    "style-line-art",
  ]);
  // all 3 prompts are surfaced in the composer; no styles active by default
  expect(s.quickPromptIds).toEqual(["describe", "palette", "lighting"]);
  expect(s.activeContextIds).toEqual([]);
});

test("defaultState returns fresh (non-shared) library per call", () => {
  const a = defaultState("a");
  const b = defaultState("b");
  a.library[0].name = "mutated";
  a.quickPromptIds.push("x");
  expect(b.library[0].name).not.toBe("mutated");
  expect(b.quickPromptIds).toEqual(["describe", "palette", "lighting"]);
});
```

Then update `fixtureWithBlobs()` — replace the `s.styles.push({ ... ghibli })`
block with a library entry, and drop the `s.batches`/refs parts you keep:

```ts
s.library.push({
  id: "ctx-ghibli",
  kind: "style",
  name: "ghibli",
  content: "soft painterly anime",
  image: "data:image/webp;base64,STYLEBLOB",
  imagePath: "/tmp/files/style-ghibli.webp",
  captured: true,
});
```

And replace the `leanState strips style.image` test with:

```ts
test("leanState strips a library entry's image but keeps imagePath + content", () => {
  const lean = leanState(fixtureWithBlobs());
  const g = lean.library.find((e) => e.id === "ctx-ghibli") as Record<
    string,
    unknown
  >;
  expect(g.image).toBeUndefined();
  expect(g.imagePath).toBe("/tmp/files/style-ghibli.webp");
  expect(g.content).toBe("soft painterly anime");
  expect(g.captured).toBe(true);
});

test("leanState passes the linked sets through verbatim", () => {
  const src = fixtureWithBlobs();
  src.activeContextIds = ["ctx-ghibli"];
  src.quickPromptIds = ["describe"];
  const lean = leanState(src);
  expect(lean.activeContextIds).toEqual(["ctx-ghibli"]);
  expect(lean.quickPromptIds).toEqual(["describe"]);
});
```

Also update the `defaultState carries ... empty artifact collections` test to
add `expect(s.library).toBeInstanceOf(Array)` and remove any
`s.styles`/`s.prompts` references. Remove the
`leanState preserves prompts ... verbatim` test (prompts no longer exist as a
top-level field).

- [ ] **Step 2: Run the tests to confirm they fail.**

Run: `cd plugins/spellbook/skills/imago && bun test tests/state.test.ts`
Expected: FAIL (compile/type errors on `library`, `ContextEntry`, etc.).

- [ ] **Step 3: Add the contract types** in `surface/state/types.ts`. Delete
      `StyleEntry` (lines 94–101) and `PromptEntry` (line 107) and the
      `DEFAULT_STYLES`/`DEFAULT_PROMPTS` consts (lines 434–461). Add, near the
      other artifact types:

```ts
// A unified, reusable piece of textual agent-context. `kind` drives behavior +
// default filter (a style materializes an image + acts as ambient context; a
// prompt fills the composer) but is NOT a hard router — membership in a linked
// set (see ImagoState.activeContextIds / quickPromptIds) is what surfaces it.
// `tags` carry cross-kind findability. No `archived`: removal from a site is an
// unlink; the only destroy is context.delete on the library.
export type ContextKind = "prompt" | "style" | "skill" | "context";
export type ContextEntry = {
  id: string;
  kind: ContextKind;
  name: string;
  content: string;
  tags?: string[];
  image?: string; // base64 identity image (stripped in the lean agent projection)
  imagePath?: string; // on-disk materialized image the agent can --ref
  captured?: boolean; // style-only: extracted from an image
};
// The named linked sets over `library` (the consumption sites).
export type ContextSet = "active" | "quickPrompts";
```

- [ ] **Step 4: Update `ImagoState`** (lines 211–212). Replace
      `styles: StyleEntry[];` and `prompts: PromptEntry[];` with:

```ts
  library: ContextEntry[]; // the unified, passive context catalog (styles + quick-prompts; skill/context reserved)
  activeContextIds: string[]; // styles attached to the NEXT generation (the active-context tray)
  quickPromptIds: string[]; // prompts surfaced in the composer quick-prompts list (a curated subset)
```

- [ ] **Step 5: Update the contract messages.** In `ClientToServer`, delete the
      6 lines `style.toggle` / `style.remove` / `style.capture` / `prompt.add` /
      `prompt.update` / `prompt.remove` (lines 269–274) and add:

```ts
  | { type: "context.add"; kind: ContextKind; name: string; content: string; tags?: string[]; image?: string; link?: ContextSet }
  | { type: "context.update"; id: string; name?: string; content?: string; tags?: string[] }
  | { type: "context.delete"; id: string } // the ONLY destroy (guarded by a UI confirm)
  | { type: "context.link"; id: string; set: ContextSet } // add to a linked set
  | { type: "context.unlink"; id: string; set: ContextSet } // remove from a linked set (the everyday ✕)
  | { type: "context.capture" } // capture a style from the focused image
```

In `AgentCommand`, delete `style.add` (lines 358–366) and `prompt.add`
(line 367) and add:

```ts
  | { type: "context.add"; kind: ContextKind; name: string; content: string; tags?: string[]; image?: string; link?: ContextSet }
```

In `AGENT_EVENT_TYPES` (lines 385–396) replace `"style.capture"` with
`"context.capture"`. In `AgentEventPayload` (lines 402–430) rename the
`"style.capture"` key to `"context.capture"` (same `{ focus: Focus | null }`
shape; update the comment).

- [ ] **Step 6: Add the default seeds + rewrite `defaultState`.** Near where
      `DEFAULT_STYLES` was:

```ts
const DEFAULT_STYLE_NAMES = [
  "anime",
  "painterly",
  "photoreal",
  "3d",
  "watercolor",
  "line art",
];
// deterministic, reproducible id so seeding/restore don't churn ids
const styleId = (name: string) =>
  `style-${name.trim().toLowerCase().replace(/\s+/g, "-")}`;

const DEFAULT_PROMPTS: ContextEntry[] = [
  {
    id: "describe",
    kind: "prompt",
    name: "describe",
    content: "Describe this image in detail — literally what is in it.",
  },
  {
    id: "palette",
    kind: "prompt",
    name: "palette",
    content:
      "Break down the color palette — the key colors and how they work together.",
  },
  {
    id: "lighting",
    kind: "prompt",
    name: "lighting",
    content:
      "Describe the lighting — direction, quality, mood — so I can reuse it.",
  },
];
```

In `defaultState`, replace the `styles`/`prompts` fields with:

```ts
    library: [
      ...DEFAULT_PROMPTS.map((p) => ({ ...p })),
      ...DEFAULT_STYLE_NAMES.map((name) => ({ id: styleId(name), kind: "style" as const, name, content: "" })),
    ],
    activeContextIds: [],
    quickPromptIds: DEFAULT_PROMPTS.map((p) => p.id),
```

- [ ] **Step 7: Update the lean projection** in `scripts/server.ts`. Replace
      `styleForAgent` (lines 154–157) with:

```ts
function contextForAgent(e: ContextEntry): Omit<ContextEntry, "image"> {
  const { image: _drop, ...rest } = e;
  return rest; // agent reads imagePath, not the inlined blob
}
```

In `leanState` (lines 170–179) replace `styles: s.styles.map(styleForAgent),`
with `library: s.library.map(contextForAgent),`. Update the `ContextEntry`
import on the `types` import line (add `ContextEntry`; remove `StyleEntry`,
`PromptEntry`).

- [ ] **Step 8: Run the tests to confirm they pass.**

Run: `cd plugins/spellbook/skills/imago && bun test tests/state.test.ts`
Expected: PASS.

- [ ] **Step 9: Format + commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/surface/state/types.ts plugins/spellbook/skills/imago/scripts/server.ts plugins/spellbook/skills/imago/tests/state.test.ts
git commit -m "feat(imago): unify styles+prompts into ContextEntry library (contract + lean)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: Server handlers (context.add/update/delete/link/unlink/capture)

**Files:**

- Modify: `scripts/server.ts` — agent handler (lines 529–568), browser handlers
  (lines 714–751), plus new helper closures.
- Test: `tests/server.integration.test.ts` (replace the `style.*`/`prompt.*`
  suites).

**Interfaces:**

- Consumes: `ContextEntry`, `ContextSet`, `library`, `activeContextIds`,
  `quickPromptIds` from Task 1.
- Produces: handlers for `context.add` (browser + agent, style upsert-on-name),
  `context.update`, `context.delete`, `context.link`, `context.unlink`,
  `context.capture`; closures `addContextEntry`, `linkContext`, `unlinkContext`.

- [ ] **Step 1: Replace the style/prompt integration suites with context tests
      (red).** In `tests/server.integration.test.ts`, delete the
      `describe("style.add / toggle / remove", ...)` and
      `describe("prompt.add / update / remove", ...)` blocks (≈747–823) and add:

```ts
describe("context library — add / link / unlink / delete", () => {
  test("context.add creates a library entry; link puts it in a set", async () => {
    const s = await spawnDaemon();
    const ws = await openWs(s);
    ws.send({
      type: "context.add",
      kind: "prompt",
      name: "moody",
      content: "make it moody",
      link: "quickPrompts",
    });
    const st = await waitForState(s, (x) =>
      x.library.some((e) => e.name === "moody")
    );
    const entry = st.library.find((e) => e.name === "moody")!;
    expect(entry.kind).toBe("prompt");
    expect(entry.content).toBe("make it moody");
    expect(st.quickPromptIds).toContain(entry.id);
    ws.close();
  });

  test("context.link/unlink toggles set membership; idempotent; entry survives unlink", async () => {
    const s = await spawnDaemon();
    const ws = await openWs(s);
    ws.send({
      type: "context.add",
      kind: "style",
      name: "noir",
      content: "high contrast b&w",
    });
    const added = await waitForState(s, (x) =>
      x.library.some((e) => e.name === "noir")
    );
    const id = added.library.find((e) => e.name === "noir")!.id;
    ws.send({ type: "context.link", id, set: "active" });
    ws.send({ type: "context.link", id, set: "active" }); // idempotent
    let st = await waitForState(s, (x) => x.activeContextIds.includes(id));
    expect(st.activeContextIds.filter((x) => x === id)).toHaveLength(1);
    ws.send({ type: "context.unlink", id, set: "active" });
    st = await waitForState(s, (x) => !x.activeContextIds.includes(id));
    expect(st.library.some((e) => e.id === id)).toBe(true); // unlink ≠ delete
    ws.close();
  });

  test("context.delete removes from library AND every set", async () => {
    const s = await spawnDaemon();
    const ws = await openWs(s);
    ws.send({
      type: "context.add",
      kind: "prompt",
      name: "doomed",
      content: "x",
      link: "quickPrompts",
    });
    const added = await waitForState(s, (x) =>
      x.library.some((e) => e.name === "doomed")
    );
    const id = added.library.find((e) => e.name === "doomed")!.id;
    ws.send({ type: "context.delete", id });
    const st = await waitForState(
      s,
      (x) => !x.library.some((e) => e.id === id)
    );
    expect(st.quickPromptIds).not.toContain(id);
    ws.close();
  });

  test("agent context.add upserts a style on name and link:'active' attaches it", async () => {
    const s = await spawnDaemon();
    await postCmd(s, {
      type: "context.add",
      kind: "style",
      name: "Ghibli",
      content: "soft",
      image: PNG_1x1,
      link: "active",
    });
    const st = await waitForState(s, (x) =>
      x.library.some((e) => e.kind === "style" && e.name === "ghibli")
    );
    const style = st.library.find(
      (e) => e.kind === "style" && e.name === "ghibli"
    )!;
    expect(st.activeContextIds).toContain(style.id);
    // re-add same name → upsert (no duplicate), updates content
    await postCmd(s, {
      type: "context.add",
      kind: "style",
      name: "ghibli",
      content: "soft painterly",
    });
    const st2 = await waitForState(
      s,
      (x) =>
        x.library.find((e) => e.id === style.id)?.content === "soft painterly"
    );
    expect(
      st2.library.filter((e) => e.kind === "style" && e.name === "ghibli")
    ).toHaveLength(1);
    // lean strips the image blob, keeps imagePath
    const lean = await getState(s, true);
    const leanStyle = lean.library.find((e) => e.id === style.id) as Record<
      string,
      unknown
    >;
    expect(leanStyle.image).toBeUndefined();
    expect(typeof leanStyle.imagePath).toBe("string");
  });

  test("context.capture emits the agent event with the focus", async () => {
    const s = await spawnDaemon();
    const { batchId, variantId } = await seedFocusedVariant(s);
    const events = collectEvents(s);
    const ws = await openWs(s);
    ws.send({ type: "context.capture" });
    const ev = await events.next("context.capture");
    expect(ev.focus).toEqual({ batchId, variantId });
    ws.close();
  });
});
```

> Adjust `collectEvents`/`events.next` to match the existing helper's API (see
> its definition at ≈157) — mirror how the current `marks.commit` event test
> consumes it. If `seedFocusedVariant` doesn't already focus, focus it first.

- [ ] **Step 2: Run to confirm red.**

Run:
`cd plugins/spellbook/skills/imago && bun test tests/server.integration.test.ts`
Expected: FAIL (unknown message types `context.*`).

- [ ] **Step 3: Add helper closures** in `scripts/server.ts` near the other
      in-`main` state helpers (where `ensureDrawLayer` etc. live, so `state`,
      `sessionFilesDir`, `newId`, `saveDataUrl`, `normStyle` are in scope):

```ts
function linkContext(id: string, set: ContextSet) {
  if (!state.library.some((e) => e.id === id)) return;
  const arr = set === "active" ? state.activeContextIds : state.quickPromptIds;
  if (!arr.includes(id)) arr.push(id);
}
function unlinkContext(id: string, set: ContextSet) {
  if (set === "active")
    state.activeContextIds = state.activeContextIds.filter((x) => x !== id);
  else state.quickPromptIds = state.quickPromptIds.filter((x) => x !== id);
}
// Create (or, for styles, upsert-on-name) a library entry. Returns the entry id
// (existing id on a style upsert), or null if the payload is invalid.
function addContextEntry(msg: {
  kind: ContextKind;
  name: string;
  content?: string;
  tags?: string[];
  image?: string;
}): string | null {
  if (typeof msg.name !== "string" || !msg.name.trim()) return null;
  const content = typeof msg.content === "string" ? msg.content : "";
  const tags = Array.isArray(msg.tags) ? msg.tags : undefined;
  const imageSrc =
    typeof msg.image === "string" && msg.image.startsWith("data:")
      ? msg.image
      : undefined;
  const imagePath = imageSrc
    ? saveDataUrl(sessionFilesDir, newId("ctx"), imageSrc) || undefined
    : undefined;
  if (msg.kind === "style") {
    const name = normStyle(msg.name);
    const existing = state.library.find(
      (e) => e.kind === "style" && normStyle(e.name) === name
    );
    if (existing) {
      if (content) existing.content = content;
      if (tags) existing.tags = tags;
      if (imageSrc) {
        existing.image = imageSrc;
        existing.imagePath = imagePath;
        existing.captured = true;
      }
      return existing.id;
    }
    const id = newId("ctx");
    state.library.push({
      id,
      kind: "style",
      name,
      content,
      tags,
      image: imageSrc,
      imagePath,
      captured: imageSrc ? true : undefined,
    });
    return id;
  }
  const id = newId("ctx");
  state.library.push({
    id,
    kind: msg.kind,
    name: msg.name.trim(),
    content,
    tags,
    image: imageSrc,
    imagePath,
  });
  return id;
}
```

- [ ] **Step 4: Replace the browser handlers** (the `style.toggle` …
      `style.capture` chain, lines 714–751) with:

```ts
    } else if (t === "context.add") {
      const id = addContextEntry(msg);
      if (id && msg.link) linkContext(id, msg.link);
      if (id) broadcastState();
    } else if (t === "context.update") {
      const e = state.library.find((x) => x.id === msg.id);
      if (e) {
        if (typeof msg.name === "string") e.name = msg.name.trim() || e.name;
        if (typeof msg.content === "string") e.content = msg.content;
        if (Array.isArray(msg.tags)) e.tags = msg.tags;
        broadcastState();
      }
    } else if (t === "context.delete") {
      if (typeof msg.id === "string") {
        state.library = state.library.filter((x) => x.id !== msg.id);
        state.activeContextIds = state.activeContextIds.filter((x) => x !== msg.id);
        state.quickPromptIds = state.quickPromptIds.filter((x) => x !== msg.id);
        broadcastState();
      }
    } else if (t === "context.link") {
      if (typeof msg.id === "string") {
        linkContext(msg.id, msg.set);
        broadcastState();
      }
    } else if (t === "context.unlink") {
      if (typeof msg.id === "string") {
        unlinkContext(msg.id, msg.set);
        broadcastState();
      }
    } else if (t === "context.capture") {
      // carry the focused variant so the agent knows which image to read the look from
      emitEvent({ type: "context.capture", focus: state.focus });
```

- [ ] **Step 5: Replace the agent handlers** (`style.add` lines 529–559 +
      `prompt.add` lines 560–568) with:

```ts
    } else if (t === "context.add") {
      const id = addContextEntry(msg);
      if (id && msg.link) linkContext(id, msg.link);
      if (id) broadcastState();
```

- [ ] **Step 6: Run to confirm green.**

Run:
`cd plugins/spellbook/skills/imago && bun test tests/server.integration.test.ts`
Expected: PASS (migration test from Task 3 may still be pending; the context
suite passes).

- [ ] **Step 7: Format + commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/scripts/server.ts plugins/spellbook/skills/imago/tests/server.integration.test.ts
git commit -m "feat(imago): context library server handlers (add/update/delete/link/unlink/capture)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Restore migration (legacy styles[]/prompts[] → library + sets)

**Files:**

- Modify: `scripts/server.ts` — the `if (restored)` block (lines 1237–1310).
- Test: `tests/server.integration.test.ts` (rewrite the restore test ≈829–884).

**Interfaces:**

- Consumes: the Task 1 state shape.
- Produces: a restore path that converts legacy `styles`/`prompts` into
  `library`
  - `activeContextIds`/`quickPromptIds` and re-materializes library images.

- [ ] **Step 1: Write the migration test (red).** Replace the existing restore
      test that backfills `prompts` with one that seeds a legacy snapshot and
      asserts the unified shape. Use the file's existing restore pattern (write
      a snapshot JSON into a pre-seeded `IMAGO_HOME`, spawn with that home + the
      session id). Concretely:

```ts
test("restore migrates legacy styles[]/prompts[] into the unified library", async () => {
  const home = mkdtempSync(join(tmpdir(), "imago-home-"));
  const sessionId = "legacy-ctx";
  const snapDir = join(home, "snapshots"); // match the daemon's snapshot dir layout
  mkdirSync(snapDir, { recursive: true });
  const legacy = {
    title: "old",
    batches: [],
    focus: null,
    conversation: [],
    styles: [
      { name: "anime", active: false },
      {
        name: "ghibli",
        active: true,
        captured: true,
        description: "soft",
        image: PNG_1x1,
      },
    ],
    prompts: [{ id: "describe", label: "describe", text: "Describe it." }],
    pins: [],
    marksByVariant: {},
    layersByVariant: {},
    analysisCache: {},
    aspect: "1:1",
    size: "1K",
    status: { busy: false, text: "" },
    cost: "",
    handoff: "",
    history: { canUndo: false, canRedo: false },
    marksUnseen: false,
  };
  writeFileSync(join(snapDir, `${sessionId}.json`), JSON.stringify(legacy));
  const s = await spawnDaemon(["--restore", sessionId], { IMAGO_HOME: home });
  const st = await getState(s);
  // prompt id preserved + surfaced
  expect(st.library.find((e) => e.id === "describe")?.kind).toBe("prompt");
  expect(st.quickPromptIds).toContain("describe");
  // styles migrated; the active one is attached
  const ghibli = st.library.find(
    (e) => e.kind === "style" && e.name === "ghibli"
  )!;
  expect(ghibli.content).toBe("soft");
  expect(st.activeContextIds).toContain(ghibli.id);
  // no leftover legacy fields
  expect((st as Record<string, unknown>).styles).toBeUndefined();
  expect((st as Record<string, unknown>).prompts).toBeUndefined();
});
```

> Verify the snapshot dir + restore-flag mechanics against the existing restore
> test before running — match its exact home layout and `spawnDaemon` args (the
> existing test is the source of truth for how `--restore` finds a snapshot).

- [ ] **Step 2: Run to confirm red.**

Run:
`cd plugins/spellbook/skills/imago && bun test tests/server.integration.test.ts -t "restore migrates"`
Expected: FAIL.

- [ ] **Step 3: Add the migration** inside `if (restored)`, BEFORE the existing
      `for (const b of state.batches)` materialization loop (after the refs
      migration block, near line 1276):

```ts
// context-library migration: legacy styles[]/prompts[] → unified library + sets.
type LegacyStyle = {
  name: string;
  active?: boolean;
  captured?: boolean;
  description?: string;
  image?: string;
  imagePath?: string;
};
type LegacyPrompt = { id: string; label: string; text: string };
state.library ??= [];
state.activeContextIds ??= [];
state.quickPromptIds ??= [];
const legacyStyles = (state as { styles?: LegacyStyle[] }).styles;
if (Array.isArray(legacyStyles)) {
  for (const st of legacyStyles) {
    const name = normStyle(st.name);
    const id = `style-${name.replace(/\s+/g, "-")}`;
    state.library.push({
      id,
      kind: "style",
      name,
      content: st.description ?? "",
      image: st.image,
      imagePath: st.imagePath,
      captured: st.captured,
    });
    if (st.active) state.activeContextIds.push(id);
  }
}
const legacyPrompts = (state as { prompts?: LegacyPrompt[] }).prompts;
if (Array.isArray(legacyPrompts)) {
  for (const p of legacyPrompts) {
    state.library.push({
      id: p.id,
      kind: "prompt",
      name: p.label,
      content: p.text,
    });
    state.quickPromptIds.push(p.id);
  }
}
delete (state as { styles?: unknown }).styles;
delete (state as { prompts?: unknown }).prompts;
```

- [ ] **Step 4: Re-materialize library images** on restore. Inside the existing
      `for (const b of state.batches)` materialization loop's enclosing block,
      add after it (still inside `if (restored)`):

```ts
for (const e of state.library) {
  if (e.image)
    e.imagePath = saveDataUrl(sessionFilesDir, e.id, e.image) || e.imagePath;
}
```

- [ ] **Step 5: Run the full test suite to confirm green.**

Run: `cd plugins/spellbook/skills/imago && bun test` Expected: PASS (all suites;
count ≥ prior 97).

- [ ] **Step 6: Format + commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/scripts/server.ts plugins/spellbook/skills/imago/tests/server.integration.test.ts
git commit -m "feat(imago): restore migration folds legacy styles/prompts into the context library

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase B — Surface (implement-against-live-component + Playwright-verify)

> Surface tasks have no unit harness for the React canvas (imago norm). Each
> ends with a live verification: redeploy the daemon (`close --session <old>` +
> `open --restore <old>`), then drive the new tab with Playwright. Keep a clean
> daemon restart before the final e2e (HMR can desync on long-running daemons).

### Task 4: Pure context-library helpers (TDD)

**Files:**

- Create: `surface/state/contextLibrary.ts`
- Test: `tests/contextLibrary.test.ts`

**Interfaces:**

- Produces: `resolveSet(library, ids)` → ordered `ContextEntry[]`;
  `entriesByKind(library, kind)` → `ContextEntry[]`; `isLinked(ids, id)` →
  `boolean`. Consumed by Tasks 5–8.

- [ ] **Step 1: Write the tests (red).** `tests/contextLibrary.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  entriesByKind,
  isLinked,
  resolveSet,
} from "../surface/state/contextLibrary";
import type { ContextEntry } from "../surface/state/types";

const lib: ContextEntry[] = [
  { id: "p1", kind: "prompt", name: "a", content: "" },
  { id: "s1", kind: "style", name: "b", content: "" },
  { id: "p2", kind: "prompt", name: "c", content: "" },
];

test("resolveSet maps ids → entries in set order, skipping missing ids", () => {
  expect(resolveSet(lib, ["p2", "missing", "p1"]).map((e) => e.id)).toEqual([
    "p2",
    "p1",
  ]);
});

test("entriesByKind filters by kind, preserving library order", () => {
  expect(entriesByKind(lib, "prompt").map((e) => e.id)).toEqual(["p1", "p2"]);
});

test("isLinked reports membership", () => {
  expect(isLinked(["p1"], "p1")).toBe(true);
  expect(isLinked(["p1"], "p2")).toBe(false);
});
```

- [ ] **Step 2: Run to confirm red.**

Run:
`cd plugins/spellbook/skills/imago && bun test tests/contextLibrary.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `surface/state/contextLibrary.ts`:

```ts
import type { ContextEntry, ContextKind } from "./types";

// Resolve an ordered id list (a linked set) against the library, in set order,
// dropping ids that no longer resolve (deleted entries).
export function resolveSet(
  library: ContextEntry[],
  ids: string[]
): ContextEntry[] {
  const byId = new Map(library.map((e) => [e.id, e]));
  return ids
    .map((id) => byId.get(id))
    .filter((e): e is ContextEntry => e !== undefined);
}

export function entriesByKind(
  library: ContextEntry[],
  kind: ContextKind
): ContextEntry[] {
  return library.filter((e) => e.kind === kind);
}

export function isLinked(ids: string[], id: string): boolean {
  return ids.includes(id);
}
```

- [ ] **Step 4: Run to confirm green.**

Run:
`cd plugins/spellbook/skills/imago && bun test tests/contextLibrary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/surface/state/contextLibrary.ts plugins/spellbook/skills/imago/tests/contextLibrary.test.ts
git commit -m "feat(imago): pure context-library helpers (resolveSet/entriesByKind/isLinked)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5: Vertical library switcher + Context library pane

**Files:**

- Create: `surface/components/ContextLibrary.tsx` (the pane)
- Create: `surface/components/LibrarySwitcher.tsx` (the vertical icon rail)
- Modify: the surface shell that currently mounts `GenerationsRail` (find it:
  `grep -rn "GenerationsRail" surface/`) to host the switcher + swap panes.

**Interfaces:**

- Consumes: `entriesByKind`, `isLinked`, `resolveSet` (Task 4); `send` (the WS
  sender used by other components); `state.library`, `state.activeContextIds`,
  `state.quickPromptIds`.
- Produces: `<LibrarySwitcher value pane onChange />`;
  `<ContextLibrary state send />`.

- [ ] **Step 1: Build `LibrarySwitcher`.** A skinny non-expanding vertical rail
      (icons only) with two items: Images and Context (use lucide `Images` and
      `Library`/`FileText` icons, matching the icon-pill style already in
      `GenerationsRail`'s `FILTERS`). Active item: `bg-accent text-accent-ink`;
      include `title` + `aria-label`. Emits the selected pane key
      (`"images" | "context"`).

- [ ] **Step 2: Build `ContextLibrary` pane.** Mirror `GenerationsRail`'s
      structure: a "Library" header + icon-only kind facet pills (All / Prompts
      / Styles — lucide `LayoutGrid` / `MessageSquareText` / `Sparkles`), then
      entry cards from `entriesByKind`. Each card shows `name` + a one-line
      `content` preview; styles render `image` if present; an "active" marker
      when `isLinked(state.activeContextIds, e.id)` (styles) or
      `isLinked(state.quickPromptIds, e.id)` (prompts). Card actions:
  - **edit** → opens an inline name/content form → `context.update`.
  - **link** → for a style, `context.link {id, set:"active"}`; for a prompt,
    `context.link {id, set:"quickPrompts"}`.
  - **Delete** → an inline two-step confirm (✕ → "Delete forever?") →
    `context.delete {id}`. This is the only destroy.
  - A **"+ New"** affordance per kind that sends
    `context.add {kind, name, content, link}` (link the new entry into the
    kind's default set).

- [ ] **Step 3: Wire the switcher into the shell.** Replace the always-on
      `GenerationsRail` mount with: `<LibrarySwitcher />` + (pane === "images" ?
      `<GenerationsRail/>` : `<ContextLibrary/>`). Keep `GenerationsRail`
      unchanged.

- [ ] **Step 4: Build check.**

Run:
`cd plugins/spellbook/skills/imago && bun build surface/main.tsx --outdir /tmp/imago-build`
Expected: success (no errors).

- [ ] **Step 5: Live-verify.** Redeploy the daemon; open the tab. Switch to
      **Context** via the rail. Confirm: prompts + styles list under the right
      facets; "+ New prompt" creates and the new card shows linked; edit changes
      content; Delete shows the two-step confirm and removes. Use Playwright
      (`browser_navigate`, `browser_click`, `browser_snapshot`).

- [ ] **Step 6: Format + commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/surface/components/ContextLibrary.tsx plugins/spellbook/skills/imago/surface/components/LibrarySwitcher.tsx plugins/spellbook/skills/imago/surface/components/<shell-file>
git commit -m "feat(imago): vertical library switcher + context library pane

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 6: Universal `LibraryPicker` component

**Files:**

- Create: `surface/components/LibraryPicker.tsx`

**Interfaces:**

- Consumes: `entriesByKind` (Task 4); `state.library`.
- Produces: `<LibraryPicker library kind excludeIds onPick onClose />` — a small
  popover listing library entries filtered to `kind` (default), excluding
  `excludeIds` (already-linked, greyed/hidden), emitting the chosen entry id via
  `onPick`. The single reusable "link from library" UI (design §"Shared
  LibraryPicker component").

- [ ] **Step 1: Build the popover.** Render a filtered, searchable list
      (`entriesByKind(library, kind)` minus `excludeIds`); clicking a row calls
      `onPick(id)` then `onClose()`. Match the surface's existing popover
      styling (see the QuickPrompts dropdown in `Conversation.tsx` for the
      idiom).

- [ ] **Step 2: Build check.**

Run:
`cd plugins/spellbook/skills/imago && bun build surface/main.tsx --outdir /tmp/imago-build`
Expected: success.

- [ ] **Step 3: Commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/surface/components/LibraryPicker.tsx
git commit -m "feat(imago): reusable LibraryPicker for linking entries from the library

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 7: Active-context tray (drawer) + remove the old Styles tab

**Files:**

- Modify: `surface/components/Canvas.tsx` (`ReferenceDrawer`, ≈833–1070).

**Interfaces:**

- Consumes: `resolveSet`, `isLinked` (Task 4); `<LibraryPicker>` (Task 6);
  `readImagoDrag` (`surface/state/fileIntake.ts`); `state.activeContextIds`.
- Produces: an active-context tray section in the drawer;
  `context.link`/`unlink` via drag + picker.

- [ ] **Step 1: Add the active-context section.** In `ReferenceDrawer`, render
      the drawer as **two mirrored sections** (per the spec's resolved
      decision): the existing **References** tray, and a new **Active context**
      tray showing `resolveSet(state.library, state.activeContextIds)`. Each
      active-context tile shows the style name/image; ✕ →
      `context.unlink {id, set:"active"}`. Add a "+ link" control that opens
      `<LibraryPicker kind="style"     excludeIds={state.activeContextIds} onPick={(id) => send({ type:     "context.link", id, set: "active" })} />`.

- [ ] **Step 2: Accept drags into the tray.** On the active-context tray's drop
      handler, parse `readImagoDrag(dt)`; if it carries a `variantId` that's
      a…`     no — context entries aren't variants. Instead, make the **ContextLibrary     style cards draggable** (Task 5) carrying the entry id via a new MIME     `IMAGO*CONTEXT_DND
      =
      "application/x-imago-context"`(add to    `fileIntake.ts`next to`IMAGO_IMAGE_DND`, with a `readContextDrag(dt)`    returning`{
      id }`). The tray drop reads it → `context.link {id, set:"active"}`. (Drag
      is the \_additional* input atop the picker.)

- [ ] **Step 3: Remove the old Styles tab** and its
      `style.toggle`/`style.remove` handlers/JSX (≈903–1069). The capture
      affordance moves to Task 9.

- [ ] **Step 4: Build check + live-verify.** Build; redeploy; confirm a style
      drags from the Context pane into the Active-context tray (and via the
      picker), shows there, and ✕ removes it from the tray while the style stays
      in the library.

- [ ] **Step 5: Format + commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/surface/components/Canvas.tsx plugins/spellbook/skills/imago/surface/state/fileIntake.ts
git commit -m "feat(imago): active-context tray (drag + picker) replaces the styles toggle tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 8: Composer quick-prompts migration

**Files:**

- Modify: `surface/components/Conversation.tsx` (`QuickPrompts`, ≈173–312).

**Interfaces:**

- Consumes: `resolveSet`, `entriesByKind` (Task 4); `<LibraryPicker>` (Task 6);
  `state.library`, `state.quickPromptIds`.
- Produces: composer quick-prompts driven by `quickPromptIds`; `context.*` CRUD.

- [ ] **Step 1: Read from the set.** `QuickPrompts` now lists
      `resolveSet(state.library, state.quickPromptIds)`. Pick → fills the
      textarea (unchanged `onPick(entry.content)`).

- [ ] **Step 2: Two add paths.** "+ New prompt" → opens the existing inline
      form; Save →
      `context.add {kind:"prompt", name, content, link:"quickPrompts"}`
      (create + link in one step). Add a "Link from library" entry that opens
      `<LibraryPicker kind="prompt" excludeIds={state.quickPromptIds}     onPick={(id) => send({ type: "context.link", id, set: "quickPrompts" })} />`.

- [ ] **Step 3: Edit + unlink.** Pencil → edit form →
      `context.update {id, name,     content}`. The ✕ on a quick-prompt →
      `context.unlink {id,     set:"quickPrompts"}` (NOT delete — the prompt
      stays in the library; true delete lives in the Context pane).

- [ ] **Step 4: Build check + live-verify.** Build; redeploy; confirm: defaults
      show; "+ New" adds and it appears; pick fills the composer; ✕ unlinks (and
      the prompt still exists in the Context pane); "Link from library" re-adds
      it.

- [ ] **Step 5: Format + commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/surface/components/Conversation.tsx
git commit -m "feat(imago): composer quick-prompts read the quickPrompts linked set (create+link, unlink)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 9: Style capture rewire + agent contract docs

**Files:**

- Modify: `surface/components/Canvas.tsx` (the capture affordance → send
  `context.capture`).
- Modify: `plugins/spellbook/skills/imago/SKILL.md` (the agent's contract:
  document `context.add`/capture; remove `style.add`/`prompt.add`).

**Interfaces:**

- Consumes: the `context.capture` message (Task 1/2).
- Produces: a capture button that sends `context.capture`; agent docs telling
  the agent to answer capture with
  `context.add {kind:"style", link:"active", image}`.

- [ ] **Step 1: Rewire capture.** The "capture style" affordance (formerly in
      the Styles tab; relocate to the Context pane's Styles facet header or the
      drawer) sends `{ type: "context.capture" }` when a variant is focused.

- [ ] **Step 2: Update SKILL.md.** Replace any `style.add` / `prompt.add` agent
      verbs with `context.add` (note `kind`, optional `link`, style
      upsert-on-name) and document that the response to a `context.capture`
      event is
      `context.add {kind:"style", name, content, image, link:"active"}`. Grep
      the spell for stale verb names:
      `grep -rn "style.add\|prompt.add\|style.capture\|style.toggle\|style.remove\|prompt.remove\|prompt.update" plugins/spellbook/skills/imago/SKILL.md`.

- [ ] **Step 3: Build check + live e2e.** Clean daemon restart. Walk the full
      loop with Playwright: capture a style from a focused image → it appears in
      the Context pane (Styles) AND in the active-context tray; create a prompt
      → pick it; unlink/relink; delete from the library with confirm. Confirm
      `bun test` still green and `bunx biome check --error-on-warnings` (repo
      root) clean.

- [ ] **Step 4: Format + commit.**

```bash
cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/imago
git add plugins/spellbook/skills/imago/surface/components/Canvas.tsx plugins/spellbook/skills/imago/SKILL.md
git commit -m "feat(imago): rewire style capture to context.capture + update agent contract docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Finalize

After Task 9, run the `project-docs:finalize-branch` flow: independent code
review of `git diff develop..HEAD`, fix findings, session doc under
`docs/projects/imago/sessions/`, then ff-merge `feat/imago-context-library` →
`develop`. release-please owns the version bump (the `feat(imago):` commits
drive a minor). Per house rule: the agent merges to develop locally; **cole**
handles push + release.

## Self-review notes (spec coverage)

- Data model (`ContextEntry`, sets, no `archived`) → Task 1. ✓
- Migration mapping + defaultState seeding → Tasks 1 (defaults) + 3 (restore). ✓
- Contract changes (browser + agent + events) → Tasks 1 (types) + 2 (handlers).
  ✓
- Lean projection (strip image, pass sets) → Task 1. ✓
- Linked-set link/unlink + guarded hard-delete → Task 2. ✓
- Vertical switcher + Context pane → Task 5. ✓
- Universal `LibraryPicker` + drag as additional input → Tasks 6, 7, 8. ✓
- Active-context tray (sections, not tabs) + remove Styles tab → Task 7. ✓
- Composer quick-prompts (create+link, unlink, link-from-library) → Task 8. ✓
- Style capture rename + agent docs → Task 9. ✓
- Tags: stored in the type, filterable/displayable in the pane; no edit
  affordance (resolved decision) → Tasks 1 + 5. ✓
