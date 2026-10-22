// The map in the frame, against a REAL flagged daemon (`kitDaemon`, in this
// process, under a scratch SCRIPTORIUM_HOME), mounted in happy-dom: "Show the
// map of this set" in a set's menu opens the map as the document pane's app
// view, fed by the kit's `link.graph` joined with docMeta; it draws both
// layouts and its draw cap, a frontmatter reference dashed apart from a body
// link, never says "unverified", and a node's click opens its document and
// leaves the map.

import "../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../../kit/context/daemonClient";
import { useDaemon } from "../../kit/context/useDaemon";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../../kit/lib/testDom";
import type { WorkspaceDaemon } from "../../kit/workspace/server";
import { tempRoot } from "../../kit/workspace/testing";
import { kitDaemon } from "../backend/kit/server";
import { Frame } from "./Frame";
import { DRAW_CAP } from "./MapView";

const root = tempRoot("scriptorium-frame-map");
const set = join(root, "docs", "set");
const big = join(root, "docs", "big");
const lone = join(root, "docs", "lone.md");
const mut = join(root, "docs", "mut");
const gone = join(root, "docs", "gone");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;

beforeAll(async () => {
  installDom();
  process.env.SCRIPTORIUM_HOME = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(set, { recursive: true });
  // A guide citing a rule in its prose and another by its frontmatter; the
  // stale rule has tags and no `verified`; one document has no frontmatter.
  writeFileSync(
    join(set, "index.md"),
    "---\ntitle: The Guide\ntype: guide\nstatus: draft\nrelated: [./old.md]\n---\n\n[Rule](./rule.md) and [plain](./plain.md)\n",
  );
  writeFileSync(join(set, "rule.md"), "---\ntitle: A Rule\ntype: rule\n---\n\n# A Rule\n");
  writeFileSync(
    join(set, "old.md"),
    "---\ntitle: An Old Rule\ntype: rule\nstale_after: 2001-01-01\ntags: [legacy]\n---\n\n# Old\n",
  );
  writeFileSync(join(set, "plain.md"), "# Plain\n\nNo frontmatter here.\n");
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < DRAW_CAP + 10; i++)
    writeFileSync(join(big, `n${String(i).padStart(3, "0")}.md`), `# Note ${i}\n`);
  writeFileSync(lone, "# Lone\n");
  mkdirSync(mut, { recursive: true });
  writeFileSync(join(mut, "note.md"), "---\ntitle: Note\nstatus: stable\n---\n\n# Note\n");
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(gone, "a.md"), "# A\n");
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
const listRow = (name: string) =>
  all('[aria-label="Context"] button').find((b) => (b.textContent ?? "").trim().startsWith(name)) ??
  null;
const map = () =>
  document.querySelector<HTMLElement>('[data-slot="app-view"][data-view="scriptorium.map"]');
const summary = () => document.querySelector('[data-slot="map-summary"]')?.textContent ?? "";
const columnNodes = () => all('[data-slot="map-columns"] g[data-path]');
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

/** Right-click a set's row, and choose the map. */
async function showMap(name: string) {
  await waitFor(() => listRow(name) !== null, `${name}'s row`);
  await rightClick(listRow(name));
  await waitFor(() => menuItem("Show the map of this set") !== null, "the map in the menu");
  await click(menuItem("Show the map of this set"));
  await waitFor(() => map() !== null, "the map in the centre");
}

describe("the map as the document pane's app view", () => {
  test("a set's menu opens its map in the centre, fed by the kit's graph and docMeta", async () => {
    const m = await open(set);
    await showMap("set");
    // Inside the document pane's centre, not a dialog.
    expect(map()?.closest('[data-pane="centre"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await waitFor(() => columnNodes().length === 4, "four documents drawn");
    expect(summary()).toContain("4 documents · 3 links inside");
    // Columns by kind, the guide's links drawn, the frontmatter one dashed.
    const text = map()?.textContent ?? "";
    expect(text).toContain("Map of set");
    expect(text).toContain("rule");
    expect(text).toContain("guide");
    const paths = all('[data-slot="map-columns"] path[data-source]');
    expect(paths.map((p) => p.getAttribute("data-source")).sort()).toEqual([
      "frontmatter",
      "link",
      "link",
    ]);
    expect(
      paths
        .find((p) => p.getAttribute("data-source") === "frontmatter")
        ?.getAttribute("stroke-dasharray"),
    ).toBe("4 3");
    // docMeta joined: the old rule is stale with its tag; the plain one claims no status.
    const old = all('[data-slot="map-columns"] g[data-path]').find((g) =>
      (g.getAttribute("data-path") ?? "").endsWith("old.md"),
    );
    expect(old?.querySelector("title")?.textContent).toContain("stale");
    expect(old?.querySelector("title")?.textContent).toContain("legacy");
    const plain = columnNodes().find((g) =>
      (g.getAttribute("data-path") ?? "").endsWith("plain.md"),
    );
    expect(plain?.getAttribute("aria-label")).toBe("Plain — 1 citations");
    expect(plain?.querySelector("title")?.textContent).not.toContain("stable");
    // E69: no document here has `verified`, and nothing on the map says unverified.
    expect(map()?.innerHTML).not.toContain("nverified");
    await m.unmount();
  });

  test("physics lays the same documents out by force, and the toggle brings the columns back", async () => {
    const m = await open(set);
    await showMap("set");
    await waitFor(() => columnNodes().length === 4, "the columns");
    await click(withText('[aria-label="How to lay the map out"] button', "physics"));
    // The canvas, not its bodies: `d3-timer` binds the window's animation frame
    // once, when it first loads, so in a run where another test file loaded it
    // under a DOM since removed, its ticks never come. The bodies are checked
    // in the browser.
    await waitFor(
      () =>
        document.querySelector('[data-slot="map-force"]')?.getAttribute("aria-label") ===
        "4 documents, arranged by their links",
      "the physics canvas, of four documents",
    );
    expect(columnNodes().length).toBe(0);
    await click(withText('[aria-label="How to lay the map out"] button', "columns"));
    await waitFor(() => columnNodes().length === 4, "the columns again");
    await m.unmount();
  });

  test("clicking a node opens its document and leaves the map; the pane's toggle comes back to it", async () => {
    const m = await open(set);
    await showMap("set");
    await waitFor(() => columnNodes().length === 4, "the map");
    const rule = columnNodes().find((g) => (g.getAttribute("data-path") ?? "").endsWith("rule.md"));
    await click(rule ?? null);
    await waitFor(
      () => client?.state?.docs.some((d) => d.original.endsWith("/set/rule.md")) ?? false,
      "the rule open",
    );
    await waitFor(() => map() === null, "the map left");
    // The view stays offered, as the app view's toggle, and returns to the same set.
    const toggle = document.querySelector('[data-slot="app-view-toggle"]');
    expect(toggle?.getAttribute("aria-label")).toBe("Map of set");
    await click(toggle);
    await waitFor(() => columnNodes().length === 4, "the map again");
    // And back to the document by the map's own close.
    await click(document.querySelector('[aria-label="Back to the document"]'));
    await waitFor(() => map() === null, "the document again");
    await m.unmount();
  });

  test("past the draw cap the columns draw the 140 best connected, and say so", async () => {
    const m = await open(big);
    await showMap("big");
    await waitFor(() => columnNodes().length > 0, "the map");
    expect(columnNodes().length).toBe(DRAW_CAP);
    expect(summary()).toContain(`${DRAW_CAP + 10} documents`);
    expect(summary()).toContain(`drawing the ${DRAW_CAP} best-connected`);
    await m.unmount();
  });

  test("a status and a stale change between two showings appear together; Escape leaves the map", async () => {
    const m = await open(mut);
    await showMap("mut");
    const note = () => columnNodes()[0];
    await waitFor(() => note() !== undefined, "the note drawn");
    expect(note()?.getAttribute("aria-label")).toBe("Note — stable, 0 citations");
    expect(note()?.querySelector("title")?.textContent).not.toContain("stale");
    // Escape goes back to the document, as Escape closed the shipped overlay.
    await settle(() => {
      document.body.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await waitFor(() => map() === null, "the map left by Escape");
    // Between showings, the note becomes deprecated and stale on disk.
    writeFileSync(
      join(mut, "note.md"),
      "---\ntitle: Note\nstatus: deprecated\nstale_after: 2001-01-01\n---\n\n# Note\n",
    );
    // Shown again by the pane's toggle at once: both changes, from one ask. Not
    // waiting for the page's docMeta, which a change to an unheld document
    // does not push: the map must not depend on it.
    await click(document.querySelector('[data-slot="app-view-toggle"]'));
    await waitFor(
      () => (note()?.getAttribute("aria-label") ?? "").includes("deprecated"),
      "the new status",
    );
    expect(note()?.querySelector("title")?.textContent).toContain("deprecated · stale");
    await m.unmount();
  });

  test("a set taken out of the context withdraws its map", async () => {
    const m = await open(gone);
    await showMap("gone");
    await waitFor(() => columnNodes().length === 1, "the map");
    const id = client?.state?.context.find((e) => e.root.endsWith("/docs/gone"))?.id as string;
    await settle(() => {
      client?.send({ op: "context.remove", id });
    });
    await waitFor(() => map() === null, "the map withdrawn");
    expect(
      [...document.querySelectorAll('[data-slot="app-view-toggle"]')].map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).not.toContain("Map of gone");
    await m.unmount();
  });

  test("a document listed on its own has no set to map", async () => {
    const m = await open(lone);
    await waitFor(() => listRow("lone.md") !== null, "the row");
    await rightClick(listRow("lone.md"));
    await waitFor(() => all('[role^="menuitem"]').length > 0, "the menu");
    expect(menuItem("Show the map of this set")).toBeNull();
    await m.unmount();
  });
});
