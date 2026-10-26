// Following a link in the rendered document, in a DOM against a REAL workspace
// daemon: a click on a relative link sends the href exactly as written, with the
// document it is in, and the daemon's resolver opens the target; a target that
// cannot open comes back as the client's refusal, naming it; and a link the
// renderer refused stays inert. The host stands in for the shell, which the
// pane's subpath does not reach; the shell's toast for a refusal is held in
// `shell/WorkspaceShell.links.test.tsx`.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useEffect, useMemo } from "react";
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
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
/** Every frame the page sent. */
let sent: { op?: string; [k: string]: unknown }[];
/** Every refusal the client surfaced, in order (the shell would toast each). */
let refused: string[];
let client: Daemon | null = null;

const A = [
  "# A",
  "",
  "[typed](./part/b.md?rel=sister-of,extends#top)",
  "[outside](../solo.md?rel=sister-of#top)",
  "[folder](./part/)",
  "[gone](./gone.md)",
  "[operator](op:doc/01a0f97b)",
  "",
].join("\n");

beforeEach(async () => {
  root = tempRoot("pane-links");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "set", "a.md"), A);
  writeFileSync(join(docs, "set", "part", "b.md"), "# B\n\n[back](../a.md)\n");
  localStorage.clear();
  sent = [];
  refused = [];
  client = null;
  daemon = fixtureDaemon({ tmp: join(root, "tmp") });
  await daemon.start();
  // Only the set is in the context: `solo.md` beside it is outside.
  daemon.session.addContext(join(docs, "set"));
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
  // As the shell does: each refusal is taken once, then dismissed.
  useEffect(() => {
    if (!d.lastError) return;
    refused.push(d.lastError);
    d.clearError();
  }, [d.lastError, d.clearError]);
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
        <DocumentPane mode="rendered" />
      </main>
    </WorkspaceContext.Provider>
  );
}

const openName = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.name;
const link = (label: string) =>
  [...document.querySelectorAll(".md-prose a")].find((a) => a.textContent === label) ?? null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

/** Mount, open `a.md`, and wait for its rendered links. */
async function openA() {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(docs, "set", "a.md") });
  });
  await waitFor(() => link("typed") !== null, "the rendered links");
  return m;
}

describe("following a link in the rendered document", () => {
  test("a typed `./` link opens its target, and a `../` link from there comes back", async () => {
    const m = await openA();
    await click(link("typed"));
    await waitFor(() => openName() === "b.md", "b.md open");
    expect(sent.find((f) => f.op === "link.open")).toMatchObject({
      target: "./part/b.md?rel=sister-of,extends#top",
      doc: "a",
    });
    await waitFor(() => link("back") !== null, "b's rendered link");
    await click(link("back"));
    await waitFor(() => openName() === "a.md", "a.md open again");
    // Following added nothing to the context, and nothing was refused.
    expect(client?.state?.context).toHaveLength(1);
    expect(refused).toEqual([]);
    await m.unmount();
  });

  test("a link into another folder set of the session opens that set's document, and back", async () => {
    // Two folder sets, A (`set`) and B (`lore`): a relative link between them
    // is not leaving the session (Cole, 2026-10-23), so the click must open it.
    mkdirSync(join(docs, "lore"), { recursive: true });
    writeFileSync(join(docs, "set", "cross.md"), "# Cross\n\n[the myth](../lore/myth.md)\n");
    writeFileSync(join(docs, "lore", "myth.md"), "# Myth\n\n[home](../set/cross.md)\n");
    // `set` was scanned before cross.md was written.
    daemon.session.rescan(daemon.session.context[0]?.id ?? "");
    daemon.session.addContext(join(docs, "lore"));
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open", "the connection");
    await settle(() => {
      client?.send({ op: "open", path: join(docs, "set", "cross.md") });
    });
    await waitFor(() => link("the myth") !== null, "cross's rendered link");
    await click(link("the myth"));
    await waitFor(() => openName() === "myth.md", "myth.md, in the other set, open");
    expect(client?.state?.docs.find((d) => d.name === "myth.md")?.original).toBe(
      join(docs, "lore", "myth.md"),
    );
    await waitFor(() => link("home") !== null, "myth's rendered link");
    await click(link("home"));
    await waitFor(() => openName() === "cross.md", "cross.md open again");
    // Following added nothing to the context, and nothing was refused.
    expect(client?.state?.context).toHaveLength(2);
    expect(refused).toEqual([]);
    await m.unmount();
  });

  test("a target outside the context is refused by name, with the folder to add, and adds nothing", async () => {
    const m = await openA();
    await click(link("outside"));
    await waitFor(() => refused.length > 0, "the refusal");
    // The target as written, without its `?rel=` and `#anchor`, and the folder's path.
    expect(refused).toEqual([
      `../solo.md is outside this session's context. Add its folder, ${docs}, to open it here.`,
    ]);
    expect(openName()).toBe("a.md");
    expect(client?.state?.context).toHaveLength(1);
    await m.unmount();
  });

  test("a link to a folder says it is a folder", async () => {
    const m = await openA();
    await click(link("folder"));
    await waitFor(() => refused.length > 0, "the refusal");
    expect(refused).toEqual([`./part/ is a folder, not a document: ${join(docs, "set", "part")}.`]);
    expect(openName()).toBe("a.md");
    await m.unmount();
  });

  test("a missing target is refused by name", async () => {
    const m = await openA();
    await click(link("gone"));
    await waitFor(() => refused.length > 0, "the refusal");
    expect(refused).toEqual([
      `That link points at ./gone.md, which does not exist: nothing at ${join(docs, "set", "gone.md")}.`,
    ]);
    expect(openName()).toBe("a.md");
    await m.unmount();
  });

  test("an Operator `op:doc` link stays visibly blocked and sends nothing", async () => {
    const m = await openA();
    const op = link("operator");
    expect(op?.hasAttribute("data-blocked-link")).toBe(true);
    expect(op?.getAttribute("href")).toBeNull();
    const before = sent.length;
    await click(op);
    await settle(() => {});
    expect(sent.slice(before).filter((f) => f.op === "link.open")).toEqual([]);
    expect(openName()).toBe("a.md");
    await m.unmount();
  });
});
