// The document pane once the session has ended: the raw editor is read-only and
// Save is disabled, over a REAL workspace daemon. The workspace around the pane
// is a small host, as in `DocumentPane.test.tsx`: the pane's subpath does not
// reach the shell.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { createRef, useMemo } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { cleanup, installDom, mount, nativeGlobal, removeDom, waitFor } from "../lib/testDom.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { testWorkspace } from "../workspace/fixtures/harness";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";
import type { EditorHandle } from "./DocumentView.tsx";

beforeAll(() => {
  installDom();
  // CodeMirror measures text with ranges and rects, which happy-dom does not lay out.
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => ({ ...rect, toJSON() {} });
  const el = window.Element.prototype as unknown as Record<string, unknown>;
  el.getClientRects = el.getClientRects ?? (() => []);
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
afterAll(async () => {
  await removeDom();
});

let root: string;
let ws: string;
let story: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
const editor = createRef<EditorHandle>();

beforeEach(async () => {
  root = tempRoot("document-ended");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The story sits in the session's workspace folder.
  ws = testWorkspace(root, "ws");
  story = join(ws, "story.md");
  writeFileSync(story, "First line.\n");
  localStorage.clear();
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  const toasts = useMemo(() => createToastStore(), []);
  const state = d.state;
  if (!state) return null;
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc: state.docs.find((doc) => doc.slug === state.openDoc) ?? null,
    selection: null,
    reportSelection: () => {},
    dropSelection: () => {},
    clearSeq: 0,
    reveal: null,
    requestReveal: () => {},
    revealApplied: () => {},
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
        <DocumentPane mode="raw" editor={editor} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = (sel: string) => document.querySelector(sel);

describe("the pane after the session ends", () => {
  test("the raw editor stops being editable and Save is disabled", async () => {
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open", "connected");
    client?.send({ op: "context.add", path: story });
    client?.send({ op: "open", path: story });
    await waitFor(() => q(".cm-content")?.getAttribute("contenteditable") === "true", "the editor");
    const view = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement);
    expect(view()?.state.readOnly).toBe(false);

    client?.send({ op: "close" });
    await waitFor(() => client?.connection === "ended", "ended");
    await waitFor(() => q(".cm-content")?.getAttribute("contenteditable") === "false", "read-only");
    expect(view()?.state.readOnly).toBe(true);
    const save = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Save"),
    );
    expect((save as HTMLButtonElement | undefined)?.disabled).toBe(true);
    // A dispatch is not typing: the handle must not put text into the ended editor.
    editor.current?.insertAtCaret("[PAUSE:MICRO]");
    expect(view()?.state.doc.toString()).toBe("First line.\n");
    // Comparing is asked of the daemon, which has gone.
    const compare = q('button[aria-label="Compare with another version"]') as HTMLButtonElement;
    expect(compare.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(compare.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("The session has ended, so there is nothing to compare");
    await m.unmount();
  });
});
