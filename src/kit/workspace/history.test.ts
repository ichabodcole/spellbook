// The context's own undo: planning inverses, and the two stacks.
import { describe, expect, test } from "bun:test";
import { type After, History, type HistoryView, planInverse } from "./history";
import type { HistoryView as WireHistoryView } from "./protocol";

const plan = (op: Parameters<typeof planInverse>[0], after: After = {}) => planInverse(op, after);

describe("planInverse: reversible acts carry what only the act knew", () => {
  test("a move goes back to the folder it came FROM", () => {
    const act = plan(
      { op: "move", path: "/w/note.md", into: "/w/drafts" },
      { path: "/w/drafts/note.md", from: "/w/note.md" },
    );
    expect(act?.inverse).toEqual({ kind: "move", path: "/w/drafts/note.md", into: "/w" });
    expect(act?.label).toBe("moved note.md into drafts");
  });

  test("a rename goes back to the old BASENAME, not the old path", () => {
    const act = plan(
      { op: "rename", path: "/w/old.md", name: "new.md" },
      { path: "/w/new.md", from: "/w/old.md" },
    );
    expect(act?.inverse).toEqual({ kind: "rename", path: "/w/new.md", name: "old.md" });
  });

  test("a move or rename with no recorded origin records nothing", () => {
    expect(plan({ op: "move", path: "/w/a.md", into: "/w/d" }, { path: "/w/d/a.md" })).toBeNull();
    expect(plan({ op: "rename", path: "/w/a.md", name: "b.md" }, { path: "/w/b.md" })).toBeNull();
  });
});

describe("planInverse: creations plan a DELETE, gated by confirmation", () => {
  // Refusing stranded every act behind a creation. The arrow stays live; the
  // dialog is the gate.
  test("a new document plans a file delete", () => {
    const act = plan({ op: "doc.create", dir: "/w" }, { path: "/w/Untitled.md" });
    expect(act?.inverse).toEqual({ kind: "delete", path: "/w/Untitled.md", dir: false });
  });

  test("a new folder plans a DIRECTORY delete; the emptiness rule hangs off `dir`", () => {
    const act = plan({ op: "folder.create", dir: "/w" }, { path: "/w/notes" });
    expect(act?.inverse).toEqual({ kind: "delete", path: "/w/notes", dir: true });
  });

  test("an import plans a delete of the COPY", () => {
    const act = plan({ op: "import", name: "a.md", text: "x" }, { path: "/w/a.md" });
    expect(act?.inverse).toEqual({ kind: "delete", path: "/w/a.md", dir: false });
  });
});

describe("History: the two stacks and what the arrows show", () => {
  const move: Parameters<typeof planInverse>[0] = { op: "move", path: "/w/a.md", into: "/w/d" };
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

  test("a new act clears the redo stack", () => {
    // Redoing after diverging would replay an act against a world that has
    // moved on: the classic way an undo stack corrupts a document.
    const h = new History();
    h.did(plan(move, moved));
    h.tookUndo({ label: "back", inverse: { kind: "move", path: "/w/a.md", into: "/w/d" } });
    expect(h.depth().redo).toBe(1);
    h.did(
      plan({ op: "rename", path: "/w/b.md", name: "c.md" }, { path: "/w/c.md", from: "/w/b.md" }),
    );
    expect(h.depth()).toEqual({ undo: 1, redo: 0 });
  });

  test("a deleting undo is still undoable; the gate is the dialog", () => {
    const h = new History();
    h.did(plan({ op: "folder.create", dir: "/w" }, { path: "/w/notes" }));
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
// `protocol.ts` duplicates `HistoryView` because it is import-free on purpose.
// The guard is key equality in both directions, because two-way assignability
// alone is blind to an optional field added to one side.
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
