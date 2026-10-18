// The pane when the open document's file is deleted outside the app, in a DOM
// against a real fixture daemon: a "gone from disk" banner in the register of the
// changed-on-disk one (not Unsaved), Save to recreate it (and its folder, said
// so), and Close. The toolbar's Save and Revert are off behind the banner; a
// plain Save the daemon refuses anyway (`workspace/fileGone.test.ts`).

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo } from "react";
import type { Daemon } from "../context/daemonClient.ts";
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
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";

beforeAll(() => {
  installDom();
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
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
afterAll(async () => {
  await removeDom();
});

let root: string;
let ws: string;
let world: string;
let part: string;
let story: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;

beforeEach(async () => {
  root = tempRoot("document-pane-gone");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The set sits in the workspace, so it is in the context from the start.
  ws = testWorkspace(root, "ws");
  world = join(ws, "world");
  part = join(world, "part");
  mkdirSync(part, { recursive: true });
  story = join(part, "story.md");
  writeFileSync(story, "First line.\n");
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
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
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ??
  null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const banner = () => q("[data-slot=file-gone]");
/**
 * How long the banner may take after the delete: the watcher's settle and the
 * daemon's missing recheck (about half a second), then a frame and a render,
 * sized for a parallel run rather than testDom's 2 s default.
 */
const GONE_MS = 10_000;
const doc = () => daemon.session.doc("story");

/** Open the story and type into it, so it has an unsaved edit when the file goes. */
async function openEdited() {
  await mount(<Host />);
  await waitFor(() => document.body.textContent?.includes("No document open") === true, "empty");
  await settle(() => {
    client?.send({ op: "context.add", path: world });
  });
  await waitFor(() => (client?.state?.context.length ?? 0) === 1, "the set");
  // The set's watch is not live at once (FSEvents on macOS): a delete made in
  // its first milliseconds is never reported. A file made until the tree shows
  // it says the watch is live.
  await writeUntilSeen(
    "the set's watch",
    () => writeFileSync(join(world, "watch-live.md"), "# Live\n"),
    () => JSON.stringify(client?.state?.context ?? []).includes("watch-live.md"),
  );
  await settle(() => {
    client?.send({ op: "open", path: story });
  });
  await waitFor(() => (q(".cm-content")?.textContent ?? "").length > 0, "the editor");
  await settle(() => {
    client?.send({ op: "edit", doc: "story", version: 1, text: "First line, edited.\n" });
  });
  await waitFor(() => document.body.textContent?.includes("Unsaved") === true, "Unsaved");
}

describe("an open document whose file is deleted outside the app", () => {
  test("says the file is gone, not Unsaved; the toolbar's Save and Revert stand aside", async () => {
    await openEdited();
    rmSync(story);
    await waitFor(() => banner() !== null, "the gone banner", GONE_MS);
    expect(banner()?.getAttribute("role")).toBe("alert");
    expect(banner()?.textContent).toContain("This file is gone from disk.");
    expect(banner()?.textContent).toContain("Save to recreate it");
    expect(document.body.textContent).not.toContain("Unsaved");
    expect(document.body.textContent).toContain("File gone");
    expect(document.body.textContent).not.toContain("changed on disk");
    // The toolbar's own Save and Revert are off: the banner is the way.
    const toolbarSave = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Save",
    ) as HTMLButtonElement;
    expect(toolbarSave.disabled).toBe(true);
    expect((button("Revert") as HTMLButtonElement).disabled).toBe(true);
  });

  test("Save to recreate it writes the session's text back", async () => {
    await openEdited();
    rmSync(story);
    await waitFor(() => banner() !== null, "the gone banner", GONE_MS);
    await click(button("Save to recreate it"));
    await waitFor(() => existsSync(story), "the file back");
    expect(readFileSync(story, "utf8")).toBe("First line, edited.\n");
    await waitFor(() => banner() === null, "the banner gone");
  });

  test("Close puts it away; its versions stay in the session", async () => {
    await openEdited();
    rmSync(story);
    await waitFor(() => banner() !== null, "the gone banner", GONE_MS);
    await click(button("Close"));
    await waitFor(() => document.body.textContent?.includes("No document open") === true, "closed");
    expect(doc().missing).toBe("file");
    expect(readFileSync(doc().versions[0]?.path ?? "", "utf8")).toBe("First line, edited.\n");
  });
});

describe("an open document whose folder is deleted outside the app", () => {
  test("says the folder went too, and Save says it makes the folder again", async () => {
    await openEdited();
    rmSync(part, { recursive: true });
    await waitFor(
      () => banner()?.textContent?.includes("its folder") === true,
      "the banner",
      GONE_MS,
    );
    expect(banner()?.textContent).toContain("This file and its folder are gone from disk.");
    await click(button("Save, making the folder again"));
    await waitFor(() => existsSync(story), "the folder and file back");
    expect(readFileSync(story, "utf8")).toBe("First line, edited.\n");
  });
});
