import { describe, expect, test } from "bun:test";
import type { TrashPreview } from "../workspace/protocol";
import { listNames, trashDialog } from "./trashDialog.ts";

const base: TrashPreview = {
  path: "/w/world/places",
  shown: "world/places",
  dir: true,
  files: 12,
  folders: 3,
  docs: [],
};

describe("the Delete dialog", () => {
  test("a folder names itself and counts what goes, and says the Trash keeps it", () => {
    const d = trashDialog(base);
    expect(d.title).toBe("Move places to the Trash?");
    expect(d.message).toBe(
      "The folder world/places and everything in it go to the Trash. It holds 12 files in 3 folders. You can put it back from the Trash.",
    );
    expect(d.warning).toBeNull();
    expect(d.confirmLabel).toBe("Move to Trash");
  });

  test("counts in the singular, an empty folder, and a count that stopped at the cap", () => {
    expect(trashDialog({ ...base, files: 1, folders: 0 }).message).toContain("It holds 1 file.");
    expect(trashDialog({ ...base, files: 0, folders: 0 }).message).toContain("It is empty.");
    expect(trashDialog({ ...base, truncated: true }).message).toContain("at least 12 files");
  });

  test("a document says where it goes", () => {
    const d = trashDialog({
      ...base,
      path: "/w/world/harbour.md",
      shown: "world/harbour.md",
      dir: false,
      files: 1,
      folders: 0,
    });
    expect(d.title).toBe("Move harbour.md to the Trash?");
    expect(d.message).toBe("world/harbour.md goes to the Trash. You can put it back from there.");
  });

  test("a link says the link goes, not what it points at", () => {
    const d = trashDialog({
      ...base,
      path: "/w/world/home",
      shown: "world/home",
      dir: false,
      link: true,
      files: 1,
      folders: 0,
    });
    expect(d.message).toBe(
      "world/home is a link: the link goes to the Trash, not what it points at.",
    );
  });

  test("warns about unsaved edits, session versions and the open document, and says they stay", () => {
    const d = trashDialog({
      ...base,
      docs: [
        { slug: "a", name: "a.md", unsaved: true, versions: 3, open: true },
        { slug: "b", name: "b.md", unsaved: true, versions: 1, open: false },
        { slug: "c", name: "c.md", unsaved: false, versions: 1, open: false },
      ],
    });
    expect(d.warning).toBe(
      "a.md and b.md have unsaved edits: they stay in this session, not in the file. a.md has 3 versions in this session; they are kept here, not in the Trash. a.md is open, and closes.",
    );
  });

  test("names run out after three", () => {
    expect(listNames(["a"])).toBe("a");
    expect(listNames(["a", "b", "c"])).toBe("a, b and c");
    expect(listNames(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});
