// Where the floating composer is drawn, over a REAL workspace daemon with the
// kit's document pane in the centre: with a document open, in the pane's dock,
// under the document and above its status strip, with the toasts' anchor just
// above it; with no status strip on screen, at the foot of the centre.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { useDaemon } from "../context/useDaemon.ts";
import { useWorkspace, type Workspace } from "../context/workspace.ts";
import { DocumentPane } from "../document/DocumentPane.tsx";
import { DEFAULT_VIEW_MODE_KEY } from "../document/pane.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { type LaidOut, laidOut } from "../lib/testLayout.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let stub: LaidOut | null = null;

beforeEach(async () => {
  root = tempRoot("shell-float-dock");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  // The rendered view: no editor to lay out, and the order is the pane's either way.
  localStorage.setItem(DEFAULT_VIEW_MODE_KEY, "rendered");
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
  stub = laidOut(1200);
});
afterEach(async () => {
  stub?.undo();
  stub = null;
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

let w: Workspace | null = null;
const ws = () => w as Workspace;
function Centre() {
  w = useWorkspace();
  return <DocumentPane />;
}

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<Centre />} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const float = () => q('[data-slot="floating-composer"]');
const strip = () => q('[data-pane="centre"] [data-slot="status-strip"]');
const view = () => q('[data-pane="centre"] [data-slot="markdown-view"]');
/** Whether `a` comes before `b` in the document. */
const before = (a: Element | null, b: Element | null) =>
  !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

async function mountShell() {
  w = null;
  const m = await mount(<Host />);
  await waitFor(() => w !== null && !!q('[data-pane="chat"]'), "the shell");
  return m;
}
async function collapseChat() {
  const el = q('[data-column-control="chat-collapse"]');
  if (!el) throw new Error("no collapse control");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await waitFor(() => ws().columns.collapsed.chat, "the chat shut");
  await waitFor(() => float() !== null, "the float");
}
async function openSolo() {
  await settle(() => {
    ws().daemon.send({ op: "open", path: join(docs, "solo.md") });
  });
  await waitFor(() => !!ws().openDoc && !!view() && !!strip(), "the document and its strip");
}

describe("the float's place in the centre", () => {
  test("with a document open: the document, then the float, then the status strip", async () => {
    const m = await mountShell();
    await openSolo();
    await collapseChat();
    await waitFor(() => !!float()?.closest('[data-slot="centre-dock"]'), "the float docked");
    expect(before(view(), float())).toBe(true);
    expect(before(float(), strip())).toBe(true);
    // In the flow, not over the text: the document's view does not hold it.
    expect((view() as Element).contains(float())).toBe(false);
    // Drawn once, in the dock: nothing at the foot of the centre.
    expect(document.querySelectorAll('[data-slot="floating-composer"]').length).toBe(1);
    const body = q('[data-slot="centre-body"]') as Element;
    expect(body.contains(float())).toBe(true);
    await m.unmount();
  });

  test("the toasts' anchor sits above the docked float", async () => {
    const m = await mountShell();
    await openSolo();
    await collapseChat();
    await waitFor(() => !!float()?.closest('[data-slot="centre-dock"]'), "the float docked");
    await settle(() => {
      ws().announce("A toast");
    });
    await waitFor(() => !!q('[data-slot="toasts"]'), "the toast");
    const toasts = q('[data-slot="toasts"]');
    expect(toasts?.closest('[data-slot="dock-toasts"]')).not.toBeNull();
    expect(before(toasts, float())).toBe(true);
    expect(before(toasts, strip())).toBe(true);
    // One stack, not one per place.
    expect(document.querySelectorAll('[data-slot="toasts"]').length).toBe(1);
    await m.unmount();
  });

  test("with no status strip, the float stays at the foot of the centre", async () => {
    const m = await mountShell();
    await collapseChat();
    expect(strip()).toBeNull();
    expect(q('[data-slot="centre-dock"]')).toBeNull();
    const body = q('[data-slot="centre-body"]') as Element;
    expect(before(body, float())).toBe(true);
    expect(body.contains(float())).toBe(false);
    expect(float()?.closest('[data-pane="centre"]')).not.toBeNull();
    // A document opened afterwards takes the float into its dock.
    await openSolo();
    await waitFor(() => !!float()?.closest('[data-slot="centre-dock"]'), "the float docked");
    expect(before(float(), strip())).toBe(true);
    await m.unmount();
  });
});
