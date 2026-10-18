// A bundle open in the pane, in a DOM against a real fixture daemon: with no
// view of its own its main file is a document of its type's format (a JSON
// board opens raw, in JSON mode, guarded like any JSON document), and an app's
// `formatViews` entry for the type is drawn in its place, writing through the
// same path the editor does.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useState } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
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
import { TEST_BUNDLE, tempRoot, writeBundle } from "../workspace/testing";
import { DocumentPane, type FormatView } from "./DocumentPane.tsx";

beforeAll(() => {
  installDom();
  registerBundleType(TEST_BUNDLE);
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => ({ ...rect, toJSON() {} });
  const el = window.Element.prototype as unknown as Record<string, unknown>;
  el.getClientRects = el.getClientRects ?? (() => []);
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
afterAll(async () => {
  unregisterBundleType(TEST_BUNDLE.extension);
  await removeDom();
});

let root: string;
let ws: string;
let world: string;
let well: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let views: Record<string, FormatView> | undefined;
let rawMain: string | null = null;

beforeEach(async () => {
  root = tempRoot("document-pane-bundles");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The set sits in the session's workspace folder.
  ws = testWorkspace(root, "ws");
  world = join(ws, "world");
  mkdirSync(world, { recursive: true });
  well = writeBundle(world, "The well", { version: 1, type: "board", title: "The well" });
  writeFileSync(join(world, "story.md"), "# Story\n\nOnce, a well.\n");
  localStorage.clear();
  views = undefined;
  rawMain = null;
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
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
    rawMain,
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" tabIndex={-1} style={{ width: 900, height: 700 }}>
        <DocumentPane splitView formatViews={views} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = (sel: string) => document.querySelector(sel);

async function openWell() {
  await mount(<Host />);
  await waitFor(() => document.body.textContent?.includes("No document open") === true, "empty");
  await settle(() => {
    client?.send({ op: "context.add", path: world });
  });
  await waitFor(() => (client?.state?.context.length ?? 0) === 1, "the set");
  // The row sends the bundle's own path; the daemon opens its main file.
  await settle(() => {
    client?.send({ op: "open", path: well });
  });
}

describe("a bundle in the pane", () => {
  test("with no view of its own, its main file opens raw, in its format's mode", async () => {
    localStorage.setItem("spellbook:view-mode", "rendered");
    await openWell();
    await waitFor(() => (q(".cm-content")?.textContent ?? "").includes("lantern"), "the editor");
    const view = EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
    const names = new Set<string>();
    syntaxTree(view.state).iterate({ enter: (n) => void names.add(n.name) });
    expect(names.has("PropertyName")).toBe(true);
    expect(q('button[aria-label="Rendered"]')).toBeNull();
    expect(q("[data-slot=format-view]")).toBeNull();
    // The header names the bundle by its title, never its main file or folder.
    const header = q(`span[title="${join(well, "board.board")}"]`);
    expect(header?.textContent).toBe("The well");
    expect(document.body.textContent).not.toContain("board.board");
    expect(document.body.textContent).not.toContain(".boardbundle");
  });

  test("an app's view for its type is drawn in place of the editor, and writes as the editor does", async () => {
    let write: ((text: string) => void) | null = null;
    views = {
      board: ({ text, bundle, write: w }) => {
        write = w;
        return (
          <p data-testid="board-view" data-bundle-path={bundle}>
            {text.length} characters
          </p>
        );
      },
    };
    await openWell();
    await waitFor(() => q('[data-testid="board-view"]') !== null, "the app's view");
    expect(q("[data-slot=format-view]")?.getAttribute("data-bundle")).toBe("board");
    expect(q('[data-testid="board-view"]')?.getAttribute("data-bundle-path")).toBe(well);
    expect(q(".cm-editor")).toBeNull();
    await settle(() => write?.('{"nodes":[],"edges":[]}\n'));
    await waitFor(() => client?.state?.docs[0]?.dirty === true, "the edit in the active version");
  });

  test("opened from its own row inside the bundle (rawMain), the main file is drawn raw", async () => {
    views = { board: () => <p data-testid="board-view">a board</p> };
    rawMain = join(well, "board.board");
    await openWell();
    await waitFor(() => (q(".cm-content")?.textContent ?? "").includes("lantern"), "the editor");
    expect(q('[data-testid="board-view"]')).toBeNull();
    expect(q("[data-slot=format-view]")).toBeNull();
  });

  test("the header names the type: its icon, a chip, and the view's own mode button", async () => {
    // The type is swapped for the variant, then back.
    unregisterBundleType(TEST_BUNDLE.extension);
    registerBundleType({ ...TEST_BUNDLE, icon: <svg data-testid="board-icon" /> });
    try {
      views = { board: () => <p data-testid="board-view">a board</p> };
      await openWell();
      await waitFor(() => q('[data-testid="board-view"]') !== null, "the app's view");
      expect(q("[data-slot=format-chip]")?.textContent).toBe("board");
      expect(q("[data-slot=format-icon] [data-testid=board-icon]")).not.toBeNull();
      // "Raw" is the view itself here, named for the type; Compare stays.
      expect(q('button[aria-label="Raw text"]')).toBeNull();
      expect(q('button[aria-label="Board"]')?.getAttribute("aria-pressed")).toBe("true");
      expect(q('button[aria-label="Compare with another version"]')).not.toBeNull();
    } finally {
      unregisterBundleType(TEST_BUNDLE.extension);
      registerBundleType(TEST_BUNDLE);
    }
  });

  test("an edit still in its pause is written to its version before another is made active", async () => {
    let props: Parameters<FormatView>[0] | null = null;
    views = {
      board: (p) => {
        props = p;
        return <p data-testid="board-view">a board</p>;
      },
    };
    await openWell();
    await waitFor(() => q('[data-testid="board-view"]') !== null, "the app's view");
    const slug = client?.state?.docs[0]?.slug as string;
    await settle(() => {
      client?.send({ op: "version.new", doc: slug, from: 1, activate: false });
    });
    await waitFor(() => (client?.state?.docs[0]?.versions.length ?? 0) === 2, "a v2");
    const edited = '{"nodes":[],"edges":[],"note":"typed a moment ago"}\n';
    // Written, and v2 chosen at once, well inside the editor's 250 ms pause.
    await settle(() => (props as Parameters<FormatView>[0] | null)?.write(edited));
    await settle(() => {
      q('button[aria-label^="Version "]')?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => q('[role="menuitem"]') !== null, "the version menu");
    const v2 = [...document.querySelectorAll('[role="menuitem"]')].find(
      (i) => i.getAttribute("aria-current") !== "true" && (i.textContent ?? "").includes("v2"),
    );
    await settle(() => {
      v2?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => client?.state?.docs[0]?.active === 2, "v2 active");
    const v1 = await fetch(`${daemon.url}/fs/version?doc=${slug}&v=1`);
    expect(((await v1.json()) as { text: string }).text).toBe(edited);
  });

  test("Revert drops a write still in its pause, so it never lands on the reverted text", async () => {
    let props: Parameters<FormatView>[0] | null = null;
    views = {
      board: (p) => {
        props = p;
        return <p data-testid="board-view">a board</p>;
      },
    };
    await openWell();
    await waitFor(() => q('[data-testid="board-view"]') !== null, "the app's view");
    const slug = client?.state?.docs[0]?.slug as string;
    const write = (t: string) => (props as Parameters<FormatView>[0] | null)?.write(t);
    await settle(() => write('{"nodes":[],"edges":[],"first":1}\n'));
    await waitFor(() => client?.state?.docs[0]?.dirty === true, "unsaved");
    // A second write, then Revert at once, inside the pause.
    await settle(() => write('{"nodes":[],"edges":[],"second":2}\n'));
    const revert = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Revert"),
    );
    await settle(() => {
      revert?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => client?.state?.docs[0]?.dirty === false, "reverted");
    await Bun.sleep(500);
    expect(client?.state?.docs[0]?.dirty).toBe(false);
    const v1 = await fetch(`${daemon.url}/fs/version?doc=${slug}&v=1`);
    expect(((await v1.json()) as { text: string }).text).toBe(
      readFileSync(join(well, "board.board"), "utf8"),
    );
  });

  test("the view saves as Save does, and hears of a change inside its bundle", async () => {
    let props: Parameters<FormatView>[0] | null = null;
    views = {
      board: (p) => {
        props = p;
        return <p data-testid="board-view">a board</p>;
      },
    };
    await openWell();
    await waitFor(() => q('[data-testid="board-view"]') !== null, "the app's view");
    const heard: string[] = [];
    const stop = (props as Parameters<FormatView>[0] | null)?.onBundleChange((f) => heard.push(f));
    await settle(() =>
      (props as Parameters<FormatView>[0] | null)?.write('{"nodes":[],"edges":[]}\n'),
    );
    await settle(() => (props as Parameters<FormatView>[0] | null)?.save());
    await waitFor(
      () => readFileSync(join(well, "board.board"), "utf8") === '{"nodes":[],"edges":[]}\n',
      "the board saved to its file",
    );
    await waitFor(() => client?.state?.docs[0]?.dirty === false, "clean after the save");
    // Change an asset as an agent would. Written until heard, not after a fixed
    // pause: the bundle's watch was armed when the context was added, and a
    // write in a watch's first moments is lost on macOS (see `writeUntilSeen`).
    // Writing the same bytes again is harmless.
    const fox = join(well, "assets", "fox.png");
    await writeUntilSeen(
      "the asset's change",
      () => writeFileSync(fox, "new bytes"),
      () => heard.includes(fox),
    );
    stop?.();
  }, 15000);

  test("the view is a component of its own: its hooks survive moving to a document and back", async () => {
    let mounts = 0;
    function Board({ text }: { text: string }) {
      const [seen] = useState(() => text.length);
      useEffect(() => {
        mounts++;
      }, []);
      return <p data-testid="board-view">first saw {seen}</p>;
    }
    views = { board: Board };
    await openWell();
    await waitFor(() => q('[data-testid="board-view"]') !== null, "the app's view");
    // To a markdown document: the pane's own hooks are the same as before.
    await settle(() => {
      client?.send({ op: "open", path: join(world, "story.md") });
    });
    await waitFor(
      () => (q(".cm-content")?.textContent ?? "").includes("Once, a well."),
      "the story",
    );
    expect(q('[data-testid="board-view"]')).toBeNull();
    // And back: the view starts afresh, as a new instance.
    await settle(() => {
      client?.send({ op: "open", path: well });
    });
    await waitFor(() => q('[data-testid="board-view"]') !== null, "the view again");
    expect(mounts).toBe(2);
  });
});
