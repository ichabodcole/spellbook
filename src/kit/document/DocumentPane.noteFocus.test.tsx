// The focused note, painted by the document pane over a REAL workspace daemon:
// the workspace's `focusedNote` (the note chosen in the Notes panel) paints its
// passage with the focus highlight in the rendered view and with the focus mark
// in the raw editor; the paint follows the choice and goes when it is let go; a
// note on another document paints nothing here; and a note whose passage is
// gone paints nothing and breaks nothing. A resolved note is painted only while
// the panel shows resolved notes, or while it is the chosen one, as the panel
// lists it. The shell's side, the choice reaching
// the workspace, is held in `shell/WorkspaceShell.noteFocus.test.tsx`.
//
// happy-dom has no CSS Custom Highlight API, so a minimal one is installed: a
// registry and a Highlight that keeps its ranges, which is all the view uses.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo, useState } from "react";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { testWorkspace, writeUntilSeen } from "../workspace/fixtures/harness";
import type { DocView } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";
import type { ViewMode } from "./pane.ts";

/** Set-like, as the real one is: ranges are added one at a time. */
class FakeHighlight extends Set<Range> {
  get ranges(): Range[] {
    return [...this];
  }
}
let highlights: Map<string, FakeHighlight>;
let cssBefore: PropertyDescriptor | undefined;

beforeAll(() => {
  installDom();
  highlights = new Map();
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
  // happy-dom's CSS can be a fresh object on every read, so the registry is pinned.
  cssBefore = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    value: { highlights, supports: () => false, escape: (s: string) => s },
    configurable: true,
    writable: true,
  });
  // CodeMirror measures text with ranges and rects, which happy-dom does not lay out.
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON() {},
  };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => rect;
  const el = window.Element.prototype as unknown as Record<string, unknown>;
  el.getClientRects = el.getClientRects ?? (() => []);
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
afterEach(async () => {
  await cleanup();
  highlights.clear();
});
afterAll(async () => {
  delete (globalThis as { Highlight?: unknown }).Highlight;
  if (cssBefore) Object.defineProperty(globalThis, "CSS", cssBefore);
  else delete (globalThis as { CSS?: unknown }).CSS;
  await removeDom();
});

const TEXT = "# Story\n\nThe lantern is lit.\n\nThe harbour is dark.\n";
let root: string;
let story: string;
let daemon: WorkspaceDaemon;
/** The open document, as the pane last saw it. */
let open: DocView | null = null;
/** The panel's choice, as the shell would hand it over. */
let choose: (id: string | null) => void = () => {};
/** The panel's "show resolved", as the shell would hand it over. */
let showResolved: (on: boolean) => void = () => {};

beforeEach(async () => {
  root = tempRoot("document-note-focus");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The story sits in the workspace, so it is in the context from the start.
  const ws = testWorkspace(root, "ws");
  story = join(ws, "story.md");
  writeFileSync(story, TEXT);
  localStorage.clear();
  open = null;
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host({ mode }: { mode: ViewMode }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  const toasts = useMemo(() => createToastStore(), []);
  const [focusedNote, setFocusedNote] = useState<string | null>(null);
  choose = setFocusedNote;
  const [showResolvedNotes, setShowResolvedNotes] = useState(false);
  showResolved = setShowResolvedNotes;
  const state = d.state;
  if (!state) return null;
  const openDoc = state.docs.find((doc) => doc.slug === state.openDoc) ?? null;
  open = openDoc;
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc,
    selection: null,
    reportSelection: () => {},
    dropSelection: () => {},
    clearSeq: 0,
    reveal: null,
    requestReveal: () => {},
    revealApplied: () => {},
    focusedNote,
    showResolvedNotes,
    toasts,
    announce: () => 0,
    theme: "dark",
    setTheme: () => {},
    focusPane: () => {},
    columns: { collapsed: { context: false, chat: false }, collapse: () => {}, expand: () => {} },
    setQuiet: () => {},
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" style={{ width: 900, height: 700 }}>
        <DocumentPane mode={mode} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const post = (cmd: Record<string, unknown>) =>
  nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify(cmd),
  });
const q = (sel: string) => document.querySelector(sel);
/** What is painted under a highlight name, as text. */
const painted = (name: string) => highlights.get(name)?.ranges.map((r) => r.toString()) ?? [];
const focusPaint = () => painted("doc-note-focus");
const notePaint = () => painted("doc-note");
const idOf = (body: string) => open?.notes.find((n) => n.body === body)?.id ?? null;
const pick = (id: string | null) => settle(() => choose(id));

/** Mount in `mode` with the story open and two notes on it. */
async function openStory(mode: ViewMode) {
  const m = await mount(<Host mode={mode} />);
  await waitFor(() => open !== null || q('[data-pane="centre"]') !== null, "the pane");
  const socket = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
  await new Promise<void>((r) => {
    socket.onopen = () => r();
  });
  socket.send(JSON.stringify({ op: "open", path: story }));
  socket.close();
  await waitFor(() => open !== null, "the story open");
  const slug = (open as DocView | null)?.slug as string;
  await post({ op: "note.add", doc: slug, quote: "lantern", body: "the light" });
  await post({ op: "note.add", doc: slug, quote: "harbour", body: "the water" });
  await waitFor(() => !!idOf("the light") && !!idOf("the water"), "both notes");
  return m;
}

describe("the rendered view paints the focused note", () => {
  test("its passage takes the focus paint, the others the plain one; letting go clears it", async () => {
    const m = await openStory("rendered");
    await waitFor(() => notePaint().length === 2, "both notes painted");
    expect(focusPaint()).toEqual([]);

    await pick(idOf("the water"));
    await waitFor(() => focusPaint().length > 0, "the focus paint");
    expect(focusPaint()).toEqual(["harbour"]);
    expect(notePaint()).toEqual(["lantern"]);

    await pick(idOf("the light"));
    await waitFor(() => focusPaint()[0] === "lantern", "the paint moved");
    expect(notePaint()).toEqual(["harbour"]);

    await pick(null);
    await waitFor(() => focusPaint().length === 0, "the paint gone");
    expect(notePaint().sort()).toEqual(["harbour", "lantern"]);
    await m.unmount();
  });

  test("a note that is not on this document paints nothing here", async () => {
    const m = await openStory("rendered");
    await pick(idOf("the water"));
    await waitFor(() => focusPaint()[0] === "harbour", "a real note's paint");
    await pick("a-note-on-another-document");
    await waitFor(() => focusPaint().length === 0, "the focus paint gone");
    expect(notePaint().sort()).toEqual(["harbour", "lantern"]);
    await m.unmount();
  });

  test("a note whose passage is gone paints nothing, and the view goes on", async () => {
    const m = await openStory("rendered");
    await pick(idOf("the water"));
    await waitFor(() => focusPaint()[0] === "harbour", "the focus paint");
    await writeUntilSeen(
      "the passage gone",
      () => writeFileSync(story, TEXT.replace("harbour", "bay")),
      () => (q(".md-prose")?.textContent ?? "").includes("bay"),
    );
    await waitFor(
      () => open?.notes.find((n) => n.body === "the water")?.from === null,
      "the note placed nowhere",
    );
    await waitFor(() => focusPaint().length === 0, "no focus paint");
    expect(notePaint()).toEqual(["lantern"]);
    expect(q(".md-prose")?.textContent).toContain("The bay is dark.");
    await m.unmount();
  });
});

describe("the raw editor marks the focused note", () => {
  test("its passage carries the focus mark, which follows the choice and goes when let go", async () => {
    const m = await openStory("raw");
    const marked = (cls: string) =>
      [...document.querySelectorAll(`.cm-editor .${cls}`)].map((e) => e.textContent);
    await waitFor(() => marked("cm-note").length === 2, "both notes marked");
    expect(marked("cm-note-focus")).toEqual([]);

    await pick(idOf("the water"));
    await waitFor(() => marked("cm-note-focus").length > 0, "the focus mark");
    expect(marked("cm-note-focus")).toEqual(["harbour"]);
    await pick(idOf("the light"));
    await waitFor(() => marked("cm-note-focus")[0] === "lantern", "the mark moved");
    expect(marked("cm-note-focus")).toEqual(["lantern"]);
    expect(marked("cm-note")).toHaveLength(2);

    await pick(null);
    await waitFor(() => marked("cm-note-focus").length === 0, "the mark gone");
    expect(marked("cm-note")).toHaveLength(2);
    await m.unmount();
  });
});

describe("a resolved note is painted as the panel lists it", () => {
  const resolve = (body: string) =>
    post({ op: "note.resolve", doc: open?.slug, id: idOf(body), resolved: true });
  const resolvedHere = (body: string) =>
    open?.notes.find((n) => n.body === body)?.resolved === true;

  test("in the rendered view: not painted, unless shown or chosen", async () => {
    const m = await openStory("rendered");
    await waitFor(() => notePaint().length === 2, "both notes painted");
    await resolve("the water");
    await waitFor(() => resolvedHere("the water"), "resolved");
    await waitFor(() => notePaint().length === 1, "the resolved one unpainted");
    expect(notePaint()).toEqual(["lantern"]);

    await settle(() => showResolved(true));
    await waitFor(() => notePaint().length === 2, "shown, painted");
    await settle(() => showResolved(false));
    await waitFor(() => notePaint().length === 1, "hidden again");

    // Chosen, it is listed and so painted, as the focused one.
    await pick(idOf("the water"));
    await waitFor(() => focusPaint()[0] === "harbour", "the chosen resolved note");
    await m.unmount();
  });

  test("in the raw editor: not marked, unless shown", async () => {
    const m = await openStory("raw");
    const marked = () =>
      [...document.querySelectorAll(".cm-editor .cm-note")].map((e) => e.textContent);
    await waitFor(() => marked().length === 2, "both notes marked");
    await resolve("the water");
    await waitFor(() => resolvedHere("the water"), "resolved");
    await waitFor(() => marked().length === 1, "the resolved one unmarked");
    expect(marked()).toEqual(["lantern"]);
    await settle(() => showResolved(true));
    await waitFor(() => marked().length === 2, "shown, marked");
    await m.unmount();
  });
});
