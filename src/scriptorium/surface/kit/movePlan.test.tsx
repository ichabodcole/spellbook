// The flagged Scriptorium's pre-move slot against a REAL kit daemon
// (`kitDaemon`, in this process, under a scratch SCRIPTORIUM_HOME), with the
// kit's ContextSidebar mounted in happy-dom: a menu move and a drag move each
// show the daemon's plan, Cancel leaves the disk and the tree as they were, and
// Move moves. The adapter's own answers (a refusal, a failure, nothing to ask)
// are pinned below against a stand-in `request`.

import "../../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { useMemo } from "react";
import { ContextSidebar } from "../../../kit/context/ContextSidebar";
import { type Daemon, DaemonError } from "../../../kit/context/daemonClient";
import { encodeRowDrag, ROW_DRAG_MIME } from "../../../kit/context/rowDrag";
import { useDaemon } from "../../../kit/context/useDaemon";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../../../kit/lib/testDom";
import type { ContextEntry, StructureOp } from "../../../kit/workspace/protocol";
import type { WorkspaceDaemon } from "../../../kit/workspace/server";
import { tempRoot } from "../../../kit/workspace/testing";
import { kitDaemon } from "../../backend/kit/server";
import {
  movePrompt,
  type ScriptoriumMovePlan,
  scriptoriumBeforeMove,
  scriptoriumUncheckedMoveNote,
} from "./movePlan";

const root = tempRoot("scriptorium-premove");
const set = join(root, "docs", "set");
/** A second set: the list's row for it is where a dragged row is dropped. */
const other = join(root, "docs", "other");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;

beforeAll(async () => {
  installDom();
  process.env.SCRIPTORIUM_HOME = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(set, "part"), { recursive: true });
  mkdirSync(join(set, "lore"), { recursive: true });
  writeFileSync(join(set, "index.md"), "# Index\n\n[C](./part/c.md) and [D](./d.md)\n");
  writeFileSync(join(set, "part", "c.md"), "# C\n");
  writeFileSync(join(set, "lore", "keep.md"), "# Keep\n");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "o.md"), "# O\n");
  writeFileSync(join(set, "d.md"), "# D\n");
  writeFileSync(join(set, "plain.md"), "# Plain\n");
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
  // Awaited: the next file's `installDom` must not find this DOM still leaving.
  await removeDom();
  if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
  else process.env.SCRIPTORIUM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** The thin part of the kit page this item needs: the sidebar on a live daemon, the slot filled. */
function Frame({ url }: { url: string }) {
  const d = useDaemon({
    url,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  const beforeMove = useMemo(() => scriptoriumBeforeMove(d, { userHome: root }), [d.request]);
  if (!d.state) return <p>waiting</p>;
  return (
    <div style={{ width: 300, height: 600, display: "flex" }}>
      <ContextSidebar
        entries={d.state.context}
        activeDoc={null}
        userHome={root}
        workspace={d.state.workspace ?? null}
        onOpenDoc={() => {}}
        onAddPath={() => {}}
        onStructure={(op) => d.send(op)}
        onRemoveEntry={() => {}}
        onReveal={() => {}}
        onPick={() => {}}
        listDir={d.listDir}
        beforeMove={beforeMove}
      />
    </div>
  );
}

/** Every file under the set, with its bytes: what "the disk as it was" is held to. */
function disk(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(join(root, "docs"));
  return out;
}
/** The tree the daemon shows, as the client last saw it. */
const tree = () => JSON.stringify(client?.state?.context ?? null);

const buttonWith = (text: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ?? null;
const treeRow = (name: string) =>
  [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
    (e.textContent ?? "").trim().startsWith(name),
  ) ?? null;
const menuItem = (text: string) =>
  [...document.querySelectorAll('[role^="menuitem"]')].find((e) =>
    (e.textContent ?? "").includes(text),
  ) ?? null;
const option = (text: string) =>
  [...document.querySelectorAll('[data-slot="move-to-dialog"] [role="option"]')].find(
    (e) => (e.textContent ?? "").trim() === text,
  ) ?? null;
const dialog = () => document.querySelector<HTMLElement>('[data-slot="confirm-dialog"]');
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
async function dropRow(target: Element, entry: string, path: string) {
  const data = encodeRowDrag([{ entry, path, kind: "document" }]);
  const dt = {
    types: [ROW_DRAG_MIME],
    files: [],
    items: [],
    getData: (t: string) => (t === ROW_DRAG_MIME ? data : ""),
  };
  for (const type of ["dragover", "drop"])
    await settle(() => {
      const ev = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      target.dispatchEvent(ev);
    });
}

/** The frame on the daemon, both sets in its context; `drill` opens the first set's tree. */
async function open(drill: boolean) {
  const m = await mount(<Frame url={`${daemon.url}/ws`} />);
  await waitFor(() => client?.connection === "open" && client.state !== null, "the hello");
  for (const [i, path] of [set, other].entries())
    if ((client?.state?.context.length ?? 0) === i) {
      client?.send({ op: "context.add", path });
      await waitFor(() => (client?.state?.context.length ?? 0) === i + 1, `${path} in the context`);
    }
  if (drill) {
    await click(listRow("set"));
    await waitFor(() => treeRow("part") !== null, "the set's tree");
  }
  return m;
}
/** A row of the list, by the set's own name. */
const listRow = (name: string) =>
  [...document.querySelectorAll('[aria-label="Context"] button')].find((b) =>
    (b.textContent ?? "").trim().startsWith(name),
  ) ?? null;
const setId = () => client?.state?.context.find((e) => e.root === set)?.id ?? "";

describe("the move plan through the kit's pre-move slot, on a real kit daemon", () => {
  test("a menu move shows the links it breaks and their rewrites; Cancel leaves disk and tree as they were", async () => {
    const m = await open(true);
    if (!treeRow("c.md")) await click(treeRow("part"));
    await waitFor(() => treeRow("c.md") !== null, "c.md in the tree");
    const diskBefore = disk();
    const treeBefore = tree();
    await rightClick(treeRow("c.md"));
    await waitFor(() => menuItem("Move to") !== null, "the menu");
    await click(menuItem("Move to"));
    await waitFor(() => option("set/lore") !== null, "the Move to dialog");
    await click(option("set/lore"));
    await waitFor(() => dialog() !== null, "the plan");
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Move “c.md” into “lore”?");
    expect(text).toContain("1 document moved on disk");
    expect(text).toContain("It breaks 1 link in 1 document.");
    expect(text).toContain("./part/c.md → ./lore/c.md");
    // The move leaves them; the shell's relink bar offers the update after it.
    // The dialog is what names them, each with its rewrite.
    expect(text).toContain("after it, the context column offers to update them");
    expect(text).toContain("They are these, each with the rewrite");
    expect(text).not.toContain("the chat names");
    await click(buttonWith("Cancel", dialog() as ParentNode));
    await waitFor(() => dialog() === null, "the dialog to close");
    // Give a stray move every chance to land before looking.
    await Bun.sleep(150);
    await settle(() => {});
    expect(disk()).toEqual(diskBefore);
    expect(tree()).toBe(treeBefore);
    await m.unmount();
  });

  test("the same move, confirmed, moves on disk and in the tree", async () => {
    const m = await open(true);
    if (!treeRow("c.md")) await click(treeRow("part"));
    await waitFor(() => treeRow("c.md") !== null, "c.md in the tree");
    await rightClick(treeRow("c.md"));
    await waitFor(() => menuItem("Move to") !== null, "the menu");
    await click(menuItem("Move to"));
    await waitFor(() => option("set/lore") !== null, "the Move to dialog");
    await click(option("set/lore"));
    await waitFor(() => dialog() !== null, "the plan");
    await click(buttonWith("Move", dialog() as ParentNode));
    await waitFor(() => existsSync(join(set, "lore", "c.md")), "the move on disk");
    expect(existsSync(join(set, "part", "c.md"))).toBe(false);
    await waitFor(() => tree().includes("lore/c.md"), "the move in the tree");
    await m.unmount();
  });

  // A row dragged out of a set's tree carries the kit's row payload; dropped on
  // another set's row in the list, it moves into that set.
  test("a drag move shows the plan too; Cancel leaves disk and tree; one that breaks nothing moves at once", async () => {
    const m = await open(false);
    await waitFor(() => listRow("other") !== null, "the list");
    const diskBefore = disk();
    const treeBefore = tree();
    await dropRow(listRow("other") as Element, setId(), join(set, "d.md"));
    await waitFor(() => dialog() !== null, "the plan");
    expect(dialog()?.textContent).toContain("Move “d.md” into “other”?");
    expect(dialog()?.textContent).toContain("./d.md → ../other/d.md");
    await click(buttonWith("Cancel", dialog() as ParentNode));
    await waitFor(() => dialog() === null, "the dialog to close");
    await Bun.sleep(150);
    await settle(() => {});
    expect(disk()).toEqual(diskBefore);
    expect(tree()).toBe(treeBefore);
    // plain.md: nothing links to it, nothing in it links out, no repository.
    await dropRow(listRow("other") as Element, setId(), join(set, "plain.md"));
    await waitFor(() => existsSync(join(other, "plain.md")), "the move on disk");
    expect(dialog()).toBeNull();
    await m.unmount();
  });

  test("a move the daemon would refuse is not sent: its reason is the notice", async () => {
    writeFileSync(join(other, "d.md"), "# another D\n");
    const m = await open(false);
    await waitFor(() => listRow("other") !== null, "the list");
    const before = disk();
    await dropRow(listRow("other") as Element, setId(), join(set, "d.md"));
    await waitFor(
      () => (document.querySelector('[role="alert"]')?.textContent ?? "").length > 0,
      "the notice",
    );
    expect(dialog()).toBeNull();
    expect(disk()).toEqual(before);
    await m.unmount();
  });
});

describe("the adapter's answers", () => {
  const base: ScriptoriumMovePlan = {
    from: "/h/set/a.md",
    to: "/h/set/b/a.md",
    into: "/h/set/b",
    name: "a.md",
    folder: false,
    docs: 1,
    links: [],
    wiki: [],
    edges: [],
    references: 0,
    checked: 0,
    repo: null,
    leavesRepo: false,
  };

  test("nothing to ask for one document that breaks nothing; a folder, a repository or a break asks", () => {
    expect(movePrompt(base, "/h")).toBeNull();
    expect(movePrompt({ ...base, folder: true, docs: 3 }, "/h")?.title).toBe(
      "Move “a.md” into “b”?",
    );
    expect(movePrompt({ ...base, leavesRepo: true, repo: "set" }, "/h")?.warning).toBeTruthy();
    expect(
      movePrompt({ ...base, wiki: [{ path: "/h/set/x.md", line: 3, raw: "[[a]]" }] }, "/h"),
    ).not.toBeNull();
    expect(
      movePrompt(
        { ...base, edges: [{ kind: "frontmatter", source: "/h/set/x.md", raw: "./a.md" }] },
        "/h",
      ),
    ).not.toBeNull();
  });

  test("the dialog lists the wiki links and frontmatter references it breaks, each as written, and says they are never rewritten", async () => {
    const p = movePrompt(
      {
        ...base,
        wiki: [{ path: "/h/set/x.md", line: 3, raw: "[[a]]" }],
        edges: [{ kind: "frontmatter", source: "/h/set/y.md", key: "related", raw: "./a.md" }],
      },
      "/h",
    );
    const m = await mount(<div>{p?.message}</div>);
    const text = m.container.textContent ?? "";
    expect(text).toContain("1 wiki link would no longer find its page");
    expect(text).toContain("~/set/x.md:3 [[a]]");
    expect(text).toContain("1 frontmatter reference would point elsewhere");
    expect(text).toContain("~/set/y.md related: ./a.md");
    expect(text).not.toContain("It breaks no links.");
    await m.unmount();
  });

  test("a refusal is an answer; any other failure rejects, so the sidebar asks without a plan; the timeout is passed on", async () => {
    let asked: unknown = null;
    const refused = scriptoriumBeforeMove({
      request: async (op, o) => {
        asked = { op, o };
        throw new DaemonError("a.md is already in that folder");
      },
    });
    expect(await refused({ path: "/h/a.md", into: "/h/b" })).toEqual({
      refused: "a.md is already in that folder",
    });
    expect(asked).toEqual({
      op: { op: "scriptorium.move.plan", path: "/h/a.md", into: "/h/b" },
      o: { timeoutMs: 5000 },
    });
    const down = scriptoriumBeforeMove(
      {
        request: async () => {
          throw new Error("no reply to scriptorium.move.plan within 50 ms");
        },
      },
      { timeoutMs: 50 },
    );
    await expect(down({ path: "/h/a.md", into: "/h/b" })).rejects.toThrow("within 50 ms");
  });
});

// Cole's ruling (2026-10-17): a plan that cannot be fetched still lets the
// human Move anyway, and the dialog names what was not checked.
describe("when the plan cannot be fetched", () => {
  const list: ContextEntry = {
    id: "c-notes",
    label: "notes",
    root: "/h/notes",
    membership: "listed",
    nodes: [{ kind: "doc", rel: "memo.md" }],
  };
  const drafts: ContextEntry = {
    id: "c-drafts",
    label: "drafts",
    root: "/h/drafts",
    membership: "mirrored",
    nodes: [{ kind: "doc", rel: "a.md" }],
  };
  async function unchecked() {
    const structure: StructureOp[] = [];
    const m = await mount(
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar
          entries={[list, drafts]}
          activeDoc={null}
          userHome="/h"
          onOpenDoc={() => {}}
          onAddPath={() => {}}
          onStructure={(op) => structure.push(op)}
          onRemoveEntry={() => {}}
          onReveal={() => {}}
          onPick={() => {}}
          listDir={async () => ({ entries: [] })}
          beforeMove={scriptoriumBeforeMove({
            request: async () => {
              throw new Error("the session has ended");
            },
          })}
          uncheckedMoveNote={scriptoriumUncheckedMoveNote}
        />
      </div>,
    );
    await rightClick(buttonWith("memo.md"));
    await waitFor(() => menuItem("Move to") !== null, "the menu");
    await click(menuItem("Move to"));
    await waitFor(() => option("drafts") !== null, "the Move to dialog");
    await click(option("drafts"));
    await waitFor(() => dialog() !== null, "the unchecked question");
    return { structure, m };
  }

  test("the dialog names both things not checked: the links, and leaving a git repository", async () => {
    const { m } = await unchecked();
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("could not be checked first (the session has ended)");
    expect(text).toContain("The links into and out of what moves were not checked.");
    expect(text).toContain("Nor was whether it leaves a git repository");
    expect(text).toContain("git will see the files as deleted");
    expect(text).toContain(
      "Any it breaks are named in the chat after the move, and the context column offers to update them.",
    );
    await m.unmount();
  });

  test("Move anyway sends the move", async () => {
    const { structure, m } = await unchecked();
    await click(buttonWith("Move anyway", dialog() as ParentNode));
    await waitFor(() => structure.length === 1, "the move");
    expect(structure).toEqual([{ op: "move", path: "/h/notes/memo.md", into: "/h/drafts" }]);
    await m.unmount();
  });

  test("Cancel sends nothing", async () => {
    const { structure, m } = await unchecked();
    await click(buttonWith("Cancel", dialog() as ParentNode));
    await waitFor(() => dialog() === null, "the dialog to close");
    await settle(() => {});
    expect(structure).toEqual([]);
    await m.unmount();
  });
});
