// A reveal (a note clicked, a search result opened) in the document pane: the raw
// editor selects the range, and the rendered view, which has no selection to move,
// scrolls to the range's line and spends the reveal so it does not replay.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { cleanup, installDom, mount, nativeGlobal, removeDom, waitFor } from "../lib/testDom.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { testWorkspace } from "../workspace/fixtures/harness";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";

beforeAll(() => {
  installDom();
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
afterAll(removeDom);

const TEXT = "# Title\n\nfirst paragraph\n\nthe lantern is lit\n";
let root: string;
let ws: string;
let story: string;
let daemon: WorkspaceDaemon;
let applied: number[];

beforeEach(async () => {
  root = tempRoot("document-reveal");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The story sits in the session's workspace folder.
  ws = testWorkspace(root, "ws");
  story = join(ws, "story.md");
  writeFileSync(story, TEXT);
  localStorage.clear();
  applied = [];
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host({ mode }: { mode: "raw" | "rendered" }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  const toasts = useMemo(() => createToastStore(), []);
  const state = d.state;
  if (!state) return null;
  const openDoc = state.docs.find((doc) => doc.slug === state.openDoc) ?? null;
  const from = TEXT.indexOf("lantern");
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc,
    selection: null,
    reportSelection: () => {},
    dropSelection: () => {},
    clearSeq: 0,
    reveal: openDoc
      ? { doc: openDoc.slug, version: openDoc.active, from, to: from + 7, seq: 1 }
      : null,
    requestReveal: () => {},
    revealApplied: (seq) => applied.push(seq),
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

async function openStory(mode: "raw" | "rendered") {
  await mount(<Host mode={mode} />);
  await fetch(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify({ op: "context.add", paths: [story] }),
  });
  const socket = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
  await new Promise<void>((r) => {
    socket.onopen = () => r();
  });
  socket.send(JSON.stringify({ op: "open", path: story }));
  socket.close();
}

describe("a reveal in the document pane", () => {
  test("the raw editor selects the range", async () => {
    await openStory("raw");
    await waitFor(() => applied.length > 0, "the reveal applied");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
    const sel = view?.state.selection.main;
    expect(TEXT.slice(sel?.from, sel?.to)).toBe("lantern");
  });

  test("the rendered view takes the reveal too, and spends it", async () => {
    await openStory("rendered");
    await waitFor(() => document.querySelector(".md-prose p") !== null, "the rendered text");
    await waitFor(() => applied.length > 0, "the reveal spent");
    expect(applied[0]).toBe(1);
    expect(document.querySelector(".cm-editor")).toBeNull();
  });
});
