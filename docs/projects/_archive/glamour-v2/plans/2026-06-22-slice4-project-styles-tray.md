# Glamour v2 — Slice 4: Project-Styles Tray — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **project-scoped styles tray** — the agent codifies a finished
style (the style-guide sections + canonical images) and saves it to a store
keyed to the checkout where the spell was cast; past styles are listed in a tray
(not auto-loaded) and deliberately brought into a new session as a
`kind:"style"` reference. Non-destructive (archive, not delete).

**Architecture:** A new **project-keyed style store** (`styles.server.ts`)
persists `SavedStyle` records (codified `StyleSection[]` + copied
canonical-image blobs) under `GLAMOUR_HOME/styles/<projectKey>/`, where
`projectKey` derives from the user's working directory captured at `cli.ts open`
time (the daemon's own cwd is pinned to the skill root for Tailwind, so the
project path is passed in explicitly via `--project`). On open the daemon loads
that project's styles into `state.tray` (metadata only — never into the
library). The human marks library images **canonical** (a per-item flag,
ambient), the agent **saves** the current style (`style.save` — gathers the
style guide + canonical images, persists, pushes to the tray), and the human
**brings a style in** (`style.bringIn` — the daemon builds a `kind:"style"`
library item carrying the style's canonical thumbnails and emits the existing
`item.add` agent event). No new agent-event type is introduced.

**Tech Stack:** Bun ≥ 1.3.14, React 19 (bundled by Bun), bun-plugin-tailwind,
Tailwind v4, lucide-react. No new npm dependencies.

## Global Constraints

- v2 lives at `plugins/spellbook/skills/glamour-v2/`; it stays **unlisted** (no
  `SKILL.md`) until the post-Slice-4 cutover. **V1
  (`plugins/spellbook/skills/glamour/`) is never touched by this slice.**
- **One shared contract:** all channels import `surface/state/types.ts`.
- **`AGENT_EVENT_TYPES` is the frozen allowlist.** This slice adds **no new
  event type** — `style.bringIn` reuses the existing `"item.add"` event; marking
  canonical is ambient; `style.save`/`style.archive` are agent-origin.
- **Ambient vs. imperative vs. agent-origin:** `item.canonical` (mark/unmark) is
  **ambient** (mutate + broadcast, no event). `style.bringIn` is **imperative**
  (the human deliberately adds a style item → daemon builds it, broadcasts, and
  emits `item.add`). `style.save` / `style.archive` are **agent-origin**
  (broadcast, no event).
- **Project scoping by the user's cwd, captured at open.** `cli.ts open` records
  `process.cwd()` **before** the cwd-pinned spawn and passes it as `--project`.
  The daemon derives a stable `projectKey` from the absolute path. Snapshots
  stay session-keyed (unchanged); only the **styles store** is project-keyed.
- **Non-destructive.** A `SavedStyle` carries an `archived` flag; archive hides
  it from the tray and keeps the file. No delete.
- **Conversational-interface principle (from Slice 3.5 dogfooding,
  `sessions/2026-06-23-slices1-3-dogfood-feedback.md`).** Slice 3.5 stripped the
  top bar of imperative action-chrome (Generate, Add buttons); it now holds only
  identity + the Library/Style-guide view toggle. This slice MUST NOT
  reintroduce a top-bar action button. The tray opener lives in the **gallery
  area** (the facet row, where styles visually live), the canonical control is
  an **in-context** pin toggle in the details fly-out, "bring in" lives **inside
  the tray drawer**, and saving is **agent-driven** (no human save button) —
  controls live where the action visually is.
- **Purity:** pure reducers in `reduce.ts` never call `Date.now()` / `crypto` or
  touch the filesystem; the server supplies ids/timestamps and does all IO.
- **`styles.server.ts` is server/CLI-only** (filesystem) — never imported from
  browser code (mirrors `persist.server.ts` / `imageOptimize.server.ts`).
- **Live Playwright e2e is mandatory and controller-run** (final task).
- **Formatting:** biome on changed `.ts`/`.tsx`/`.json`; prettier on `.md`.
- **Commit trailer** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Run tests with `bun test`** from the repo root.

---

## Design decisions (the mockup left these open)

The converged mockup depicts the **tray drawer**, the **bring-in** flow, and the
`kind:"style"` tile, but leaves two flows undecided. Resolved here:

- **Saving a style is agent-driven** (`style.save <label>`). The agent codifies
  when the guide is agreed; there is no human "save" button this slice (matches
  the mockup, which shows the agent announcing the save).
- **Marking canonical is a per-item toggle** (`item.canonical`), surfaced in the
  details fly-out beside star/like. This **diverges from V1's single-select
  canonical** deliberately: a v2 style is a compound of _multiple_ canonical
  images, so the flag is multi, not single-select.
- **Tray thumbnails:** the drawer shows each style's label + description + a
  **"N canonical" count** (not thumbnails) to keep `state.tray` lean (no blobs).
  Real canonical thumbnails render on the **brought-in** `kind:"style"` tile
  (carried as data-URLs in full state, stripped in the lean agent projection).
  The mockup's per-entry swatches were CSS-gradient placeholders.

---

## Data-model design

V1 mining (proposal): V1's
`spec {understanding, modules, recreatePrompt, model}` already became the
**style-guide sections** (Slice 2). V1's single-select `Variant.canonical` is
**reframed** here as a multi `LibraryItem.canonical` marker feeding the style's
canonical-image set. V1 had **no** durable/project style persistence — this
slice is the proposal's headline value-add.

---

## File Structure

**Modified:**

- `surface/state/types.ts` — add `CanonImg`, `CanonicalRef`, `SavedStyle`;
  `LibraryItem` gains `canonical: boolean` + `canon: CanonImg[]`; `GlamourState`
  gains `tray: SavedStyle[]`; `LeanItem` omits `canon` (in addition to
  `src`/`text`); `ClientToServer` gains `item.canonical` + `style.bringIn`;
  `AgentCommand` gains `style.save` + `style.archive`; `defaultState()` seeds
  `tray: []`; `makeItem` defaults `canonical:false`, `canon:[]`.
- `surface/state/reduce.ts` — add `setCanonical`, `archiveTrayStyle`,
  `buildStyleItem`; `leanItem` strips `canon`; `applyAgentMsg` handles
  `style.archive`; `AMBIENT_CLIENT` gains `item.canonical`.
- `scripts/server.ts` — `--project` plumbing → `projectKey` + styles dir; load
  tray on open; handle `item.canonical` (ambient), `style.bringIn` (build
  `kind:"style"` item + `item.add` event), `style.save` (gather + persist + push
  tray), `style.archive`.
- `scripts/cli.ts` — `cmdOpen` captures `process.cwd()` → `--project`; add
  `style-save` / `style-archive` / `tray` verbs (+ pure builders); refresh HELP.
- `surface/components/LibraryTile.tsx` (or `LibraryGrid.tsx` — wherever tiles
  render) — render a `kind:"style"` tile (palette icon, fuchsia "Styles" badge,
  description, canonical thumbnails).
- `surface/components/DetailsFlyout.tsx` — a **canonical** toggle beside
  star/like (ref/gen items).
- `surface/components/FacetBar.tsx` — an optional `trailing` slot so the
  "Project styles" tray opener renders as the last pill in the facet row (see
  the conversational-interface constraint below).
- `surface/App.tsx` — the "Project styles" opener passed into `FacetBar`'s
  `trailing` slot (gallery area, NOT the top bar) + `StylesTray` drawer wiring.

**Created:**

- `surface/state/styles.server.ts` — project-keyed style store: `projectKey`,
  `saveStyle`, `loadTray`, `setStyleArchived`, `materializeCanon`.
- `surface/components/StylesTray.tsx` — the left-slide tray drawer (list +
  bring-in).
- (tests added to existing `tests/*.test.ts` + a new `tests/styles.test.ts`)

---

### Task 1: Extend the contract (styles tray + canonical)

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/state/types.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/types.test.ts`

**Interfaces:**

- Consumes: existing `ItemKind` (has `"style"`), `LibraryItem`, `LeanItem`,
  `GlamourState`, `StyleSection`, `ClientToServer`, `AgentCommand`,
  `AGENT_EVENT_TYPES`, `defaultState`.
- Produces:
  - `type CanonImg = { title: string; src: string }` — a brought-in style's
    thumbnail (data-URL `src`); blob — stripped in lean.
  - `type CanonicalRef = { id: string; title: string; file: string; mime: string }`
    — a canonical image inside a `SavedStyle` (blob copied into the style dir as
    `file`).
  - `type SavedStyle = { id: string; label: string; text: string; sections: StyleSection[]; canonical: CanonicalRef[]; createdAt: number; archived: boolean }`
  - `LibraryItem` gains `canonical: boolean` and `canon: CanonImg[]`.
  - `LeanItem = Omit<LibraryItem, "src" | "text" | "canon">`.
  - `GlamourState` gains `tray: SavedStyle[]`.
  - `ClientToServer` gains
    `{ type: "item.canonical"; id: string; canonical: boolean }` and
    `{ type: "style.bringIn"; id: string }`.
  - `AgentCommand` gains `{ type: "style.save"; label: string }` and
    `{ type: "style.archive"; id: string; archived: boolean }`.
  - `defaultState()` seeds `tray: []`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/types.test.ts`:

```ts
import { AGENT_EVENT_TYPES, defaultState } from "../surface/state/types";

describe("Slice 4 contract", () => {
  test("defaultState seeds an empty tray", () => {
    expect(defaultState("t", "i").tray).toEqual([]);
  });

  test("style + canonical commands add NO new agent event type", () => {
    // bring-in reuses item.add; canonical is ambient; save/archive agent-origin.
    expect(AGENT_EVENT_TYPES).not.toContain("style.bringIn");
    expect(AGENT_EVENT_TYPES).not.toContain("style.save");
    expect(AGENT_EVENT_TYPES).not.toContain("style.archive");
    expect(AGENT_EVENT_TYPES).not.toContain("item.canonical");
    expect(AGENT_EVENT_TYPES).toContain("item.add"); // bring-in rides this
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/types.test.ts`
Expected: FAIL — `defaultState(...).tray` is undefined.

- [ ] **Step 3: Implement the contract additions**

In `surface/state/types.ts`, add the new types (near `GenMeta`/`StyleSection`):

```ts
// A brought-in style's canonical thumbnail (data-URL `src` — stripped in lean).
export type CanonImg = { title: string; src: string };

// A canonical image inside a SavedStyle: the blob is copied into the style's
// dir on save and referenced by `file` (so the saved style is self-contained).
export type CanonicalRef = {
  id: string;
  title: string;
  file: string;
  mime: string;
};

// A style saved to the project tray — a compound "canonical shape": the codified
// style-guide sections (text) + canonical images. Project-scoped, non-destructive.
export type SavedStyle = {
  id: string;
  label: string;
  text: string; // short human description (e.g. the Understanding/Direction gist)
  sections: StyleSection[]; // the codified style guide at save time
  canonical: CanonicalRef[];
  createdAt: number;
  archived: boolean;
};
```

Extend `LibraryItem` (add the two fields after `annotations`):

```ts
  annotations: { agent: string; human: string };
  canonical: boolean; // marked canonical for the style being built (multi, not single-select)
  canon: CanonImg[]; // a kind:"style" item's canonical thumbnails; [] otherwise — stripped in lean
  archived: boolean;
```

Update `LeanItem` to strip the new blob field:

```ts
export type LeanItem = Omit<LibraryItem, "src" | "text" | "canon">;
```

Extend `GlamourState` (add `tray` after `styleGuide`):

```ts
  styleGuide: StyleSection[];
  tray: SavedStyle[];
```

Extend `ClientToServer`:

```ts
  | { type: "item.canonical"; id: string; canonical: boolean } // ambient
  | { type: "style.bringIn"; id: string }; // imperative — adds a kind:"style" item
```

Extend `AgentCommand`:

```ts
  | { type: "style.save"; label: string }
  | { type: "style.archive"; id: string; archived: boolean }
```

Seed `tray` in `defaultState()`:

```ts
    styleGuide: defaultStyleGuide(),
    tray: [],
```

> `AGENT_EVENT_TYPES` is **unchanged**.

- [ ] **Step 4: Update `makeItem` defaults** (so existing callers compile)

In `surface/state/reduce.ts`, `makeItem` returns an object — add the two new
fields with defaults (Task 2 covers reduce.ts more, but this keeps Task 1's
suite green):

```ts
    annotations: { agent: "", human: "" },
    canonical: false,
    canon: [],
    archived: false,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test plugins/spellbook/skills/glamour-v2/` Expected: PASS (the
contract tests + all existing tests — `makeItem` now returns the new fields, so
`reduce`/`persist`/`daemon` tests still type-check and pass).

- [ ] **Step 6: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/state/types.ts \
        plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts \
        plugins/spellbook/skills/glamour-v2/tests/types.test.ts
git commit -m "feat(glamour-v2): extend contract with project-styles tray + canonical

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Reducers — canonical, tray archive, style-item builder

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`

**Interfaces:**

- Consumes: `GlamourState`, `SavedStyle`, `LibraryItem`, `CanonImg`,
  `AgentCommand` (Task 1).
- Produces:
  - `setCanonical(state, id: string, canonical: boolean): boolean` — sets a
    library item's `canonical` flag; `false` if no such item.
  - `archiveTrayStyle(state, id: string, archived: boolean): boolean` — toggles
    a tray entry's `archived`; `false` if not found.
  - `buildStyleItem(style: SavedStyle, canon: CanonImg[], createdAt: number): LibraryItem`
    — pure builder for a `kind:"style"` library item (id `style-${style.id}`,
    title = label, text = description, `canon` thumbnails). The server resolves
    `canon` (data-URLs from disk) and passes it in.
  - `leanItem` also strips `canon`.
  - `applyAgentMsg` handles `style.archive` (→ `archiveTrayStyle`).
  - `AMBIENT_CLIENT` gains `"item.canonical"`.

> `style.save` and `style.bringIn` are server-handled (IO + id/ts); only
> `style.archive` is pure → `applyAgentMsg`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/reduce.test.ts`:

```ts
import {
  applyAgentMsg,
  archiveTrayStyle,
  buildStyleItem,
  leanItem,
  setCanonical,
} from "../surface/state/reduce";
import { defaultState } from "../surface/state/types";

describe("styles tray + canonical reducers", () => {
  const sampleStyle = {
    id: "s1",
    label: "house style",
    text: "cute-occult, ink lines",
    sections: [],
    canonical: [],
    createdAt: 1,
    archived: false,
  };

  test("setCanonical toggles a library item; false for unknown id", () => {
    const s = defaultState("t", "i");
    s.library.push({
      id: "ref-1",
      kind: "ref",
      title: "a",
      src: "x",
      path: "",
      text: "",
      mime: "image/webp",
      tags: [],
      starred: false,
      liked: false,
      annotations: { agent: "", human: "" },
      canonical: false,
      canon: [],
      archived: false,
      createdAt: 1,
      gen: null,
    });
    expect(setCanonical(s, "ref-1", true)).toBe(true);
    expect(s.library[0].canonical).toBe(true);
    expect(setCanonical(s, "nope", true)).toBe(false);
  });

  test("archiveTrayStyle toggles archived; false when not found", () => {
    const s = defaultState("t", "i");
    s.tray.push({ ...sampleStyle });
    expect(archiveTrayStyle(s, "s1", true)).toBe(true);
    expect(s.tray[0].archived).toBe(true);
    expect(archiveTrayStyle(s, "nope", true)).toBe(false);
  });

  test("buildStyleItem produces a kind:style library item carrying canon", () => {
    const item = buildStyleItem(
      sampleStyle,
      [{ title: "hero", src: "data:..." }],
      42
    );
    expect(item.id).toBe("style-s1");
    expect(item.kind).toBe("style");
    expect(item.title).toBe("house style");
    expect(item.text).toBe("cute-occult, ink lines");
    expect(item.canon).toEqual([{ title: "hero", src: "data:..." }]);
    expect(item.createdAt).toBe(42);
  });

  test("leanItem strips canon (and src/text)", () => {
    const item = buildStyleItem(
      sampleStyle,
      [{ title: "hero", src: "data:..." }],
      42
    );
    const lean = leanItem(item) as Record<string, unknown>;
    expect("canon" in lean).toBe(false);
    expect("src" in lean).toBe(false);
    expect("text" in lean).toBe(false);
  });

  test("applyAgentMsg routes style.archive", () => {
    const s = defaultState("t", "i");
    s.tray.push({ ...sampleStyle });
    applyAgentMsg(s, { type: "style.archive", id: "s1", archived: true });
    expect(s.tray[0].archived).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`
Expected: FAIL — `setCanonical` / `archiveTrayStyle` / `buildStyleItem` not
exported.

- [ ] **Step 3: Implement the reducers**

In `surface/state/reduce.ts`, extend the type import with `SavedStyle`,
`CanonImg`, then add (place after the focus reducers from Slice 3):

```ts
export function setCanonical(
  state: GlamourState,
  id: string,
  canonical: boolean
): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.canonical = canonical;
  return true;
}

export function archiveTrayStyle(
  state: GlamourState,
  id: string,
  archived: boolean
): boolean {
  const st = state.tray.find((s) => s.id === id);
  if (!st) return false;
  st.archived = archived;
  return true;
}

export function buildStyleItem(
  style: SavedStyle,
  canon: CanonImg[],
  createdAt: number
): LibraryItem {
  return {
    id: `style-${style.id}`,
    kind: "style",
    title: style.label,
    src: "",
    path: "",
    text: style.text,
    mime: "",
    tags: [],
    starred: false,
    liked: false,
    annotations: { agent: "", human: "" },
    canonical: false,
    canon,
    archived: false,
    createdAt,
    gen: null,
  };
}
```

Update `leanItem` to strip `canon`:

```ts
export function leanItem(it: LibraryItem): LeanItem {
  const { src: _s, text: _t, canon: _c, ...rest } = it;
  return rest;
}
```

Add a `style.archive` case to `applyAgentMsg`:

```ts
    case "style.archive":
      archiveTrayStyle(state, msg.id, msg.archived);
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
  "item.canonical",
]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/state/reduce.ts \
        plugins/spellbook/skills/glamour-v2/tests/reduce.test.ts
git commit -m "feat(glamour-v2): canonical, tray-archive, style-item reducers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Project-keyed style store (`styles.server.ts`)

**Files:**

- Create: `plugins/spellbook/skills/glamour-v2/surface/state/styles.server.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/styles.test.ts`

**Interfaces:**

- Consumes: `SavedStyle`, `CanonImg`, `CanonicalRef`, `LibraryItem`,
  `StyleSection`.
- Produces (server/CLI-only — filesystem):
  - `projectKey(projectDir: string): string` — stable, filesystem-safe key from
    an absolute path (sanitized base name + short hash of the full path, so two
    different checkouts named the same don't collide).
  - `stylesDir(home: string, key: string): string` — `${home}/styles/${key}`.
  - `saveStyle(home, key, args: { id: string; label: string; text: string; sections: StyleSection[]; canonicalItems: LibraryItem[]; createdAt: number }): SavedStyle`
    — copies each canonical item's blob (from `item.path`) into the style's dir,
    writes `<id>.json`, returns the `SavedStyle`.
  - `loadTray(home, key): SavedStyle[]` — reads every `<id>.json` in the dir
    (returns all, archived included; the surface filters).
  - `setStyleArchived(home, key, id, archived): boolean` — rewrites the
    `<id>.json` with the flag flipped.
  - `materializeCanon(home, key, style: SavedStyle): CanonImg[]` — reads each
    canonical blob from disk and returns `{ title, src }` data-URLs for
    bring-in.

- [ ] **Step 1: Write the failing tests**

Create `tests/styles.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTray,
  materializeCanon,
  projectKey,
  saveStyle,
  setStyleArchived,
  stylesDir,
} from "../surface/state/styles.server";

let HOME: string;
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), "glamour-v2-styles-"));
});

test("projectKey is stable + filesystem-safe + path-distinguishing", () => {
  const a = projectKey("/Users/x/proj-one");
  const b = projectKey("/Users/x/proj-one");
  const c = projectKey("/Users/y/proj-one"); // same base, different path
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
});

test("saveStyle copies canonical blobs + writes the record; loadTray reads it back", () => {
  const key = projectKey("/tmp/projA");
  // a fake materialized canonical image on disk
  const filesDir = mkdtempSync(join(tmpdir(), "glamour-v2-files-"));
  const blobPath = join(filesDir, "gen-1.webp");
  writeFileSync(blobPath, Buffer.from([1, 2, 3, 4]));

  const saved = saveStyle(HOME, key, {
    id: "st1",
    label: "house style",
    text: "ink + indigo",
    sections: [
      {
        key: "palette",
        label: "Palette",
        status: "agreed",
        content: "indigo",
        prompts: [],
      },
    ],
    canonicalItems: [
      {
        id: "gen-1",
        kind: "gen",
        title: "hero",
        src: "",
        path: blobPath,
        text: "",
        mime: "image/webp",
        tags: [],
        starred: false,
        liked: false,
        annotations: { agent: "", human: "" },
        canonical: true,
        canon: [],
        archived: false,
        createdAt: 1,
        gen: null,
      },
    ],
    createdAt: 100,
  });

  expect(saved.id).toBe("st1");
  expect(saved.canonical).toHaveLength(1);
  expect(saved.canonical[0]).toMatchObject({
    id: "gen-1",
    title: "hero",
    mime: "image/webp",
  });

  const tray = loadTray(HOME, key);
  expect(tray.map((s) => s.id)).toContain("st1");
  expect(tray.find((s) => s.id === "st1")?.label).toBe("house style");
});

test("materializeCanon returns data-URLs for the copied blobs", () => {
  const key = projectKey("/tmp/projA");
  const style = loadTray(HOME, key).find((s) => s.id === "st1");
  if (!style) throw new Error("style not found");
  const canon = materializeCanon(HOME, key, style);
  expect(canon).toHaveLength(1);
  expect(canon[0].title).toBe("hero");
  expect(canon[0].src.startsWith("data:image/webp;base64,")).toBe(true);
});

test("setStyleArchived flips the flag on disk", () => {
  const key = projectKey("/tmp/projA");
  expect(setStyleArchived(HOME, key, "st1", true)).toBe(true);
  expect(loadTray(HOME, key).find((s) => s.id === "st1")?.archived).toBe(true);
  expect(setStyleArchived(HOME, key, "nope", true)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/styles.test.ts`
Expected: FAIL — module/exports don't exist yet.

- [ ] **Step 3: Implement `styles.server.ts`**

```ts
// Server/CLI-only: the project-scoped style store. Do NOT import from browser
// code (filesystem access). Styles live under ${home}/styles/${projectKey}/,
// keyed to the checkout where the spell was cast.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  CanonImg,
  CanonicalRef,
  LibraryItem,
  SavedStyle,
  StyleSection,
} from "./types";

const EXT_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

// A stable, filesystem-safe key: sanitized base name + a short hash of the full
// absolute path (so two checkouts with the same folder name don't collide).
export function projectKey(projectDir: string): string {
  const base = basename(projectDir).replace(/[^a-zA-Z0-9_-]/g, "_") || "root";
  let h = 5381;
  for (let i = 0; i < projectDir.length; i++)
    h = ((h << 5) + h + projectDir.charCodeAt(i)) >>> 0;
  return `${base}-${h.toString(36)}`;
}

export function stylesDir(home: string, key: string): string {
  return join(home, "styles", key);
}

export function saveStyle(
  home: string,
  key: string,
  args: {
    id: string;
    label: string;
    text: string;
    sections: StyleSection[];
    canonicalItems: LibraryItem[];
    createdAt: number;
  }
): SavedStyle {
  const dir = stylesDir(home, key);
  mkdirSync(dir, { recursive: true });
  const canonical: CanonicalRef[] = [];
  for (const it of args.canonicalItems) {
    if (!it.path || !existsSync(it.path)) continue;
    const ext = EXT_BY_MIME[it.mime] ?? "bin";
    const file = `${args.id}-${it.id}.${ext}`;
    try {
      writeFileSync(join(dir, file), readFileSync(it.path));
      canonical.push({ id: it.id, title: it.title, file, mime: it.mime });
    } catch {
      /* skip an unreadable blob */
    }
  }
  const style: SavedStyle = {
    id: args.id,
    label: args.label,
    text: args.text,
    sections: args.sections,
    canonical,
    createdAt: args.createdAt,
    archived: false,
  };
  writeFileSync(join(dir, `${args.id}.json`), JSON.stringify(style));
  return style;
}

export function loadTray(home: string, key: string): SavedStyle[] {
  const dir = stylesDir(home, key);
  if (!existsSync(dir)) return [];
  const out: SavedStyle[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as SavedStyle);
    } catch {
      /* skip a corrupt record */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function setStyleArchived(
  home: string,
  key: string,
  id: string,
  archived: boolean
): boolean {
  const path = join(stylesDir(home, key), `${id}.json`);
  if (!existsSync(path)) return false;
  try {
    const style = JSON.parse(readFileSync(path, "utf8")) as SavedStyle;
    style.archived = archived;
    writeFileSync(path, JSON.stringify(style));
    return true;
  } catch {
    return false;
  }
}

export function materializeCanon(
  home: string,
  key: string,
  style: SavedStyle
): CanonImg[] {
  const dir = stylesDir(home, key);
  const out: CanonImg[] = [];
  for (const ref of style.canonical) {
    try {
      const bytes = readFileSync(join(dir, ref.file));
      out.push({
        title: ref.title,
        src: `data:${ref.mime};base64,${bytes.toString("base64")}`,
      });
    } catch {
      /* skip a missing blob */
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/styles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/state/styles.server.ts \
        plugins/spellbook/skills/glamour-v2/tests/styles.test.ts
git commit -m "feat(glamour-v2): project-keyed style store (styles.server)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Server wiring + project plumbing

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/scripts/server.ts`
- Modify: `plugins/spellbook/skills/glamour-v2/scripts/cli.ts` (only `cmdOpen`
  capturing cwd → `--project`; the new verbs land in Task 5)
- Test: `plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`

**Interfaces:**

- Consumes: `setCanonical`, `archiveTrayStyle` (via `applyAgentMsg`),
  `buildStyleItem`, `addItem`, `makeItem`, `leanItem` (reduce); `projectKey`,
  `stylesDir`, `saveStyle`, `loadTray`, `materializeCanon` (styles.server);
  `materializeItem` (persist); `randHex`, `broadcastState`, `emitEvent`.
- Produces:
  - `StartOpts` gains `project?: string`. `startDaemon` derives
    `projectKey(opts.project ?? process.cwd())`, computes the styles dir under
    `GLAMOUR_HOME`, and on startup loads `state.tray = loadTray(...)`.
  - WS `{ type:"item.canonical", id, canonical }` → `setCanonical` + broadcast,
    **no** event (ambient).
  - WS `{ type:"style.bringIn", id }` → look up the tray style; build a
    `kind:"style"` item via
    `buildStyleItem(style, materializeCanon(...), Date.now())`; `addItem`;
    broadcast; `emitEvent({ type:"item.add", item: leanItem(it), selectedIds })`
    (reuses the existing item.add event — idempotent: skip if `style-${id}`
    already in the library).
  - POST `/cmd { type:"style.save", label }` → gather `state.library` items with
    `canonical === true`; derive `text` from the agreed style-guide sections
    (the `understanding`/`direction` content, joined); `saveStyle(...)`; push
    the returned `SavedStyle` to `state.tray`; broadcast. **No** event.
  - POST `/cmd { type:"style.archive", id, archived }` → also mirror to disk via
    `setStyleArchived` (so the change survives restart), then `applyAgentMsg`
    handles the in-memory tray; broadcast.

- [ ] **Step 1: Write the failing tests**

Add to `tests/daemon.integration.test.ts` (reuse `drainEvents`). Note the
integration harness sets `GLAMOUR_HOME`; pass `project` via `startDaemon`. If
the top-level `startDaemon` in `beforeAll` doesn't pass `project`, these tests
start their own daemon with an explicit `project` + a fresh port — follow the
file's existing multi-daemon pattern, or add `project` to the shared one. Tests:

```ts
test("item.canonical marks an item and emits no agent event", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  ws.send(
    JSON.stringify({
      type: "item.add",
      item: { kind: "ref", title: "c.png", src: "data:image/webp;base64,AAAA" },
    })
  );
  await Bun.sleep(120);
  const s0 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string }[] };
  };
  const id = s0.state.library.at(-1)?.id as string;
  ws.send(JSON.stringify({ type: "item.canonical", id, canonical: true }));
  await Bun.sleep(50);
  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { id: string; canonical: boolean }[] };
  };
  expect(s1.state.library.find((i) => i.id === id)?.canonical).toBe(true);
  const ev = await drainEvents(base, 0, "__never__", 250);
  expect(ev).not.toContain('"type":"item.canonical"');
  ws.close();
});

test("style.save persists the current style to the tray (agent-origin, no event)", async () => {
  // mark the canonical item from the prior test, agree a section, then save
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({
      type: "section",
      key: "understanding",
      content: "cute-occult ink",
      status: "agreed",
    }),
  });
  await fetch(`${base}/cmd`, {
    method: "POST",
    body: JSON.stringify({ type: "style.save", label: "house style" }),
  });
  await Bun.sleep(80);
  const s = (await (await fetch(`${base}/state`)).json()) as {
    state: { tray: { label: string; canonical: unknown[] }[] };
  };
  const saved = s.state.tray.find((t) => t.label === "house style");
  expect(saved).toBeTruthy();
  expect(saved?.canonical.length).toBeGreaterThanOrEqual(1); // the canonical-marked ref was captured
  const ev = await drainEvents(base, 0, "__never__", 250);
  expect(ev).not.toContain('"type":"style.save"');
});

test("style.bringIn adds a kind:style item and emits item.add", async () => {
  const s0 = (await (await fetch(`${base}/state`)).json()) as {
    state: { tray: { id: string }[] };
  };
  const styleId = s0.state.tray[0].id;
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  await new Promise((res) => (ws.onopen = () => res(null)));
  ws.send(JSON.stringify({ type: "style.bringIn", id: styleId }));
  const ev = await drainEvents(base, 0, '"kind":"style"');
  expect(ev).toContain('"type":"item.add"');
  expect(ev).toContain('"kind":"style"');
  const s1 = (await (await fetch(`${base}/state`)).json()) as {
    state: { library: { kind: string }[] };
  };
  expect(s1.state.library.some((i) => i.kind === "style")).toBe(true);
  ws.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`bun test plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts`
Expected: FAIL — none of `item.canonical`/`style.save`/`style.bringIn` are
wired.

- [ ] **Step 3: Implement the server wiring**

In `scripts/server.ts`:

(a) Imports — add to the `reduce` block `setCanonical` and `buildStyleItem`; add
a styles-store import:

```ts
import {
  loadTray,
  materializeCanon,
  projectKey,
  saveStyle,
  setStyleArchived,
} from "../surface/state/styles.server";
```

(b) `StartOpts` gains `project?: string`. After `GLAMOUR_HOME`/`SNAPSHOTS_DIR`,
derive the project key and load the tray into the (possibly restored) state:

```ts
const PROJECT_KEY = projectKey(opts.project ?? process.cwd());
// Load the project's saved styles into the tray (metadata only — NOT the
// library). Do this after restore so a restored snapshot's stale tray is
// replaced by the authoritative on-disk set.
state.tray = loadTray(GLAMOUR_HOME, PROJECT_KEY);
```

(c) Agent `style.save` + `style.archive` in `handleAgentMsg` (before the
`applyAgentMsg` fall-through for save; archive both mirrors to disk and
applies):

```ts
if (msg.type === "style.save") {
  const canonicalItems = state.library.filter(
    (i) => i.canonical && !i.archived
  );
  const agreed = state.styleGuide.filter(
    (s) => s.status !== "empty" && s.content
  );
  const text = agreed
    .map((s) => s.content)
    .join(" · ")
    .slice(0, 280);
  const style = saveStyle(GLAMOUR_HOME, PROJECT_KEY, {
    id: `style-${randHex(4)}`,
    label: msg.label,
    text,
    sections: state.styleGuide,
    canonicalItems,
    createdAt: Date.now(),
  });
  state.tray.push(style);
  broadcastState();
  return;
}
if (msg.type === "style.archive") {
  setStyleArchived(GLAMOUR_HOME, PROJECT_KEY, msg.id, msg.archived);
  applyAgentMsg(state, msg); // flips the in-memory tray entry
  broadcastState();
  return;
}
```

(d) Client `item.canonical` + `style.bringIn` in `handleClientMsg`:

```ts
      case "item.canonical":
        if (setCanonical(state, msg.id, msg.canonical)) broadcastState();
        break;
      case "style.bringIn": {
        const style = state.tray.find((s) => s.id === msg.id);
        if (!style) break;
        const itemId = `style-${style.id}`;
        if (state.library.some((i) => i.id === itemId)) break; // idempotent
        const canon = materializeCanon(GLAMOUR_HOME, PROJECT_KEY, style);
        const it = buildStyleItem(style, canon, Date.now());
        if (addItem(state, it)) {
          broadcastState();
          emitEvent({ type: "item.add", item: leanItem(it), selectedIds: state.selectedIds });
        }
        break;
      }
```

(e) `import.meta.main` bootstrap — pass `project: flag("project")`:

```ts
    project: flag("project"),
```

In `scripts/cli.ts` `cmdOpen` — capture the user's cwd BEFORE the spawn (the
spawn pins cwd to `SKILL_ROOT`), and pass it:

```ts
// The user's project dir — captured here because the daemon spawns with
// cwd pinned to SKILL_ROOT (Tailwind), so it can't read the real cwd itself.
daemonArgs.push("--project", process.cwd());
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
        plugins/spellbook/skills/glamour-v2/scripts/cli.ts \
        plugins/spellbook/skills/glamour-v2/tests/daemon.integration.test.ts
git commit -m "feat(glamour-v2): project-scoped tray wiring (save/bring-in/canonical/archive)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: CLI verbs — style-save, style-archive, tray

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/scripts/cli.ts`
- Test: `plugins/spellbook/skills/glamour-v2/tests/cli.test.ts`

**Interfaces:**

- Consumes: `parseArgs`, `postCmd`, `cmdState`-style readers.
- Produces:
  - `buildStyleSaveCmd(pos): { type:"style.save"; label: string }` (label =
    joined positionals).
  - `buildStyleArchiveCmd(pos, flags): { type:"style.archive"; id: string; archived: boolean }`
    — `archived` defaults `true`; `--restore` (or `--archived false`) sets it
    `false`.
  - Verbs: `style-save <label...>`; `style-archive <id> [--restore]`; `tray`
    (prints the lean tray from `/state`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/cli.test.ts`:

```ts
import {
  buildStyleArchiveCmd,
  buildStyleSaveCmd,
  parseArgs,
} from "../scripts/cli";

describe("slice 4 cli builders", () => {
  test("style-save joins the label", () => {
    const { pos } = parseArgs(["house", "style"]);
    expect(buildStyleSaveCmd(pos)).toEqual({
      type: "style.save",
      label: "house style",
    });
  });
  test("style-archive defaults archived true; --restore flips it", () => {
    expect(buildStyleArchiveCmd(["s1"], {})).toEqual({
      type: "style.archive",
      id: "s1",
      archived: true,
    });
    expect(buildStyleArchiveCmd(["s1"], { restore: true })).toEqual({
      type: "style.archive",
      id: "s1",
      archived: false,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/cli.test.ts` Expected:
FAIL — builders not exported.

- [ ] **Step 3: Implement the builders + verbs**

In `scripts/cli.ts`, add (export both):

```ts
export function buildStyleSaveCmd(pos: string[]): {
  type: "style.save";
  label: string;
} {
  return { type: "style.save", label: pos.join(" ") };
}

export function buildStyleArchiveCmd(
  pos: string[],
  flags: Record<string, string | boolean>
): { type: "style.archive"; id: string; archived: boolean } {
  return {
    type: "style.archive",
    id: pos[0],
    archived: flags.restore !== true,
  };
}
```

Wire the verbs in `main`:

```ts
    case "style-save":
      if (!pos.length) die("usage: style-save <label...>");
      await postCmd(session, buildStyleSaveCmd(pos));
      break;
    case "style-archive":
      if (!pos.length) die("usage: style-archive <id> [--restore]");
      await postCmd(session, buildStyleArchiveCmd(pos, flags));
      break;
    case "tray": {
      const s = requireSession(session);
      const { data } = await api(s.port, "GET", "/state?lean=1");
      const tray = (data as { state?: { tray?: unknown[] } })?.state?.tray ?? [];
      printJson(tray);
      break;
    }
```

Refresh `HELP`:

```ts
  style-save <label...>              codify the current style → project tray
  style-archive <id> [--restore]     archive (or --restore) a saved style
  tray                               list the project's saved styles
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test plugins/spellbook/skills/glamour-v2/tests/cli.test.ts` Expected:
PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/scripts/cli.ts \
        plugins/spellbook/skills/glamour-v2/tests/cli.test.ts
git commit -m "feat(glamour-v2): style-save, style-archive, tray CLI verbs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Surface — StylesTray, style tile, canonical toggle

**Files:**

- Create:
  `plugins/spellbook/skills/glamour-v2/surface/components/StylesTray.tsx`
- Modify: the tile renderer (`LibraryTile.tsx` if present, else the tile block
  in `LibraryGrid.tsx`) — render `kind:"style"` tiles.
- Modify:
  `plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx` — a
  canonical toggle beside star/like.

**Interfaces:**

- `StylesTray({ tray, inLibrary, onBringIn, onClose }: { tray: SavedStyle[]; inLibrary: (id: string) => boolean; onBringIn: (id: string) => void; onClose: () => void })`
  — left-slide drawer listing non-archived styles; each: palette icon, label,
  text, "N canonical" count, and a bring-in button that reads "bring into
  session" / "in palette" (disabled when `inLibrary("style-"+id)`).
- Tile renderer: a `kind:"style"` item shows a palette icon, the fuchsia
  "Styles" badge, `item.text` (clamped), and a row of `item.canon` thumbnails.
- `DetailsFlyout` gains an `onCanonical: (canonical: boolean) => void` prop +
  `item.canonical` and renders a canonical (pin) toggle for ref/gen items.

> Build-check only. `StylesTray` is wired in Task 7; verify it type-checks.

- [ ] **Step 1: Implement `StylesTray.tsx`**

```tsx
import { ArrowRightToLine, Check, Library, Palette, X } from "lucide-react";
import type { SavedStyle } from "../state/types";

export function StylesTray({
  tray,
  inLibrary,
  onBringIn,
  onClose,
}: {
  tray: SavedStyle[];
  inLibrary: (id: string) => boolean;
  onBringIn: (id: string) => void;
  onClose: () => void;
}) {
  const styles = tray.filter((s) => !s.archived);
  return (
    <aside className="absolute bottom-0 left-0 top-0 z-20 flex w-80 flex-col border-r border-white/10 bg-slate-900 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <Library className="h-4 w-4 text-fuchsia-300" />
        <span className="text-sm font-semibold">Styles · this project</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close tray"
          className="ml-auto text-slate-500 hover:text-slate-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="border-b border-white/10 px-4 py-2 text-[10px] leading-snug text-slate-500">
        Styles you've defined in this checkout. Not loaded automatically — bring
        one in to use it as a reference.
      </p>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {styles.length === 0 ? (
          <p className="text-xs text-slate-500">No saved styles yet.</p>
        ) : (
          styles.map((st) => {
            const present = inLibrary(`style-${st.id}`);
            return (
              <div
                key={st.id}
                className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-3"
              >
                <div className="flex items-center gap-1.5">
                  <Palette className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-xs font-medium text-slate-200">
                    {st.label}
                  </span>
                </div>
                {st.text && (
                  <p className="mt-1 text-[10px] text-slate-500">{st.text}</p>
                )}
                <p className="mt-1 text-[10px] text-slate-600">
                  {st.canonical.length} canonical image
                  {st.canonical.length === 1 ? "" : "s"}
                </p>
                <button
                  type="button"
                  onClick={() => onBringIn(st.id)}
                  disabled={present}
                  className={`mt-2 flex w-full items-center justify-center gap-1 rounded-md border py-1.5 text-[11px] ${
                    present
                      ? "cursor-default border-slate-700 text-slate-600"
                      : "border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-600/20"
                  }`}
                >
                  {present ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <ArrowRightToLine className="h-3 w-3" />
                  )}
                  {present ? "in palette" : "bring into session"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Render the `kind:"style"` tile**

Read the tile renderer first. Add a `kind:"style"` branch that shows: the
fuchsia "Styles" badge (reuse the gen-badge pattern), a `Palette` icon,
`item.text` (clamped to ~3 lines), and a bottom row of `item.canon` thumbnails:

```tsx
{
  item.kind === "style" && (
    <div className="relative flex h-full flex-col bg-slate-800/80 p-2.5">
      <span className="absolute left-1.5 top-1.5 rounded-full bg-fuchsia-600/80 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white">
        style
      </span>
      <Palette className="mb-1 mt-3 h-4 w-4 text-slate-500" />
      <p className="line-clamp-3 text-[10px] leading-snug text-slate-400">
        {item.text}
      </p>
      {item.canon.length > 0 && (
        <div className="mt-auto flex gap-1 pt-2">
          {item.canon.map((c) => (
            <img
              key={c.title}
              src={c.src}
              alt={c.title}
              className="h-5 flex-1 rounded-sm object-cover"
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

Adapt to the file's real tile structure (image tiles use `item.src`; the style
tile is text+canon, not a single `src`). Keep the existing `<button>` wrapper +
click-to-select.

- [ ] **Step 3: Canonical toggle in `DetailsFlyout.tsx`**

Add an `onCanonical` prop and a pin toggle next to star/like (shown for ref/gen
items — not style items):

```tsx
{
  item.kind !== "style" && (
    <button
      type="button"
      onClick={() => onCanonical(!item.canonical)}
      aria-label="canonical"
    >
      <Pin
        className={`h-4 w-4 ${item.canonical ? "fill-fuchsia-300 text-fuchsia-300" : "text-slate-400"}`}
      />
    </button>
  );
}
```

Import `Pin` from `lucide-react`; add
`onCanonical: (canonical: boolean) => void` to the props type.

- [ ] **Step 4: Format + build-check**

Run:
`bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/components/StylesTray.tsx plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx`
(+ the tile file). Then
`bun build plugins/spellbook/skills/glamour-v2/surface/index.html --outdir /tmp/glamour-v2-buildcheck`
(the tile + flyout changes are reachable; `StylesTray` type-checks via reading).
Run `bun test plugins/spellbook/skills/glamour-v2/`.

> The flyout now requires an `onCanonical` prop — App passes it in Task 7. To
> keep this task's build green, App must be updated minimally OR `onCanonical`
> made optional. Make it **required** and update the App call site in this
> task's commit if the build fails without it (a one-line
> `onCanonical={() => {}}` placeholder is acceptable here; Task 7 wires the real
> handler). State which you did in the report.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/components/StylesTray.tsx \
        plugins/spellbook/skills/glamour-v2/surface/components/DetailsFlyout.tsx \
        plugins/spellbook/skills/glamour-v2/surface/components/LibraryTile.tsx \
        plugins/spellbook/skills/glamour-v2/surface/App.tsx
git commit -m "feat(glamour-v2): styles tray drawer, style tile, canonical toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Adjust the `git add` list to the real files touched.)

---

### Task 7: App integration — facet-row tray opener + canonical wiring

**Files:**

- Modify: `plugins/spellbook/skills/glamour-v2/surface/App.tsx`
- Modify: `plugins/spellbook/skills/glamour-v2/surface/components/FacetBar.tsx`
  (add the optional `trailing` slot)

**Interfaces:**

- Consumes: `StylesTray` (Task 6), the `DetailsFlyout` `onCanonical` prop, the
  scope-aware `LibraryGrid`, `FacetBar` (now with a `trailing` slot),
  `useSession.send`.
- Produces: a "Project styles" opener rendered as the last pill in the **facet
  row** (gallery area — NOT the top bar; see the conversational-interface
  constraint), toggling a local `trayOpen` state; the `StylesTray` drawer wired
  to `send({type:"style.bringIn", id})`; the flyout's `onCanonical` →
  `send({type:"item.canonical", id, canonical})`.

- [ ] **Step 1: Add a `trailing` slot to `FacetBar`**

In `surface/components/FacetBar.tsx`, add an optional `trailing?: ReactNode`
prop (import `type { ReactNode } from "react"`) and render it pushed to the
right end of the existing facet row, so the opener sits cohesively with the
facet pills:

```tsx
import type { ReactNode } from "react";
import type { ItemKind, LibraryItem } from "../state/types";
import { VALID_KIND } from "../state/types";
// …LABEL unchanged…

export function FacetBar({
  library,
  facet,
  onPick,
  trailing,
}: {
  library: LibraryItem[];
  facet: ItemKind | "all";
  onPick: (f: ItemKind | "all") => void;
  trailing?: ReactNode;
}) {
  // …live/count/pill unchanged…
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
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire App.tsx**

Read `App.tsx`, then add the local tray state:

```tsx
const [trayOpen, setTrayOpen] = useState(false);
```

Pass the "Project styles" opener into `FacetBar`'s `trailing` slot (library
view). Style it as a facet-row pill (`rounded-full bg-white/5 …`), consistent
with the facets — NOT as a top-bar button. Replace the existing
`<FacetBar library={state.library} facet={facet} onPick={setFacet} />` with:

```tsx
<FacetBar
  library={state.library}
  facet={facet}
  onPick={setFacet}
  trailing={
    <button
      type="button"
      onClick={() => setTrayOpen((v) => !v)}
      className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs text-slate-300 hover:bg-white/10"
    >
      <Library className="h-3.5 w-3.5" /> Project styles
      <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[9px] text-slate-400">
        {state.tray.filter((s) => !s.archived).length}
      </span>
    </button>
  }
/>
```

> The top bar is NOT touched — it stays at identity + the Library/Style-guide
> toggle (the Slice 3.5 shape). Do not add a header button.

The drawer (inside the `main` region so it overlays the library, library view
only) + the canonical wiring on the flyout:

```tsx
{
  trayOpen && (
    <StylesTray
      tray={state.tray}
      inLibrary={(id) => state.library.some((i) => i.id === id)}
      onBringIn={(id) => {
        send({ type: "style.bringIn", id });
        setTrayOpen(false);
      }}
      onClose={() => setTrayOpen(false)}
    />
  );
}
```

```tsx
// on <DetailsFlyout ...>
onCanonical={(canonical) => send({ type: "item.canonical", id: selected.id, canonical })}
```

Add the `Library` lucide import. Keep all Slice-1/2/3.5 wiring intact
(Conversation + the automatic thinking indicator, the resizable composer + Send
button, view toggle, FocusBar/FocusDrawer, Lightbox, drag/drop,
`role="application"`, `key={selected.id}`). Note: there is NO Generate or Add
button (removed in Slice 3.5) — do not reintroduce either.

- [ ] **Step 3: Format + build-check**

Run:
`bunx biome check --write plugins/spellbook/skills/glamour-v2/surface/App.tsx plugins/spellbook/skills/glamour-v2/surface/components/FacetBar.tsx`
Then
`bun build plugins/spellbook/skills/glamour-v2/surface/index.html --outdir /tmp/glamour-v2-buildcheck`
(must succeed — `StylesTray` now reachable). Run
`bun test plugins/spellbook/skills/glamour-v2/`.

- [ ] **Step 4: Commit**

```bash
git add plugins/spellbook/skills/glamour-v2/surface/App.tsx \
        plugins/spellbook/skills/glamour-v2/surface/components/FacetBar.tsx
git commit -m "feat(glamour-v2): wire the project-styles tray + canonical into the shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Live end-to-end verification (controller-run)

> **Not a subagent task.** Controller runs this with a live daemon + Playwright
> after Task 7's review is clean. The project store is exercised under a temp
> `GLAMOUR_HOME` and a temp `--project` dir so the real store isn't touched.

**Verification script:**

- [ ] Launch in a throwaway project dir with an isolated home:
      `GLAMOUR_HOME=$(mktemp -d) bun …/cli.ts open --title "Slice 4 e2e"` from a
      `cd`'d temp dir (so `--project` captures it) — or pass the daemon a known
      `--project`. Confirm the tray starts empty.
- [ ] Drop/seed a ref + a couple of gen items (via `cli.ts gen --file`).
- [ ] **Mark canonical:** open a gen tile's fly-out → click the pin toggle →
      `item.canonical` sets the flag (no agent event in `tail`).
- [ ] **Agree a section + save:**
      `cli.ts section understanding --content "cute-occult ink" --status agreed`,
      then `cli.ts style-save house style`. Confirm: the "Project styles" opener
      in the facet row shows its count tick to 1; `cli.ts tray` lists the style
      with `canonical.length >= 1`; the style dir under
      `$GLAMOUR_HOME/styles/<key>/` holds `<id>.json` + the copied canonical
      blob.
- [ ] **Bring in:** open the tray drawer → click "bring into session" → a
      `kind:"style"` tile appears (palette icon, fuchsia badge, description, the
      canonical thumbnail); the button flips to "in palette"; `tail` shows an
      `item.add` event with `"kind":"style"`. Bring-in again is a no-op
      (idempotent).
- [ ] **Project scoping / persistence:** `close`, then `open` **from the same
      project dir** (fresh session, NOT `--restore`) → the tray still lists the
      saved style (loaded from the project store), and the library starts empty
      (styles are not auto-loaded). Open from a **different** dir → the tray is
      empty (scoped).
- [ ] **Archive:** `cli.ts style-archive <id>` → the style drops from the tray
      drawer; `style-archive <id> --restore` brings it back.
- [ ] Confirm no zombie processes.

Record findings in the SDD ledger; dispatch one fix subagent for any
Critical/Important. Then the whole-branch review (opus).

---

## After Slice 4: the cutover (out of scope for this plan)

Slice 4 completes the MVP feature set. The **cutover** is a separate operation
(its own session): rename `glamour-v2/` → `glamour/` (replacing V1), run the
`ward` checklist (synced listings, version bump, fresh-agent, smoke test,
decay-ledger), reserve nothing new (the name already exists), and remove the old
V1 implementation — gated on the proposal's success criteria (fresh-agent + ward
pass). The deferred Minors logged across Slices 1–4 get triaged at the cutover.
Do **not** fold the cutover into this build.

---

## Self-Review

**Spec coverage** (proposal Slice 4 = "Project-styles tray"):

- Project-scoped tray, not auto-loaded → `state.tray` loaded on open from the
  project store; never injected into the library (Tasks 3, 4). ✅
- Deliberate bring-in → `style.bringIn` client command + tray drawer button
  (Tasks 4, 6, 7). ✅
- Styles as compound "canonical shapes" (text + canonical images) → `SavedStyle`
  = sections + `CanonicalRef[]`; `kind:"style"` item carries `canon` thumbnails
  (Tasks 1, 3, 6). ✅
- Non-destructive archive/restore → `archived` flag + `style-archive`
  [`--restore`], mirrored to disk (Tasks 3, 4, 5). ✅
- Save a codified style to the project + bring a prior style into a new session
  → `style.save` + project-keyed persistence + reload-on-open (Tasks 3, 4, 8).
  ✅
- V1 mining: single-select canonical → reframed as multi `item.canonical`;
  spec/sections already carried (Slice 2). ✅

**Placeholder scan:** No "TBD"/uncoded steps. Read-then-edit spots (the tile
renderer in Task 6, `App.tsx` in Tasks 6–7) name the exact change + reference
classes and tell the implementer to adapt to real variable names. Task 6's
flyout-prop/App-build coupling is called out with a concrete resolution.

**Type consistency:** `SavedStyle`, `CanonicalRef`, `CanonImg`,
`LibraryItem.canonical`/`canon`, `state.tray`, and the command shapes
(`item.canonical`/`style.bringIn`/`style.save`/`style.archive`) are identical
across Tasks 1–7. `style.bringIn` (client) reuses the `item.add` agent event —
no new `AGENT_EVENT_TYPES` member. `projectKey`/`saveStyle`/`loadTray`/
`materializeCanon`/`setStyleArchived` signatures match between Task 3 (store)
and Task 4 (server).

**Out of scope (correctly deferred):** the cross-spell shared library (L1); the
imago handoff (B1/B2); the cutover (rename → ward → remove V1).
