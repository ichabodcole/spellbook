// The header search box inside the real shell, over a real daemon: the shortcut
// opens it, typing asks the daemon, the arrows move, Enter opens the chosen
// result at the match, and Escape closes.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useDaemon } from "../context/useDaemon.ts";
import { useWorkspace } from "../context/workspace.ts";
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
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { isSearchShortcut, onMac } from "./SearchBox.tsx";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;

beforeEach(async () => {
  root = tempRoot("shell-search");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "set", "keeper.md"), "# Keeper\n\nline two\nthe lantern is lit\n");
  writeFileSync(join(docs, "set", "lamp.md"), "# Lamp\n\nanother lantern, unlit\n");
  localStorage.clear();
  // The docs folder is the workspace, so the seeded set is in it where it is.
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** What the centre shows of the workspace: the open document and the reveal asked for. */
function Probe() {
  const w = useWorkspace();
  return (
    <p data-testid="probe">
      {JSON.stringify({
        open: w.openDoc?.name ?? null,
        reveal: w.reveal ? { from: w.reveal.from, to: w.reveal.to, doc: w.reveal.doc } : null,
      })}
    </p>
  );
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
      <WorkspaceShell
        daemon={d}
        centre={<Probe />}
        toolbar={<button type="button">Render</button>}
      />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const probe = () => JSON.parse(q('[data-testid="probe"]')?.textContent ?? "{}");
const input = () => q('input[aria-label="Search documents"]') as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')];

const key = async (target: EventTarget, init: KeyboardEventInit) => {
  await settle(() => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
};

async function addContext(): Promise<void> {
  const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  ws.send(JSON.stringify({ op: "context.add", path: join(docs, "set") }));
  await waitFor(
    () => !(q('[data-pane="context"]')?.textContent ?? "No context yet").includes("No context yet"),
    "the context",
  );
  ws.close();
}

describe("the shortcut", () => {
  test("is Cmd-K on a Mac and Ctrl-K elsewhere, and leaves a Mac's Ctrl-K to the editor", () => {
    const k = { key: "k", shiftKey: false, altKey: false };
    expect(isSearchShortcut({ ...k, metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isSearchShortcut({ ...k, metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isSearchShortcut({ ...k, metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isSearchShortcut({ ...k, metaKey: true, ctrlKey: false }, false)).toBe(false);
    expect(isSearchShortcut({ ...k, key: "K", metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isSearchShortcut({ ...k, key: "j", metaKey: true, ctrlKey: false }, true)).toBe(false);
    expect(isSearchShortcut({ ...k, shiftKey: true, metaKey: true, ctrlKey: false }, true)).toBe(
      false,
    );
  });
});

describe("the search box in the shell", () => {
  const shortcut = (): KeyboardEventInit => (onMac() ? { metaKey: true } : { ctrlKey: true });

  test("the shortcut focuses it, typing lists matches, the arrows move, Enter opens at the match", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    await addContext();
    expect(input()).not.toBeNull();
    expect(document.activeElement).not.toBe(input());

    await key(document.body, { key: "k", ...shortcut() });
    expect(document.activeElement).toBe(input());

    await typeInto(input(), "lantern");
    await waitFor(() => options().length === 2, "two text results");
    expect(options().every((o) => o.getAttribute("data-kind") === "text")).toBe(true);
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(q('[role="listbox"]')?.textContent).toContain("In text");

    await key(input(), { key: "ArrowDown" });
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1]?.id ?? null);
    const chosen = options()[1]?.textContent ?? "";
    const name = chosen.includes("keeper.md") ? "keeper.md" : "lamp.md";
    await key(input(), { key: "ArrowDown" });
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    await key(input(), { key: "ArrowUp" });
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");

    await key(input(), { key: "Enter" });
    await waitFor(
      () => probe().open === name && probe().reveal !== null,
      "the document and reveal",
    );
    const text = name === "keeper.md" ? "# Keeper\n\nline two\nthe lantern is lit\n" : "";
    const { reveal } = probe();
    if (name === "keeper.md") {
      expect(text.slice(reveal.from, reveal.to)).toBe("lantern");
    } else {
      expect("# Lamp\n\nanother lantern, unlit\n".slice(reveal.from, reveal.to)).toBe("lantern");
    }
    // Choosing closes the results.
    expect(q('[role="listbox"]')).toBeNull();
    await m.unmount();
  });

  test("a name match opens the document without asking for a reveal; Escape closes the results", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    await addContext();

    await key(document.body, { key: "k", ...shortcut() });
    await typeInto(input(), "lamp");
    await waitFor(() => options().some((o) => o.getAttribute("data-kind") === "name"), "a name");
    expect(q('[role="listbox"]')?.textContent).toContain("Documents");
    expect(options()[0]?.getAttribute("data-kind")).toBe("name");
    expect(options()[0]?.textContent).toContain("lamp.md");

    await key(input(), { key: "Escape" });
    expect(q('[role="listbox"]')).toBeNull();
    expect(probe().open).toBeNull();

    await key(document.body, { key: "k", ...shortcut() });
    await waitFor(() => options().length > 0, "the results again");
    await key(input(), { key: "Enter" });
    await waitFor(() => probe().open === "lamp.md", "lamp.md open");
    expect(probe().reveal).toBeNull();
    await m.unmount();
  });

  test("a query nothing matches says so, and clearing it hides the list", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    await addContext();
    await typeInto(input(), "zzzzqqq");
    await waitFor(
      () => (q('[data-slot="search-results"]')?.textContent ?? "").includes("Nothing"),
      "none",
    );
    await settle(() => {
      (q('button[aria-label="Clear the search"]') as HTMLButtonElement).click();
    });
    expect(q('[data-slot="search-results"]')).toBeNull();
    expect(input().value).toBe("");
    await m.unmount();
  });
});

describe("the search box in the top bar", () => {
  test("it sits in the top bar, not beside the app's toolbar, and gives way down to an icon", async () => {
    // happy-dom has no layout, so the guarantee is asserted as the classes that give
    // it: the box is in the top bar's middle column, a flexible container that shows
    // its input only from 9rem and otherwise an icon button that opens it. The app's
    // toolbar keeps its width in the centre's own row.
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    const toolbar = q('[data-slot="shell-toolbar"]');
    expect(toolbar?.textContent).toBe("Render");
    expect(toolbar?.className).toContain("shrink-0");
    expect(toolbar?.querySelector('[data-slot="search-box"]')).toBeNull();
    const box = q('[data-slot="search-box"]');
    expect(box?.closest('[data-slot="shell-top-bar"]')).not.toBeNull();
    expect(box?.className).toContain("@container");
    expect(box?.className).toContain("flex-1");
    expect(box?.className).toContain("min-w-6");
    const icon = box?.querySelector("button[aria-label='Search documents']");
    expect(icon?.className).toContain("@min-[9rem]:hidden");
    expect(box?.querySelector("input")?.parentElement?.className).toContain("@min-[9rem]:flex");
    await m.unmount();
  });

  test("the icon opens the input, and the match is marked in the snippet", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    await addContext();
    await settle(() => {
      (q("button[aria-label='Search documents']") as HTMLButtonElement).click();
    });
    expect(document.activeElement).toBe(input());
    await typeInto(input(), "lit");
    await waitFor(() => options().length > 0, "a result");
    expect(q('[data-slot="search-match"]')?.textContent?.toLowerCase()).toBe("lit");
    await m.unmount();
  });
});

describe("a result whose document will not open", () => {
  test("leaves no reveal behind to fire when that document is opened later", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    await addContext();
    await typeInto(input(), "lantern");
    await waitFor(() => options().length === 2, "two results");
    // Both documents vanish under the context before the choice is made.
    unlinkSync(join(docs, "set", "keeper.md"));
    unlinkSync(join(docs, "set", "lamp.md"));
    await key(input(), { key: "Enter" });
    await waitFor(
      () => (document.body.textContent ?? "").includes("The workspace refused that"),
      "the refusal",
    );
    expect(probe().open).toBeNull();
    // The file comes back and is opened the ordinary way: no reveal rides along.
    const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    for (const f of ["keeper.md", "lamp.md"])
      writeFileSync(join(docs, "set", f), "# back\n\nthe lantern again\n");
    for (const f of ["keeper.md", "lamp.md"]) {
      ws.send(JSON.stringify({ op: "open", path: join(docs, "set", f) }));
      await waitFor(() => probe().open === f, `${f} open`);
      await settle(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(probe().reveal, f).toBeNull();
    }
    ws.close();
    await m.unmount();
  });
});
