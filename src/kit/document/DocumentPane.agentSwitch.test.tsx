// The document pane, with its real editor, when the agent switches the open
// document's version while what the human typed waits out the client's pause
// (`kit-agent-activate-pending-edit`). In both orders (the switch seen before
// the write goes, and the write sent before the switch is seen) the typed text
// is in the version it was typed in, the editor moves to the agent's version,
// no error is shown, and the chat says where the edit went.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { heldSocket } from "../context/heldSocket.fixture.ts";
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
import { cmd, testWorkspace } from "../workspace/fixtures/harness";
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
afterAll(async () => {
  await removeDom();
});

let root: string;
let story: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let held: ReturnType<typeof heldSocket>;

beforeEach(async () => {
  root = tempRoot("pane-agent-switch");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  const ws = testWorkspace(root, "ws");
  story = join(ws, "story.md");
  writeFileSync(story, "First line.\n");
  localStorage.clear();
  held = heldSocket(nativeGlobal<typeof WebSocket>("WebSocket"));
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  held.release();
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: held.WebSocket,
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
    columns: {
      collapsed: { context: false, chat: false },
      collapse: () => {},
      expand: () => {},
    },
    setQuiet: () => {},
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" tabIndex={-1} style={{ width: 900, height: 700 }}>
        <DocumentPane />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = (sel: string) => document.querySelector(sel);
const editorText = () => q(".cm-content")?.textContent ?? "";
const viewOf = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const versionFile = (n: number) => join(daemon.dir, "docs", "story", `v${n}.md`);
const chat = () => (client?.state?.chat ?? []).map((m) => m.text);
const SAVED = "Your last edit was saved to v1 of story; the agent made v2 active.";

/** Open the story, with a second version the agent wrote; v1 stays active. */
async function openStory() {
  await mount(<Host />);
  await waitFor(
    () => document.body.textContent?.includes("No document open") === true,
    "the empty state",
  );
  await cmd(daemon.url, { op: "context.add", paths: [story] });
  await settle(() => {
    client?.send({ op: "open", path: story });
  });
  await waitFor(() => editorText().includes("First line."), "the text in the editor");
  await cmd(daemon.url, { op: "version.new", doc: "story", body: "Version two.\n" });
  await waitFor(
    () => client?.state?.docs.find((d) => d.slug === "story")?.versions.length === 2,
    "v2",
  );
}

/** A keystroke's worth: the human types at the start of the line. */
const type = (text: string) =>
  settle(() => viewOf().dispatch({ changes: { from: 0, insert: text } }));

describe("the agent switches the open document's version while an edit waits", () => {
  test("the switch seen first: the edit is in v1, the editor shows v2, the chat says so", async () => {
    await openStory();
    await type("Now. ");
    await cmd(daemon.url, { op: "activate", doc: "story", version: 2 });
    await waitFor(() => editorText().includes("Version two."), "v2 in the editor");
    await waitFor(
      () => readFileSync(versionFile(1), "utf8") === "Now. First line.\n",
      "the edit in v1",
    );
    // The buffer was read before it was given v2's text: v2 is as the agent wrote it.
    expect(readFileSync(versionFile(2), "utf8")).toBe("Version two.\n");
    expect(editorText()).not.toContain("Now.");
    await waitFor(() => chat().includes(SAVED), "the chat line");
    expect(client?.lastError ?? null).toBeNull();
  });

  test("the write sent first: the edit reaches the daemon after the switch and is saved", async () => {
    await openStory();
    held.hold();
    await type("Now. ");
    await cmd(daemon.url, { op: "activate", doc: "story", version: 2 });
    // The pane has not seen the switch; its pause ends (a blur flushes the same way).
    await settle(() => client?.flushText("story"));
    await settle(() => held.release());
    await waitFor(() => editorText().includes("Version two."), "v2 in the editor");
    await waitFor(
      () => readFileSync(versionFile(1), "utf8") === "Now. First line.\n",
      "the edit in v1",
    );
    expect(readFileSync(versionFile(2), "utf8")).toBe("Version two.\n");
    await waitFor(() => chat().includes(SAVED), "the chat line");
    expect(client?.lastError ?? null).toBeNull();
  });

  test("with nothing typed, the editor simply moves to v2", async () => {
    await openStory();
    await cmd(daemon.url, { op: "activate", doc: "story", version: 2 });
    await waitFor(() => editorText().includes("Version two."), "v2 in the editor");
    expect(readFileSync(versionFile(1), "utf8")).toBe("First line.\n");
    expect(chat().filter((t) => t.includes("last edit"))).toEqual([]);
    expect(client?.lastError ?? null).toBeNull();
  });
});

describe("switching back to the version the edit was saved in", () => {
  test("after the agent's switch: the editor shows the saved edit, and the next key adds to it", async () => {
    await openStory();
    await type("Now. ");
    await cmd(daemon.url, { op: "activate", doc: "story", version: 2 });
    await waitFor(() => editorText().includes("Version two."), "v2 in the editor");
    await waitFor(
      () => readFileSync(versionFile(1), "utf8") === "Now. First line.\n",
      "the edit in v1",
    );
    // Back to v1, with nothing typed in v2.
    await cmd(daemon.url, { op: "activate", doc: "story", version: 1 });
    await waitFor(() => editorText().includes("Now. First line."), "v1's saved text");
    expect(editorText()).not.toContain("Version two.");
    await type("X");
    await settle(() => client?.flushText("story"));
    await waitFor(
      () => readFileSync(versionFile(1), "utf8") === "XNow. First line.\n",
      "the key added to v1",
    );
    expect(readFileSync(versionFile(2), "utf8")).toBe("Version two.\n");
  });

  test("after the user's own switch: the same", async () => {
    await openStory();
    await type("Now. ");
    await settle(() => {
      client?.send({ op: "activate", doc: "story", version: 2 });
    });
    await waitFor(() => editorText().includes("Version two."), "v2 in the editor");
    expect(readFileSync(versionFile(1), "utf8")).toBe("Now. First line.\n");
    await settle(() => {
      client?.send({ op: "activate", doc: "story", version: 1 });
    });
    await waitFor(() => editorText().includes("Now. First line."), "v1's saved text");
    await type("X");
    await settle(() => client?.flushText("story"));
    await waitFor(
      () => readFileSync(versionFile(1), "utf8") === "XNow. First line.\n",
      "the key added to v1",
    );
    expect(readFileSync(versionFile(2), "utf8")).toBe("Version two.\n");
  });
});
