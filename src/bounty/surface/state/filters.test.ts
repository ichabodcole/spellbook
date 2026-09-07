// surface-filter. The persistence rules run against a Map, which is why
// `StorageLike` is injected rather than reached for — the browser's
// localStorage is not available under `bun test` and stubbing a global to
// throw is not the same thing as proving the throw is caught.
import { describe, expect, test } from "bun:test";
import {
  boardOwners,
  boardTags,
  FILTERS_KEY,
  hasActiveFilters,
  loadFilters,
  NO_FILTERS,
  persistFilters,
  type StorageLike,
  tasksByStatus,
  toggleFacet,
} from "./filters";
import type { Task } from "./types";

const t = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: "todo",
  ...over,
});

function mapStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const throwingStorage: StorageLike = {
  getItem() {
    throw new Error("private mode");
  },
  setItem() {
    throw new Error("quota");
  },
};

describe("boardTags / boardOwners (F3)", () => {
  const tasks = [t("a", { tags: ["z", "b"], owner: "cole" }), t("c", { tags: ["b"] })];

  test("distinct and sorted", () => {
    expect(boardTags(tasks, [])).toEqual(["b", "z"]);
    expect(boardOwners(tasks, [])).toEqual(["cole"]);
  });

  test("UNIONED with the active set, so a vanished filter keeps its chip", () => {
    expect(boardTags(tasks, ["gone"])).toEqual(["b", "gone", "z"]);
    expect(boardOwners(tasks, ["ghost"])).toEqual(["cole", "ghost"]);
  });

  test("an owner-less, tag-less board offers nothing to filter on (F1)", () => {
    expect(boardTags([t("a")], [])).toEqual([]);
    expect(boardOwners([t("a")], [])).toEqual([]);
  });
});

describe("toggleFacet (F5)", () => {
  test("adds then removes, without mutating", () => {
    const a: string[] = [];
    const b = toggleFacet(a, "x");
    expect(b).toEqual(["x"]);
    expect(a).toEqual([]);
    expect(toggleFacet(b, "x")).toEqual([]);
  });
});

describe("hasActiveFilters (F6)", () => {
  test("either facet counts", () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    expect(hasActiveFilters({ tags: ["a"], owners: [] })).toBe(true);
    expect(hasActiveFilters({ tags: [], owners: ["a"] })).toBe(true);
  });
});

describe("tasksByStatus (F7, F8, F9)", () => {
  const tasks = [
    t("a", { status: "doing", tags: ["x"], owner: "cole" }),
    t("b", { status: "doing", tags: ["y"] }),
    t("c", { status: "todo", tags: ["x"] }),
  ];

  test("no filters: every card of that status, in board order", () => {
    expect(tasksByStatus(tasks, "doing", NO_FILTERS).map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("OR within a facet", () => {
    expect(
      tasksByStatus(tasks, "doing", { tags: ["x", "y"], owners: [] }).map((x) => x.id),
    ).toEqual(["a", "b"]);
  });

  test("AND across facets", () => {
    expect(tasksByStatus(tasks, "doing", { tags: ["y"], owners: ["cole"] })).toEqual([]);
    expect(
      tasksByStatus(tasks, "doing", { tags: ["x"], owners: ["cole"] }).map((x) => x.id),
    ).toEqual(["a"]);
  });

  test("an unowned card can never pass an owner filter", () => {
    expect(tasksByStatus(tasks, "doing", { tags: [], owners: ["cole"] }).map((x) => x.id)).toEqual([
      "a",
    ]);
  });
});

describe("persistFilters / loadFilters (F10-F13, Z2, Z3)", () => {
  test("F10 — the key and the shape", () => {
    const s = mapStorage();
    persistFilters(s, { tags: ["a"], owners: ["b"] });
    expect(s.map.get(FILTERS_KEY)).toBe('{"tags":["a"],"owners":["b"]}');
    expect(loadFilters(s)).toEqual({ tags: ["a"], owners: ["b"] });
  });

  test("F12 — nothing stored yields no filters", () => {
    expect(loadFilters(mapStorage())).toEqual(NO_FILTERS);
  });

  test("F12 — a corrupt value yields no filters, not a throw", () => {
    expect(loadFilters(mapStorage({ [FILTERS_KEY]: "{" }))).toEqual(NO_FILTERS);
  });

  test("F13 — only arrays are read, and only their string members survive", () => {
    expect(
      loadFilters(mapStorage({ [FILTERS_KEY]: '{"tags":[1,"a",null],"owners":"cole"}' })),
    ).toEqual({ tags: ["a"], owners: [] });
  });

  test("Z2/Z3 — a storage that throws never breaks the board", () => {
    expect(() => persistFilters(throwingStorage, { tags: ["a"], owners: [] })).not.toThrow();
    expect(loadFilters(throwingStorage)).toEqual(NO_FILTERS);
  });

  test("no storage at all (SSR, a locked-down browser) is also survivable", () => {
    expect(() => persistFilters(undefined, NO_FILTERS)).not.toThrow();
    expect(loadFilters(undefined)).toEqual(NO_FILTERS);
  });
});
