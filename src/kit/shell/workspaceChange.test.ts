import { expect, test } from "bun:test";
import { workspaceChangeDialog } from "./workspaceChange.ts";

const docs = [
  { name: "cave.md", original: "/w/old/places/cave.md", dirty: true },
  { name: "glade.md", original: "/w/old/places/glade.md", dirty: false },
  { name: "keep.md", original: "/w/new/keep.md", dirty: true },
];

test("names the documents with unsaved edits that leave the tree, and only those", () => {
  const d = workspaceChangeDialog({ to: "/w/new", docs, by: "human", home: null });
  expect(d.title).toBe("Change the workspace?");
  expect(d.warning).toContain("cave.md has unsaved edits and leaves the tree");
  expect(d.warning).toContain("not in its file");
  // Saved, or still in the tree under the new folder: not named.
  expect(d.warning).not.toContain("glade.md");
  expect(d.warning).not.toContain("keep.md");
  expect(d.message).toContain("keeps its versions");
  expect(d.confirmLabel).toBe("Change workspace");
});

test("a ~ path is read against the home folder; nothing unsaved leaving says nothing", () => {
  const d = workspaceChangeDialog({ to: "~/old/", docs, by: "human", home: "/w" });
  // cave.md is under ~/old and stays; keep.md, under /w/new, leaves.
  expect(d.warning).toContain("keep.md has unsaved edits");
  expect(d.warning).not.toContain("cave.md");
  const saved = docs.map((x) => ({ ...x, dirty: false }));
  expect(
    workspaceChangeDialog({ to: "/w/x", docs: saved, by: "human", home: null }).warning,
  ).toBeNull();
});

test("the agent's ask says who is asking, and names several documents together", () => {
  const two = [...docs, { name: "well.md", original: "/w/old/well.md", dirty: true }];
  const d = workspaceChangeDialog({
    to: "/w/new",
    shown: "~/new",
    docs: two,
    by: "agent",
    home: "/w",
  });
  expect(d.title).toBe("The agent asks to change the workspace");
  expect(d.message).toContain("~/new");
  expect(d.warning).toContain("cave.md and well.md have unsaved edits and leave the tree");
});
