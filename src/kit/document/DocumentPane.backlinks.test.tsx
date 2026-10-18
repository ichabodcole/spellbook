// Relations and backlinks in the rendered document, in a DOM against a REAL
// workspace daemon: a typed link carries its relations as an attribute the
// stylesheet draws (never as text, so selection still aligns), and the foot of
// the rendered view lists what links to the open document, grouped by relation,
// each entry opening its source at the link. The host stands in for the shell
// and records what the pane asks it to open.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo, useState } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import type { HeldSelection } from "../context/selection.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import type { LinkedFromAction } from "./Backlinks.tsx";
import { type AppView, DocumentPane } from "./DocumentPane.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
/** What the pane asked the host to open, in order. */
let opened: { path: string; at?: { from: number; to: number } }[];
/** Every selection the pane reported to the host. */
let selections: HeldSelection[] = [];

const A = [
  "# A",
  "",
  "Her [sister](./part/b.md?rel=sister-of,extends) lives by the river.",
  "",
  "A [bare one](./part/b.md) too.",
  "",
].join("\n");

beforeEach(async () => {
  root = tempRoot("pane-backlinks");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "set", "a.md"), A);
  writeFileSync(join(docs, "set", "part", "b.md"), "# B\n\n[back](../a.md)\n");
  writeFileSync(join(docs, "set", "c.md"), "# C\n\nSee [b](part/b.md?rel=extends).\n");
  localStorage.clear();
  client = null;
  opened = [];
  selections = [];
  // The seeded folder is the workspace, so its set is in the context from the start.
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
  daemon.session.addContext(join(docs, "set"));
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host({
  mode = "rendered",
  linkedFromAction,
  appView,
}: {
  mode?: "rendered" | "raw";
  linkedFromAction?: LinkedFromAction;
  appView?: AppView;
}) {
  const d = useDaemon({ url: `${daemon.url}/ws`, minDelayMs: 20, maxDelayMs: 60 });
  client = d;
  const toasts = useMemo(() => createToastStore(), []);
  const state = d.state;
  if (!state) return null;
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc: state.docs.find((doc) => doc.slug === state.openDoc) ?? null,
    selection: null,
    reportSelection: (sel) => {
      selections.push(sel);
    },
    dropSelection: () => {},
    clearSeq: 0,
    reveal: null,
    requestReveal: () => {},
    revealApplied: () => {},
    openAt: (path, at) => {
      opened.push({ path, ...(at ? { at } : {}) });
      d.send({ op: "open", path });
    },
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
        <DocumentPane
          mode={mode}
          {...(linkedFromAction ? { linkedFromAction } : {})}
          {...(appView ? { appView } : {})}
        />
      </main>
    </WorkspaceContext.Provider>
  );
}

const openName = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.name;
const link = (label: string) =>
  [...document.querySelectorAll(".md-prose a")].find((a) => a.textContent === label) ?? null;
const section = () => document.querySelector('[data-slot="backlinks"]');
const groups = () =>
  [...document.querySelectorAll('[data-slot="backlink-group"]')].map((g) => [
    g.getAttribute("data-rel"),
    [...g.querySelectorAll('[data-slot="backlink"]')].map(
      (b) =>
        `${b.getAttribute("data-source")?.slice(join(docs, "set").length + 1)}:${b.getAttribute("data-line")}`,
    ),
  ]);

async function open(path: string, ready: () => boolean, mode?: "rendered" | "raw") {
  const m = await mount(<Host mode={mode} />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path });
  });
  await waitFor(ready, "the document");
  return m;
}

describe("a typed link's relations", () => {
  test("are on the anchor as data-rel, several joined, and never in its text", async () => {
    const m = await open(join(docs, "set", "a.md"), () => link("sister") !== null);
    const typed = link("sister");
    expect(typed?.getAttribute("data-rel")).toBe("sister-of · extends");
    // The words are the link's own: the chip is the stylesheet's, not the DOM's.
    expect(typed?.textContent).toBe("sister");
    expect(document.querySelector(".md-prose")?.textContent).not.toContain("sister-of");
    expect(link("bare one")?.hasAttribute("data-rel")).toBe(false);
    await m.unmount();
  });

  test("the stylesheet draws the attribute after the link, muted, in both themes", () => {
    const css = readFileSync(join(import.meta.dir, "..", "theme", "base.css"), "utf8");
    const rule = css.slice(css.indexOf(".md-prose a[data-rel]::after"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("content: attr(data-rel)");
    // Theme tokens, never a fixed colour, so light and dark both read.
    expect(body).toContain("var(--color-ink-dim)");
    expect(body).toContain("var(--color-surface-raised)");
    expect(body).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("Linked from", () => {
  test("lists the open document's backlinks grouped by relation, bare last", async () => {
    const m = await open(join(docs, "set", "part", "b.md"), () => section() !== null);
    expect(section()?.querySelector("h2")?.textContent).toContain("3 links");
    expect(groups()).toEqual([
      ["extends", ["a.md:3", "c.md:3"]],
      ["sister-of", ["a.md:3"]],
      ["", ["a.md:5"]],
    ]);
    // Each entry names its source and quotes the line, the link reduced to its words.
    const first = section()?.querySelector('[data-slot="backlink"]');
    expect(first?.textContent).toContain("a");
    expect(first?.querySelector('[data-slot="snippet"]')?.textContent).toBe(
      "Her sister lives by the river.",
    );
    expect(first?.querySelector("mark")?.textContent).toBe("sister");
    await m.unmount();
  });

  test("an entry opens its source at the link", async () => {
    const m = await open(join(docs, "set", "part", "b.md"), () => section() !== null);
    const entry = [...document.querySelectorAll('[data-slot="backlink"]')].find(
      (b) => b.getAttribute("data-source") === join(docs, "set", "c.md"),
    );
    await settle(() => {
      entry?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(opened).toHaveLength(1);
    const { path, at } = opened[0] ?? { path: "" };
    expect(path).toBe(join(docs, "set", "c.md"));
    const text = readFileSync(path, "utf8");
    expect(text.slice(at?.from, at?.to)).toBe("[b](part/b.md?rel=extends)");
    await waitFor(() => openName() === "c.md", "c.md open");
    await m.unmount();
  });

  test("each entry is named by its source and line, and described by its quote", async () => {
    const m = await open(join(docs, "set", "part", "b.md"), () => section() !== null);
    const entry = section()?.querySelector('[data-slot="backlink"]');
    expect(entry?.getAttribute("aria-label")).toBe("a, line 3");
    const described = entry?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe("Her sister lives by the river.");
    await m.unmount();
  });

  test("a selection dragged from the prose into the footer reports only the prose", async () => {
    const m = await open(join(docs, "set", "part", "b.md"), () => section() !== null);
    const prose = document.querySelector(".md-prose h1")?.firstChild as Text;
    const snippet = section()?.querySelector('[data-slot="snippet"] span')?.firstChild as Text;
    expect(prose.data).toBe("B");
    await settle(() => {
      const r = document.createRange();
      r.setStart(prose, 0);
      r.setEnd(snippet, 3);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    await waitFor(() => selections.some((s) => s.text !== ""), "the reported selection");
    const last = selections.filter((s) => s.text !== "").at(-1);
    const source = readFileSync(join(docs, "set", "part", "b.md"), "utf8");
    // Only the body's source: nothing of the footer's quote or names.
    expect(source.slice(last?.from, last?.to)).toBe(last?.text ?? "");
    expect(last?.text).toContain("B");
    expect(last?.text).not.toContain("Her");
    await m.unmount();
  });

  test("an app's action sits in the heading and is told the document; without one there is none", async () => {
    const plain = await open(join(docs, "set", "part", "b.md"), () => section() !== null);
    expect(document.querySelector('[data-slot="linked-from-action"]')).toBeNull();
    await plain.unmount();
    const asked: string[] = [];
    const m = await mount(
      <Host linkedFromAction={{ label: "Show as a graph", onSelect: (d) => asked.push(d.name) }} />,
    );
    await waitFor(() => client?.connection === "open", "the connection");
    await settle(() => {
      client?.send({ op: "open", path: join(docs, "set", "part", "b.md") });
    });
    await waitFor(() => section() !== null, "the section");
    const action = section()?.querySelector('h2 [data-slot="linked-from-action"]');
    expect(action?.textContent).toBe("Show as a graph");
    await settle(() => {
      action?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(asked).toEqual(["b.md"]);
    await m.unmount();
  });

  test("an app's own view takes the centre beside the document's modes, and gives it back", async () => {
    function WithView() {
      const [active, setActive] = useState(false);
      return (
        <Host
          appView={{
            id: "test.view",
            label: "The app's view",
            icon: <span>V</span>,
            active,
            onActive: setActive,
            render: () => <p data-testid="app-body">the app's own drawing</p>,
          }}
        />
      );
    }
    const m = await mount(<WithView />);
    await waitFor(() => client?.connection === "open", "the connection");
    await settle(() => {
      client?.send({ op: "open", path: join(docs, "set", "part", "b.md") });
    });
    await waitFor(() => section() !== null, "the document");
    const toggle = () => document.querySelector('[data-slot="app-view-toggle"]');
    const rendered = () => document.querySelector('button[aria-label="Rendered"]');
    // In the document's own toolbar, beside its modes.
    expect(toggle()?.closest('[aria-label="How to show this document"]')).not.toBeNull();
    expect(rendered()?.getAttribute("aria-pressed")).toBe("true");
    await settle(() => {
      toggle()?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="app-body"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="app-view"]')?.getAttribute("data-view")).toBe(
      "test.view",
    );
    expect(section()).toBeNull();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(rendered()?.getAttribute("aria-pressed")).toBe("false");
    // A document mode gives the centre back to the document.
    await settle(() => {
      rendered()?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="app-body"]')).toBeNull();
    await waitFor(() => section() !== null, "the document again");
    await m.unmount();
  });

  test("a document nothing links to shows no section at all", async () => {
    const m = await open(join(docs, "set", "c.md"), () => link("b") !== null);
    await settle(() => new Promise((r) => setTimeout(r, 400)));
    expect(section()).toBeNull();
    await m.unmount();
  });

  test("a new link elsewhere appears without reopening, and a raw view asks for none", async () => {
    const m = await open(join(docs, "set", "part", "b.md"), () => section() !== null);
    writeFileSync(join(docs, "set", "d.md"), "# D\n\n[[part/b?rel=contrasts-with|B]]\n");
    await waitFor(
      () => groups().some(([rel]) => rel === "contrasts-with"),
      "the new backlink",
      5000,
    );
    await m.unmount();

    const raw = await open(join(docs, "set", "part", "b.md"), () => openName() === "b.md", "raw");
    await settle(() => new Promise((r) => setTimeout(r, 400)));
    expect(section()).toBeNull();
    await raw.unmount();
  });
});
