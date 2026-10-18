// The interim frame's wiring against a REAL flagged daemon (`kitDaemon`, in
// this process, under a scratch SCRIPTORIUM_HOME), mounted in happy-dom: chat
// reaches the daemon, a set is added, hide and unhide and make-set go through
// the menu, a move asks with the plan, opening a document says why nothing
// shows, a refusal's hint is the notice, and the daemon serves the built frame.

import "../../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../../../kit/context/daemonClient";
import { useDaemon } from "../../../kit/context/useDaemon";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../../../kit/lib/testDom";
import type { ContextEntry } from "../../../kit/workspace/protocol";
import type { WorkspaceDaemon } from "../../../kit/workspace/server";
import { tempRoot } from "../../../kit/workspace/testing";
import { frameSurface, kitDaemon } from "../../backend/kit/server";
import { Frame, scriptoriumMenuActions } from "./Frame";

const root = tempRoot("scriptorium-frame");
const set = join(root, "docs", "set");
const lone = join(root, "docs", "lone.md");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;

beforeAll(async () => {
  installDom();
  process.env.SCRIPTORIUM_HOME = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "index.md"), "# Index\n\n[C](./part/c.md)\n");
  writeFileSync(join(set, "part", "c.md"), "# C\n");
  writeFileSync(join(set, "aside.md"), "# Aside\n");
  writeFileSync(lone, "# Lone\n");
  daemon = kitDaemon({
    tmp: join(root, "tmp"),
    drainGraceMs: 10,
    trash: async () => {
      throw new Error("no Trash in this test");
    },
  });
  await daemon.start();
});
afterEach(cleanup);
afterAll(async () => {
  await daemon?.stop().catch(() => {});
  // Awaited: the next file's `installDom` must not find this DOM still leaving.
  await removeDom();
  if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
  else process.env.SCRIPTORIUM_HOME = savedHome;
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
  return (
    <div style={{ width: 1200, height: 700 }}>
      <Frame daemon={d} />
    </div>
  );
}

const all = (sel: string) => [...document.querySelectorAll(sel)];
const withText = (sel: string, text: string) =>
  all(sel).find((e) => (e.textContent ?? "").includes(text)) ?? null;
const menuItem = (text: string) => withText('[role^="menuitem"]', text);
const treeRow = (name: string) =>
  all('[role="treeitem"]').find((e) => (e.textContent ?? "").trim().startsWith(name)) ?? null;
const listRow = (name: string) =>
  all('[aria-label="Context"] button').find((b) => (b.textContent ?? "").trim().startsWith(name)) ??
  null;
const centre = () => document.querySelector('[data-pane="centre"]')?.textContent ?? "";
const dialog = () => document.querySelector<HTMLElement>('[data-slot="confirm-dialog"]');
const entry = (rootPath: string): ContextEntry | undefined =>
  client?.state?.context.find((e) => e.root === rootPath);
const hidden = () =>
  ((client?.state?.appState as { hidden?: Record<string, string[]> })?.hidden ?? {}) as Record<
    string,
    string[]
  >;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const rightClick = async (el: Element | null) => {
  if (!el) throw new Error("nothing to right-click");
  await settle(() => {
    el.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 9 }),
    );
  });
};

/** The frame, connected, with `paths` in the context. */
async function open(...paths: string[]) {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open" && client.state !== null, "the hello");
  for (const path of paths)
    if (!client?.state?.context.some((e) => e.root === path || join(e.root, "lone.md") === path)) {
      const n = client?.state?.context.length ?? 0;
      client?.send({ op: "context.add", path });
      await waitFor(() => (client?.state?.context.length ?? 0) > n, `${path} in the context`);
    }
  return m;
}

describe("the interim frame on a real kit daemon", () => {
  test("it shows the context, the chat with its composer, Notes and Tasks, and the centre's message", async () => {
    const m = await open();
    // An empty context: the sidebar's own empty state, offering to add.
    expect(document.querySelector('[data-pane="context"]')?.textContent).toContain("Add");
    expect(
      document.querySelector('[data-pane="chat"] [data-slot="composer-input"]'),
    ).not.toBeNull();
    expect(all('[role="tab"]').map((t) => t.textContent)).toEqual(["Chat", "Notes", "Tasks"]);
    expect(centre()).toContain("The document pane arrives in the next cycle.");
    await click(withText('[role="tab"]', "Tasks"));
    expect(document.querySelector('input[aria-label="New task"]')).not.toBeNull();
    await click(withText('[role="tab"]', "Notes"));
    expect(document.querySelector('[data-slot="composer-input"]')).toBeNull();
    await m.unmount();
  });

  test("a message typed in the composer reaches the daemon's chat", async () => {
    const m = await open();
    await typeInto(
      document.querySelector('[data-pane="chat"] textarea') as HTMLTextAreaElement,
      "hello from the frame",
    );
    await click(withText('[data-pane="chat"] button', "Send") ?? null);
    await waitFor(
      () => client?.state?.chat.some((c) => c.text === "hello from the frame") ?? false,
      "the message in the daemon's chat",
    );
    const said = client?.state?.chat.find((c) => c.text === "hello from the frame");
    expect(said?.from).toBe("human");
    await m.unmount();
  });

  test("a set added to the context shows in the list", async () => {
    const m = await open(set);
    await waitFor(() => listRow("set") !== null, "the set's row");
    expect(entry(set)?.membership).toBe("mirrored");
    await m.unmount();
  });

  test("Hide takes a document out of the set; Show hidden on the set's row brings it back", async () => {
    const m = await open(set);
    await click(listRow("set"));
    await waitFor(() => treeRow("aside.md") !== null, "the set's tree");
    await rightClick(treeRow("aside.md"));
    await waitFor(() => menuItem("Hide from Scriptorium") !== null, "the menu");
    await click(menuItem("Hide from Scriptorium"));
    await waitFor(() => treeRow("aside.md") === null, "the row gone");
    const id = entry(set)?.id as string;
    expect(hidden()[id]).toEqual(["aside.md"]);
    expect(existsSync(join(set, "aside.md"))).toBe(true);
    // Back to the list, and the set's own menu offers what it hides.
    await click(document.querySelector('[aria-label="Back to the context list"]'));
    await waitFor(() => listRow("set") !== null, "the list");
    await rightClick(listRow("set"));
    await waitFor(() => menuItem("Show 1 hidden item") !== null, "Show hidden");
    await click(menuItem("Show 1 hidden item"));
    await waitFor(() => (hidden()[id] ?? []).length === 0, "nothing hidden");
    await m.unmount();
  });

  test("Turn into a set makes a document listed on its own a set, on disk", async () => {
    const m = await open(lone);
    await waitFor(() => listRow("lone.md") !== null, "the document's row");
    await rightClick(listRow("lone.md"));
    await waitFor(() => menuItem("Turn into a set") !== null, "the menu");
    await click(menuItem("Turn into a set"));
    await waitFor(() => existsSync(join(root, "docs", "lone", "lone.md")), "the set on disk");
    await waitFor(
      () => entry(join(root, "docs", "lone"))?.membership === "mirrored",
      "the entry now a set",
    );
    await m.unmount();
  });

  test("a move through the menu waits on the plan; Cancel sends nothing", async () => {
    const m = await open(set);
    await click(listRow("set"));
    await waitFor(() => treeRow("part") !== null, "the set's tree");
    if (!treeRow("c.md")) await click(treeRow("part"));
    await waitFor(() => treeRow("c.md") !== null, "c.md");
    await rightClick(treeRow("c.md"));
    await waitFor(() => menuItem("Move to") !== null, "the menu");
    await click(menuItem("Move to"));
    const option = () =>
      all('[data-slot="move-to-dialog"] [role="option"]').find(
        (e) => (e.textContent ?? "").trim() === "set",
      ) ?? null;
    await waitFor(() => option() !== null, "the Move to dialog");
    await click(option());
    await waitFor(() => dialog() !== null, "the plan");
    expect(dialog()?.textContent).toContain("It breaks 1 link in 1 document.");
    await click(withText('[data-slot="confirm-dialog"] button', "Cancel"));
    await waitFor(() => dialog() === null, "the dialog closed");
    await Bun.sleep(150);
    expect(existsSync(join(set, "part", "c.md"))).toBe(true);
    await m.unmount();
  });

  test("opening a document says, in the centre, that it cannot be shown yet", async () => {
    const m = await open(set);
    await click(listRow("set"));
    await waitFor(() => treeRow("index.md") !== null, "the set's tree");
    await click(treeRow("index.md"));
    await waitFor(() => client?.state?.openDoc != null, "the daemon opened it");
    await waitFor(() => centre().includes("is open in this session"), "the centre's answer");
    expect(centre()).toContain("index.md");
    expect(centre()).toContain("the document pane arrives in the next cycle");
    await m.unmount();
  });

  test("a refused create shows the daemon's refusal and its hint as the notice", async () => {
    const m = await open(set);
    await settle(() => {
      client?.send({ op: "doc.create" } as never);
    });
    await waitFor(
      () => (document.querySelector('[role="alert"]')?.textContent ?? "").includes("make-set"),
      "the notice with the hint",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "no location was named",
    );
    await m.unmount();
  });
});

describe("scriptoriumMenuActions", () => {
  const sent: unknown[] = [];
  const send = (op: unknown) => {
    sent.push(op);
    return 1;
  };
  const listed: ContextEntry = {
    id: "e1",
    label: "a.md",
    root: "/s",
    membership: "listed",
    nodes: [{ kind: "doc", rel: "a.md" }],
  };
  const mirrored: ContextEntry = { ...listed, id: "e2", membership: "mirrored", nodes: [] };
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  test("the list's background has none; a lone document turns into a set; a set unhides only what it hides", () => {
    const acts = scriptoriumMenuActions(send, { e2: ["x.md"] });
    expect(acts({ kind: "background", path: "" })).toEqual([]);
    expect(ids(acts({ kind: "entry", path: "/s/a.md", entry: listed }))).toEqual([
      "scriptorium.make-set",
    ]);
    expect(ids(acts({ kind: "entry", path: "/s", entry: mirrored }))).toEqual([
      "scriptorium.unhide",
    ]);
    expect(ids(acts({ kind: "doc", path: "/s/b.md", entry: mirrored }))).toEqual([
      "scriptorium.hide",
    ]);
    for (const a of acts({ kind: "entry", path: "/s/a.md", entry: listed })) a.onSelect();
    expect(sent).toEqual([{ op: "set.make", path: "/s/a.md" }]);
  });
});

describe("where the frame is found", () => {
  // The served page itself is held end to end, through the launchers and the
  // BUILT daemon, in `backend/kit/kit.integration.test.ts`.
  test("run from source there is no built frame beside the daemon, so it serves none", async () => {
    const s = frameSurface();
    expect(s.distDir).toBe(join(import.meta.dir, "..", "..", "backend", "kit", "kit"));
    expect(await s.devIndex()).toBeUndefined();
    expect((await fetch(`${daemon.url}/`)).status).toBe(404);
  });
});
