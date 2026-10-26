// The shell over a REAL workspace daemon, mounted in a DOM: the panes and slots,
// the context sidebar wired to the daemon, the selection the centre reports, the
// collapse and theme the viewer keeps, and the keys.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { useEffect } from "react";
import { useDaemon } from "../context/useDaemon.ts";
import { useWorkspace, type Workspace } from "../context/workspace.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { BAD_LAYOUTS, type LaidOut, laidOut } from "../lib/testLayout.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { type ShellPanel, WorkspaceShell, type WorkspaceShellProps } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;

beforeEach(async () => {
  root = tempRoot("shell");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  daemon = fixtureDaemon({ tmp: join(root, "tmp") });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** Like `waitUntil`, for an async probe. */
async function pollUntil(what: string, probe: () => Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await probe()) return;
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Extra = Partial<Omit<WorkspaceShellProps, "daemon">>;

function Host({ extra }: { extra?: Extra }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<p data-testid="centre">the centre</p>} {...extra} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

describe("the shell", () => {
  test("says it is connecting until the daemon's first snapshot, then renders the panes", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-slot="workspace-shell"][data-theme]'), "the shell");
    expect(q('[data-pane="context"]')).not.toBeNull();
    expect(q('[data-pane="centre"]')?.textContent).toContain("the centre");
    expect(q('[data-pane="chat"]')).not.toBeNull();
    expect(q('[data-slot="shell-status"]')?.textContent).toContain("connected");
    // Three resizable panes.
    expect(document.querySelectorAll('[data-slot="resizable-panel"]').length).toBe(3);
    expect(document.querySelectorAll('[data-slot="resizable-handle"]').length).toBe(2);
    await m.unmount();
  });

  test("renders the toolbar, status and panels slots", async () => {
    const panels: ShellPanel[] = [
      { id: "a", label: "Alpha", node: <p>alpha body</p> },
      { id: "b", label: "Beta", node: <p>beta body</p> },
    ];
    const m = await mount(
      <Host
        extra={{
          toolbar: <span data-testid="toolbar">the toolbar</span>,
          status: <span data-testid="status">a status</span>,
          panels,
        }}
      />,
    );
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    expect(q('[data-testid="toolbar"]')?.textContent).toBe("the toolbar");
    expect(q('[data-slot="shell-status"]')?.textContent).toContain("a status");
    // The kit's own tabs come first, and the app's follow them.
    expect(q('[data-pane="chat"]')?.textContent).toContain("Nothing said yet");
    const alpha = [...document.querySelectorAll('[data-pane="chat"] button')].find(
      (b) => b.textContent === "Alpha",
    );
    await click(alpha ?? null);
    expect(q('[data-pane="chat"]')?.textContent).toContain("alpha body");
    const beta = [...document.querySelectorAll('[data-pane="chat"] button')].find(
      (b) => b.textContent === "Beta",
    );
    await click(beta ?? null);
    expect(q('[data-pane="chat"]')?.textContent).toContain("beta body");
    await m.unmount();
  });

  test("the context sidebar shows what the daemon holds, and follows a change", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    expect(q('[data-pane="context"]')?.textContent).toContain("No context yet");
    // The daemon pushes state on a change, and a context op through the wire is one.
    const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.send(JSON.stringify({ op: "context.add", path: join(docs, "solo.md") }));
    await waitFor(
      () => (q('[data-pane="context"]')?.textContent ?? "").includes("solo.md"),
      "the new entry",
    );
    ws.close();
    await m.unmount();
  });

  test("a document opened in the sidebar becomes the open document the centre can read", async () => {
    let seen: string | null = null;
    function Centre() {
      const w = useWorkspace();
      seen = w.openDoc?.name ?? null;
      return <p>{w.openDoc?.name ?? "no document"}</p>;
    }
    daemon.session.addContext(join(docs, "solo.md"));
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(
      () => (q('[data-pane="context"]')?.textContent ?? "").includes("solo.md"),
      "entry",
    );
    const row = [...document.querySelectorAll('[data-pane="context"] button')].find((b) =>
      (b.textContent ?? "").includes("solo.md"),
    );
    await click(row ?? null);
    await waitFor(() => seen === "solo.md", "the open document");
    await m.unmount();
  });

  test("the centre reports a selection, and the daemon holds it for `say` to attach", async () => {
    let report: ((s: import("../context/selection.ts").HeldSelection) => void) | null = null;
    function Centre() {
      const w = useWorkspace();
      report = w.reportSelection;
      return <p>{w.openDoc ? `open:${w.openDoc.slug}:${w.selection?.text ?? "none"}` : "none"}</p>;
    }
    daemon.session.addContext(join(docs, "solo.md"));
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(
      () => (q('[data-pane="context"]')?.textContent ?? "").includes("solo.md"),
      "entry",
    );
    const row = [...document.querySelectorAll('[data-pane="context"] button')].find((b) =>
      (b.textContent ?? "").includes("solo.md"),
    );
    await click(row ?? null);
    await waitFor(() => (q('[data-pane="centre"]')?.textContent ?? "").startsWith("open:"), "open");
    const slug = (q('[data-pane="centre"]')?.textContent ?? "").split(":")[1] as string;
    await settle(() => {
      report?.({ doc: slug, version: 1, from: 2, to: 6, fromLine: 1, toLine: 1, text: "Solo" });
    });
    const nativeFetch = nativeGlobal<typeof fetch>("fetch");
    await pollUntil("the daemon holding it", async () => {
      const snap = (await (await nativeFetch(`${daemon.url}/state`)).json()) as {
        selection: { text: string } | null;
      };
      return snap.selection?.text === "Solo";
    });
    expect(q('[data-pane="centre"]')?.textContent).toContain("Solo");
    await m.unmount();
  });

  test("the badge slot and the app's menu actions see the document the daemon has open", async () => {
    const targets: Array<{ kind: string; doc?: string }> = [];
    daemon.session.addContext(join(docs, "solo.md"));
    const m = await mount(
      <Host
        extra={{
          badges: (doc) => <b data-testid="badge">{`badge:${doc.name}`}</b>,
          menuActions: (t) => {
            targets.push({ kind: t.kind, doc: t.doc?.name });
            return [{ id: "x", label: "Render", onSelect: () => {} }];
          },
        }}
      />,
    );
    await waitFor(
      () => (q('[data-pane="context"]')?.textContent ?? "").includes("solo.md"),
      "entry",
    );
    // Not opened yet, so there is no document to badge.
    expect(q('[data-testid="badge"]')).toBeNull();
    const row = () =>
      [...document.querySelectorAll('[data-pane="context"] button')].find((b) =>
        (b.textContent ?? "").includes("solo.md"),
      ) ?? null;
    await click(row());
    await waitFor(() => !!q('[data-testid="badge"]'), "the badge");
    expect(q('[data-testid="badge"]')?.textContent).toBe("badge:solo.md");
    await settle(() => {
      row()?.dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 5,
          clientY: 5,
        }),
      );
    });
    await waitFor(() => targets.some((t) => t.doc === "solo.md"), "the target with its document");
    expect(targets.at(-1)).toEqual({ kind: "entry", doc: "solo.md" });
    await m.unmount();
  });

  test("a document made from the sidebar opens, and arrives in rename mode", async () => {
    daemon.session.addContext(join(docs, "set"));
    const m = await mount(<Host />);
    await waitFor(() => (q('[data-pane="context"]')?.textContent ?? "").includes("set"), "entry");
    await click(
      [...document.querySelectorAll('[data-pane="context"] button')].find((b) =>
        (b.textContent ?? "").includes("set"),
      ) ?? null,
    );
    await click(q('[aria-label="New document in this set"]'));
    await waitFor(() => !!q('input[aria-label^="Rename Untitled"]'), "the rename box");
    expect(q('input[aria-label^="Rename Untitled"]')).not.toBeNull();
    await m.unmount();
  });

  test("the theme switch sets the attribute on the root and remembers the choice", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    const toggle = q('[aria-label="Switch to the light theme"]');
    await click(toggle);
    expect(q('[data-slot="workspace-shell"]')?.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("spellbook:theme")).toBe("light");
    await m.unmount();
  });

  test("a saved layout with a column shut opens it shut, with its way back on screen", async () => {
    // What `useDefaultLayout` wrote on an earlier visit: the context at width 0.
    // A DOM has no layout, so the panels cannot be dragged here; the browser
    // hand test covers the writing half.
    localStorage.setItem(
      "spellbook:react-resizable-panels:panes:context:centre:chat",
      JSON.stringify({ context: 0, centre: 72, chat: 28 }),
    );
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    // A layout saved at 0 by an earlier build still reads as shut, now as a rail.
    const reopen = q('[aria-label="Reopen the context column"]');
    expect(reopen).not.toBeNull();
    expect(reopen?.closest("[data-slot=column-rail]")).not.toBeNull();
    expect(reopen?.closest("[inert]")).toBeNull();
    expect(q('[aria-label="Reopen the conversation column"]')).toBeNull();
    // The body is kept mounted, hidden and inert, so the tree's open folders
    // survive being put away.
    const body = q('[data-pane="context"]') as HTMLElement | null;
    expect(body).not.toBeNull();
    expect(body?.closest("[inert]")).not.toBeNull();
    expect(body?.hidden).toBe(true);
    expect(q('[data-pane="chat"]')?.closest("[inert]")).toBeNull();
    // Its way back is on the rail, so the centre has no row to hold it.
    expect(q("[data-slot=shell-toolbar-row]")).toBeNull();
    await m.unmount();
  });

  test("each column's shut state is its own, and the key prefix is the app's to choose", async () => {
    localStorage.setItem(
      "soundstage:react-resizable-panels:panes:context:centre:chat",
      JSON.stringify({ context: 22, centre: 78, chat: 0 }),
    );
    const m = await mount(<Host extra={{ storageKey: "soundstage" }} />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    expect(q('[aria-label="Reopen the conversation column"]')).not.toBeNull();
    expect(q('[aria-label="Reopen the context column"]')).toBeNull();
    await m.unmount();
  });

  test("a corrupt or wrongly shaped saved layout is ignored: the default layout opens", async () => {
    // What a hand edit, a crash mid-write or an older build can leave under the
    // shell's columns. The layout library parses it during render, unguarded.
    const KEY = "spellbook:react-resizable-panels:panes:context:centre:chat";
    for (const bad of BAD_LAYOUTS) {
      localStorage.clear();
      localStorage.setItem(KEY, bad.value);
      const m = await mount(<Host />);
      await waitFor(() => !!q('[data-pane="centre"]'), `the shell, over ${bad.what}`);
      // The default: both columns open, neither a rail.
      expect(q('[aria-label="Reopen the context column"]')).toBeNull();
      expect(q('[aria-label="Reopen the conversation column"]')).toBeNull();
      await m.unmount();
    }
  });

  test("a saved layout whose sizes do not sum to 100 is ignored: the default sizes open", async () => {
    const KEY = "spellbook:react-resizable-panels:panes:context:centre:chat";
    const sizes = () =>
      ["context", "centre", "chat"].map(
        (id) => (document.getElementById(id) as HTMLElement)?.style.flexGrow,
      );
    localStorage.clear();
    const first = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell, with nothing saved");
    const defaults = sizes();
    await first.unmount();
    for (const [what, value] of [
      ["sizes summing to 300", { context: 100, centre: 100, chat: 100 }],
      ["sizes summing to 60", { context: 20, centre: 20, chat: 20 }],
      ["every size zero", { context: 0, centre: 0, chat: 0 }],
    ] as const) {
      localStorage.clear();
      localStorage.setItem(KEY, JSON.stringify(value));
      const m = await mount(<Host />);
      await waitFor(() => !!q('[data-pane="centre"]'), `the shell, over ${what}`);
      expect([what, ...sizes()]).toEqual([what, ...defaults]);
      expect(q('[aria-label="Reopen the context column"]')).toBeNull();
      expect(q('[aria-label="Reopen the conversation column"]')).toBeNull();
      await m.unmount();
    }
  });

  test("Ctrl+1, 2 and 3 move focus between the panes", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    const press = (key: string) =>
      settle(() => {
        window.dispatchEvent(
          new window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }),
        );
      });
    await press("2");
    await waitFor(
      () => document.activeElement === q('[data-pane="centre"]'),
      "focus in the centre",
    );
    await press("1");
    await waitFor(
      () => document.activeElement === q('[data-pane="context"]'),
      "focus in the context",
    );
    await press("3");
    await waitFor(() => document.activeElement === q('[data-pane="chat"]'), "focus in the chat");
    await m.unmount();
  });

  test("Escape from inside a sidebar returns focus to the centre", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    (q('[data-pane="context"]') as HTMLElement).focus();
    await settle(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await waitFor(
      () => document.activeElement === q('[data-pane="centre"]'),
      "focus in the centre",
    );
    await m.unmount();
  });

  test("useWorkspace outside a shell says so", async () => {
    function Stray() {
      useWorkspace();
      return null;
    }
    const errors = console.error;
    console.error = () => {};
    try {
      await expect(mount(<Stray />)).rejects.toThrow("inside a WorkspaceShell");
    } finally {
      console.error = errors;
    }
  });
});

describe("the columns and the quiet the centre asks for", () => {
  let seen: Workspace | null = null;
  function Centre() {
    seen = useWorkspace();
    return <p data-testid="centre">the centre</p>;
  }
  const mountWith = () =>
    mount(<Host extra={{ centre: <Centre />, toolbar: <button type="button">Tool</button> }} />);
  const faded = (el: Element | null | undefined) => el?.classList.contains("opacity-40") === true;
  const connectedNow = () =>
    (q("[data-slot=shell-status]")?.textContent ?? "").includes("connected");

  test("the centre reads which columns are shut off the layout", async () => {
    // A DOM has no layout, so the library cannot resize a panel here and the acts
    // themselves (collapse, expand) are the browser hand test's.
    localStorage.setItem(
      "spellbook:react-resizable-panels:panes:context:centre:chat",
      JSON.stringify({ context: 0, centre: 100, chat: 0 }),
    );
    seen = null;
    const m = await mountWith();
    await waitFor(() => seen !== null, "the centre");
    expect((seen as Workspace | null)?.columns.collapsed).toEqual({ context: true, chat: true });
    await m.unmount();
  });

  test("quiet fades the top bar, the toolbar row and the status bar, and they come back when it ends", async () => {
    seen = null;
    const m = await mountWith();
    await waitFor(() => seen !== null && connectedNow(), "the shell, connected");
    const row = () => q("[data-slot=shell-toolbar-row]");
    const end = () => q('[aria-label="End session"]');
    expect(faded(end())).toBe(false);
    await settle(() => (seen as Workspace | null)?.setQuiet(true));
    expect(row()?.classList.contains("group/chrome")).toBe(true);
    expect(q("[data-slot=shell-top-bar]")?.classList.contains("group/chrome")).toBe(true);
    expect(faded(q("[data-slot=app-title]"))).toBe(true);
    expect(faded(q("[data-slot=session-id]"))).toBe(true);
    expect(faded(end())).toBe(true);
    expect(faded(q("[data-slot=search-box]"))).toBe(true);
    expect(faded(q("[data-slot=shell-toolbar]"))).toBe(true);
    // Connected is idle, so it fades with the rest.
    expect(faded(q("[data-slot=shell-status] > span"))).toBe(true);
    await settle(() => (seen as Workspace | null)?.setQuiet(false));
    expect(row()?.classList.contains("group/chrome")).toBe(false);
    expect(document.querySelectorAll(".opacity-40").length).toBe(0);
    await m.unmount();
  });

  test("an ended session stays at full strength while quiet", async () => {
    seen = null;
    const m = await mountWith();
    await waitFor(() => seen !== null && connectedNow(), "the shell, connected");
    await settle(() => (seen as Workspace | null)?.setQuiet(true));
    await settle(() => {
      (seen as Workspace | null)?.daemon.send({ op: "close" });
    });
    await waitFor(() => q("[data-slot=ended-chip]") !== null, "the session ended");
    expect(faded(q("[data-slot=shell-status] > span"))).toBe(false);
    // The Ended chip in the top bar, where End session was, stays loud; no banner.
    const chip = q("[data-slot=ended-chip]");
    for (let e = chip; e; e = e.parentElement) expect(faded(e)).toBe(false);
    expect(q("[data-slot=session-ended]")).toBeNull();
    // The top bar's "(ended)" is news too, while the title beside it fades.
    const sid = q("[data-slot=session-id]");
    expect(sid?.textContent).toContain("(ended)");
    expect(faded(sid)).toBe(false);
    for (let e = sid?.parentElement; e; e = e.parentElement) expect(faded(e)).toBe(false);
    expect(faded(q("[data-slot=app-title]"))).toBe(true);
    await m.unmount();
  });
});

describe("the top bar", () => {
  const bar = () => q("[data-slot=shell-top-bar]");

  test("names the app and the session, and holds search, End session and the theme", async () => {
    const m = await mount(<Host extra={{ toolbar: <button type="button">Tool</button> }} />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    // The fixture app declares no title, so its name stands in.
    expect(q("[data-slot=app-title]")?.textContent).toBe("kit-fixture");
    expect(q("[data-slot=session-id]")?.textContent).toBe(`session ${daemon.sessionId}`);
    // Where the bar is too narrow for the id, the title still carries it.
    expect(q("[data-slot=app-title]")?.getAttribute("title")).toBe(`session ${daemon.sessionId}`);
    // Above the panes, not inside the centre.
    expect(bar()?.nextElementSibling?.querySelector('[data-pane="centre"]')).not.toBeNull();
    for (const sel of [
      "[data-slot=search-box]",
      '[aria-label="End session"]',
      '[aria-label^="Switch to the"]',
    ]) {
      expect(q(sel)?.closest("[data-slot=shell-top-bar]"), sel).not.toBeNull();
      expect(
        q(sel)?.closest('[data-pane="centre"], [data-slot=shell-toolbar-row]'),
        sel,
      ).toBeNull();
    }
    // The centre's row keeps the app's own controls.
    expect(q("[data-slot=shell-toolbar-row]")?.textContent).toBe("Tool");
    await m.unmount();
  });

  test("Cmd-K or Ctrl-K still reaches the search box", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    await settle(() => {
      for (const mod of [{ metaKey: true }, { ctrlKey: true }])
        window.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "k",
            bubbles: true,
            cancelable: true,
            ...mod,
          }),
        );
    });
    await waitFor(
      () => document.activeElement === q("[data-slot=shell-top-bar] input"),
      "focus in the bar's search",
    );
    await m.unmount();
  });

  test("an app with no toolbar and both columns open draws no empty row over its centre", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    expect(q("[data-slot=shell-toolbar-row]")).toBeNull();
    await m.unmount();
  });

  test("a shut column's way back is on its rail, never in the centre's row", async () => {
    localStorage.setItem(
      "spellbook:react-resizable-panels:panes:context:centre:chat",
      JSON.stringify({ context: 22, centre: 75, chat: 3 }),
    );
    const m = await mount(<Host extra={{ toolbar: <button type="button">Tool</button> }} />);
    await waitFor(() => !!q('[data-pane="centre"]'), "the shell");
    const reopen = q('[data-column-control="chat-reopen"]');
    expect(reopen).not.toBeNull();
    expect(reopen?.closest("[data-slot=column-rail]")).not.toBeNull();
    // The row holds the app's toolbar and nothing else.
    expect(q("[data-slot=shell-toolbar-row]")?.textContent).toBe("Tool");
    expect(q("[data-slot=shell-toolbar-row] [data-column-control]")).toBeNull();
    await m.unmount();
  });
});

describe("the chat rail's mark", () => {
  const SHUT = JSON.stringify({ context: 22, centre: 75, chat: 3 });
  const KEY = "spellbook:react-resizable-panels:panes:context:centre:chat";
  const mark = () => q("[data-slot=chat-unseen]");
  const reopen = () => q('[data-column-control="chat-reopen"]');
  const agentSays = (text: string) =>
    nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "say", text, from: "agent" }),
    });
  let w: Workspace | null = null;
  const ws = () => w as Workspace;
  function Centre({ quiet = false }: { quiet?: boolean }) {
    const workspace = useWorkspace();
    w = workspace;
    const { setQuiet } = workspace;
    useEffect(() => setQuiet(quiet), [quiet, setQuiet]);
    return <p>the centre</p>;
  }
  let layoutStub: LaidOut | null = null;
  beforeEach(() => {
    w = null;
    layoutStub = laidOut();
  });
  afterEach(() => {
    layoutStub?.undo();
    layoutStub = null;
  });

  test("the agent speaking while the chat is shut marks its rail, loud in reader mode; a reload starts clean", async () => {
    localStorage.setItem(KEY, SHUT);
    const m = await mount(<Host extra={{ centre: <Centre quiet /> }} />);
    await waitFor(() => !!reopen(), "the chat rail");
    expect(mark()).toBeNull();
    await agentSays("Done with the harbour.");
    await waitFor(() => mark() !== null, "the mark");
    expect(reopen()?.getAttribute("aria-label")).toContain("something new");
    // Quiet: the rail's button has faded, and the mark, asking for attention, has not.
    expect(reopen()?.classList.contains("opacity-40")).toBe(true);
    for (let e = mark(); e; e = e.parentElement)
      expect(e.classList.contains("opacity-40")).toBe(false);
    expect(mark()?.querySelectorAll(".opacity-40").length).toBe(0);
    // Its own control on the rail, under the reopen button rather than on its corner.
    const button = reopen() as Element;
    expect(mark()?.closest("[data-slot=column-rail]")).toBe(
      button.closest("[data-slot=column-rail]"),
    );
    expect(button.contains(mark())).toBe(false);
    expect(
      button.compareDocumentPosition(mark() as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await m.unmount();
    // What was already there when the page loads is not news.
    const again = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => !!reopen(), "the chat rail");
    expect(mark()).toBeNull();
    await again.unmount();
  });

  test("reopening is seeing: the mark goes, and shutting the column again does not bring it back", async () => {
    localStorage.setItem(KEY, SHUT);
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => !!reopen(), "the chat rail");
    await agentSays("A reply.");
    await waitFor(() => mark() !== null, "the mark");
    await click(reopen());
    await waitFor(() => ws().columns.collapsed.chat === false, "the chat open");
    expect(mark()).toBeNull();
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => ws().columns.collapsed.chat === true, "the chat shut again");
    expect(mark()).toBeNull();
    await m.unmount();
  });

  test("a task the agent starts raises a toast whose button opens the column on the Tasks tab; a reload raises nothing", async () => {
    localStorage.setItem(KEY, SHUT);
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => !!reopen(), "the chat rail");
    await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "task.create", title: "Map the rivers" }),
    });
    const toast = () =>
      [...document.querySelectorAll("article")].find((a) =>
        (a.textContent ?? "").includes("Agent started: Map the rivers"),
      ) ?? null;
    await waitFor(() => toast() !== null, "the start toast");
    const show = toast()?.querySelector(
      'button[aria-label="Open the conversation column on the Tasks tab"]',
    );
    expect(show?.textContent).toBe("Show tasks");
    await click(show ?? null);
    await waitFor(() => ws().columns.collapsed.chat === false, "the chat open");
    const tasksTab = [...document.querySelectorAll('[role="tab"]')].find((t) =>
      (t.textContent ?? "").includes("Tasks"),
    );
    expect(tasksTab?.getAttribute("aria-selected")).toBe("true");
    expect(q('[role="tabpanel"]')?.textContent).toContain("Map the rivers");
    expect(toast()).toBeNull();
    // With the column open on Chat, the start is already on screen as a chat line.
    await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "task.create", title: "Name the hills" }),
    });
    await click(
      [...document.querySelectorAll('[role="tab"]')].find((t) =>
        (t.textContent ?? "").startsWith("Chat"),
      ) ?? null,
    );
    await waitFor(
      () => (q('[role="log"]')?.textContent ?? "").includes("Name the hills"),
      "the chat line",
    );
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(document.body.textContent).not.toContain("Agent started: Name the hills");
    await m.unmount();
    // The task is still running, and a page loaded now does not announce it again.
    const again = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => !!q('[role="tabpanel"]'), "the shell");
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(toast()).toBeNull();
    await again.unmount();
  });

  test("the human's own lines and system lines leave no mark", async () => {
    localStorage.setItem(KEY, SHUT);
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => !!reopen() && daemon.session.view().chat !== undefined, "the chat rail");
    const lines = () => daemon.session.view().chat.length;
    const before = lines();
    await settle(() => {
      ws().daemon.send({ op: "say", text: "A note to self." });
    });
    // A revert is the human's own act, reported as a system line.
    daemon.session.addContext(join(docs, "solo.md"));
    await settle(() => {
      ws().daemon.send({ op: "open", path: join(docs, "solo.md") });
    });
    await waitFor(() => ws().openDoc !== null, "the document open");
    await settle(() => {
      ws().daemon.send({ op: "revert", doc: ws().openDoc?.slug as string });
    });
    await waitFor(() => lines() >= before + 2, "a human line and a system line");
    expect(
      daemon.session
        .view()
        .chat.slice(before)
        .map((l) => l.from),
    ).toEqual(expect.arrayContaining(["human", "system"]));
    await new Promise((r) => setTimeout(r, 100));
    expect(mark()).toBeNull();
    await m.unmount();
  });

  test("pressing the mark opens the conversation on its Chat tab, and the mark goes", async () => {
    localStorage.setItem("spellbook:tab", "tasks");
    localStorage.setItem(KEY, SHUT);
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => !!reopen(), "the chat rail");
    await agentSays("Look at this.");
    await waitFor(() => mark() !== null, "the mark");
    expect(mark()?.tagName).toBe("BUTTON");
    expect(mark()?.getAttribute("aria-label")).toBe(
      "Open the conversation: the agent has said something new",
    );
    await click(mark());
    await waitFor(() => ws().columns.collapsed.chat === false, "the chat open");
    expect(q('[data-pane="chat"] [role="tab"][aria-selected="true"]')?.textContent).toContain(
      "Chat",
    );
    expect(mark()).toBeNull();
    await m.unmount();
  });

  test("Ctrl+[ from inside the context hands focus to its rail's reopen button", async () => {
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => w !== null, "the shell");
    await settle(() => (q('[data-pane="context"]') as HTMLElement).focus());
    await settle(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "[", ctrlKey: true, bubbles: true }),
      );
    });
    await waitFor(() => ws().columns.collapsed.context === true, "the context shut");
    await waitFor(
      () => document.activeElement === q('[data-column-control="context-reopen"]'),
      "focus on the rail's reopen button",
    );
    await m.unmount();
  });
});

describe("the columns as the window changes", () => {
  let w: Workspace | null = null;
  const ws = () => w as Workspace;
  function Centre() {
    w = useWorkspace();
    return <p>the centre</p>;
  }
  let stub: LaidOut | null = null;
  afterEach(() => {
    stub?.undo();
    stub = null;
    w = null;
  });
  const press = (key: string) =>
    settle(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }),
      );
    });

  test("a rail collapsed in a narrow window stays a rail when the window widens", async () => {
    stub = laidOut(640);
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => w !== null, "the shell");
    // Both shut, as reader mode leaves them: then the library, keeping the rails'
    // percentages, brings the context back past its threshold at 1400 px.
    await click(q('[data-column-control="context-collapse"]'));
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(
      () => ws().columns.collapsed.context && ws().columns.collapsed.chat,
      "both shut at 640",
    );
    await stub.resize(1400);
    await new Promise((r) => setTimeout(r, 50));
    expect(ws().columns.collapsed).toEqual({ context: true, chat: true });
    expect(q('[data-column-control="context-reopen"]')).not.toBeNull();
    expect(q('[data-column-control="chat-reopen"]')).not.toBeNull();
    await m.unmount();
  });

  test("after a widen the shell's own reopen still opens it, by button and by Ctrl+[", async () => {
    stub = laidOut(640);
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => w !== null, "the shell");
    await click(q('[data-column-control="context-collapse"]'));
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => ws().columns.collapsed.context && ws().columns.collapsed.chat, "both shut");
    await stub.resize(1400);
    await click(q('[data-column-control="context-reopen"]'));
    await waitFor(() => ws().columns.collapsed.context === false, "the context open");
    await press("]");
    await waitFor(() => ws().columns.collapsed.chat === false, "the chat open");
    await m.unmount();
  });

  test("a double-click on a rail's handle reopens it, and on an open column's handle resets its width", async () => {
    stub = laidOut(1200);
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => w !== null, "the shell");
    await click(q('[data-column-control="context-collapse"]'));
    await waitFor(() => ws().columns.collapsed.context, "the context shut");
    const handle = () => document.querySelectorAll('[data-slot="resizable-handle"]')[0] as Element;
    await settle(() => {
      handle().dispatchEvent(
        new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => ws().columns.collapsed.context === false, "the context reopened");
    await new Promise((r) => setTimeout(r, 50));
    expect(ws().columns.collapsed.context).toBe(false);
    // Open: back to its default width (22%), as the library's own double-click did.
    const share = () =>
      Number(
        (q('[data-pane="context"]')?.closest("[data-panel]") as HTMLElement | null)?.style.flexGrow,
      );
    // A width of the human's own (30%), saved and restored, rather than a drag:
    // the library's pointer and key handling need a layout a DOM does not have.
    await m.unmount();
    localStorage.setItem(
      "spellbook:react-resizable-panels:panes:context:centre:chat",
      JSON.stringify({ context: 30, centre: 42, chat: 28 }),
    );
    const again = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => Math.abs(share() - 22) > 1, "the context dragged off its default");
    await settle(() => {
      handle().dispatchEvent(
        new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => Math.abs(share() - 22) < 0.1, "the default width");
    expect(ws().columns.collapsed.context).toBe(false);
    await again.unmount();
  });

  test("a double-click a few pixels off the drawn line still reaches the handle the library marks", async () => {
    stub = laidOut(1200);
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => w !== null, "the shell");
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => ws().columns.collapsed.chat, "the chat shut");
    const chatHandle = document.querySelectorAll('[data-slot="resizable-handle"]')[1] as Element;
    // The pointer is beside the line, over the centre, inside the library's margin.
    await settle(() => {
      chatHandle.setAttribute("data-separator", "hover");
      q('[data-pane="centre"]')?.dispatchEvent(
        new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => ws().columns.collapsed.chat === false, "the chat reopened");
    await m.unmount();
  });

  test("Ctrl+] with focus on the chat rail's mark hands focus on, not to the page", async () => {
    stub = laidOut(1200);
    localStorage.setItem(
      "spellbook:react-resizable-panels:panes:context:centre:chat",
      JSON.stringify({ context: 22, centre: 75, chat: 3 }),
    );
    const m = await mount(<Host extra={{ centre: <Centre /> }} />);
    await waitFor(() => !!q('[data-column-control="chat-reopen"]'), "the chat rail");
    await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "say", text: "Here.", from: "agent" }),
    });
    await waitFor(() => !!q("[data-slot=chat-unseen]"), "the mark");
    await settle(() => (q("[data-slot=chat-unseen]") as HTMLElement).focus());
    await press("]");
    await waitFor(() => ws().columns.collapsed.chat === false, "the chat open");
    await waitFor(
      () => document.activeElement === q('[data-column-control="chat-collapse"]'),
      "focus on the chat's collapse button",
    );
    await m.unmount();
  });
});
