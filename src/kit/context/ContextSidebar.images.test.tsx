// Images in the sidebar (the kit-image-files item): an image row shows an
// image icon and opens like any row; a dropped image goes to the daemon as
// bytes, never as text; a taken name is put to the human (replace, which sends
// the old file to the Trash, or keep both); an SVG is refused with its reason.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from "bun:test";
import { SVG_REFUSED } from "../lib/docFormat.ts";
import {
  cleanup,
  installDom,
  mount,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../lib/testDom.ts";
import type { ContextEntry, StructureOp } from "../workspace/protocol";
import { ContextSidebar, type ContextSidebarProps } from "./ContextSidebar.tsx";
import { type ImageImport, linkRefusal } from "./daemonClient.ts";

test("a followed link to an image no set shows is said as an image, with the folder to add", () => {
  expect(
    linkRefusal({
      op: "link.target",
      target: "../outside/secret.png",
      state: "not-a-doc",
      path: "/r/outside/secret.png",
    }),
  ).toBe(
    "../outside/secret.png is an image that no set in this session shows. Add its folder, /r/outside, to open it here.",
  );
  // Anything else that is not a document is said as before.
  expect(
    linkRefusal({ op: "link.target", target: "a.zip", state: "not-a-doc", path: "/r/a.zip" }),
  ).toBe("a.zip is not a document the workspace opens: /r/a.zip.");
});

test("a followed link the daemon refused to open says the daemon's why, not 'no set shows it'", () => {
  const why = "world/images/escape.png leads outside world through a link: not opened";
  expect(
    linkRefusal({
      op: "link.target",
      target: "images/escape.png",
      state: "in-context",
      path: "/r/world/images/escape.png",
      refused: why,
    }),
  ).toBe(why);
});

import { PEEK_DELAY_MS } from "./EntryTree.tsx";

beforeAll(installDom);
afterEach(async () => {
  jest.useRealTimers();
  await cleanup();
});
afterAll(removeDom);

// The rest before a thumbnail is shown is crossed on a fake clock: a test
// installs the fakes once its tree is drawn (its `waitFor` polls with timers)
// and before the first pointer rests, and nothing polls while they are on.
const rest = (ms: number) =>
  settle(() => {
    jest.advanceTimersByTime(ms);
  });

const set: ContextEntry = {
  id: "c-set",
  label: "world",
  root: "/w/world",
  membership: "mirrored",
  nodes: [
    { kind: "doc", rel: "fox.md" },
    { kind: "image", rel: "fox.png" },
    { kind: "group", rel: "images", children: [{ kind: "image", rel: "images/arch.jpg" }] },
  ],
};

type Sent = { name: string; dir?: string; onTaken?: string; bytes: number };

function harness(answers: ImageImport[] = []) {
  const opened: Array<[string, string]> = [];
  const structure: StructureOp[] = [];
  const sent: Sent[] = [];
  const props: ContextSidebarProps = {
    entries: [set],
    activeDoc: null,
    userHome: "/w",
    onOpenDoc: (e, rel) => opened.push([e.id, rel]),
    onAddPath: () => {},
    onStructure: (op) => structure.push(op),
    onRemoveEntry: () => {},
    onReveal: () => {},
    onPick: () => {},
    listDir: async () => ({ entries: [] }),
    importImage: async (file, opts) => {
      sent.push({ name: file.name, ...opts, bytes: file.size });
      return answers.shift() ?? { ok: true, path: `${opts.dir ?? "/w"}/${file.name}` };
    },
  };
  return { props, opened, structure, sent };
}

const buttonWith = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ??
  null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
async function drop(target: Element, files: File[]) {
  const dt = {
    types: ["Files"],
    files,
    items: files.map(() => ({ webkitGetAsEntry: () => ({ isDirectory: false }) })),
    getData: () => "",
  };
  await settle(() => {
    const over = new window.Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: dt });
    target.dispatchEvent(over);
  });
  await settle(() => {
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    target.dispatchEvent(ev);
  });
}
/** A file whose text() would betray a read as text. */
function imageFile(name: string): File {
  const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name);
  f.text = () => {
    throw new Error(`${name} was read as text`);
  };
  return f;
}

async function drilled(h: ReturnType<typeof harness>) {
  const m = await mount(
    <div style={{ width: 300, height: 600, display: "flex" }}>
      <ContextSidebar {...h.props} />
    </div>,
  );
  await click(buttonWith("world"));
  await waitFor(() => !!document.querySelector('[role="tree"]'), "the tree");
  return m;
}

describe("a set's counts by kind", () => {
  test("the set row counts documents and images apart, with an icon each and the words on hover", async () => {
    const h = harness();
    await mount(
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar {...h.props} />
      </div>,
    );
    const counts = buttonWith("world")?.querySelector('[data-slot="set-counts"]');
    // One document and two images (one nested): never "1 document" alone.
    expect(counts?.querySelector(".sr-only")?.textContent).toBe("1 document, 2 images");
    expect(counts?.getAttribute("title")).toBe("1 document, 2 images");
    expect(counts?.querySelectorAll("svg")).toHaveLength(2);
    expect(counts?.textContent).toContain("1");
    expect(counts?.textContent).toContain("2");
  });

  test("a set of images only reads 0 documents and its images", async () => {
    const h = harness();
    h.props.entries = [{ ...set, nodes: [{ kind: "image", rel: "fox.png" }] }];
    await mount(
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar {...h.props} />
      </div>,
    );
    const counts = buttonWith("world")?.querySelector('[data-slot="set-counts"]');
    expect(counts?.querySelector(".sr-only")?.textContent).toBe("0 documents, 1 image");
  });
});

describe("images in the tree", () => {
  test("an image row shows an image icon, sorted among the documents, and opens on a click", async () => {
    const h = harness();
    await drilled(h);
    const row = buttonWith("fox.png") as HTMLElement;
    expect(row.querySelector('[data-format="image"]')).not.toBeNull();
    // A document row keeps its page icon.
    expect(buttonWith("fox.md")?.querySelector('[data-format="image"]')).toBeNull();
    const names = [...document.querySelectorAll('[role="treeitem"]')].map((r) => r.textContent);
    expect(names.indexOf("fox.md")).toBeLessThan(names.indexOf("fox.png"));
    await click(row);
    expect(h.opened).toEqual([["c-set", "fox.png"]]);
  });

  test("resting on an image row shows its thumbnail; leaving puts it away; a document has none", async () => {
    const h = harness();
    h.props.thumbFor = (path) => `/fs/thumb?w=256&path=${encodeURIComponent(path)}`;
    await drilled(h);
    jest.useFakeTimers();
    const hover = async (el: Element, type: string) =>
      settle(() => {
        el.dispatchEvent(new window.PointerEvent(type, { bubbles: false }));
      });
    const doc = buttonWith("fox.md") as HTMLElement;
    await hover(doc, "pointerenter");
    await rest(PEEK_DELAY_MS + 50);
    expect(document.querySelector('[data-slot="image-peek"]')).toBeNull();
    const row = buttonWith("fox.png") as HTMLElement;
    await hover(row, "pointerenter");
    // Nothing is asked for until the pointer has rested.
    expect(document.querySelector('[data-slot="image-peek"]')).toBeNull();
    await rest(PEEK_DELAY_MS - 50);
    expect(document.querySelector('[data-slot="image-peek"]')).toBeNull();
    await rest(100);
    const img = document.querySelector('[data-slot="image-peek"] img');
    expect(img?.getAttribute("src")).toBe("/fs/thumb?w=256&path=%2Fw%2Fworld%2Ffox.png");
    await hover(row, "pointerleave");
    expect(document.querySelector('[data-slot="image-peek"]')).toBeNull();
    // A thumbnail that cannot load shows no empty box.
    await hover(row, "pointerenter");
    await rest(PEEK_DELAY_MS + 50);
    await settle(() => {
      document
        .querySelector('[data-slot="image-peek"] img')
        ?.dispatchEvent(new window.Event("error"));
    });
    expect(document.querySelector('[data-slot="image-peek"]')).toBeNull();
  });

  test("an image is marked as the open row", async () => {
    const h = harness();
    h.props.activeDoc = { entryId: "c-set", rel: "fox.png" };
    await drilled(h);
    expect((buttonWith("fox.png") as HTMLElement).dataset.active).toBe("true");
  });
});

describe("an image dropped from outside", () => {
  test("goes to the daemon as bytes, into the folder it was dropped on, never as text", async () => {
    const h = harness();
    await drilled(h);
    await drop(document.querySelector('[role="tree"]') as Element, [imageFile("moth.webp")]);
    await waitFor(() => h.sent.length > 0, "the upload");
    expect(h.sent).toEqual([{ name: "moth.webp", dir: "/w/world", onTaken: "ask", bytes: 7 }]);
    expect(h.structure).toEqual([]);
  });

  test("a HEIC photo is sent as an image too, for the daemon to convert", async () => {
    const h = harness();
    await drilled(h);
    await drop(document.querySelector('[role="tree"]') as Element, [imageFile("IMG_0001.HEIC")]);
    await waitFor(() => h.sent.length > 0, "the upload");
    expect(h.sent[0]?.name).toBe("IMG_0001.HEIC");
  });

  test("a taken name asks; Replace sends it again to replace the old one", async () => {
    const h = harness([{ ok: false, error: "fox.png is already in world", taken: true }]);
    await drilled(h);
    await drop(document.querySelector('[role="tree"]') as Element, [imageFile("fox.png")]);
    await waitFor(() => !!document.querySelector('[data-slot="confirm-dialog"]'), "the question");
    const dialog = document.querySelector('[data-slot="confirm-dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Replace fox.png?");
    expect(dialog.textContent).toContain("the old file goes to the Trash");
    await click(buttonWith("Replace"));
    await waitFor(() => h.sent.length === 2, "the replace");
    expect(h.sent.map((s) => s.onTaken)).toEqual(["ask", "replace"]);
  });

  test("a name the import settings changed asks about the name that is taken, saying both", async () => {
    const h = harness([
      { ok: false, error: "fox.webp is already in world", taken: true, takenName: "fox.webp" },
    ]);
    await drilled(h);
    await drop(document.querySelector('[role="tree"]') as Element, [imageFile("fox.png")]);
    await waitFor(() => !!document.querySelector('[data-slot="confirm-dialog"]'), "the question");
    const dialog = document.querySelector('[data-slot="confirm-dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Replace fox.webp?");
    expect(dialog.textContent).toContain(
      "fox.png would be written as fox.webp, and fox.webp is already in this folder",
    );
  });

  test("an image the settings left as it came says so on screen", async () => {
    const h = harness([
      {
        ok: true,
        path: "/w/world/spin.gif",
        kept: true,
        note: "kept as it came: it is animated, and only its first frame would be kept",
      },
    ]);
    await drilled(h);
    await drop(document.querySelector('[role="tree"]') as Element, [imageFile("spin.gif")]);
    await waitFor(
      () => (document.querySelector('[role="alert"]')?.textContent ?? "").includes("animated"),
      "the note",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "spin.gif was kept as it came: it is animated",
    );
  });

  test("Keep both sends it again under a free name, and nothing is replaced", async () => {
    const h = harness([{ ok: false, error: "fox.png is already in world", taken: true }]);
    await drilled(h);
    await drop(document.querySelector('[role="tree"]') as Element, [imageFile("fox.png")]);
    await waitFor(() => !!document.querySelector('[data-slot="confirm-dialog"]'), "the question");
    await click(buttonWith("Keep both"));
    await waitFor(() => h.sent.length === 2, "the second send");
    expect(h.sent.map((s) => s.onTaken)).toEqual(["ask", "keep-both"]);
  });

  test("a refusal is said; an SVG is refused here with its reason, and not sent", async () => {
    const h = harness([{ ok: false, error: "it is larger than 20 MB" }]);
    await drilled(h);
    await drop(document.querySelector('[role="tree"]') as Element, [imageFile("huge.png")]);
    await waitFor(
      () => (document.querySelector('[role="alert"]')?.textContent ?? "").includes("20 MB"),
      "the refusal",
    );
    await drop(document.querySelector('[role="tree"]') as Element, [imageFile("logo.svg")]);
    await waitFor(
      () => (document.querySelector('[role="alert"]')?.textContent ?? "").includes("script"),
      "the SVG's reason",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(SVG_REFUSED);
    expect(h.sent.map((s) => s.name)).toEqual(["huge.png"]);
  });
});

// ── a loose image on the context list (the kit-image-loose item) ──────────

const loose: ContextEntry = {
  id: "c-loose",
  label: "map.png",
  root: "/w/ws",
  membership: "listed",
  nodes: [{ kind: "image", rel: "map.png" }],
};

async function onList(h: ReturnType<typeof harness>) {
  h.props.entries = [set, loose];
  return mount(
    <div style={{ width: 300, height: 600, display: "flex" }}>
      <ContextSidebar {...h.props} />
    </div>,
  );
}
const rightClick = async (el: Element | null) => {
  if (!el) throw new Error("nothing to right-click");
  await settle(() => {
    el.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 9 }),
    );
  });
};
const menuItem = (text: string) =>
  [...document.querySelectorAll('[role^="menuitem"]')].find((e) =>
    (e.textContent ?? "").includes(text),
  ) ?? null;
const confirmDialog = () => document.querySelector('[data-slot="confirm-dialog"]');

describe("an image dropped on the context list", () => {
  test("goes to the daemon with no folder, so it lands in the workspace as its own entry", async () => {
    const h = harness();
    await onList(h);
    await drop(document.querySelector('[aria-label="Context"]') as Element, [imageFile("map.png")]);
    await waitFor(() => h.sent.length > 0, "the upload");
    expect(h.sent).toEqual([{ name: "map.png", onTaken: "ask", bytes: 7 }]);
    expect(h.structure).toEqual([]);
  });

  test("a taken name in the workspace asks the same question, and Keep both sends no folder either", async () => {
    const h = harness([{ ok: false, error: "map.png is already in workspace", taken: true }]);
    await onList(h);
    await drop(document.querySelector('[aria-label="Context"]') as Element, [imageFile("map.png")]);
    await waitFor(() => confirmDialog() !== null, "the question");
    expect(confirmDialog()?.textContent).toContain("Replace map.png?");
    await click(buttonWith("Keep both"));
    await waitFor(() => h.sent.length === 2, "the second send");
    expect(h.sent.map((s) => [s.dir, s.onTaken])).toEqual([
      [undefined, "ask"],
      [undefined, "keep-both"],
    ]);
  });
});

describe("a loose image's row on the list", () => {
  test("shows as the image itself, with an image icon, and opens on a click", async () => {
    const h = harness();
    await onList(h);
    const row = buttonWith("map.png") as HTMLElement;
    expect(row.querySelector('[data-format="image"]')).not.toBeNull();
    // Not a set: no document count.
    expect(row.textContent).not.toContain("document");
    await click(row);
    expect(h.opened).toEqual([["c-loose", "map.png"]]);
  });

  test("is marked open while it is in the viewer", async () => {
    const h = harness();
    h.props.activeDoc = { entryId: "c-loose", rel: "map.png" };
    await onList(h);
    expect((buttonWith("map.png") as HTMLElement).className).toContain("bg-selected");
  });

  test("its menu opens it, renames it, offers Delete and Remove from context", async () => {
    const h = harness();
    const removed: string[] = [];
    const trashed: string[] = [];
    h.props.onRemoveEntry = (id) => removed.push(id);
    h.props.trashPreview = async (path) => ({
      path,
      shown: "map.png",
      dir: false,
      files: 1,
      folders: 0,
      docs: [],
    });
    h.props.onTrash = (path) => trashed.push(path);
    await onList(h);
    await rightClick(buttonWith("map.png"));
    await waitFor(() => menuItem("Open") !== null, "the menu");
    expect(menuItem("Open set")).toBeNull();
    expect(menuItem("Rename")).not.toBeNull();
    expect(menuItem("Move to Trash")).not.toBeNull();
    await click(menuItem("Remove from context"));
    expect(removed).toEqual(["c-loose"]);
    await rightClick(buttonWith("map.png"));
    await waitFor(() => menuItem("Move to Trash") !== null, "the menu again");
    await click(menuItem("Move to Trash"));
    await waitFor(() => confirmDialog() !== null, "the dialog");
    const inDialog = [...(confirmDialog()?.querySelectorAll("button") ?? [])].find((b) =>
      (b.textContent ?? "").includes("Move to Trash"),
    );
    await click(inDialog ?? null);
    expect(trashed).toEqual(["/w/ws/map.png"]);
  });

  test("F2 renames the file in place", async () => {
    const h = harness();
    await onList(h);
    const row = buttonWith("map.png") as HTMLElement;
    await settle(() => {
      row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });
    const box = document.querySelector('input[aria-label="Rename map.png"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    await typeInto(box, "chart.png");
    await settle(() => {
      box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.structure).toEqual([{ op: "rename", path: "/w/ws/map.png", name: "chart.png" }]);
  });

  test("resting on it shows its thumbnail", async () => {
    const h = harness();
    h.props.thumbFor = (path) => `/fs/thumb?w=256&path=${encodeURIComponent(path)}`;
    await onList(h);
    jest.useFakeTimers();
    const row = buttonWith("map.png") as HTMLElement;
    await settle(() => {
      row.dispatchEvent(new window.PointerEvent("pointerenter", { bubbles: false }));
    });
    await rest(PEEK_DELAY_MS + 50);
    expect(document.querySelector('[data-slot="image-peek"] img')?.getAttribute("src")).toBe(
      "/fs/thumb?w=256&path=%2Fw%2Fws%2Fmap.png",
    );
  });
});
