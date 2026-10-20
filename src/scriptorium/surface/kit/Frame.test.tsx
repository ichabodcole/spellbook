// The flagged Scriptorium's shell wiring against a REAL flagged daemon (`kitDaemon`, in
// this process, under a scratch SCRIPTORIUM_HOME), mounted in happy-dom: chat
// reaches the daemon, a set is added, hide and unhide and make-set go through
// the menu, a move asks with the plan, opening a document shows it in the
// kit's document pane, a refusal's hint is the notice, and the daemon serves
// the built frame. What the pane does in the frame (edits, the held selection,
// notes, chips, the outside-change toast) is `Frame.document.test.tsx`.
// Where a create goes: with a selection beside or inside it, unasked; with
// nothing selected, or a drop on the list itself, the location dialog. Every
// test is watched: a create, import or drop that reaches the daemon without a
// `dir` fails the test it happened in (`placeless`).

import "../../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { GIF_1PX } from "../../../kit/lib/testImages";
import { type LaidOut, laidOut } from "../../../kit/lib/testLayout";
import { THEME_STORAGE_KEY } from "../../../kit/theme/mode";
import type { ContextEntry } from "../../../kit/workspace/protocol";
import type { WorkspaceDaemon } from "../../../kit/workspace/server";
import { tempRoot } from "../../../kit/workspace/testing";
import { frameSurface, kitDaemon } from "../../backend/kit/server";
import { Frame, scriptoriumMenuActions } from "./Frame";
import { reseedPrefs, seedPrefs } from "./testPrefs";

const root = tempRoot("scriptorium-frame");
const set = join(root, "docs", "set");
const lone = join(root, "docs", "lone.md");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;

/** The panels laid out as a browser would, so the shell's columns are open and can collapse. */
let layout: LaidOut | null = null;

beforeAll(async () => {
  installDom();
  layout = laidOut(1400);
  process.env.SCRIPTORIUM_HOME = join(root, "home");
  // These tests read the raw editor: they start there (`./testPrefs.ts`).
  seedPrefs(join(root, "home"), { "doc:view": "raw" });
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
afterEach(() => reseedPrefs(join(root, "home"), { "doc:view": "raw" }));
// No test may let the frame send a create, import or drop that names no place.
afterEach(() => {
  const seen = placeless.splice(0);
  expect(seen).toEqual([]);
});
afterAll(async () => {
  layout?.undo();
  await daemon?.stop().catch(() => {});
  // Awaited: the next file's `installDom` must not find this DOM still leaving.
  await removeDom();
  if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
  else process.env.SCRIPTORIUM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** The ops that must name their place, by the field that names it. */
const PLACED = new Set(["doc.create", "folder.create", "bundle.create", "import"]);
/** What the frame sent the daemon that names no place: must stay empty. */
const placeless: unknown[] = [];
/** Every create and import the frame sent, in order, with the place it named. */
const placed: { op: string; dir?: unknown }[] = [];
const names = (dir: unknown) => typeof dir === "string" && dir.startsWith("/");

/** The client the frame is given, with every op and image it sends checked for a place. */
function watched(d: Daemon): Daemon {
  const check = (op: { op: string; dir?: unknown }) => {
    if (!PLACED.has(op.op)) return;
    placed.push({ op: op.op, dir: op.dir });
    if (!names(op.dir)) placeless.push(op);
  };
  return {
    ...d,
    send: (op) => {
      check(op as { op: string; dir?: unknown });
      return d.send(op);
    },
    request: (op, o) => {
      check(op as { op: string; dir?: unknown });
      return d.request(op, o);
    },
    importImage: (f, o) => {
      placed.push({ op: "image", dir: o.dir });
      if (!names(o.dir) && !o.doc && !o.bundle) placeless.push({ image: f.name, ...o });
      return d.importImage(f, o);
    },
  };
}

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
      <Frame daemon={watched(d)} />
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

describe("the flagged Scriptorium in the shell, on a real kit daemon", () => {
  test("it shows the context, the chat with its composer, Notes and Tasks, and the document pane", async () => {
    const m = await open();
    // An empty context: the sidebar's own empty state, offering to add.
    expect(document.querySelector('[data-pane="context"]')?.textContent).toContain("Add");
    expect(
      document.querySelector('[data-pane="chat"] [data-slot="composer-input"]'),
    ).not.toBeNull();
    expect(all('[role="tab"]').map((t) => t.textContent)).toEqual(["Chat", "Notes", "Tasks"]);
    // The pane's own empty state; nothing says a pane is still to come.
    expect(centre()).toContain("No document open");
    expect(centre()).not.toContain("next cycle");
    await click(withText('[role="tab"]', "Tasks"));
    expect(document.querySelector('input[aria-label="New task"]')).not.toBeNull();
    await click(withText('[role="tab"]', "Notes"));
    expect(document.querySelector('[data-slot="composer-input"]')).toBeNull();
    await m.unmount();
  });

  test("Notes offers its form, waiting for a passage selected in the document", async () => {
    const m = await open();
    await click(withText('[role="tab"]', "Notes"));
    const form = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="New note"]');
    expect(form).not.toBeNull();
    expect(form?.disabled).toBe(true);
    expect(document.querySelector('[data-pane="chat"] form')?.textContent).toContain(
      "No selection",
    );
    expect(document.querySelector('[data-pane="chat"]')?.textContent).not.toContain("cannot show");
    await m.unmount();
  });

  test("the theme is kept in the daemon's prefs, and a theme chosen elsewhere is applied", async () => {
    const m = await open();
    const before = document.documentElement.dataset.theme;
    const next = before === "light" ? "dark" : "light";
    await click(document.querySelector('[aria-label^="Switch to the"]'));
    await waitFor(() => client?.state?.prefs.theme === next, "the theme in the prefs");
    expect(document.documentElement.dataset.theme).toBe(next);
    // The browser copy the page's pre-paint script reads, under the key it reads.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(next);
    const page = readFileSync(join(import.meta.dir, "index.html"), "utf8");
    expect(page).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    // Another session (another port, another origin) chose the other one.
    await settle(() => {
      client?.send({ op: "prefs.set", key: "theme", value: before === "light" ? "light" : "dark" });
    });
    await waitFor(
      () => document.documentElement.dataset.theme === (before === "light" ? "light" : "dark"),
      "the prefs' theme applied",
    );
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
    // And taken out again by the list row's own Remove: nothing leaves the disk.
    await rightClick(listRow("set"));
    await waitFor(() => menuItem("Remove from context") !== null, "the menu");
    await click(menuItem("Remove from context"));
    await waitFor(() => entry(set) === undefined, "the set gone from the context");
    expect(existsSync(join(set, "index.md"))).toBe(true);
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

  test("opening a document from the tree shows it in the centre's document pane", async () => {
    const m = await open(set);
    await click(listRow("set"));
    await waitFor(() => treeRow("index.md") !== null, "the set's tree");
    await click(treeRow("index.md"));
    await waitFor(() => client?.state?.openDoc != null, "the daemon opened it");
    await waitFor(
      () => document.querySelector('[data-pane="centre"] .cm-editor') !== null,
      "the pane's editor",
    );
    expect(centre()).toContain("index.md");
    expect(centre()).toContain("Index");
    expect(centre()).not.toContain("next cycle");
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

const where = () => document.querySelector<HTMLElement>('[data-slot="location-dialog"]');
const places = () =>
  all('[data-slot="location-dialog"] [role="option"]').map((e) => (e.textContent ?? "").trim());
const chosen = () =>
  all('[data-slot="location-dialog"] [role="option"][aria-selected="true"]').map((e) =>
    (e.textContent ?? "").trim(),
  );
const place = (text: string) =>
  all('[data-slot="location-dialog"] [role="option"]').find(
    (e) => (e.textContent ?? "").trim() === text,
  ) ?? null;
const key = (el: Element | null, k: string) =>
  settle(() => {
    if (!el) throw new Error("no element for the key");
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
const search = () =>
  document.querySelector(
    '[data-slot="location-dialog"] input[aria-label="Search sets and folders"]',
  );
const byLabel = (l: string) => document.querySelector(`[aria-label="${l}"]`);
const backToList = async () => {
  const back = byLabel("Back to the context list");
  if (back) await click(back);
  await waitFor(() => byLabel("New document…") !== null, "the list");
};
const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
async function dropFiles(target: Element, files: File[]) {
  await settle(() => {
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
      value: {
        types: ["Files"],
        files,
        items: files.map(() => ({ webkitGetAsEntry: () => ({ isDirectory: false }) })),
        getData: () => "",
      },
    });
    target.dispatchEvent(ev);
  });
}

describe("where a new file goes (no default workspace)", () => {
  test("the list says a drop asks, and never that it lands somewhere unseen", async () => {
    const m = await open();
    const pane = document.querySelector('[data-pane="context"]')?.textContent ?? "";
    expect(pane).not.toContain("here to copy them in");
    expect(pane).toContain("Drop documents or images, then choose a set");
    await m.unmount();
  });

  test("with nothing selected New document asks; a folder made at a path is preselected, and the next is one Enter", async () => {
    const fresh = join(root, "made", "fresh");
    mkdirSync(join(root, "made"), { recursive: true });
    const m = await open();
    await click(byLabel("New document…"));
    await waitFor(() => where() !== null, "the location dialog");
    expect(where()?.textContent).toContain("Where should the new document go?");
    // The pointer to make-set, in Scriptorium's words.
    expect(where()?.textContent).toContain("Turn into a set");
    // Making room: a new folder at a path, the daemon's folder.add, a set.
    const box = document.querySelector<HTMLInputElement>(
      '[data-slot="location-dialog"] input[aria-label="New folder at a path"]',
    );
    await typeInto(box as HTMLInputElement, fresh);
    await key(box, "Enter");
    await waitFor(() => chosen().join() === "fresh", "the new set, preselected");
    expect(entry(fresh)?.membership).toBe("mirrored");
    const was = client?.done?.seq;
    await key(search(), "Enter");
    await waitFor(() => filesIn(fresh).includes("Untitled.md"), "the document in the new set");
    await waitFor(() => where() === null, "the dialog closed");
    // The new document opens, and the sidebar shows it in its set.
    await waitFor(
      () => client?.done?.seq !== was && byLabel("New document in this set") !== null,
      "the new document shown in its set",
    );
    // The last place is remembered: the next ask preselects it, and Enter is all it takes.
    await backToList();
    await click(byLabel("New folder…"));
    await waitFor(() => where() !== null, "the dialog again");
    expect(chosen()).toEqual(["fresh"]);
    await key(search(), "Enter");
    await waitFor(() => filesIn(fresh).includes("New folder"), "the folder in the new set");
    expect(placed.slice(-2)).toEqual([
      { op: "doc.create", dir: fresh },
      { op: "folder.create", dir: fresh },
    ]);
    // Gone from the context: nothing is preselected, and Enter does nothing.
    // (Taken out by the daemon directly: the list's Remove is held above.)
    await settle(() => {
      client?.send({ op: "context.remove", id: entry(fresh)?.id as string });
    });
    await waitFor(() => entry(fresh) === undefined, "the set gone");
    await waitFor(() => byLabel("New document…") !== null, "the list");
    await click(byLabel("New document…"));
    await waitFor(() => where() !== null, "the dialog");
    expect(places()).not.toContain("fresh");
    expect(chosen()).toEqual([]);
    const before = placed.length;
    await key(search(), "Enter");
    expect(where()).not.toBeNull();
    await key(search(), "Escape");
    await waitFor(() => where() === null, "backed out");
    await Bun.sleep(100);
    expect(placed.length).toBe(before);
    await m.unmount();
  });

  test("a drop on the list itself asks, and the files are copied into the set chosen", async () => {
    const m = await open(set);
    await waitFor(() => listRow("set") !== null, "the set's row");
    const list = document.querySelector('[data-pane="context"] ul[aria-label="Context"]')
      ?.parentElement as Element;
    await dropFiles(list, [
      new File(["# Dropped\n"], "dropped.md"),
      new File([GIF_1PX], "fox.gif", { type: "image/gif" }),
    ]);
    await waitFor(() => where() !== null, "the location dialog");
    expect(where()?.textContent).toContain("Where should these 2 files be copied?");
    await click(place("set"));
    await waitFor(() => existsSync(join(set, "dropped.md")), "the document copied in");
    await waitFor(() => filesIn(set).some((f) => f.startsWith("fox.")), "the image copied in");
    expect(placed.slice(-2).map((p) => p.dir)).toEqual([set, set]);
    await m.unmount();
  });

  test("a folder made at a path typed with . and .. is highlighted once it shows", async () => {
    mkdirSync(join(root, "made", "beta"), { recursive: true });
    const m = await open();
    await click(byLabel("New folder…"));
    await waitFor(() => where() !== null, "the location dialog");
    const box = document.querySelector<HTMLInputElement>(
      '[data-slot="location-dialog"] input[aria-label="New folder at a path"]',
    );
    await typeInto(box as HTMLInputElement, `${root}/made/./beta/../dotted`);
    await key(box, "Enter");
    await waitFor(() => chosen().join() === "dotted", "the new set, highlighted");
    expect(where()?.textContent).not.toContain("Making");
    await key(search(), "Escape");
    await waitFor(() => where() === null, "backed out");
    await m.unmount();
  });

  test("after a create, the list the human went back to stays when the next snapshot comes", async () => {
    const m = await open(set);
    if (!byLabel("New document in this set")) await click(listRow("set"));
    await waitFor(() => byLabel("New document in this set") !== null, "the set");
    const was = client?.done?.seq;
    await click(byLabel("New document in this set"));
    await waitFor(() => client?.done?.seq !== was, "the document made");
    // The shell opens what it is told was made: wait for that open to land
    // (the snapshot that carries it, and the pane drawing it) before going back,
    // or the open arriving after the click is a race this test is not about.
    const made = client?.done?.path;
    await waitFor(
      () =>
        client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.original === made &&
        document.querySelector('[data-pane="centre"] .cm-editor') !== null,
      "the new document open",
    );
    await settle();
    await backToList();
    await settle(() => {
      client?.send({ op: "say", text: "a snapshot after the create", withSelection: false });
    });
    await waitFor(
      () => client?.state?.chat.some((c) => c.text === "a snapshot after the create") ?? false,
      "the next snapshot",
    );
    await settle();
    expect(byLabel("Back to the context list")).toBeNull();
    expect(byLabel("New document…")).not.toBeNull();
    await m.unmount();
  });

  test("with a selection New document and New folder go beside or inside it, unasked", async () => {
    const m = await open(set);
    // Each create is let land before the next step: the daemon's `done`, and
    // for a document the shell's open of it (the editor mounts), which would
    // otherwise race the next right-click.
    let seen = client?.done?.seq;
    const landed = async (doc: boolean) => {
      await waitFor(() => client?.done != null && client.done.seq !== seen, "the create done");
      seen = client?.done?.seq;
      const made = client?.done?.path;
      if (doc)
        await waitFor(
          () =>
            client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.original === made &&
            document.querySelector('[data-pane="centre"] .cm-editor') !== null,
          "the new document open",
        );
      await settle();
    };
    // The set's own row in the list: inside the set.
    await rightClick(listRow("set"));
    await waitFor(() => menuItem("New folder") !== null, "the set's menu");
    await click(menuItem("New folder"));
    await waitFor(() => placed.at(-1)?.op === "folder.create", "the folder");
    expect(placed.at(-1)).toEqual({ op: "folder.create", dir: set });
    await landed(false);
    // Drilled in: beside a document, inside a folder, and the header's in this set.
    if (!treeRow("aside.md")) await click(listRow("set"));
    await waitFor(() => treeRow("aside.md") !== null, "the set's tree");
    await rightClick(treeRow("aside.md"));
    await waitFor(() => menuItem("New document beside it") !== null, "the document's menu");
    await click(menuItem("New document beside it"));
    await waitFor(() => placed.at(-1)?.op === "doc.create", "beside the document");
    expect(placed.at(-1)).toEqual({ op: "doc.create", dir: set });
    await landed(true);
    await waitFor(() => treeRow("part") !== null, "the folder row");
    await rightClick(treeRow("part"));
    await waitFor(() => menuItem("New document") !== null, "the folder's menu");
    await click(menuItem("New document"));
    await waitFor(() => placed.at(-1)?.dir === join(set, "part"), "inside the folder");
    await landed(true);
    await click(byLabel("New document in this set"));
    await waitFor(() => placed.at(-1)?.dir === set, "in the set");
    expect(where()).toBeNull();
    await waitFor(() => existsSync(join(set, "part", "Untitled.md")), "on disk");
    await m.unmount();
    // Longer than the default 5 s: the shell opens each new document it is told
    // was made (the editor mounts three times here), which under the full gate's
    // load took this past 5 s; alone it passes well inside it.
  }, 20_000);
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
      "scriptorium.new-doc-beside",
      "scriptorium.new-folder-beside",
      "scriptorium.hide",
    ]);
    // A folder makes inside itself with the kit's own items: nothing beside it here.
    expect(ids(acts({ kind: "group", path: "/s/part", entry: mirrored }))).toEqual([
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
