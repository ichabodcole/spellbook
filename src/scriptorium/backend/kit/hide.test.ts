// `hide` and `unhide` on the kit path, over a real session and disk: the
// shipped semantics (S/backend/session.ts `hide`, `unhide`) with the hidden
// lists in the app slot, read by the kit's scan filter.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextNode } from "../../../kit/workspace/protocol";
import { WorkspaceSession } from "../../../kit/workspace/session";
import { tempRoot } from "../../../kit/workspace/testing";
import { hiddenLists, scriptoriumApp } from "./app";
import { hide, unhide } from "./hide";

let root: string;
let set: string;
let sessions: string;
let s: WorkspaceSession;
let entry: string;

beforeEach(() => {
  root = tempRoot("scriptorium-hide");
  set = join(root, "set");
  sessions = join(root, "sessions");
  mkdirSync(join(set, "drafts", "old"), { recursive: true });
  writeFileSync(join(set, "a.md"), "# A\n\nThe lighthouse.\n");
  writeFileSync(join(set, "drafts", "rough.md"), "# Rough\n\nlighthouse [a](../a.md)\n");
  writeFileSync(join(set, "drafts", "old", "older.md"), "# Older\n");
  writeFileSync(join(root, "solo.md"), "# Solo\n");
  s = WorkspaceSession.create(sessions, scriptoriumApp);
  entry = s.addContext(set).entry.id;
  s.addContext(join(root, "solo.md"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const rels = (nodes: readonly ContextNode[]): string[] =>
  nodes.flatMap((n) => [n.rel, ...(n.kind === "group" ? rels(n.children) : [])]);
const tree = (x: WorkspaceSession = s) => rels(x.context.find((e) => e.id === entry)?.nodes ?? []);

describe("hide", () => {
  test("a folder in a set: out of the tree and search, on disk, listed in the app slot", () => {
    const r = hide(s, join(set, "drafts"));
    expect(r).toMatchObject({ path: join(set, "drafts"), entry, removedEntry: false });
    expect(tree()).toEqual(["a.md"]);
    expect(s.search({ query: "lighthouse" }).results.map((x) => x.path)).toEqual([
      join(set, "a.md"),
    ]);
    expect(s.backlinks(join(set, "a.md")).backlinks).toEqual([]);
    expect(existsSync(join(set, "drafts", "old", "older.md"))).toBe(true);
    expect(hiddenLists(s.appSlot)).toEqual({ [entry]: ["drafts"] });
    // On the context entry itself, nothing: the kit's entries are the kit's.
    expect(JSON.stringify(s.context)).not.toContain('"hidden"');
  });

  test("each hide adds to the set's list, in the order hidden", () => {
    hide(s, join(set, "drafts", "old"));
    hide(s, join(set, "a.md"));
    expect(hiddenLists(s.appSlot)[entry]).toEqual(["drafts/old", "a.md"]);
    expect(tree()).toEqual(["drafts", "drafts/rough.md"]);
  });

  test("a whole entry (a set's own folder, a listed document) leaves the context, its list with it", () => {
    hide(s, join(set, "drafts"));
    expect(hide(s, set)).toMatchObject({ entry, removedEntry: true });
    expect(s.context.map((e) => e.label)).toEqual(["solo.md"]);
    expect(hiddenLists(s.appSlot)).toEqual({});
    expect(hide(s, join(root, "solo.md"))).toMatchObject({ removedEntry: true });
    expect(s.context).toEqual([]);
    expect(existsSync(join(root, "solo.md"))).toBe(true);
  });

  test("a path the context does not show is refused, and so is one already hidden", () => {
    expect(() => hide(s, join(root, "elsewhere.md"))).toThrow("not shown");
    hide(s, join(set, "drafts"));
    expect(() => hide(s, join(set, "drafts", "rough.md"))).toThrow("not shown");
  });
});

describe("unhide", () => {
  test("brings back everything hidden in a set, and says how many", () => {
    hide(s, join(set, "drafts", "old"));
    hide(s, join(set, "a.md"));
    expect(unhide(s, entry)).toMatchObject({ entry, restored: 2 });
    expect(tree()).toContain("drafts/old/older.md");
    expect(tree()).toContain("a.md");
    expect(hiddenLists(s.appSlot)).toEqual({});
  });

  test("an entry that is not there is a 404 naming the ones that are", () => {
    expect(() => unhide(s, "c-nope")).toThrow("no context entry c-nope");
  });

  test("nothing hidden restores nothing", () => {
    expect(unhide(s, entry)).toMatchObject({ restored: 0 });
  });
});

describe("the hidden list survives", () => {
  test("a restore: the manifest carries it, and the restore scans through it", () => {
    hide(s, join(set, "drafts"));
    const manifest = JSON.parse(readFileSync(join(sessions, s.id, "manifest.json"), "utf8"));
    expect(manifest.app).toEqual({ hidden: { [entry]: ["drafts"] }, version: 2 });
    const back = WorkspaceSession.restore(sessions, scriptoriumApp, s.id);
    expect(tree(back)).toEqual(["a.md"]);
  });

  test("a rescan after an outside change: a new file shows, the hidden folder's new file does not", () => {
    hide(s, join(set, "drafts"));
    writeFileSync(join(set, "drafts", "new.md"), "# New\n");
    writeFileSync(join(set, "fresh.md"), "# Fresh\n");
    s.rescan(entry);
    expect(tree()).toEqual(["a.md", "fresh.md"]);
  });
});

describe("the slot", () => {
  test("version 2; a fresh slot and a version 1 slot both gain an empty hidden list", () => {
    expect(scriptoriumApp.slot.version).toBe(2);
    expect(scriptoriumApp.slot.migrate({}, 0)).toEqual({ hidden: {} });
    expect(scriptoriumApp.slot.migrate({}, 1)).toEqual({ hidden: {} });
  });

  test("a version 1 manifest restores as version 2, with nothing hidden", () => {
    const path = join(sessions, s.id, "manifest.json");
    const m = JSON.parse(readFileSync(path, "utf8"));
    m.app = { version: 1 };
    writeFileSync(path, JSON.stringify(m));
    const back = WorkspaceSession.restore(sessions, scriptoriumApp, s.id);
    expect(back.appSlot).toEqual({ hidden: {} });
    expect(tree(back)).toContain("drafts/rough.md");
  });
});
