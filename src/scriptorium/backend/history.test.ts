// E60: the context's own undo — planning inverses, and the two stacks.
import { describe, expect, test } from "bun:test";
import { type After, type Before, History, type HistoryView, planInverse } from "./history";
import type { HistoryView as WireHistoryView } from "./protocol";

const plan = (op: Parameters<typeof planInverse>[0], after: After = {}, before: Before = {}) =>
  planInverse(op, after, before);

describe("planInverse — reversible acts carry what only the act knew", () => {
  test("a move goes back to the folder it came FROM", () => {
    const act = plan(
      { type: "move", path: "/w/note.md", into: "/w/drafts" },
      { path: "/w/drafts/note.md", from: "/w/note.md" },
    );
    expect(act?.inverse).toEqual({ kind: "move", path: "/w/drafts/note.md", into: "/w" });
    expect(act?.label).toBe("moved note.md into drafts");
  });

  test("a rename goes back to the old BASENAME, not the old path", () => {
    const act = plan(
      { type: "rename", path: "/w/old.md", name: "new.md" },
      { path: "/w/new.md", from: "/w/old.md" },
    );
    expect(act?.inverse).toEqual({ kind: "rename", path: "/w/new.md", name: "old.md" });
  });

  test("hiding one item inside a set restores the WHOLE previous hidden list", () => {
    // ⛔ The list, not the one path: that is what puts the entry back exactly,
    // and reading `hidden` afterwards would include the thing just hidden.
    const act = plan(
      { type: "hide", path: "/w/set/b.md" },
      { path: "/w/set/b.md", entry: "c-1", removedEntry: false },
      { hidden: { entry: "c-1", rels: ["a.md"] } },
    );
    expect(act?.inverse).toEqual({ kind: "hidden", entry: "c-1", rels: ["a.md"] });
  });

  test("hiding a single-document entry is undone by putting it back in the context", () => {
    const act = plan(
      { type: "hide", path: "/w/solo.md" },
      { path: "/w/solo.md", entry: "c-2", removedEntry: true },
    );
    expect(act?.inverse).toEqual({ kind: "context.add", path: "/w/solo.md" });
  });

  test("unhide is undone by re-hiding exactly what it revealed", () => {
    const act = plan(
      { type: "unhide", entry: "c-1" },
      { entry: "c-1" },
      {
        hidden: { entry: "c-1", rels: ["a.md", "b.md"] },
      },
    );
    expect(act?.inverse).toEqual({ kind: "hidden", entry: "c-1", rels: ["a.md", "b.md"] });
    expect(act?.label).toBe("brought back 2 hidden items");
  });

  test("a workspace change goes back to the previous workspace", () => {
    const act = plan(
      { type: "workspace.set", path: "/w/new" },
      { path: "/w/new" },
      {
        workspace: "/w/old",
      },
    );
    expect(act?.inverse).toEqual({ kind: "workspace", path: "/w/old" });
  });
});

describe("planInverse — a no-op is not history", () => {
  test("unhiding an entry with nothing hidden records nothing", () => {
    // ⛔ An arrow that steps over acts which changed nothing lies about how far
    // back it can go.
    expect(
      plan(
        { type: "unhide", entry: "c-1" },
        { entry: "c-1" },
        { hidden: { entry: "c-1", rels: [] } },
      ),
    ).toBeNull();
    expect(plan({ type: "unhide", entry: "c-1" }, { entry: "c-1" })).toBeNull();
  });

  test("setting the workspace to what it already was records nothing", () => {
    expect(
      plan({ type: "workspace.set", path: "/w" }, { path: "/w" }, { workspace: "/w" }),
    ).toBeNull();
  });
});

describe("planInverse — creations plan a DELETE, gated by confirmation", () => {
  // Cole reversed an earlier hard block: refusing stranded every act behind a
  // creation. The arrow stays live; the dialog is the gate.
  test("a new document plans a file delete", () => {
    const act = plan({ type: "doc.create", dir: "/w" }, { path: "/w/Untitled.md" });
    expect(act?.inverse).toEqual({ kind: "delete", path: "/w/Untitled.md", dir: false });
  });

  test("a new folder plans a DIRECTORY delete — the emptiness rule hangs off `dir`", () => {
    const act = plan({ type: "folder.create", dir: "/w" }, { path: "/w/notes" });
    expect(act?.inverse).toEqual({ kind: "delete", path: "/w/notes", dir: true });
  });

  test("an import plans a delete of the COPY", () => {
    const act = plan({ type: "import", name: "a.md", text: "x" }, { path: "/w/a.md" });
    expect(act?.inverse).toEqual({ kind: "delete", path: "/w/a.md", dir: false });
  });

  test("set.make plans the FOLDER's removal, not the move inside it", () => {
    const act = plan(
      { type: "set.make", path: "/w/solo.md" },
      {
        path: "/w/solo/solo.md",
        folder: "/w/solo",
      },
    );
    expect(act?.inverse).toEqual({ kind: "delete", path: "/w/solo", dir: true });
  });
});

describe("History — the two stacks and what the arrows show", () => {
  const move: Parameters<typeof planInverse>[0] = { type: "move", path: "/w/a.md", into: "/w/d" };
  const moved: After = { path: "/w/d/a.md", from: "/w/a.md" };

  test("empty history offers nothing", () => {
    const h = new History();
    expect(h.view()).toEqual({ canUndo: false, canRedo: false });
  });

  test("an act makes undo available, with its label", () => {
    const h = new History();
    h.did(plan(move, moved));
    const v = h.view();
    expect(v.canUndo).toBe(true);
    expect(v.canRedo).toBe(false);
    expect(v.undoLabel).toBe("moved a.md into d");
  });

  test("a null act is not recorded", () => {
    const h = new History();
    h.did(null);
    expect(h.depth()).toEqual({ undo: 0, redo: 0 });
  });

  test("undoing moves the act to the redo stack", () => {
    const h = new History();
    h.did(plan(move, moved));
    h.tookUndo({
      label: "moved a.md back",
      inverse: { kind: "move", path: "/w/a.md", into: "/w/d" },
    });
    expect(h.depth()).toEqual({ undo: 0, redo: 1 });
    const v = h.view();
    expect(v.canUndo).toBe(false);
    expect(v.canRedo).toBe(true);
    expect(v.redoLabel).toBe("moved a.md back");
  });

  test("⛔ A NEW ACT CLEARS THE REDO STACK", () => {
    // Redoing after diverging would replay an act against a world that has
    // moved on — the classic way an undo stack corrupts a document.
    const h = new History();
    h.did(plan(move, moved));
    h.tookUndo({ label: "back", inverse: { kind: "move", path: "/w/a.md", into: "/w/d" } });
    expect(h.depth().redo).toBe(1);
    h.did(
      plan({ type: "rename", path: "/w/b.md", name: "c.md" }, { path: "/w/c.md", from: "/w/b.md" }),
    );
    expect(h.depth()).toEqual({ undo: 1, redo: 0 });
  });

  test("a deleting undo is STILL undoable — the gate is the dialog", () => {
    const h = new History();
    h.did(plan({ type: "folder.create", dir: "/w" }, { path: "/w/notes" }));
    const v = h.view();
    expect(v.canUndo).toBe(true);
    expect(v.undoDeletes).toEqual({ path: "/w/notes", dir: true });
  });

  test("a non-deleting undo announces no deletion", () => {
    const h = new History();
    h.did(plan(move, moved));
    expect(h.view().undoDeletes).toBeUndefined();
  });

  test("undo and redo alternate without growing either stack", () => {
    const h = new History();
    h.did(plan(move, moved));
    for (let i = 0; i < 3; i++) {
      h.tookUndo({ label: "back", inverse: { kind: "move", path: "/w/a.md", into: "/w/d" } });
      expect(h.depth()).toEqual({ undo: 0, redo: 1 });
      h.tookRedo({ label: "forward", inverse: { kind: "move", path: "/w/d/a.md", into: "/w" } });
      expect(h.depth()).toEqual({ undo: 1, redo: 0 });
    }
  });

  test("undoing an empty stack is a no-op, not a crash", () => {
    const h = new History();
    expect(() => h.tookUndo(null)).not.toThrow();
    expect(h.depth()).toEqual({ undo: 0, redo: 0 });
  });
});

// ── the mirror guard ────────────────────────────────────────────────────────
//
// ⛔ `protocol.ts` duplicates `HistoryView` because it is import-free on
// purpose. Same discipline as `GraphPayload` and `SearchReport`: KEY EQUALITY
// in both directions, because two-way assignability alone is blind to an
// optional field added to one side — measured when E54 drifted `raw?`/`line?`
// straight past exactly that check.
type ExactKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
const _viewKeys: ExactKeys<HistoryView, WireHistoryView> = true;
const _viewToWire: WireHistoryView = {} as HistoryView;
const _wireToView: HistoryView = {} as WireHistoryView;
void _viewKeys;
void _viewToWire;
void _wireToView;
