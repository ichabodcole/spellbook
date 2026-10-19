// The pane's rendered view against a real daemon, with each redraw made costly:
// a newer text of the same version waits out the redraw's pause (coalesced), and
// another version is drawn at once (the pane names the version in `textKey`).
//
// A redraw is made costly by an inline widget that moves `performance.now` on as
// it draws. The daemon runs in this process and reads the same clock; it only
// ever moves forward.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo } from "react";
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
import { testWorkspace } from "../workspace/fixtures/harness";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane, type DocumentPaneSlots } from "./DocumentPane.tsx";

beforeAll(() => {
  installDom();
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => ({ ...rect, toJSON() {} });
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
afterAll(removeDom);

const realNow = performance.now.bind(performance);
let ahead = 0;
let root: string;
let story: string;
let daemon: WorkspaceDaemon;

beforeEach(async () => {
  root = tempRoot("document-pane-coalesce");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  const ws = testWorkspace(root, "ws");
  story = join(ws, "story.md");
  writeFileSync(story, "COST one.\n");
  localStorage.clear();
  ahead = 0;
  performance.now = () => realNow() + ahead;
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  performance.now = realNow;
  rmSync(root, { recursive: true, force: true });
});

/** Every drawing of "COST" costs a second. */
const slots: DocumentPaneSlots = {
  inlineWidgets: [
    {
      className: "costly-widget",
      find: (text) =>
        [...text.matchAll(/COST/g)].map((m) => ({ start: m.index, end: m.index + 4 })),
      render: () => {
        ahead += 1000;
        return null;
      },
    },
  ],
};

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
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
        <DocumentPane {...slots} mode="rendered" />
      </main>
    </WorkspaceContext.Provider>
  );
}

const cmd = async (body: Record<string, unknown>) => {
  const res = await fetch(`${daemon.url}/cmd`, { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
};
const rendered = () => document.querySelector(".md-prose")?.textContent ?? "";
const pause = (ms: number) => settle(() => new Promise((r) => setTimeout(r, ms)));

/** Another surface on the session, as a second tab is. */
async function otherTab(): Promise<WebSocket> {
  const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  return ws;
}

async function openStory() {
  await mount(<Host />);
  await cmd({ op: "context.add", paths: [story] });
  const ws = await otherTab();
  ws.send(JSON.stringify({ op: "open", path: story }));
  await waitFor(() => rendered().includes("one."), "the story, rendered");
  return ws;
}

test("a newer text of the same version waits out a costly redraw's pause, then is drawn", async () => {
  const ws = await openStory();
  ws.send(JSON.stringify({ op: "edit", doc: "story", version: 1, text: "COST two.\n", rid: 1 }));
  await waitFor(() => daemon.session.readVersion("story", 1).text === "COST two.\n", "the edit");
  await pause(100);
  // Held: the redraw before cost a second, so the newer text waits.
  expect(rendered()).toContain("one.");
  await waitFor(() => rendered().includes("two."), "drawn after the pause", 3000);
  ws.close();
});

test("another version of a costly document is drawn at once", async () => {
  const ws = await openStory();
  await cmd({ op: "version.new", doc: "story", body: "COST version two.\n", activate: false });
  await waitFor(() => daemon.session.doc("story").versions.length === 2, "v2 made");
  await cmd({ op: "activate", doc: "story", version: 2 });
  await waitFor(() => rendered().includes("version two."), "v2 drawn", 250);
  ws.close();
});
