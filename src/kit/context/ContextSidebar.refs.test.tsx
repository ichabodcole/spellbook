// The sidebar's two ref gestures, the file tree's multi-select and "Add as
// reference", over a REAL workspace daemon: the refs a host builds from them
// (`rowRefs` for the tree, the row's path and name for the menu) are refs the
// daemon accepts and stores as sent. Story Studio holds this through its shell
// (`WorkspaceShell.refs.test.tsx`, bbc54fd), which this kit does not have yet;
// here a small host stands where the shell will, holding `selected` and the
// added refs and sending `say` as the composer does.
//
// It also holds that adding a path adds a set where the path lives: nothing is
// copied into the session's workspace folder.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { Message, MessageRef } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { ContextSidebar } from "./ContextSidebar.tsx";
import type { Daemon } from "./daemonClient.ts";
import { rowRefs } from "./model.ts";
import { useDaemon } from "./useDaemon.ts";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

let root: string;
let ws: string;
let world: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null;
let selected: readonly string[];
let added: readonly MessageRef[];
let opened: string[];

beforeEach(async () => {
  root = tempRoot("sidebar-refs");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The session's workspace folder, empty, and a set that lives elsewhere.
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  world = join(root, "elsewhere", "world");
  mkdirSync(join(world, "places"), { recursive: true });
  writeFileSync(join(world, "places", "cave.md"), "# Cave\n");
  writeFileSync(join(world, "stair.md"), "# Stair\n");
  writeFileSync(join(world, "well.md"), "# Well\n");
  writeFileSync(join(world, "fox.png"), pngBytes(4, 4));
  client = null;
  selected = [];
  added = [];
  opened = [];
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** Where the shell will be: the tree's selection and the added refs, held here. */
function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  const [sel, setSel] = useState<readonly string[]>([]);
  const [refs, setRefs] = useState<readonly MessageRef[]>([]);
  selected = sel;
  added = refs;
  return (
    <div style={{ width: 400, height: 700 }}>
      <ContextSidebar
        entries={d.state?.context ?? []}
        activeDoc={null}
        userHome={null}
        onOpenDoc={(_e, rel) => opened.push(rel)}
        onAddPath={(path) => d.send({ op: "context.add", path })}
        onStructure={() => {}}
        onRemoveEntry={() => {}}
        onReveal={() => {}}
        onPick={() => {}}
        listDir={d.listDir}
        selected={sel}
        onSelect={setSel}
        onAddRef={(path, name) =>
          setRefs((r) => (r.some((x) => x.path === path) ? r : [...r, { path, label: name }]))
        }
      />
    </div>
  );
}

const qa = (sel: string) => [...document.querySelectorAll(sel)];
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
  qa('[role="treeitem"]').find((e) => (e.textContent ?? "").startsWith(name)) ?? null;
const said = (text: string): Message | undefined =>
  client?.state?.chat.find((m) => m.text === text);

/** Send as the composer does: the tree's documents and images, then the added refs. */
async function send(text: string): Promise<Message> {
  const entries = client?.state?.context ?? [];
  const refs: MessageRef[] = [
    ...rowRefs(entries, selected).map((r) => ({ path: r.path, label: r.name })),
    ...added,
  ];
  client?.send({ op: "say", text, withSelection: false, via: "chat", about: { refs } });
  await waitFor(() => said(text) !== undefined, `"${text}" sent`);
  return said(text) as Message;
}

/** Mount, add the set by its path as the Add path field does, and drill into it. */
async function drilledIn() {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  client?.send({ op: "context.add", path: world });
  await waitFor(() => (client?.state?.context.length ?? 0) === 1, "the set");
  await click(qa("button").find((b) => (b.textContent ?? "").includes("world")) ?? null);
  await waitFor(() => treeRow("stair.md") !== null, "the set's tree");
  return m;
}

describe("adding a path", () => {
  test("adds a set where the path lives, and copies nothing into the workspace", async () => {
    const m = await drilledIn();
    const entry = client?.state?.context[0];
    expect(entry?.root).toBe(world);
    expect(entry?.membership).toBe("mirrored");
    expect(readdirSync(ws)).toEqual([]);
    await m.unmount();
  });
});

describe("the file tree's multi-select", () => {
  test("a modified click chooses a row and opens nothing; the chosen documents and images are refs the daemon stores", async () => {
    const m = await drilledIn();
    await click(treeRow("stair.md"), { metaKey: true });
    await click(treeRow("fox.png"), { metaKey: true });
    // The folder is chosen too, but a folder is no ref.
    await click(treeRow("places"), { metaKey: true });
    expect(opened).toEqual([]);
    await waitFor(() => selected.length === 3, "three rows chosen");
    expect(treeRow("stair.md")?.getAttribute("data-selected")).toBe("true");
    const sent = await send("how do these fit?");
    expect(sent.via).toBe("chat");
    expect(sent.about?.refs).toEqual([
      { path: join(world, "stair.md"), label: "stair.md" },
      { path: join(world, "fox.png"), label: "fox.png" },
    ]);
    // The tree's selection is the tree's: a plain click that opens a row lets go of it.
    await click(treeRow("well.md"));
    expect(opened).toEqual(["well.md"]);
    await waitFor(() => selected.length === 0, "nothing chosen");
    await m.unmount();
  });
});

describe("Add as reference", () => {
  test("offered on a document and an image, not a folder; what it adds is a ref the daemon stores", async () => {
    const m = await drilledIn();
    await rightClick(treeRow("places"));
    await waitFor(() => menuItem("New document") !== null, "the folder's menu");
    expect(menuItem("Add as reference")).toBeNull();
    await rightClick(treeRow("well.md"));
    await waitFor(() => menuItem("Add as reference") !== null, "the document's menu");
    await click(menuItem("Add as reference"));
    await rightClick(treeRow("fox.png"));
    await waitFor(() => menuItem("Add as reference") !== null, "the image's menu");
    await click(menuItem("Add as reference"));
    expect(added).toEqual([
      { path: join(world, "well.md"), label: "well.md" },
      { path: join(world, "fox.png"), label: "fox.png" },
    ]);
    // It opened nothing and chose no row.
    expect(opened).toEqual([]);
    expect(selected).toEqual([]);
    const sent = await send("draw on these");
    expect(sent.about?.refs).toEqual([
      { path: join(world, "well.md"), label: "well.md" },
      { path: join(world, "fox.png"), label: "fox.png" },
    ]);
    await m.unmount();
  });
});
