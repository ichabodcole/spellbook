// The four incoming frames and their SILENT branches. Every `expect` here
// names an inventory row; the silences are the point — a frame the board
// ignores is a behaviour, not an absence.
import { describe, expect, test } from "bun:test";
import {
  applyAdd,
  applyInit,
  applyRemove,
  applyUpdate,
  type BoardSnapshot,
  isSessionEnd,
  randId,
} from "./board";
import type { Task } from "./types";

const t = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: "todo",
  ...over,
});

const EMPTY: BoardSnapshot = { title: "", tasks: [], restoreFailed: null, sessionId: "" };

describe("applyInit (W6, B3)", () => {
  test("takes title and a COPY of tasks", () => {
    const tasks = [t("a")];
    const s = applyInit(EMPTY, { type: "init", title: "board", tasks });
    expect(s.title).toBe("board");
    expect(s.tasks).toEqual(tasks);
    expect(s.tasks).not.toBe(tasks); // a copy — the frame is not retained
  });

  test("a missing or non-array tasks field yields an empty board, not a throw", () => {
    expect(applyInit(EMPTY, { type: "init" }).tasks).toEqual([]);
    expect(applyInit(EMPTY, { type: "init", tasks: "nope" as unknown as Task[] }).tasks).toEqual(
      [],
    );
  });

  test("B3 — restoreFailed counts only as a truthy OBJECT", () => {
    const rf = { path: "/x", reason: "boom" };
    expect(applyInit(EMPTY, { type: "init", restoreFailed: rf }).restoreFailed).toEqual(rf);
    expect(applyInit(EMPTY, { type: "init" }).restoreFailed).toBeNull();
    expect(applyInit(EMPTY, { type: "init", restoreFailed: null }).restoreFailed).toBeNull();
    // an older daemon, or a hostile frame: a string is NOT a report
    expect(
      applyInit(EMPTY, { type: "init", restoreFailed: "boom" as unknown as null }).restoreFailed,
    ).toBeNull();
  });

  test("a daemon that omits sessionId leaves the one we already have", () => {
    const seeded: BoardSnapshot = { ...EMPTY, sessionId: "bounty-abc-p1" };
    expect(applyInit(seeded, { type: "init" }).sessionId).toBe("bounty-abc-p1");
    expect(applyInit(seeded, { type: "init", sessionId: "bounty-def-p2" }).sessionId).toBe(
      "bounty-def-p2",
    );
  });
});

describe("applyAdd (W7, Z7)", () => {
  test("appends", () => {
    expect(applyAdd([t("a")], t("b")).map((x) => x.id)).toEqual(["a", "b"]);
  });
  test("a second frame for the same id is DROPPED, same array back", () => {
    const tasks = [t("a")];
    expect(applyAdd(tasks, t("a"))).toBe(tasks);
  });
});

describe("applyUpdate (W8, Z6)", () => {
  test("merges the patch over the task and leaves the others alone", () => {
    const out = applyUpdate([t("a"), t("b")], "a", { status: "doing", notes: "n" });
    expect(out[0]).toEqual({ id: "a", title: "a", status: "doing", notes: "n" });
    expect(out[1]).toEqual(t("b"));
  });
  test("an unknown id is a SILENT no-op, same array back", () => {
    const tasks = [t("a")];
    expect(applyUpdate(tasks, "zzz", { status: "done" })).toBe(tasks);
  });
  test("M7 — the entry is REPLACED, so a captured task object does not mutate", () => {
    const before = t("a");
    const out = applyUpdate([before], "a", { title: "new" });
    expect(before.title).toBe("a"); // the open detail modal still shows the old one
    expect(out[0]?.title).toBe("new");
  });
});

describe("applyRemove (W9, Z6)", () => {
  test("drops by id", () => {
    expect(applyRemove([t("a"), t("b")], "a").map((x) => x.id)).toEqual(["b"]);
  });
  test("an unknown id is a SILENT no-op, same array back", () => {
    const tasks = [t("a")];
    expect(applyRemove(tasks, "zzz")).toBe(tasks);
  });
});

describe("isSessionEnd (T6, W12)", () => {
  test("only the daemon's own prefix ends the session", () => {
    expect(isSessionEnd("session ended: user")).toBe(true);
    expect(isSessionEnd("session ended: timeout")).toBe(true);
    expect(isSessionEnd("a session ended: nope")).toBe(false);
    expect(isSessionEnd("hello")).toBe(false);
    expect(isSessionEnd(undefined)).toBe(false);
  });
});

describe("randId (C7)", () => {
  test("u- plus twelve lowercase hex", () => {
    expect(randId((b) => b.fill(0))).toBe("u-000000000000");
    expect(randId((b) => b.fill(255))).toBe("u-ffffffffffff");
    expect(randId()).toMatch(/^u-[0-9a-f]{12}$/);
  });
});
