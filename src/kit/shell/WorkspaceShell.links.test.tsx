// Following a link in a chat message, in the shell over a REAL workspace daemon:
// the click sends the href as written with the open document, the daemon's one
// resolver (the same the rendered document uses, held in
// `document/DocumentPane.links.test.tsx`) opens the target, and a target that
// cannot open says why in a toast that names it.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { testWorkspace } from "../workspace/fixtures/harness";
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
/** The seeded set, moved into the workspace: the one thing in the context. */
let set: string;
let daemon: WorkspaceDaemon;
/** Every frame the page sent. */
let sent: { op?: string; [k: string]: unknown }[];
let client: Daemon | null = null;

beforeEach(async () => {
  root = tempRoot("shell-links");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  // Only the set is in the workspace, so in the context: `solo.md`, left
  // behind in `docs`, is outside.
  const ws = testWorkspace(root, "ws");
  set = join(ws, "set");
  renameSync(join(docs, "set"), set);
  localStorage.clear();
  sent = [];
  client = null;
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
  daemon.session.addContext(set);
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** The real WebSocket, with what it sends recorded. */
function Recording(url: string, protocols?: string | string[]) {
  const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(url, protocols);
  const send = ws.send.bind(ws);
  ws.send = (data) => {
    try {
      sent.push(JSON.parse(String(data)));
    } catch {
      /* not a frame */
    }
    send(data);
  };
  return ws;
}

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: Recording as unknown as typeof WebSocket,
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<p>the centre</p>} />
    </div>
  );
}

const text = () => document.body.textContent ?? "";
const openName = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.name;
const chatLink = (label: string) =>
  [...document.querySelectorAll('[data-pane="chat"] a')].find((a) => a.textContent === label) ??
  null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

/** The agent says something, through the CLI's own path. */
const say = async (said: string) => {
  await fetch(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify({ op: "say", text: said }),
  });
};

/** Mount, and open `a.md`. */
async function openA() {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(set, "a.md") });
  });
  await waitFor(() => openName() === "a.md", "a.md open");
  return m;
}

describe("the context sidebar follows a followed link", () => {
  const treeRow = (name: string) =>
    [...document.querySelectorAll('[data-pane="context"] [role="treeitem"]')].find((e) =>
      (e.textContent ?? "").includes(name),
    ) ?? null;

  /** Mount, drill into the set, and open `a.md` from its row: `part` stays shut. */
  async function drilledOnA() {
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open", "the connection");
    const setRow = [...document.querySelectorAll('[data-pane="context"] button')].find((b) =>
      (b.textContent ?? "").includes("set"),
    );
    await click(setRow ?? null);
    await waitFor(() => treeRow("a.md") !== null, "the set's tree");
    await click(treeRow("a.md"));
    await waitFor(() => openName() === "a.md", "a.md open");
    expect(treeRow("part")?.getAttribute("aria-expanded")).toBe("false");
    return m;
  }

  test("a link to a document in a shut folder opens the folder, and its row is there and marked", async () => {
    const m = await drilledOnA();
    await say("See [the B page](part/b.md).");
    await waitFor(() => chatLink("the B page") !== null, "the chat link");
    await click(chatLink("the B page"));
    await waitFor(() => openName() === "b.md", "b.md open");
    await waitFor(() => treeRow("b.md") !== null, "b.md's row");
    expect(treeRow("part")?.getAttribute("aria-expanded")).toBe("true");
    expect((treeRow("b.md") as HTMLElement).dataset.active).toBe("true");
    // The human shuts the folder again: it stays shut.
    await click(treeRow("part"));
    await say("Still on B.");
    await waitFor(() => text().includes("Still on B."), "the next message");
    expect(treeRow("part")?.getAttribute("aria-expanded")).toBe("false");
    await m.unmount();
  });

  test("with the context column shut to its rail, the row is revealed but the column stays shut", async () => {
    // A saved layout with the context at width 0: a DOM has no layout to drag.
    // The body stays mounted, hidden and inert, which is what lets a script
    // drill in and open `a.md` while it is shut.
    localStorage.setItem(
      "story-studio:react-resizable-panels:panes:context:centre:chat",
      JSON.stringify({ context: 0, centre: 72, chat: 28 }),
    );
    const m = await drilledOnA();
    expect(document.querySelector('[data-pane="context"]')?.closest("[hidden]")).not.toBeNull();
    await say("See [the B page](part/b.md).");
    await waitFor(() => chatLink("the B page") !== null, "the chat link");
    await click(chatLink("the B page"));
    await waitFor(() => openName() === "b.md", "b.md open");
    await waitFor(() => treeRow("b.md") !== null, "b.md's row, ready for the reopen");
    expect(document.querySelector('[data-pane="context"]')?.closest("[hidden]")).not.toBeNull();
    await m.unmount();
  });
});

describe("following a link in a chat message", () => {
  test("a relative link reads against the open document and opens through the daemon", async () => {
    const m = await openA();
    await say("See [the B page](part/b.md?rel=extends).");
    await waitFor(() => chatLink("the B page") !== null, "the chat link");
    await click(chatLink("the B page"));
    await waitFor(() => openName() === "b.md", "b.md open");
    expect(sent.find((f) => f.op === "link.open")).toMatchObject({
      target: "part/b.md?rel=extends",
      doc: "a",
      from: "chat",
    });
    await m.unmount();
  });

  test("a `./` link opens the same target whichever document is open, a nested one included", async () => {
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open", "the connection");
    await settle(() => {
      client?.send({ op: "open", path: join(set, "part", "b.md") });
    });
    await waitFor(() => openName() === "b.md", "b.md open");
    // The agent means the context: from `part/` alone this would be `part/a.md`.
    await say("Back to [the A page](./a.md?rel=extends).");
    await waitFor(() => chatLink("the A page") !== null, "the chat link");
    await click(chatLink("the A page"));
    await waitFor(() => openName() === "a.md", "a.md open");
    expect(text()).not.toContain("didn't open");
    await m.unmount();
  });

  test("an absolute path outside the context is toasted under its own title, with where it is", async () => {
    const m = await openA();
    await say(`Compare [solo](${join(docs, "solo.md")}?rel=sister-of).`);
    await waitFor(() => chatLink("solo") !== null, "the chat link");
    await click(chatLink("solo"));
    await waitFor(() => text().includes("is outside this workspace"), "the toast");
    expect(text()).toContain("That link didn't open");
    expect(text()).not.toContain("The workspace refused that");
    expect(text()).toContain(
      `${join(docs, "solo.md")} is outside this workspace, in ${docs}. Copy it in (add) to open the copy here.`,
    );
    expect(text()).not.toContain("rel=sister-of");
    expect(openName()).toBe("a.md");
    expect(client?.state?.context).toHaveLength(1);
    await m.unmount();
  });

  test("a missing target is toasted by name", async () => {
    const m = await openA();
    await say("See [gone](./gone.md).");
    await waitFor(() => chatLink("gone") !== null, "the chat link");
    await click(chatLink("gone"));
    await waitFor(() => text().includes("does not exist"), "the toast");
    expect(text()).toContain("That link points at ./gone.md, which does not exist");
    expect(openName()).toBe("a.md");
    await m.unmount();
  });
});
