// The card cues. The PREDICATES under these live in the skill's shared/ folder
// and are guarded by scripts/server.test.ts — these cells cover the wording and
// the surface-side wiring, plus the one thing the daemon's tests cannot see:
// that the surface and the daemon now agree by CONSTRUCTION rather than by a
// comment asking two files to stay in lockstep.
import { describe, expect, test } from "bun:test";
import {
  blockedLabel,
  cardOverdue,
  liveBlockerCount,
  ownersOverWip,
  staleLabel,
  wipCued,
  wipLabel,
} from "./cards";
import type { Task } from "./types";

const MIN = 60_000;
const t = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: "todo",
  ...over,
});

describe("liveBlockerCount (K2)", () => {
  test("counts only blockers that EXIST and are not done", () => {
    const a = t("a", { blockedBy: ["b", "c", "gone"] });
    const tasks = [a, t("b"), t("c", { status: "done" })];
    expect(liveBlockerCount(a, tasks)).toBe(1);
  });
  test("no blockedBy at all is zero", () => {
    expect(liveBlockerCount(t("a"), [t("a")])).toBe(0);
  });
});

test("blockedLabel (K3)", () => {
  expect(blockedLabel(3)).toBe("⛔ blocked by 3");
});

describe("staleLabel (K10, K11)", () => {
  const now = 1_000 * MIN;
  const doing = (over: Partial<Task> = {}) =>
    t("a", { status: "doing", size: "S", enteredStatusAt: now - 25 * MIN, ...over });

  test("total age AND overdue-by", () => {
    // size S = 5 expected minutes; 25m in doing -> 20m over
    expect(staleLabel(doing(), [doing()], now)).toBe("⏱ Doing 25m · 20m over");
  });

  test("K11 — both numbers floor at 1, so 30s over never reads 0m", () => {
    const task = doing({ enteredStatusAt: now - (5 * MIN + 30_000) });
    expect(staleLabel(task, [task], now)).toBe("⏱ Doing 6m · 1m over");
  });

  test("not overdue, not doing, unsized, or BLOCKED -> no label", () => {
    const fresh = doing({ enteredStatusAt: now - MIN });
    expect(staleLabel(fresh, [fresh], now)).toBe("");
    const todo = doing({ status: "todo" });
    expect(staleLabel(todo, [todo], now)).toBe("");
    const unsized = doing({ size: undefined });
    expect(staleLabel(unsized, [unsized], now)).toBe("");
    const blocked = doing({ blockedBy: ["b"] });
    expect(staleLabel(blocked, [blocked, t("b")], now)).toBe("");
  });

  test("an explicit expect beats the size (K9)", () => {
    const task = doing({ expect: 30 });
    expect(cardOverdue(task, [task], now)).toBeNull(); // 25m in, 30m expected
  });
});

describe("wipCued / wipLabel (K13, K14, K15)", () => {
  const tasks = [
    t("a", { status: "doing", owner: "cole" }),
    t("b", { status: "doing", owner: "cole" }),
    t("c", { status: "doing" }), // unowned — counts toward nobody
    t("d", { status: "todo", owner: "cole" }),
    t("e", { status: "doing", owner: "gawain" }),
  ];
  const over = ownersOverWip(tasks, 2);

  test("K13 — an owner at the threshold is over; an unowned doing card is not", () => {
    expect([...over]).toEqual(["cole"]);
  });

  test("K14 — only a DOING card of that owner is cued", () => {
    expect(wipCued(tasks[0] as Task, over)).toBe(true);
    expect(wipCued(tasks[3] as Task, over)).toBe(false); // todo, same owner
    expect(wipCued(tasks[4] as Task, over)).toBe(false); // doing, owner under
    expect(wipCued(tasks[2] as Task, over)).toBe(false); // doing, unowned
  });

  test("K15 — the label counts that owner's doing cards", () => {
    expect(wipLabel(tasks[0] as Task, tasks)).toBe("2 in Doing — wrap one before pulling more");
  });
});
