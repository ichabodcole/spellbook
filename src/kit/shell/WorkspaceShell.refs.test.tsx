// What a message draws on beside its one subject, through the real shell over a
// real daemon: the file tree's multi-select (read at send, never cleared by it),
// a ref chip's X deselecting the row in the tree, references added by hand
// (kept through a change of subject, cleared on send), and the chip's quieter
// second row that shows them.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { useWorkspace, type Workspace } from "../context/workspace.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../lib/testDom.ts";
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { testWorkspace } from "../workspace/fixtures/harness";
import type { Message } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let set: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let ws: Workspace | null = null;
let loose: string;
/** While set, the page's `say` does not go (as with no connection): `send` answers null. */
let failSay = false;

beforeEach(async () => {
  root = tempRoot("shell-refs");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  const docs = seedDocs(root);
  const workspace = testWorkspace(root, "ws");
  set = join(workspace, "set");
  renameSync(join(docs, "set"), set);
  writeFileSync(join(set, "c.md"), "# C\n");
  writeFileSync(join(set, "fox.png"), pngBytes(4, 4));
  // A loose document at the workspace's top: a single-file row in the list.
  writeFileSync(join(workspace, "loose.md"), "# Loose\n");
  loose = join(workspace, "loose.md");
  failSay = false;
  localStorage.clear();
  client = null;
  ws = null;
  // The app's own role, as an app registers it: known, so no advisory.
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace, refRoles: ["guidance"] });
  await daemon.start();
  daemon.session.addContext(set);
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Centre() {
  ws = useWorkspace();
  return <p>the centre</p>;
}

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  const daemonHere = {
    ...d,
    send: (op: Parameters<typeof d.send>[0]) => (failSay && op.op === "say" ? null : d.send(op)),
  };
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={daemonHere} centre={<Centre />} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];
const openName = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.name;
const click = async (el: Element | null, mods: { metaKey?: boolean } = {}) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...mods }));
  });
};
const rightClick = async (el: Element | null) => {
  if (!el) throw new Error("nothing to right-click");
  await settle(() => {
    el.dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 12,
      }),
    );
  });
};
const menuItem = (text: string) =>
  qa('[role^="menuitem"]').find((e) => (e.textContent ?? "").includes(text)) ?? null;
const treeRow = (name: string) =>
  qa('[data-pane="context"] [role="treeitem"]').find((e) =>
    (e.textContent ?? "").startsWith(name),
  ) ?? null;
/** The chip's second row, as it reads: `role · name` per ref. */
const refChips = () =>
  qa('[data-pane="chat"] [data-slot="ref-chip"]').map((e) => (e.textContent ?? "").trim());
const said = (text: string): Message | undefined =>
  client?.state?.chat.find((m) => m.text === text);

/** Type and send a message from the column's composer, and wait for it in the chat. */
async function send(text: string) {
  await typeInto(q('[data-pane="chat"] textarea') as HTMLTextAreaElement, text);
  await click(qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Send")) ?? null);
  await waitFor(() => said(text) !== undefined, `"${text}" sent`);
  return said(text) as Message;
}

/** Mount, drill into the set, and open `a.md` from its row with a plain click. */
async function drilledOnA() {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await click(
    qa('[data-pane="context"] button').find((b) => (b.textContent ?? "").includes("set")) ?? null,
  );
  await waitFor(() => treeRow("a.md") !== null, "the set's tree");
  await click(treeRow("a.md"));
  await waitFor(() => openName() === "a.md", "a.md open");
  return m;
}

describe("the file tree's multi-select", () => {
  test("the open document is the subject; the other rows selected ride as refs, and stay selected after send", async () => {
    const m = await drilledOnA();
    // A plain click opened a.md and selected it: it is the subject, so no ref.
    expect(refChips()).toEqual([]);
    // Cmd-click adds a row and opens nothing.
    await click(treeRow("c.md"), { metaKey: true });
    await click(treeRow("fox.png"), { metaKey: true });
    expect(openName()).toBe("a.md");
    await waitFor(() => refChips().length === 2, "two refs");
    expect(refChips()).toEqual(["reference·c.md", "reference·fox.png"]);
    expect(treeRow("c.md")?.getAttribute("data-selected")).toBe("true");
    expect(treeRow("a.md")?.getAttribute("data-selected")).toBeNull();

    const m1 = await send("how do these fit?");
    expect(m1.via).toBe("chat");
    expect(m1.about?.doc).toBe(client?.state?.openDoc ?? "");
    expect(m1.about).not.toHaveProperty("docs");
    expect(m1.about?.refs).toEqual([
      { path: join(set, "c.md"), label: "c.md" },
      { path: join(set, "fox.png"), label: "fox.png" },
    ]);
    // The tree's selection is the tree's: sending does not clear it.
    expect(refChips()).toEqual(["reference·c.md", "reference·fox.png"]);
    expect(treeRow("fox.png")?.getAttribute("aria-selected")).toBe("true");
    const m2 = await send("and again?");
    expect(m2.about?.refs?.map((r) => r.path)).toEqual([join(set, "c.md"), join(set, "fox.png")]);
    // A plain click on another row makes it the only one, and opens it.
    await click(treeRow("c.md"));
    await waitFor(() => openName() === "c.md", "c.md open");
    await waitFor(() => refChips().length === 0, "no refs");
    await m.unmount();
  });

  test("a ref chip's X deselects its row in the tree", async () => {
    const m = await drilledOnA();
    await click(treeRow("c.md"), { metaKey: true });
    await click(treeRow("fox.png"), { metaKey: true });
    await waitFor(() => refChips().length === 2, "two refs");
    await click(q('[aria-label="Drop the reference c.md"]'));
    expect(refChips()).toEqual(["reference·fox.png"]);
    expect(treeRow("c.md")?.getAttribute("aria-selected")).toBe("false");
    expect(treeRow("c.md")?.getAttribute("data-selected")).toBeNull();
    expect(treeRow("fox.png")?.getAttribute("aria-selected")).toBe("true");
    const sent = await send("just the fox");
    expect(sent.about?.refs).toEqual([{ path: join(set, "fox.png"), label: "fox.png" }]);
    await m.unmount();
  });

  test("a plain-clicked row is opened, not chosen: it is never a ref, whatever is open after", async () => {
    const m = await drilledOnA();
    expect(treeRow("a.md")?.getAttribute("aria-selected")).toBe("false");
    // Another document opens by another route: a.md is still no ref.
    await settle(() => {
      client?.send({ op: "open", path: join(set, "c.md") });
    });
    await waitFor(() => openName() === "c.md", "c.md open");
    expect(refChips()).toEqual([]);
    expect((await send("nothing besides")).about).not.toHaveProperty("refs");
    // A view points at two documents: one is the subject, the other its only ref.
    await settle(() =>
      ws?.pointDocs?.({
        from: "test.map",
        docs: [
          { path: join(set, "part", "b.md"), name: "B" },
          { path: join(set, "fox.png"), name: "Fox" },
        ],
      }),
    );
    expect(refChips()).toEqual(["reference·Fox"]);
    expect((await send("these two")).about?.refs?.map((r) => r.path)).toEqual([
      join(set, "fox.png"),
    ]);
    await m.unmount();
  });

  test("a chosen row stays chosen when it is opened and then left: it is a ref again", async () => {
    const m = await drilledOnA();
    await click(treeRow("c.md"), { metaKey: true });
    await waitFor(() => refChips().length === 1, "the ref");
    // Opened by the agent: c.md is the subject now, so no ref.
    await settle(() => {
      client?.send({ op: "open", path: join(set, "c.md") });
    });
    await waitFor(() => openName() === "c.md", "c.md open");
    expect(refChips()).toEqual([]);
    // Something else opens: c.md, still chosen, rides again.
    await settle(() => {
      client?.send({ op: "open", path: join(set, "part", "b.md") });
    });
    await waitFor(() => openName() === "b.md", "b.md open");
    expect(refChips()).toEqual(["reference·c.md"]);
    await m.unmount();
  });

  test("a chosen row renamed or deleted leaves the selection, and a new file at its path is no ref", async () => {
    const m = await drilledOnA();
    await click(treeRow("c.md"), { metaKey: true });
    await waitFor(() => refChips().length === 1, "the ref");
    await settle(() => {
      client?.send({ op: "rename", path: join(set, "c.md"), name: "c2.md" });
    });
    await waitFor(() => treeRow("c2.md") !== null, "the rename");
    await waitFor(() => refChips().length === 0, "the ref gone");
    // A new c.md where it was: never chosen.
    writeFileSync(join(set, "c.md"), "# Another C\n");
    await waitFor(() => treeRow("c.md") !== null, "the new c.md");
    expect(refChips()).toEqual([]);
    expect((await send("after the rename")).about).not.toHaveProperty("refs");
    await m.unmount();
  });

  test("a tree ref is marked on the chip as the tree's; one added by hand keeps its plain look", async () => {
    const m = await drilledOnA();
    await click(treeRow("c.md"), { metaKey: true });
    await settle(() => ws?.addRef?.({ path: join(set, "fox.png"), label: "Fox" }));
    await waitFor(() => refChips().length === 2, "two refs");
    const chips = qa('[data-pane="chat"] [data-slot="ref-chip"]');
    expect(chips.map((c) => c.getAttribute("data-from"))).toEqual(["tree", "added"]);
    expect(chips[0]?.querySelector('[data-slot="ref-tree-mark"]')).not.toBeNull();
    expect(chips[1]?.querySelector('[data-slot="ref-tree-mark"]')).toBeNull();
    await m.unmount();
  });

  test("a plain click that expands a folder chooses nothing and drops nothing", async () => {
    const m = await drilledOnA();
    await click(treeRow("c.md"), { metaKey: true });
    await waitFor(() => refChips().length === 1, "the ref");
    await click(treeRow("part"));
    await waitFor(() => treeRow("b.md") !== null, "the folder expanded");
    expect(refChips()).toEqual(["reference·c.md"]);
    expect(treeRow("c.md")?.getAttribute("aria-selected")).toBe("true");
    expect(treeRow("part")?.getAttribute("aria-selected")).toBe("false");
    // And shut again: still nothing dropped.
    await click(treeRow("part"));
    await waitFor(() => treeRow("b.md") === null, "the folder shut");
    expect(refChips()).toEqual(["reference·c.md"]);
    await m.unmount();
  });

  test("dragging a row not chosen takes it alone, and chooses nothing", async () => {
    const m = await drilledOnA();
    await click(treeRow("c.md"), { metaKey: true });
    await waitFor(() => refChips().length === 1, "the ref");
    await settle(() => {
      treeRow("fox.png")?.dispatchEvent(new window.Event("dragstart", { bubbles: true }));
    });
    // The library selects the dragged row for the drag; that is no choice of the human's.
    expect(refChips()).toEqual(["reference·c.md"]);
    await m.unmount();
  });

  test("a chosen row keeps its tint while it has the focus", async () => {
    const m = await drilledOnA();
    await click(treeRow("c.md"), { metaKey: true });
    const cls = treeRow("c.md")?.className ?? "";
    // One background and one text colour: the focused row's tint is not lost to another.
    expect(cls).toContain("bg-brand/10");
    expect(cls).not.toContain("bg-surface-raised/60");
    expect(cls).not.toContain("text-ink-dim");
    const active = treeRow("a.md")?.className ?? "";
    expect(active).toContain("bg-selected/15");
    expect(active).not.toContain("text-ink-dim");
    await m.unmount();
  });
});

describe("references added by hand", () => {
  test("a row's Add as reference holds it; it survives a change of subject and clears on send", async () => {
    const m = await drilledOnA();
    await rightClick(treeRow("c.md"));
    await waitFor(() => menuItem("Add as reference") !== null, "the menu");
    await click(menuItem("Add as reference"));
    await waitFor(() => refChips().length === 1, "the ref");
    expect(refChips()).toEqual(["reference·c.md"]);
    expect(ws?.refs).toEqual([{ path: join(set, "c.md"), label: "c.md" }]);
    // Nothing reached the agent before the message.
    expect(client?.state?.chat ?? []).toEqual([]);
    // Another subject: the ref stays.
    await settle(() => {
      client?.send({ op: "open", path: join(set, "part", "b.md") });
    });
    await waitFor(() => openName() === "b.md", "b.md open");
    expect(refChips()).toEqual(["reference·c.md"]);
    // One added by the app's own gesture, with a role.
    await settle(() => ws?.addRef?.({ path: join(set, "a.md"), label: "A", role: "guidance" }));
    expect(refChips()).toEqual(["reference·c.md", "guidance·A"]);
    const sent = await send("with these");
    expect(sent.about?.refs).toEqual([
      { path: join(set, "c.md"), label: "c.md" },
      { path: join(set, "a.md"), label: "A", role: "guidance" },
    ]);
    // Gone with the message.
    expect(refChips()).toEqual([]);
    expect(ws?.refs).toEqual([]);
    await m.unmount();
  });

  test("refs held by hand stay held when the send does not go", async () => {
    const m = await drilledOnA();
    await settle(() => ws?.addRef?.({ path: join(set, "c.md"), label: "C" }));
    failSay = true;
    await typeInto(q('[data-pane="chat"] textarea') as HTMLTextAreaElement, "lost?");
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Send")) ?? null,
    );
    expect(ws?.refs).toEqual([{ path: join(set, "c.md"), label: "C" }]);
    expect(refChips()).toEqual(["reference·C"]);
    failSay = false;
    await m.unmount();
  });

  test("a button press carries no held refs and leaves them held", async () => {
    const m = await drilledOnA();
    await click(treeRow("c.md"), { metaKey: true });
    await settle(() => ws?.addRef?.({ path: join(set, "part", "b.md"), label: "B" }));
    await waitFor(() => refChips().length === 2, "two refs");
    // "Ask the agent to describe", the kit's own button.
    await rightClick(treeRow("fox.png"));
    await waitFor(() => menuItem("Ask the agent to describe") !== null, "the menu");
    await click(menuItem("Ask the agent to describe"));
    await waitFor(
      () => (client?.state?.chat ?? []).some((x) => x.via === "describe"),
      "the button's message",
    );
    const pressed = (client?.state?.chat ?? []).find((x) => x.via === "describe");
    expect(pressed?.about).toEqual({ path: join(set, "fox.png") });
    expect(refChips()).toEqual(["reference·c.md", "reference·B"]);
    expect(ws?.refs).toEqual([{ path: join(set, "part", "b.md"), label: "B" }]);
    await m.unmount();
  });

  test("a list row's Add as reference holds its file", async () => {
    daemon.session.addContext(loose);
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open", "the connection");
    const row = () =>
      qa('[data-pane="context"] button').find((b) => (b.textContent ?? "").includes("loose.md")) ??
      null;
    await waitFor(() => row() !== null, "the list's row");
    await rightClick(row());
    await waitFor(() => menuItem("Add as reference") !== null, "the menu");
    await click(menuItem("Add as reference"));
    await waitFor(() => refChips().length === 1, "the ref");
    expect(ws?.refs).toEqual([{ path: loose, label: "loose.md" }]);
    await m.unmount();
  });

  test("a ref naming the subject is not shown, and a path held twice shows once", async () => {
    const m = await drilledOnA();
    await settle(() => ws?.addRef?.({ path: join(set, "a.md"), label: "A" }));
    await settle(() => ws?.addRef?.({ path: join(set, "c.md"), label: "C" }));
    await click(treeRow("c.md"), { metaKey: true });
    // a.md is the subject; c.md is held by the tree and by hand, shown once.
    expect(refChips()).toEqual(["reference·c.md"]);
    const sent = await send("once each");
    expect(sent.about?.refs).toEqual([{ path: join(set, "c.md"), label: "c.md" }]);
    // The added a.md was the subject and went with the message too: nothing is held by hand.
    expect(ws?.refs).toEqual([]);
    await m.unmount();
  });
});
