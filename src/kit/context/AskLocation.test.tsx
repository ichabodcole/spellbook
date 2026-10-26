// The ask for a place, for an app with no workspace: the sidebar's `askLocation`
// slot, and the kit's answer to it (`useAskLocation`), driven from fixtures.
// What it must hold: New document, New folder and a drop on the list itself ask,
// and every op sent names the place chosen; backing out sends nothing; the
// place chosen last is preselected, and nothing is when it has left the
// context; "new folder at a path" makes room and highlights it. Without the slot
// the sidebar is as it was (ContextSidebar.test.tsx holds that).

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import { type BundleType, registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
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
import {
  type LocationAsk,
  locationTargets,
  type PickPaths,
  placePath,
  useAskLocation,
} from "./AskLocation.tsx";
import { ContextSidebar, type ContextSidebarProps } from "./ContextSidebar.tsx";
import type { ImageImportOptions } from "./daemonClient.ts";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

const lone: ContextEntry = {
  id: "c-lone",
  label: "memo.md",
  root: "/h/notes",
  membership: "listed",
  nodes: [{ kind: "doc", rel: "memo.md" }],
};
const drafts: ContextEntry = {
  id: "c-drafts",
  label: "drafts",
  root: "/h/drafts",
  membership: "mirrored",
  nodes: [
    { kind: "doc", rel: "a.md" },
    { kind: "group", rel: "part", children: [{ kind: "doc", rel: "part/b.md" }] },
  ],
};
const world: ContextEntry = {
  id: "c-world",
  label: "world",
  root: "/h/world",
  membership: "mirrored",
  nodes: [],
};

const SHELF: BundleType = {
  extension: ".shelfbundle",
  type: "shelf",
  main: "shelf.json",
  format: "json",
  label: "shelf",
  mainTemplate: "{}\n",
  expand: { members: ["docs"] },
};
const R = "lighthouse.shelfbundle";
/** A set holding an expandable bundle, whose member folder takes documents. */
const shelved: ContextEntry = {
  ...world,
  nodes: [
    {
      kind: "bundle",
      rel: R,
      type: "shelf",
      main: "shelf.json",
      title: "The lighthouse",
      contents: [{ kind: "group", rel: `${R}/docs`, children: [] }],
    },
  ],
};

type Seen = {
  structure: StructureOp[];
  images: ImageImportOptions[];
  asks: LocationAsk[];
  added: string[];
};

/**
 * The sidebar with no workspace, its slot filled by `useAskLocation`, over a
 * context the test can change (`setEntries`), as a daemon's snapshot would.
 */
function harness(
  initial: ContextEntry[],
  over: Partial<ContextSidebarProps> = {},
  hook: { pick?: PickPaths; addPlace?: (path: string) => Promise<unknown> } = {},
) {
  const seen: Seen = { structure: [], images: [], asks: [], added: [] };
  let setEntries: (e: ContextEntry[]) => void = () => {};
  let refuseAdd: string | null = null;
  let replyPath: string | null = null;
  function Host() {
    const [entries, set] = useState(initial);
    setEntries = set;
    const ask = useAskLocation({
      entries,
      userHome: "/h",
      listDir: async () => ({ entries: [] }),
      addFolder: async (path) => {
        seen.added.push(path);
        if (refuseAdd) throw new Error(refuseAdd);
        return replyPath ? { op: "structure.done", of: "folder.add", path: replyPath } : undefined;
      },
      hint: "Turn a document into a set to make room beside it.",
      ...hook,
    });
    return (
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar
          entries={entries}
          activeDoc={null}
          userHome="/h"
          onOpenDoc={() => {}}
          onAddPath={() => {}}
          onStructure={(op) => seen.structure.push(op)}
          onRemoveEntry={() => {}}
          onReveal={() => {}}
          onPick={() => {}}
          listDir={async () => ({ entries: [] })}
          importImage={async (_f, opts) => {
            seen.images.push(opts);
            return { ok: true, path: `${opts.dir}/x.png` };
          }}
          askLocation={(a) => {
            seen.asks.push(a);
            return ask.askLocation(a);
          }}
          {...over}
        />
        {ask.dialog}
      </div>
    );
  }
  return {
    seen,
    mountIt: () => mount(<Host />),
    setEntries: (e: ContextEntry[]) => settle(() => setEntries(e)),
    reply: (path: string | null) => {
      replyPath = path;
    },
    refuse: (why: string | null) => {
      refuseAdd = why;
    },
  };
}

const byLabel = (l: string) => document.querySelector(`[aria-label="${l}"]`);
const dialogEl = () => document.querySelector<HTMLElement>('[data-slot="location-dialog"]');
const places = () =>
  [...document.querySelectorAll('[data-slot="location-dialog"] [role="option"]')].map((e) =>
    (e.textContent ?? "").trim(),
  );
const chosen = () =>
  [
    ...document.querySelectorAll(
      '[data-slot="location-dialog"] [role="option"][aria-selected="true"]',
    ),
  ].map((e) => (e.textContent ?? "").trim());
const place = (text: string) =>
  [...document.querySelectorAll('[data-slot="location-dialog"] [role="option"]')].find(
    (e) => (e.textContent ?? "").trim() === text,
  ) ?? null;
const search = () =>
  document.querySelector<HTMLInputElement>('[data-slot="location-dialog"] input[role="combobox"]');
const pathBox = () =>
  document.querySelector<HTMLInputElement>(
    '[data-slot="location-dialog"] input[aria-label="New folder at a path"]',
  );
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const key = (el: Element | null, k: string) =>
  settle(() => {
    if (!el) throw new Error("no element for the key");
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
const menuItem = (text: string) =>
  [...document.querySelectorAll('[role^="menuitem"]')].find((e) =>
    (e.textContent ?? "").includes(text),
  ) ?? null;
const listArea = () => {
  const ul = document.querySelector('ul[aria-label="Context"]');
  return (ul?.parentElement ?? document.querySelector('[data-slot="empty"]')?.parentElement) as
    | Element
    | undefined;
};
const file = (name: string, text: string) => ({ file: new File([text], name), isDirectory: false });
function transfer(files: ReturnType<typeof file>[]) {
  return {
    types: ["Files"],
    files: files.map((f) => f.file),
    items: files.map((f) => ({ webkitGetAsEntry: () => ({ isDirectory: f.isDirectory }) })),
    getData: () => "",
  };
}
async function drop(target: Element, dt: object) {
  await settle(() => {
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    target.dispatchEvent(ev);
  });
}

const dialogButton = (text: string) =>
  [...document.querySelectorAll('[data-slot="location-dialog"] button')].find((b) =>
    (b.textContent ?? "").includes(text),
  ) ?? null;
/** A picker that answers with what the test says, and records each ask. */
function picker(answer: () => string[] | Error) {
  const asked: string[] = [];
  const pick: PickPaths = async (want) => {
    asked.push(want);
    const a = answer();
    if (a instanceof Error) throw a;
    return a;
  };
  return { asked, pick };
}

describe("locationTargets", () => {
  test("every set and the folders inside it; a document listed on its own is no place", () => {
    expect(locationTargets([lone, drafts, world]).map((t) => `${t.kind}:${t.label}`)).toEqual([
      "set:drafts",
      "folder:drafts/part",
      "set:world",
    ]);
  });

  test("a new bundle is never offered a place inside another bundle", () => {
    registerBundleType(SHELF);
    try {
      expect(locationTargets([shelved], "document").map((t) => t.label)).toEqual([
        "world",
        "world/The lighthouse/docs",
      ]);
      expect(locationTargets([shelved], "bundle").map((t) => t.label)).toEqual(["world"]);
    } finally {
      unregisterBundleType(SHELF.extension);
    }
  });
});

describe("with nothing selected, the list asks where", () => {
  test("the list says a drop asks, and never promises it lands somewhere unseen", async () => {
    const h = harness([]);
    const m = await h.mountIt();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("drop documents or images here to copy them in");
    expect(text).not.toContain("here to copy them in");
    expect(text).toContain("copied into a set you choose");
    await h.setEntries([drafts]);
    expect(document.body.textContent).toContain("Drop files, then choose where they go");
    await m.unmount();
  });

  test("New document asks, and makes it where the human chose; backing out sends nothing", async () => {
    const h = harness([lone, drafts, world]);
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(dialogEl()?.textContent).toContain("Where should the new document go?");
    // A modal: the page behind it is inert while it is open (`inertOutside`).
    const holderOf = (el: Element) => {
      let at: Element | null = el;
      while (at && at.parentElement !== document.body) at = at.parentElement;
      return at as HTMLElement;
    };
    const behind = [...document.body.children].filter(
      (c) => c !== holderOf(dialogEl() as HTMLElement),
    ) as HTMLElement[];
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every((c) => c.inert)).toBe(true);
    expect(places()).toEqual(["drafts", "drafts/part", "world"]);
    // The first time, nothing is chosen for them: Enter does nothing.
    expect(chosen()).toEqual([]);
    await key(search(), "Enter");
    expect(dialogEl()).not.toBeNull();
    await click(place("drafts/part"));
    await waitFor(() => dialogEl() === null, "the dialog closed");
    expect(h.seen.structure).toEqual([{ op: "doc.create", dir: "/h/drafts/part" }]);
    // Escape backs out: nothing is sent.
    await click(byLabel("New folder…"));
    await waitFor(() => dialogEl() !== null, "the dialog again");
    expect(dialogEl()?.textContent).toContain("Where should the new folder go?");
    await key(search(), "Escape");
    await waitFor(() => dialogEl() === null, "the dialog closed");
    expect(h.seen.structure).toHaveLength(1);
    await m.unmount();
  });

  test("the place chosen last is preselected, so the next is one Enter; gone from the context, nothing is", async () => {
    const h = harness([drafts, world]);
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(place("world"));
    await waitFor(() => dialogEl() === null, "closed");
    await click(byLabel("New folder…"));
    await waitFor(() => dialogEl() !== null, "the dialog again");
    expect(chosen()).toEqual(["world"]);
    await key(search(), "Enter");
    await waitFor(() => dialogEl() === null, "closed by Enter");
    expect(h.seen.structure).toEqual([
      { op: "doc.create", dir: "/h/world" },
      { op: "folder.create", dir: "/h/world" },
    ]);
    // A search moves the highlight; clearing it highlights nothing.
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await typeInto(search() as HTMLInputElement, "part");
    expect(chosen()).toEqual(["drafts/part"]);
    await key(search(), "Escape");
    await waitFor(() => dialogEl() === null, "closed");
    // The set leaves the context: the next ask preselects nothing.
    await h.setEntries([drafts]);
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(places()).toEqual(["drafts", "drafts/part"]);
    expect(chosen()).toEqual([]);
    await key(search(), "Enter");
    expect(dialogEl()).not.toBeNull();
    await key(search(), "Escape");
    await waitFor(() => dialogEl() === null, "closed");
    expect(h.seen.structure).toHaveLength(2);
    await m.unmount();
  });

  test("the list's own menu offers the same asks", async () => {
    const h = harness([drafts]);
    const m = await h.mountIt();
    await settle(() => {
      (listArea() as Element).dispatchEvent(
        new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 9 }),
      );
    });
    await waitFor(() => menuItem("New document…") !== null, "the menu");
    expect(menuItem("New folder…")).not.toBeNull();
    await click(menuItem("New folder…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(place("drafts"));
    await waitFor(() => h.seen.structure.length === 1, "the create");
    expect(h.seen.structure).toEqual([{ op: "folder.create", dir: "/h/drafts" }]);
    await m.unmount();
  });

  test("a registered bundle type gets its own ask, offered no place inside a bundle", async () => {
    registerBundleType(SHELF);
    try {
      const h = harness([shelved]);
      const m = await h.mountIt();
      await click(byLabel("New shelf…"));
      await waitFor(() => dialogEl() !== null, "the dialog");
      expect(dialogEl()?.textContent).toContain("Where should the new shelf go?");
      expect(places()).toEqual(["world"]);
      await click(place("world"));
      await waitFor(() => h.seen.structure.length === 1, "the create");
      expect(h.seen.structure).toEqual([
        { op: "bundle.create", dir: "/h/world", extension: ".shelfbundle" },
      ]);
      await m.unmount();
    } finally {
      unregisterBundleType(SHELF.extension);
    }
  });
});

describe("a drop on the list itself asks where to copy it", () => {
  test("documents and images are copied into the place chosen, each op naming it", async () => {
    const h = harness([drafts, world]);
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(dialogEl()?.textContent).toContain("Where should scene.md be copied?");
    expect(h.seen.structure).toEqual([]);
    await click(place("world"));
    await waitFor(() => h.seen.structure.length === 1, "the import");
    expect(h.seen.structure).toEqual([
      { op: "import", name: "scene.md", text: "# Scene\n", dir: "/h/world" },
    ]);
    await drop(
      listArea() as Element,
      transfer([file("fox.png", "x"), file("one.md", "1"), file("cover.psd", "x")]),
    );
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(dialogEl()?.textContent).toContain("Where should these 2 files be copied?");
    expect(chosen()).toEqual(["world"]);
    await key(search(), "Enter");
    await waitFor(() => h.seen.images.length === 1 && h.seen.structure.length === 2, "both");
    expect(h.seen.structure[1]).toEqual({
      op: "import",
      name: "one.md",
      text: "1",
      dir: "/h/world",
    });
    expect(h.seen.images[0]?.dir).toBe("/h/world");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("cover.psd");
    await m.unmount();
  });

  test("backing out copies nothing; a drop with nothing to copy only says why, unasked", async () => {
    const h = harness([drafts]);
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await key(search(), "Escape");
    await waitFor(() => dialogEl() === null, "closed");
    await Bun.sleep(30);
    expect(h.seen.structure).toEqual([]);
    await drop(listArea() as Element, transfer([file("cover.psd", "x")]));
    await waitFor(() => document.querySelector('[role="alert"]') !== null, "the notice");
    expect(dialogEl()).toBeNull();
    expect(h.seen.asks).toHaveLength(1);
    await m.unmount();
  });

  test("a drop on a set's row needs no ask: it lands in that set", async () => {
    const h = harness([drafts]);
    const m = await h.mountIt();
    const row = [...document.querySelectorAll('ul[aria-label="Context"] button')].find((b) =>
      (b.textContent ?? "").includes("drafts"),
    ) as Element;
    await drop(row, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => h.seen.structure.length === 1, "the import");
    expect(h.seen.structure).toEqual([
      { op: "import", name: "scene.md", text: "# Scene\n", dir: "/h/drafts" },
    ]);
    expect(h.seen.asks).toEqual([]);
    await m.unmount();
  });

  test("with a workspace the slot is not asked: the workspace is where things go", async () => {
    const h = harness([drafts], { workspace: "/h/ws" });
    const m = await h.mountIt();
    expect(byLabel("New document…")).toBeNull();
    await drop(listArea() as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => h.seen.structure.length === 1, "the import");
    expect(h.seen.structure).toEqual([{ op: "import", name: "scene.md", text: "# Scene\n" }]);
    expect(h.seen.asks).toEqual([]);
    await m.unmount();
  });
});

describe("making room from the dialog", () => {
  test("with no set yet it says so; a new folder at a path is made and highlighted once it shows", async () => {
    const h = harness([]);
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(dialogEl()?.textContent).toContain("There is no set to put it in yet");
    expect(dialogEl()?.textContent).toContain("Turn a document into a set");
    await typeInto(pathBox() as HTMLInputElement, "~/fresh");
    await key(pathBox(), "Enter");
    expect(h.seen.added).toEqual(["~/fresh"]);
    expect(dialogEl()?.textContent).toContain("Making /h/fresh");
    // The daemon's snapshot brings the new set: highlighted, and Enter makes the document there.
    await h.setEntries([{ ...world, id: "c-fresh", label: "fresh", root: "/h/fresh" }]);
    expect(chosen()).toEqual(["fresh"]);
    // The focus is back in the search, so the next Enter chooses it, not another folder.
    expect(document.activeElement).toBe(search());
    await key(search(), "Enter");
    await waitFor(() => h.seen.structure.length === 1, "the create");
    expect(h.seen.structure).toEqual([{ op: "doc.create", dir: "/h/fresh" }]);
    await m.unmount();
  });

  test("a refused folder says why, in the dialog", async () => {
    const h = harness([drafts]);
    h.refuse("/nowhere/x: its parent folder does not exist");
    const m = await h.mountIt();
    await click(byLabel("New folder…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await typeInto(pathBox() as HTMLInputElement, "/nowhere/x");
    await key(pathBox(), "Enter");
    await waitFor(
      () => (dialogEl()?.textContent ?? "").includes("its parent folder does not exist"),
      "the refusal",
    );
    expect(dialogEl()?.textContent).not.toContain("Making");
    expect(h.seen.structure).toEqual([]);
    await m.unmount();
  });

  test("a path typed with ., .. or doubled slashes is found once made, under the name the context gives it", async () => {
    const h = harness([]);
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await typeInto(pathBox() as HTMLInputElement, "~/work/./beta/../alpha//fresh/");
    await key(pathBox(), "Enter");
    expect(h.seen.added).toEqual(["~/work/./beta/../alpha//fresh"]);
    expect(dialogEl()?.textContent).toContain("Making /h/work/alpha/fresh");
    await h.setEntries([{ ...world, id: "c-fresh", label: "fresh", root: "/h/work/alpha/fresh" }]);
    expect(chosen()).toEqual(["fresh"]);
    expect(dialogEl()?.textContent).not.toContain("Making");
    await m.unmount();
  });

  test("the path the maker answers with is looked for too", async () => {
    const h = harness([]);
    h.reply("/real/h/fresh");
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await typeInto(pathBox() as HTMLInputElement, "/h/link/fresh");
    await key(pathBox(), "Enter");
    await h.setEntries([{ ...world, id: "c-fresh", label: "fresh", root: "/real/h/fresh" }]);
    expect(chosen()).toEqual(["fresh"]);
    await m.unmount();
  });
});

describe("the OS's own folder dialog", () => {
  test("the folder chosen is highlighted, and Enter makes it there; the list and the path box stay", async () => {
    const p = picker(() => ["/h/drafts/part"]);
    const h = harness([drafts, world], {}, { pick: p.pick });
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(pathBox()).not.toBeNull();
    expect(places()).toEqual(["drafts", "drafts/part", "world"]);
    await click(dialogButton("Choose a folder"));
    await waitFor(() => chosen().length === 1, "the highlight");
    expect(p.asked).toEqual(["choose-folder"]);
    expect(chosen()).toEqual(["drafts/part"]);
    expect(document.activeElement).toBe(search());
    await key(search(), "Enter");
    await waitFor(() => h.seen.structure.length === 1, "the create");
    expect(h.seen.structure).toEqual([{ op: "doc.create", dir: "/h/drafts/part" }]);
    await m.unmount();
  });

  test("a dismissed dialog changes nothing: the search, the highlight and the list stay", async () => {
    const p = picker(() => []);
    const h = harness([drafts, world], {}, { pick: p.pick });
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await typeInto(search() as HTMLInputElement, "wor");
    expect(chosen()).toEqual(["world"]);
    const button = dialogButton("Choose a folder") as HTMLElement;
    button.focus();
    await click(button);
    await waitFor(() => p.asked.length === 1, "the ask");
    await settle(() => {});
    // The keyboard is back in the search, so typing goes on where it was.
    expect(document.activeElement).toBe(search());
    expect(search()?.value).toBe("wor");
    expect(chosen()).toEqual(["world"]);
    expect(dialogEl()).not.toBeNull();
    expect(h.seen.structure).toEqual([]);
    await m.unmount();
  });

  test("a folder outside every set is named with the act that adds it, then highlighted once it shows", async () => {
    const p = picker(() => ["/h/elsewhere"]);
    const placed: string[] = [];
    const h = harness(
      [drafts],
      {},
      {
        pick: p.pick,
        addPlace: async (path) => {
          placed.push(path);
        },
      },
    );
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(dialogButton("Choose a folder"));
    await waitFor(() => (dialogEl()?.textContent ?? "").includes("not in a set"), "the offer");
    expect(dialogEl()?.textContent).toContain("~/elsewhere is not in a set yet.");
    expect(h.seen.structure).toEqual([]);
    await click(dialogButton("Add it as a set"));
    expect(placed).toEqual(["/h/elsewhere"]);
    await h.setEntries([
      drafts,
      { ...world, id: "c-else", label: "elsewhere", root: "/h/elsewhere" },
    ]);
    expect(chosen()).toEqual(["elsewhere"]);
    await m.unmount();
  });

  test("a refused add says why in the dialog, and nothing is left waiting", async () => {
    const p = picker(() => ["/"]);
    const h = harness(
      [drafts],
      {},
      {
        pick: p.pick,
        addPlace: async () => {
          throw new Error("/ cannot be a set: it holds the whole disk");
        },
      },
    );
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(dialogButton("Choose a folder"));
    await waitFor(() => dialogButton("Add it as a set") !== null, "the offer");
    await click(dialogButton("Add it as a set"));
    await waitFor(() => (dialogEl()?.textContent ?? "").includes("cannot be a set"), "the refusal");
    expect(dialogEl()?.textContent).not.toContain("Adding");
    await m.unmount();
  });

  test("a refused dialog says why, in the dialog", async () => {
    const p = picker(() => new Error("a file picker is already open"));
    const h = harness([drafts], {}, { pick: p.pick });
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(dialogButton("Choose a folder"));
    await waitFor(() => (dialogEl()?.textContent ?? "").includes("already open"), "the refusal");
    await m.unmount();
  });

  test("where the system has no picker, there is no button", async () => {
    const h = harness([drafts]);
    const m = await h.mountIt();
    await click(byLabel("New document…"));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(dialogButton("Choose a folder")).toBeNull();
    await m.unmount();
  });
});

describe("a drop can add the original file where it lives", () => {
  /** The sidebar's own acts on a path, recorded. */
  function acts() {
    const added: string[] = [];
    const selected: string[][] = [];
    return {
      added,
      selected,
      over: {
        onAddPath: (p: string) => added.push(p),
        onSelect: (rows: readonly string[]) => selected.push([...rows]),
      },
    };
  }

  test("the act opens the file dialog; the file chosen is added where it lives, with no copy", async () => {
    const p = picker(() => ["/h/Downloads/shot.png"]);
    const a = acts();
    const h = harness([drafts, world], a.over, { pick: p.pick });
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("shot.png", "bytes")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(dialogButton("Add the original file"));
    await waitFor(() => dialogEl() === null, "closed");
    expect(p.asked).toEqual(["choose-file"]);
    expect(a.added).toEqual(["/h/Downloads/shot.png"]);
    // Nothing was copied anywhere.
    await Bun.sleep(20);
    expect(h.seen.images).toEqual([]);
    expect(h.seen.structure).toEqual([]);
    await m.unmount();
  });

  test("a file a set already shows is selected, not listed a second time", async () => {
    const p = picker(() => ["/h/drafts/a.md"]);
    const a = acts();
    const h = harness([drafts], a.over, { pick: p.pick });
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("a.md", "# A\n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(dialogButton("Add the original file"));
    await waitFor(() => dialogEl() === null, "closed");
    expect(a.added).toEqual([]);
    expect(a.selected).toEqual([["/h/drafts/a.md"]]);
    expect(h.seen.structure).toEqual([]);
    await m.unmount();
  });

  test("a dismissed file dialog leaves the ask open, and copying into a place still works", async () => {
    const p = picker(() => []);
    const a = acts();
    const h = harness([drafts, world], a.over, { pick: p.pick });
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(dialogButton("Add the original file")?.textContent).toContain("Add the original file…");
    await click(dialogButton("Add the original file"));
    await waitFor(() => p.asked.length === 1, "the ask");
    await settle(() => {});
    expect(dialogEl()).not.toBeNull();
    expect(a.added).toEqual([]);
    await click(place("world"));
    await waitFor(() => h.seen.structure.length === 1, "the import");
    expect(h.seen.structure).toEqual([
      { op: "import", name: "scene.md", text: "# Scene\n", dir: "/h/world" },
    ]);
    await m.unmount();
  });

  test("where the system has no picker, the act is hidden and the copy is offered alone", async () => {
    const h = harness([drafts]);
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(dialogButton("Add the original")).toBeNull();
    expect(places()).toEqual(["drafts", "drafts/part"]);
    await m.unmount();
  });

  test("several files: the act says files", async () => {
    const p = picker(() => []);
    const h = harness([drafts], {}, { pick: p.pick });
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("a.md", "1"), file("b.png", "2")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    expect(dialogButton("Add the original")?.textContent).toContain("Add the original files…");
    await m.unmount();
  });
});

describe("a copy into a place that already holds that name", () => {
  const confirmEl = () => document.querySelector<HTMLElement>('[data-slot="confirm-dialog"]');
  const confirmButton = (text: string) =>
    [...document.querySelectorAll('[data-slot="confirm-dialog"] button')].find(
      (b) => (b.textContent ?? "").trim() === text,
    ) ?? null;
  /** `fileAt` over a pretend disk: path to the text there. */
  function disk(files: Record<string, string>) {
    const asked: string[] = [];
    const fileAt = async (dir: string, f: File) => {
      const path = `${dir}/${f.name}`;
      asked.push(path);
      const there = files[path];
      if (there === undefined) return { exists: false, same: false };
      return { exists: true, same: there === (await f.text()) };
    };
    return { asked, fileAt };
  }
  function recorded() {
    const added: string[] = [];
    const selected: string[][] = [];
    return {
      added,
      selected,
      onAddPath: (p: string) => added.push(p),
      onSelect: (rows: readonly string[]) => selected.push([...rows]),
    };
  }

  test("the same file there is offered instead of a second copy", async () => {
    const d = disk({ "/h/world/scene.md": "# Scene\n" });
    const r = recorded();
    const h = harness([drafts, world], {
      fileAt: d.fileAt,
      onAddPath: r.onAddPath,
      onSelect: r.onSelect,
    });
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(place("world"));
    await waitFor(() => confirmEl() !== null, "the offer");
    expect(confirmEl()?.textContent).toContain("scene.md is already in ~/world");
    await click(confirmButton("Add the one there"));
    await waitFor(() => confirmEl() === null, "answered");
    await Bun.sleep(20);
    expect(h.seen.structure).toEqual([]);
    expect(r.added).toEqual(["/h/world/scene.md"]);
    await m.unmount();
  });

  test("backing out of the offer copies nothing", async () => {
    const d = disk({ "/h/world/fox.png": "x" });
    const h = harness([drafts, world], { fileAt: d.fileAt });
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("fox.png", "x")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(place("world"));
    await waitFor(() => confirmEl() !== null, "the offer");
    await click(confirmButton("Don't copy"));
    await waitFor(() => confirmEl() === null, "answered");
    await Bun.sleep(20);
    expect(h.seen.images).toEqual([]);
    await m.unmount();
  });

  test("a different document of that name is said before anything is written", async () => {
    const d = disk({ "/h/world/scene.md": "# Another scene\n" });
    const h = harness([drafts, world], { fileAt: d.fileAt });
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(place("world"));
    await waitFor(() => confirmEl() !== null, "the warning");
    expect(confirmEl()?.textContent).toContain("A different scene.md is in ~/world");
    expect(h.seen.structure).toEqual([]);
    await click(confirmButton("Don't copy"));
    await waitFor(() => confirmEl() === null, "answered");
    await Bun.sleep(20);
    expect(h.seen.structure).toEqual([]);
    // Said again, and this time copied under a new name (the daemon's free name).
    await drop(listArea() as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await key(search(), "Enter");
    await waitFor(() => confirmEl() !== null, "the warning");
    await click(confirmButton("Copy under a new name"));
    await waitFor(() => h.seen.structure.length === 1, "the import");
    expect(h.seen.structure).toEqual([
      { op: "import", name: "scene.md", text: "# Scene\n", dir: "/h/world" },
    ]);
    await m.unmount();
  });

  test("a different image goes on to the import's own ask; a free name is copied unasked", async () => {
    const d = disk({ "/h/world/fox.png": "other" });
    const h = harness([drafts, world], { fileAt: d.fileAt });
    const m = await h.mountIt();
    await drop(listArea() as Element, transfer([file("fox.png", "x"), file("new.md", "n")]));
    await waitFor(() => dialogEl() !== null, "the dialog");
    await click(place("world"));
    await waitFor(() => h.seen.images.length === 1 && h.seen.structure.length === 1, "both");
    expect(confirmEl()).toBeNull();
    expect(d.asked).toEqual(["/h/world/new.md", "/h/world/fox.png"]);
    expect(h.seen.images[0]).toMatchObject({ dir: "/h/world", onTaken: "ask" });
    await m.unmount();
  });

  test("a drop on a set's row asks the same", async () => {
    const d = disk({ "/h/drafts/scene.md": "# Scene\n" });
    const h = harness([drafts], { fileAt: d.fileAt });
    const m = await h.mountIt();
    const row = [...document.querySelectorAll('ul[aria-label="Context"] button')].find((b) =>
      (b.textContent ?? "").includes("drafts"),
    ) as Element;
    await drop(row, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => confirmEl() !== null, "the offer");
    expect(confirmEl()?.textContent).toContain("scene.md is already in ~/drafts");
    await m.unmount();
  });
});

describe("placePath", () => {
  test("expands ~/ and resolves ., .. and doubled slashes", () => {
    expect(placePath("~/a/./b//c/../d", "/h")).toBe("/h/a/b/d");
    expect(placePath("/x/y/..", null)).toBe("/x");
    expect(placePath("/", null)).toBe("/");
    expect(placePath("~/a", null)).toBe("~/a");
  });
});
