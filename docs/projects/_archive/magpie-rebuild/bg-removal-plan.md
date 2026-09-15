# Magpie Background-Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize an element's single `cutout` into a model-tagged **version
list**, then wire a first background-removal pass + a model-agnostic retry, so
the user judges results while the agent picks models.

**Architecture:** The daemon (server.ts) holds canonical state; the agent runs
cut/removal work out-of-band and posts results back via `/cmd`; the React
surface renders the chosen version on a backdrop and lets the user flag +
re-remove. This plan migrates the contract (`cutout → versions[]`,
`reslice → flagged`), adds the removal imperatives, then renders the result. The
surface-heavy sub-steps (detail sidebar, retry UI, expand) are specified at
interface depth and finalized just-in-time after their predecessor is dogfooded
— per the project's phase-by-phase rhythm.

**Tech Stack:** Bun, TypeScript, React (Bun bundler), biome (format/lint),
`bun test`. Agent-side cut tooling is `scripts/remove.py` (Pillow + rembg) via
`scripts/backend.ts`.

## Global Constraints

- **Models are NEVER baked into the UI.** No model name/color literal in any
  `.tsx`. Model names surface ONLY as data labels on produced versions. Adding a
  model requires NO app change. The retry imperative carries **only element ids
  — never a model**; the agent picks.
- **Imperatives-only agent SSE.** Only intentional hand-offs emit an agent
  event: `say`, `source.added`, `extract`, `removeBg`, `retryRemoval`,
  `submit`, + lifecycle. Ambient editing (`element.flag`, `version.choose`,
  `backdrop.set`, the `element.*` edits) mutates state + broadcasts to the
  browser + logs a gesture, but emits NO agent event. The agent reads `/state`
  when an imperative fires.
- **WYSIWYG crop invariant holds.** `cli extract` passes explicit `--pad 0`; the
  drawn box is the only padding control. Removal versions inherit the crop
  bounds.
- **Type-driven alpha policy stays** (`scripts/backend.ts`): `auto` removes
  `illustration/sticker/icon/wordmark`; `palette/screenshot/typography` are
  forbidden (kept whole). The surface shows a "kept whole" note for forbidden
  types instead of a version strip.
- **One version per model.** `addVersion` upserts by `model`: re-running the
  same model overwrites that version's path and bumps its `rev` (cache-bust); a
  different model appends a new row. The crop is `model: "crop"`, always
  `versions[0]`.
- Format changed `.ts`/`.tsx` with `bunx biome check --write` before committing
  (NOT prettier). Run `bun test` from the skill root
  `plugins/spellbook/skills/magpie`.
- Surface (`.tsx`) edits need a browser refresh (HMR bundle); `cli`/`remove.py`
  edits apply per-invocation; `server.ts` edits need a daemon restart.

---

## File Structure

| File                               | Responsibility                               | Change                                                                                          |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `surface/state/types.ts`           | The shared contract                          | Modify: `ElementVersion`, `Element.versions/chosenVersionId/flagged`, message unions, event set |
| `surface/state/versions.ts`        | Pure version helpers (browser + server safe) | **Create**                                                                                      |
| `surface/state/reduce.ts`          | Pure mutators                                | Modify: `addVersion`, `chooseVersion`, `flagElement` (rename `markElement`)                     |
| `scripts/server.ts`                | Daemon command/message handlers              | Modify: `element.flag`, `version.choose`, `removeBg`, `retryRemoval`, `element.addVersion`      |
| `scripts/cli.ts`                   | Agent-side cut loop                          | Modify: `cmdExtract` posts `element.addVersion`                                                 |
| `surface/MagpieShell.tsx`          | The surface                                  | Modify: read `chosenVersion`; `element.mark → element.flag`; backdrop swatches; removal buttons |
| `tests/reduce.test.ts`             | Pure mutator tests                           | Modify                                                                                          |
| `tests/daemon.integration.test.ts` | Live daemon contract tests                   | Modify                                                                                          |

---

## Task 1: Contract migration — `cutout → versions[]`, `reslice → flagged`

One atomic deliverable: the whole codebase moves from a single `cutout` +
`reslice` flag to a model-tagged version list + a `flagged` flag. It must land
together (the surface won't typecheck mid-rename). Pure-logic layers are TDD'd;
the surface renames are mechanical and covered by the integration suite + a
manual smoke.

**Files:**

- Modify: `surface/state/types.ts`
- Create: `surface/state/versions.ts`
- Test: `tests/versions.test.ts` (new)
- Modify: `surface/state/reduce.ts`, `tests/reduce.test.ts`
- Modify: `scripts/server.ts`, `scripts/cli.ts`, `surface/MagpieShell.tsx`
- Modify: `tests/daemon.integration.test.ts`

**Interfaces produced (later tasks rely on these exact signatures):**

- `type ElementVersion = { id: string; model: string; kind?: "raw" | "local" | "cloud"; path: string; rev: number; note?: string }`
- `Element` gains `versions?: ElementVersion[]`, `chosenVersionId?: string`,
  `flagged?: boolean`; loses `cutout`, `reslice`.
- `chosenVersion(el: Element): ElementVersion | undefined`
- `versionUrl(v: ElementVersion): string` → `/assets/<basename>?v=<rev>`
- `addVersion(s, id, v: ElementVersion, opts?: { choose?: boolean }): ElementVersion | null`
- `chooseVersion(s: MagpieState, id: string, versionId: string): boolean`
- `flagElement(s: MagpieState, id: string, flagged: boolean): boolean`
- Client messages: `element.flag { id, flagged }`,
  `version.choose { id, versionId }`, `removeBg { ids? }`,
  `retryRemoval { ids }` (drop `element.mark`, `element.retry`).
- Agent command: `element.addVersion { id, version, choose? }`.
- Agent events: add `removeBg { ids? }`, `retryRemoval { ids }`; drop
  `element.retry`.

---

- [ ] **Step 1: Rewrite the cutout/element types in `types.ts`**

Replace the `ElementCutout` type + the `cutout`/`reslice` fields on `Element`
(lines ~54–77) with:

```ts
// A produced asset for one element: the raw crop (model:"crop") or a removal
// result. `path` is the on-disk PNG served via /assets; `rev` bumps on every
// (re-)run of the SAME model — the file is overwritten in place, so the surface
// appends ?v=<rev> to bust the browser cache. `kind` is a label-chip hint the
// agent supplies; never inferred in the UI.
export type ElementVersion = {
  id: string;
  model: string; // "crop" | "rembg" | "bria" | "ideogram" | … (agent-defined)
  kind?: "raw" | "local" | "cloud";
  path: string;
  rev: number;
  note?: string;
};

export type Element = {
  id: string;
  name: string;
  type: ElementType;
  bbox: Bbox;
  status: ElementStatus;
  // ── extraction ──
  // Produced assets, one row per model. crop = versions[0] (model:"crop").
  // Absent until the first cut; treat undefined as []. The chosen version is
  // what the rail/gallery render (chosenVersion() falls back to versions[0]).
  versions?: ElementVersion[];
  chosenVersionId?: string;
  // The sole review signal: the user flagged this element to be re-run (re-slice
  // in the slices phase, re-remove in the bg phase). Approval is the ABSENCE of a
  // flag; discarding is status:"dropped". Cleared when a fresh version lands.
  flagged?: boolean;
};
```

- [ ] **Step 2: Update the message unions + event set in `types.ts`**

In `ClientToServer`: replace the `element.mark` and `element.retry` lines with:

```ts
  | { type: "element.flag"; id: string; flagged: boolean } // flag/unflag for re-run (re-slice or re-remove)
  | { type: "version.choose"; id: string; versionId: string } // user picked a version → it becomes chosen (ambient)
  | { type: "removeBg"; ids?: string[] } // remove backgrounds for these alpha-eligible elements (absent → all eligible)
  | { type: "retryRemoval"; ids: string[] } // "try a different removal" — agent picks an UNUSED model; payload is ids only
```

In `AgentCommand`, add after `element.remove`:

```ts
  | { type: "element.addVersion"; id: string; version: ElementVersion; choose?: boolean } // agent appends a produced version
```

In `AGENT_EVENT_TYPES`: remove `"element.retry"`, add `"removeBg"` and
`"retryRemoval"` (keep `"extract"`). Update the doc comment above it to list the
new imperatives.

In `AgentEventPayload`: remove the `"element.retry"` entry; add:

```ts
  removeBg: { ids?: string[] };
  retryRemoval: { ids: string[] };
```

Also `import type { ElementVersion }` is not needed (same file). No test for
this step — it's the contract surface; the next steps fail to typecheck if it's
wrong.

- [ ] **Step 3: Write the failing test for `versions.ts` helpers**

Create `tests/versions.test.ts`:

```ts
import { expect, test } from "bun:test";
import { chosenVersion, versionUrl } from "../surface/state/versions";
import type { Element, ElementVersion } from "../surface/state/types";

function v(id: string, model: string, rev = 0): ElementVersion {
  return { id, model, path: `/tmp/files/${model}.png`, rev };
}
function el(versions?: ElementVersion[], chosenVersionId?: string): Element {
  return {
    id: "e1",
    name: "icon",
    type: "icon",
    bbox: [0, 0, 10, 10],
    status: "confirmed",
    versions,
    chosenVersionId,
  };
}

test("chosenVersion returns the chosen id, else versions[0], else undefined", () => {
  const a = v("v1", "crop"),
    b = v("v2", "rembg");
  expect(chosenVersion(el([a, b], "v2"))).toBe(b);
  expect(chosenVersion(el([a, b]))).toBe(a); // no chosen → first (the crop)
  expect(chosenVersion(el([a, b], "gone"))).toBe(a); // stale chosen → first
  expect(chosenVersion(el([]))).toBeUndefined();
  expect(chosenVersion(el(undefined))).toBeUndefined();
});

test("versionUrl is the basename with a cache-busting rev", () => {
  expect(versionUrl(v("v1", "crop", 3))).toBe("/assets/crop.png?v=3");
  expect(
    versionUrl({ id: "v2", model: "rembg", path: "/a/b/wordmark.png", rev: 0 })
  ).toBe("/assets/wordmark.png?v=0");
});
```

- [ ] **Step 4: Run it to verify it fails**

Run:
`cd /Users/colereed/Projects/Spellbook/plugins/spellbook/skills/magpie && bun test tests/versions.test.ts`
Expected: FAIL — `Cannot find module "../surface/state/versions"`.

- [ ] **Step 5: Create `surface/state/versions.ts`**

```ts
// surface/state/versions.ts
// Pure version helpers shared by server.ts AND the React client. No node:* — keep
// browser-safe. An element's produced assets are a model-tagged list (versions[]);
// these resolve "which one is shown" and "its cache-busted URL".

import type { Element, ElementVersion } from "./types";

// The version the surface renders: the explicitly chosen one, else the first
// (the crop). Tolerates an absent/empty list and a stale chosenVersionId.
export function chosenVersion(el: Element): ElementVersion | undefined {
  const vs = el.versions ?? [];
  return vs.find((v) => v.id === el.chosenVersionId) ?? vs[0];
}

// The /assets URL for a version, cache-busted by its rev. A re-run overwrites the
// file in place, so without ?v=<rev> the browser shows the stale cached image.
export function versionUrl(v: ElementVersion): string {
  return `/assets/${v.path.split("/").pop()}?v=${v.rev ?? 0}`;
}
```

- [ ] **Step 6: Run the helper test to verify it passes**

Run: `bun test tests/versions.test.ts` Expected: PASS (2 tests).

- [ ] **Step 7: Write the failing reduce tests for the new mutators**

In `tests/reduce.test.ts`: update the import line to swap `markElement` →
`addVersion, chooseVersion, flagElement`. Replace the `markElement` test (lines
~122–137) with:

```ts
test("flagElement flags/unflags an element, reports change; unknown id → false", () => {
  const s = defaultState("t");
  s.elements = [el("e1")];
  expect(flagElement(s, "e1", true)).toBe(true);
  expect(s.elements[0].flagged).toBe(true);
  expect(flagElement(s, "e1", true)).toBe(false); // no-op
  expect(flagElement(s, "e1", false)).toBe(true);
  expect(s.elements[0].flagged).toBe(false);
  expect(flagElement(s, "nope", true)).toBe(false);
});

test("addVersion appends a new model, upserts (bumps rev) on the same model, sets chosen + clears flag", () => {
  const s = defaultState("t");
  s.elements = [{ ...el("e1", "confirmed"), flagged: true }];
  // first crop
  const crop = addVersion(s, "e1", {
    id: "vC",
    model: "crop",
    path: "/f/crop.png",
    rev: 0,
  });
  expect(crop?.id).toBe("vC");
  expect(s.elements[0].versions).toHaveLength(1);
  expect(s.elements[0].chosenVersionId).toBe("vC");
  expect(s.elements[0].flagged).toBe(false); // a fresh result clears the flag
  // re-run the SAME model → upsert in place, bump rev, keep the id, stay chosen
  s.elements[0].flagged = true;
  const crop2 = addVersion(s, "e1", {
    id: "ignored",
    model: "crop",
    path: "/f/crop.png",
    rev: 0,
  });
  expect(s.elements[0].versions).toHaveLength(1);
  expect(crop2?.id).toBe("vC"); // stable id on upsert
  expect(crop2?.rev).toBe(1); // bumped
  expect(s.elements[0].flagged).toBe(false);
  // a different model → append, become chosen
  const rembg = addVersion(s, "e1", {
    id: "vR",
    model: "rembg",
    path: "/f/rembg.png",
    rev: 0,
    kind: "local",
  });
  expect(s.elements[0].versions).toHaveLength(2);
  expect(s.elements[0].chosenVersionId).toBe("vR");
  // choose:false keeps the current chosen
  addVersion(
    s,
    "e1",
    { id: "vB", model: "bria", path: "/f/bria.png", rev: 0 },
    { choose: false }
  );
  expect(s.elements[0].chosenVersionId).toBe("vR");
  // unknown id → null
  expect(
    addVersion(s, "nope", { id: "x", model: "crop", path: "/p", rev: 0 })
  ).toBeNull();
});

test("chooseVersion sets chosenVersionId when the version exists; reports change", () => {
  const s = defaultState("t");
  s.elements = [el("e1", "confirmed")];
  addVersion(s, "e1", { id: "vC", model: "crop", path: "/f/crop.png", rev: 0 });
  addVersion(s, "e1", {
    id: "vR",
    model: "rembg",
    path: "/f/rembg.png",
    rev: 0,
  });
  expect(chooseVersion(s, "e1", "vC")).toBe(true);
  expect(s.elements[0].chosenVersionId).toBe("vC");
  expect(chooseVersion(s, "e1", "vC")).toBe(false); // no-op
  expect(chooseVersion(s, "e1", "ghost")).toBe(false); // unknown version
  expect(chooseVersion(s, "nope", "vC")).toBe(false); // unknown element
});
```

- [ ] **Step 8: Run reduce tests to verify they fail**

Run: `bun test tests/reduce.test.ts` Expected: FAIL —
`addVersion`/`chooseVersion`/`flagElement` are not exported.

- [ ] **Step 9: Implement the mutators in `reduce.ts`**

Update the import block: add `ElementVersion` to the `./types` type import.
Replace `markElement` (lines ~117–126) with:

```ts
// Flag (or unflag) an element for a re-run — the sole review signal. Approval is
// the absence of a flag; discarding is status:"dropped". Returns whether the flag
// actually changed (the daemon only broadcasts on a change).
export function flagElement(
  s: MagpieState,
  id: string,
  flagged: boolean
): boolean {
  const el = s.elements.find((e) => e.id === id);
  if (!el) return false;
  if ((el.flagged ?? false) === flagged) return false;
  el.flagged = flagged;
  return true;
}

// Append a produced version, UPSERTING by model: re-running the same model
// overwrites its path + bumps rev (cache-bust) and keeps the stable id; a new
// model appends a row. A fresh result clears `flagged` (the request is fulfilled)
// and — unless { choose:false } — becomes the chosen version. Returns the stored
// version, or null if the element is gone.
export function addVersion(
  s: MagpieState,
  id: string,
  v: ElementVersion,
  opts: { choose?: boolean } = {}
): ElementVersion | null {
  const el = s.elements.find((e) => e.id === id);
  if (!el) return null;
  if (!el.versions) el.versions = [];
  const existing = el.versions.find((x) => x.model === v.model);
  let stored: ElementVersion;
  if (existing) {
    existing.path = v.path;
    existing.rev = (existing.rev ?? 0) + 1;
    if (v.kind !== undefined) existing.kind = v.kind;
    if (v.note !== undefined) existing.note = v.note;
    stored = existing;
  } else {
    stored = { ...v, rev: v.rev ?? 0 };
    el.versions.push(stored);
  }
  if (opts.choose ?? true) el.chosenVersionId = stored.id;
  el.flagged = false;
  return stored;
}

// The user selecting a version → it becomes chosen (ambient). Returns whether it
// changed; rejects an unknown element or a versionId not present on it.
export function chooseVersion(
  s: MagpieState,
  id: string,
  versionId: string
): boolean {
  const el = s.elements.find((e) => e.id === id);
  if (!el || !(el.versions ?? []).some((v) => v.id === versionId)) return false;
  if (el.chosenVersionId === versionId) return false;
  el.chosenVersionId = versionId;
  return true;
}
```

Also update the `leanState` comment block's `TODO(mock)` note to reference
`versions`/`chosenVersionId` (it already strips `src`/`cutouts` defensively —
leave that logic; the version `path`s are not blobs).

- [ ] **Step 10: Run reduce tests to verify they pass**

Run: `bun test tests/reduce.test.ts` Expected: PASS (the `el()` helper at line
24 needs no change — `versions`/`flagged`/`chosenVersionId` are all optional).

- [ ] **Step 11: Migrate the server handlers in `server.ts`**

Update the import from `reduce`: swap `markElement` →
`addVersion, chooseVersion, flagElement`.

Add an `element.addVersion` case in `handleAgentMsg` (after `element.remove`,
before `status`):

```ts
      case "element.addVersion":
        // The agent posting a produced version (crop or removal result). Append
        // (upsert by model) + broadcast; NO SSE (it's the agent's own output).
        if (
          typeof msg.id === "string" &&
          msg.version &&
          addVersion(state, msg.id, msg.version, { choose: msg.choose ?? true })
        ) {
          broadcastState();
        }
        break;
```

In `handleBrowserMsg`, replace the `element.mark` case with `element.flag` (same
gesture shape, `flagElement`):

```ts
      case "element.flag": {
        // Flag / unflag for a re-run — ambient bookkeeping, NOT pushed. The agent
        // learns which to re-run from the removeBg/retryRemoval imperative.
        if (typeof msg.id !== "string") return;
        const flagged = msg.flagged === true;
        if (!flagElement(state, msg.id, flagged)) return;
        const el = state.elements.find((e) => e.id === msg.id);
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: flagged ? `flagged ${el?.name ?? msg.id}` : `unflagged ${el?.name ?? msg.id}`,
          gesture: { kind: "flag", targetId: msg.id },
        });
        broadcastState();
        break;
      }
```

Replace the `element.retry` case with `version.choose`, `removeBg`,
`retryRemoval`:

```ts
      case "version.choose": {
        // The user picked a version → it becomes chosen. Ambient: mutate +
        // broadcast + log a gesture; NO agent push.
        if (typeof msg.id !== "string" || typeof msg.versionId !== "string") return;
        if (!chooseVersion(state, msg.id, msg.versionId)) return;
        const el = state.elements.find((e) => e.id === msg.id);
        const v = (el?.versions ?? []).find((x) => x.id === msg.versionId);
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `chose ${v?.model ?? "a version"} for ${el?.name ?? msg.id}`,
          gesture: { kind: "version.choose", targetId: msg.id },
        });
        broadcastState();
        break;
      }
      case "removeBg": {
        // Imperative: remove backgrounds for these (or all eligible) elements. The
        // agent picks the model + runs it. Flip busy immediately (the affordance).
        const ids = Array.isArray(msg.ids) ? msg.ids : undefined;
        const n = ids
          ? ids.length
          : state.elements.filter((e) => e.status !== "dropped").length;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to remove ${n} background${n === 1 ? "" : "s"}`,
          gesture: { kind: "removeBg" },
        });
        setStatus(state, true, `Removing ${n} background${n === 1 ? "" : "s"}…`);
        broadcastState();
        emitEvent({ type: "removeBg", ids });
        break;
      }
      case "retryRemoval": {
        // Imperative: "try a different removal" on these flagged items. Payload is
        // ids ONLY — the agent picks an unused model. Flip busy immediately.
        const ids = Array.isArray(msg.ids) ? msg.ids : [];
        if (!ids.length) return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to try a different removal on ${ids.length}`,
          gesture: { kind: "retryRemoval" },
        });
        setStatus(state, true, `Trying a different removal on ${ids.length}…`);
        broadcastState();
        emitEvent({ type: "retryRemoval", ids });
        break;
      }
```

Also update the `element.update` case comment (drop the `cutout`/`reslice`
mention — it's now version-only via `element.addVersion`; `element.update` still
partial-merges name/type/bbox/status).

- [ ] **Step 12: Migrate the cut loop in `cli.ts`**

In `cmdExtract`, replace the `element.update` post (lines ~447–456) with an
`element.addVersion` post. Add `import { newId } from "../surface/state/reduce"`
is already present. The version `kind` derives from the backend: crop → `"raw"`,
rembg → `"local"`.

```ts
await api(s.port, "POST", "/cmd", {
  type: "element.addVersion",
  id: el.id,
  version: {
    id: newId("v"),
    model: backend, // "crop" | "rembg" (addVersion upserts by model)
    kind: backend === "crop" ? "raw" : "local",
    path: cutout.path,
    rev: 0, // addVersion sets/bumps rev; 0 for a new model
  },
  choose: true,
});
```

(The old patch read `el.cutout?.rev` for cache-bust; that's gone — `addVersion`
owns rev now. `reslice: false` is gone too — `addVersion` clears `flagged`.)

- [ ] **Step 13: Migrate the surface reads in `MagpieShell.tsx`**

Mechanical renames (the integration suite + a manual smoke cover this; no new
unit test):

1. Replace the `cutoutSrc` helper (lines ~36–40) — delete it; import the shared
   helpers instead:
   ```ts
   import { chosenVersion, versionUrl } from "./state/versions";
   ```
   and drop `ElementCutout` from the `./state/types` import.
2. In `ElementList`: `e.cutout` → `chosenVersion(e)` everywhere (`sliced`,
   `focusable`); `e.reslice` → `e.flagged`.
3. In `ElementRow`:
   `const ver = chosenVersion(el); const sliceSrc = ver ? versionUrl(ver) : null;`.
   Replace the `toggleMark` send with
   `{ type: "element.flag", id: el.id, flagged: !el.flagged }`. Replace
   `el.reslice` → `el.flagged` in the ring class, the flag button
   title/label/color.
4. In `Lightbox`:
   `const ver = chosenVersion(el); if (!ver) return null; const src = versionUrl(ver);`.
   Replace the `el.cutout` guard, `toggleMark` (→ `element.flag`), and
   `el.reslice` references.
5. In `ElementList`'s batch button: `markedIds` is
   `focusable.filter((e) => e.flagged)`.

- [ ] **Step 14: Migrate the integration tests in `daemon.integration.test.ts`**

1. In `ObservedState.elements`, replace `reslice?: boolean` with
   `flagged?: boolean` and add
   `versions?: Array<{ id: string; model: string; path: string; rev: number }>; chosenVersionId?: string`.
2. Rename the `element.mark` test → `element.flag` (lines ~345–363): send
   `{ type: "element.flag", id: "e1", flagged: true }`, assert
   `x.elements[0]?.flagged === true`, gesture text `includes("flagged")`, and
   `evP.filter((e) => e.type === "element.flag")` is empty.
3. Add a new test asserting `element.addVersion` mutates + emits NO agent event:

```ts
test("POST /cmd element.addVersion appends a version + sets chosen; no agent event", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);
  await postCmd(s, {
    type: "element.addVersion",
    id: "e1",
    version: { id: "vC", model: "crop", path: "/tmp/f/icon.png", rev: 0 },
  });
  const st = await waitForState(
    s,
    (x) => (x.elements[0]?.versions?.length ?? 0) === 1
  );
  expect(st.elements[0].versions?.[0].model).toBe("crop");
  expect(st.elements[0].chosenVersionId).toBe("vC");
});
```

4. Add a test that `removeBg` IS an imperative (flips busy + emits with ids),
   mirroring the existing `extract` test:

```ts
test("WS removeBg IS an imperative — flips busy + emits an agent event with ids", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "removeBg");
  const ws = await openWs(s);
  ws.send({ type: "removeBg", ids: ["e1"] });
  const st = await waitForState(s, (x) => x.status.busy === true);
  expect(st.status.text).toContain("Removing");
  const ev = (await evP).find((e) => e.type === "removeBg") as
    | { ids?: string[] }
    | undefined;
  expect(ev?.ids).toEqual(["e1"]);
  ws.close();
});

test("WS retryRemoval IS an imperative — emits with ids ONLY (no model)", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "retryRemoval");
  const ws = await openWs(s);
  ws.send({ type: "retryRemoval", ids: ["e1"] });
  const ev = (await evP).find((e) => e.type === "retryRemoval") as
    | { ids?: string[]; model?: unknown }
    | undefined;
  expect(ev?.ids).toEqual(["e1"]);
  expect(ev && "model" in ev).toBe(false); // model-agnostic — ids only
  ws.close();
});
```

- [ ] **Step 15: Run the full suite + biome**

Run:
`cd /Users/colereed/Projects/Spellbook/plugins/spellbook/skills/magpie && bun test`
Expected: PASS (all reduce + versions + daemon tests green). Run:
`cd /Users/colereed/Projects/Spellbook && bunx biome check --write plugins/spellbook/skills/magpie`
Expected: formatted, no lint errors. (If biome flags an unused import — e.g. a
leftover `ElementCutout` — remove it.)

- [ ] **Step 16: Manual surface smoke (HMR)**

Open a fresh daemon, drop a board, discover, cut slices, flag one, re-slice the
flagged one. Confirm: thumbnails render, the flag ring + "Flagged" label toggle,
the re-slice updates the image with no refresh (rev cache-bust through
`versionUrl`), the lightbox cycles. This exercises the renamed surface paths
end-to-end.

- [ ] **Step 17: Commit**

```bash
cd /Users/colereed/Projects/Spellbook
git add plugins/spellbook/skills/magpie
git commit -m "refactor(magpie): migrate cutout→versions[] + reslice→flagged contract"
```

---

## Task 1.5: Phase scaffold — top-bar stepper (build BEFORE Task 2)

**Build order: after Task 1, before the removal pass.** Design:
`docs/projects/magpie-rebuild/phase-spine-design.md`. This lands the linear
`Intake → Slice → Remove → Export` spine + a top-bar stepper + the user-gated
`phase.advance` imperative + render-by-phase. The removal pass (Task 2) then
renders **into the Remove phase**, and the Export phase ships as a stub.
Contract is TDD'd; the stepper + render-by-phase are surface work covered by the
integration suite compiling + a manual smoke (UI may iterate on dogfood).

**Files:**

- Modify: `surface/state/types.ts` (`PhaseKey`, `PHASES`, `MagpieState.phase`,
  messages, events)
- Modify: `surface/state/reduce.ts`, `tests/reduce.test.ts` (`advancePhase`,
  `setPhase`)
- Modify: `scripts/server.ts` (`phase.advance` imperative, `phase.set` ambient,
  auto-intake in `elements.set`)
- Modify: `tests/daemon.integration.test.ts`
- Create: `surface/components/PhaseStepper.tsx`
- Modify: `surface/MagpieShell.tsx` (render the stepper + switch body by
  `state.phase` + the gold confirm gate)

**Interfaces produced:**

- `type PhaseKey = "intake" | "slice" | "remove" | "export"`;
  `PHASES: readonly PhaseKey[]`
- `MagpieState.phase: PhaseKey` (defaultState → `"intake"`)
- `advancePhase(s): PhaseKey | null` (cursor → next; null at last)
- `setPhase(s, phase: PhaseKey): boolean`
- Client messages: `phase.advance` (imperative), `phase.set { phase }` (ambient)
- Agent event: `phase.advance { phase }` (the NEW phase)

- [ ] **Step 1: Contract in `types.ts`**

Add near `ElementType`:

```ts
// The linear process spine (the top-bar stepper). One active phase at a time.
export type PhaseKey = "intake" | "slice" | "remove" | "export";
export const PHASES: readonly PhaseKey[] = [
  "intake",
  "slice",
  "remove",
  "export",
] as const;
```

In `MagpieState` add `phase: PhaseKey;`. In `defaultState` add
`phase: "intake",`.

In `ClientToServer` add:

```ts
  | { type: "phase.advance" } // seal the active phase, move the cursor to the next (imperative)
  | { type: "phase.set"; phase: PhaseKey } // back-nav / jump (ambient)
```

In `AGENT_EVENT_TYPES` add `"phase.advance"` (after `"retryRemoval"`); update
the doc comment. In `AgentEventPayload` add
`"phase.advance": { phase: PhaseKey };`.

- [ ] **Step 2: Write failing reduce tests**

In `tests/reduce.test.ts` import `advancePhase, setPhase`; add:

```ts
test("advancePhase moves the cursor to the next phase; null at the last", () => {
  const s = defaultState("t");
  expect(s.phase).toBe("intake");
  expect(advancePhase(s)).toBe("slice");
  expect(s.phase).toBe("slice");
  expect(advancePhase(s)).toBe("remove");
  expect(advancePhase(s)).toBe("export");
  expect(advancePhase(s)).toBeNull(); // already last → no-op
  expect(s.phase).toBe("export");
});

test("setPhase sets the cursor (back-nav), validates, reports change", () => {
  const s = defaultState("t");
  advancePhase(s);
  advancePhase(s); // → remove
  expect(setPhase(s, "slice")).toBe(true);
  expect(s.phase).toBe("slice");
  expect(setPhase(s, "slice")).toBe(false); // no-op
  // @ts-expect-error — invalid phase rejected
  expect(setPhase(s, "nope")).toBe(false);
});

test("defaultState starts at intake", () => {
  expect(defaultState("t").phase).toBe("intake");
});
```

Run: `bun test tests/reduce.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement the mutators in `reduce.ts`**

Import `PHASES, PhaseKey` from `./types`. Add:

```ts
// Advance the linear phase cursor to the next phase. Returns the new phase, or
// null if already at the last (no-op). The seal-and-hand-off the gate fires.
export function advancePhase(s: MagpieState): PhaseKey | null {
  const i = PHASES.indexOf(s.phase);
  if (i < 0 || i >= PHASES.length - 1) return null;
  s.phase = PHASES[i + 1];
  return s.phase;
}

// Set the phase cursor directly (back-nav / jump). Validates against PHASES;
// reports whether it changed.
export function setPhase(s: MagpieState, phase: PhaseKey): boolean {
  if (!PHASES.includes(phase) || s.phase === phase) return false;
  s.phase = phase;
  return true;
}
```

Run: `bun test tests/reduce.test.ts` → PASS.

- [ ] **Step 4: Server handlers in `server.ts`**

Import `advancePhase, setPhase` from reduce. In the `elements.set` agent case,
after `setElements(...)`, auto-advance intake:

```ts
if (state.phase === "intake" && state.elements.length) advancePhase(state);
```

In `handleBrowserMsg` add:

```ts
      case "phase.advance": {
        // The user sealing the active phase — an imperative hand-off. Advance the
        // cursor + tell the agent where we moved to.
        const prev = state.phase;
        const next = advancePhase(state);
        if (!next) return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `sealed ${prev} → ${next}`,
          gesture: { kind: "phase.advance" },
        });
        broadcastState();
        emitEvent({ type: "phase.advance", phase: next });
        break;
      }
      case "phase.set": {
        // Back-nav / jump — ambient (re-opens later phases for edits). NO agent push.
        if (typeof msg.phase !== "string") return;
        if (!setPhase(state, msg.phase as PhaseKey)) return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `stepped to ${msg.phase}`,
          gesture: { kind: "phase.set", targetId: msg.phase },
        });
        broadcastState();
        break;
      }
```

(Import `PhaseKey` into server.ts's type import.)

- [ ] **Step 5: Daemon integration tests**

Add `phase: string` to `ObservedState`. Add:

```ts
test("elements.set auto-advances intake → slice", async () => {
  const s = await spawnDaemon();
  expect((await getState(s)).phase).toBe("intake");
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  const st = await waitForState(s, (x) => x.phase === "slice");
  expect(st.phase).toBe("slice");
});

test("WS phase.advance IS an imperative — advances cursor + emits with the new phase", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.phase === "slice"); // auto-intake
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "phase.advance");
  const ws = await openWs(s);
  ws.send({ type: "phase.advance" });
  const st = await waitForState(s, (x) => x.phase === "remove");
  expect(st.phase).toBe("remove");
  const ev = (await evP).find((e) => e.type === "phase.advance") as
    | { phase?: string }
    | undefined;
  expect(ev?.phase).toBe("remove");
  ws.close();
});

test("WS phase.set is ambient — back-nav mutates, emits NO agent event", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.phase === "slice");
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, () => false, 700);
  const ws = await openWs(s);
  ws.send({ type: "phase.set", phase: "intake" });
  const st = await waitForState(s, (x) => x.phase === "intake");
  expect(st.phase).toBe("intake");
  expect((await evP).filter((e) => e.type === "phase.set")).toEqual([]);
  ws.close();
});
```

Run: `bun test` → all green.

- [ ] **Step 6: `PhaseStepper.tsx` (top-bar, surface)**

Create `surface/components/PhaseStepper.tsx`: a horizontal stepper over
`PHASES`, deriving each phase's status from `state.phase` (index < cursor =
sealed, === = active,

> = upcoming). Sealed = gold ✓ + artifact sublabel; active = indigo filled;
> upcoming = muted. An "N / 4 sealed" counter on the right. Sealed steps are
> clickable → `phase.set` (back-nav); upcoming steps are not clickable. Phase
> labels/icons/artifact strings live in a local const array (NOT in state —
> they're presentation). Reuse `typeColor`-style token access; no hex literals
> (use `var(--color-*)`). Mirror the mockup
> (`prototype/phase-stepper-mockup.html`).

- [ ] **Step 7: Render-by-phase + the gold gate in `MagpieShell.tsx`**

- Render `<PhaseStepper>` above the body whenever `state.source` exists.
- Switch the body on `state.phase`: `intake` → Dropzone/ScanningView (today's
  pre-element views, keyed on source presence); `slice` → today's
  BreakdownCanvas + ElementList rail; `remove` → a labeled **stub** ("Background
  removal — coming in the gallery task"); `export` → a labeled **stub** ("Export
  — bundle your assets").
- Add the **gold confirm gate** at the bottom of the Slice body: "Slices look
  good → Remove" → `send({ type: "phase.advance" })`. Disabled until at least
  one slice exists.
- Keep the existing `ended` view.

- [ ] **Step 8: Full suite + biome + manual smoke + commit**

Run: `bun test` (all green) and
`bunx biome check --write plugins/spellbook/skills/magpie`. Smoke in the
browser: drop a board → auto-advances to Slice → stepper shows Intake ✓ / Slice
active → cut slices → "Slices look good → Remove" seals Slice (gold ✓) and moves
to the Remove stub → click the sealed Slice step to step back. Commit:

```bash
cd /Users/colereed/Projects/Spellbook
git add plugins/spellbook/skills/magpie docs/projects/magpie-rebuild
git commit -m "feat(magpie): phase spine + top-bar stepper scaffold"
```

---

## Task 2: First removal pass — `removeBg` end-to-end + render the chosen version on a backdrop

> **Lands into the Remove phase** (Task 1.5). The gallery/backdrop/remove
> buttons below are the body of the Remove phase, replacing its stub.

Deliverable: the user triggers background removal (per item or batch), the agent
runs rembg and appends a `rembg` version, and the surface shows the chosen
result on a selectable backdrop. The slices→gallery transition stays explicit
and minimal here (a button); the full gallery grid is Task 3, which iterates
after this is dogfooded.

**Files:**

- Modify: `surface/MagpieShell.tsx` (backdrop swatches + remove buttons; render
  chosen version on the backdrop)
- Modify: `surface/styles.css` (backdrop swatch styles incl. the transparent
  checker)
- Reference (no change): `scripts/cli.ts` `extract --remove` already produces a
  `rembg` backend version; `scripts/backend.ts` `shouldRemove` gates alpha
  eligibility.
- Document: the agent recipe in `SKILL.md` (a later inscribe/ward step folds
  this in; capture it here).

**Interfaces consumed:** `chosenVersion`, `versionUrl`,
`removeBg`/`retryRemoval` messages, `addVersion` (Task 1).
`shouldRemove(type, "auto")` from `scripts/backend.ts` mirrors the
alpha-eligible set for the surface's "kept whole" note — but keep the policy
server/agent-side; the surface only needs the boolean per element, which the
agent can reflect, or the surface can import the pure `ALPHA_AUTO_TYPES` set
(it's a const set, not a model list — allowed).

- [ ] **Step 1: Backdrop swatch control (surface)**

Add a `BackdropSwatches` component driven by `state.backdrop` + `backdrop.set`
(already wired ambient in server.ts). Four swatches: white / gray / black /
transparent (checker). Render it in the canvas-area header (above or beside the
rail) so it travels with the review. Backdrop applies as the background behind
each rendered version (`chosenVersion`), so alpha is visible.

```tsx
const BACKDROPS: {
  key: Backdrop;
  label: string;
  style: React.CSSProperties;
}[] = [
  { key: "white", label: "White", style: { background: "#fff" } },
  { key: "gray", label: "Gray", style: { background: "#8a8a8a" } },
  { key: "black", label: "Black", style: { background: "#111" } },
  { key: "transparent", label: "Transparent", style: {} }, // .checker class
];
```

Backdrop swatch cells use a `.checker` CSS class (Task 2 Step 2) for the
transparent option. Clicking sends `{ type: "backdrop.set", backdrop: key }`.

- [ ] **Step 2: Checker + backdrop styles (`styles.css`)**

```css
/* Transparent-backdrop checker so alpha cutouts read as "no background". */
.checker {
  background-image:
    linear-gradient(45deg, var(--color-surface-3) 25%, transparent 25%),
    linear-gradient(-45deg, var(--color-surface-3) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--color-surface-3) 75%),
    linear-gradient(-45deg, transparent 75%, var(--color-surface-3) 75%);
  background-size: 16px 16px;
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
}
```

(Confirm `--color-surface-3` exists in `styles.css :root`; if not, use the
nearest neutral token — do NOT hardcode a hex outside this checker.)

- [ ] **Step 3: Render the chosen version on the active backdrop**

In `ElementRow` (and the Lightbox), wrap the rendered
`<img src={versionUrl(ver)}>` in a cell whose background reflects
`state.backdrop` — pass `backdrop` down from `MagpieShell` → `ElementList` →
`ElementRow`. For `transparent`, apply `className="checker"`; otherwise the
swatch's background color. This makes a rembg result visibly sit on the chosen
backdrop.

- [ ] **Step 4: Removal trigger buttons (surface)**

For an alpha-eligible element (`ALPHA_AUTO_TYPES.has(el.type)`) with no `rembg`
version yet, show a "Remove background" action on the row →
`send({ type: "removeBg", ids: [el.id] })`. Add a batch "Remove N backgrounds"
button (eligible + not dropped) in the rail footer →
`send({ type: "removeBg" })` (absent ids → all eligible) or with the eligible id
set. For a forbidden type (`ALPHA_FORBIDDEN_TYPES`), show a small "kept whole"
note instead. These are explicit triggers (no auto-removal on entry — Global
Constraints).

- [ ] **Step 5: Agent recipe (document, then exercise)**

On the agent's `cli tail`, the new imperatives appear. The recipe (capture in
SKILL.md during the ward pass):

- `removeBg { ids? }` → run `cli extract --remove --ids <ids>` (rembg, backend
  `rembg`); the cut loop posts `element.addVersion` per element (Task 1 Step
  12). Absent ids → all eligible (omit `--ids`).
- `retryRemoval { ids }` → inspect each element's existing `versions[].model`,
  pick an UNUSED model at the agent's discretion (rembg if not yet tried;
  otherwise a cloud backend via media-forge), run it, and post
  `element.addVersion` with the new `model`/`kind:"cloud"` via `cli cmd --stdin`
  (the generic AgentCommand escape hatch — no new cli verb needed for cloud).

- [ ] **Step 6: Live dogfood (the gate to Task 3)**

Open a daemon, discover a real board, cut slices, click "Remove background" on
an alpha element, confirm the rembg version appears as chosen and renders on
each backdrop. Flip swatches. This is the felt checkpoint that informs Task 3's
gallery + detail-sidebar layout. Commit the surface + styles + recipe.

```bash
git add plugins/spellbook/skills/magpie
git commit -m "feat(magpie): first background-removal pass — removeBg + backdrop swatches"
```

---

## Deferred sub-steps — planned just-in-time after their predecessor is dogfooded

Per the project's phase-by-phase rhythm and the design doc's note that the
slices→gallery→extraction transition "is expected to iterate during the build,"
the surface-heavy sub-steps are specified here at interface depth and detailed
into bite-sized tasks once the preceding step has been felt. They reuse the
contract from Task 1 — no further contract change is anticipated.

- **Task 3 — Gallery + detail sidebar + version strip.** Main area = gallery
  grid of `chosenVersion(el)` on the backdrop; right sidebar = the selected
  element's detail with a vertical **version strip** (one row per `versions[]`
  entry: thumbnail on backdrop, `model` label + `kind` chip, `note`, active
  marker). Selecting a row sends `version.choose { id, versionId }` (ambient,
  already wired). Forbidden types show the "kept whole" explainer instead of a
  strip. Reuses: `chosenVersion`, `versionUrl`, `version.choose`. New: layout
  components only.
- **Task 4 — Model-agnostic retry loop.** Flag (`element.flag`) the cutouts that
  aren't working; the gallery toolbar surfaces "Try a different removal on N" →
  `retryRemoval { ids }` (model-agnostic). A processing shimmer (reuse
  `ActivityBars`) sits in the strip while the agent works; the new version lands
  via `element.addVersion` and the user clicks to choose it. Reuses: everything
  from Task 1; the agent's unused-model discretion from Task 2 Step 5.
- **Task 5 — Expand-in-place.** A single gallery item fills the canvas area with
  the sidebar still open ("Back to gallery"); same detail controls. No contract
  change.
- **Task 6 — Workflow dogfood incl. other models (test step, not a feature).**
  Run the full flow together and deliberately exercise a NON-rembg model on
  selected items (Bria/Ideogram via media-forge, agent's discretion) through
  `retryRemoval` → validate the extraction-and-swap round trip and that nothing
  about a new model touches the app. This is the proof the model-agnostic path
  is real.

At phase finish: `ward` flips the registry row `cantrip → conjuration`; fold the
agent recipe (Task 2 Step 5) into SKILL.md; capture a grimoire scenario for the
Tailwind `@theme` tree-shaking gotcha and the imperatives-only judgment.

---

## Self-Review

- **Spec coverage:** design doc §"Contract changes" → Task 1; §"Interaction
  model"/"Surface" first-pass → Task 2; gallery/detail/retry/expand/dogfood
  (build sub-steps 3–6) → Deferred Tasks 3–6. Backdrop swatches (locked
  decision 6) → Task 2 Steps 1–3. Type-driven alpha policy (locked decision 4) →
  Task 2 Step 4 (kept-whole note). Model-agnostic, never-baked (decisions 2–3) →
  Global Constraints + Task 2 Step 5 + Task 4.
- **Type consistency:** `ElementVersion`/`versions`/`chosenVersionId`/`flagged`
  used identically across types.ts, versions.ts, reduce.ts, server.ts, cli.ts,
  surface, tests.
  `addVersion`/`chooseVersion`/`flagElement`/`chosenVersion`/`versionUrl`
  signatures match every call site. Messages
  `element.flag`/`version.choose`/`removeBg`/`retryRemoval` and command
  `element.addVersion` are consistent server ↔ client ↔ cli.
- **No placeholders:** Tasks 1–2 carry literal code + exact commands + expected
  output. Tasks 3–6 are deliberately interface-level (not vague) — the project's
  dogfood rhythm requires the UI to be felt before its JSX is fixed; finalizing
  them now would churn. This is a stated scoping decision, not an omission.
