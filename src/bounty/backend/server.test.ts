// PART OF THE BOUNTY DAEMON SUITE: server.test.ts plus its server.*.test.ts
// siblings, one file once (7,177 lines, about 128 s alone). It was split by
// describe block so a parallel run is not floored by one file; every test body
// is unchanged. The shared harness (spawn helpers, hermeticEnv, the suite's
// private TMPDIR) is fixtures/serverSuite.ts, evaluated once per file, so each
// file holds its own TMPDIR exactly as the single file did.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cardOverdue,
  cardPassesFilter,
  expectedMinutes,
  isBlocked,
  liveBlockerCount,
  ownersOverWip,
} from "../../../plugins/spellbook/skills/bounty/shared/predicates";
import type {
  BoardState,
  Task,
  TaskStatus,
} from "../../../plugins/spellbook/skills/bounty/shared/types";
import {
  deriveSessionId,
  findScopeRoot,
  liveBoards,
  ownerInScope,
  parseTags,
  pickTailSession,
  resolveSession,
  resolveSessionSource,
  type Session,
  sessionKeyToId,
  slugifyKey,
} from "./cli.ts";
import {
  at,
  backupHolding,
  CLI,
  CLI_SRC,
  codeLines,
  collectStdout,
  collectWsUntilClose,
  type Dropped,
  editSnapshot,
  freshState,
  hermeticEnv,
  JOIN,
  killBoard,
  liveTitles,
  must,
  type NamedBackupT,
  onlyEnvelope,
  runCli,
  runOpen,
  SCRIPT_DIR,
  SERVER,
  SHARED_TMPDIR,
  seedClosed,
  seedCmd,
  spawnServerReady,
  suiteCode,
  suiteFiles,
  TEST_TMPDIR,
  titlesAt,
  uniqHome,
} from "./fixtures/serverSuite.ts";
import { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS } from "./heartbeat.ts";
import {
  applyTaskAdd,
  applyTaskMove,
  applyTaskRemove,
  applyTaskUpdate,
  cleanTags,
  computeDuePokes,
  htmlEscape,
  isNoOpMove,
  isNoOpUpdate,
  parsePortFromSessionId,
  shouldIdleClose,
  shouldRotateSnapshot,
  snapshotTaskCount,
  validateTask,
} from "./server.ts";

// ── Pure state mutation tests ────────────────────────────────────────────

describe("applyTaskAdd", () => {
  test("appends a task", () => {
    const s = freshState();
    expect(applyTaskAdd(s, { id: "a", title: "A", status: "todo" })).toBe(true);
    expect(s.tasks).toHaveLength(1);
    expect(at(s.tasks, 0, "s.tasks").id).toBe("a");
  });
  test("rejects duplicate id", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskAdd(s, { id: "a", title: "A2", status: "doing" })).toBe(false);
    expect(s.tasks).toHaveLength(1);
  });
});

describe("applyTaskUpdate", () => {
  test("applies a partial patch", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskUpdate(s, "a", { status: "doing" })).toBe(true);
    expect(at(s.tasks, 0, "s.tasks").status).toBe("doing");
    expect(at(s.tasks, 0, "s.tasks").title).toBe("A");
  });
  test("accepts the review status", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskUpdate(s, "a", { status: "review" })).toBe(true);
    expect(at(s.tasks, 0, "s.tasks").status).toBe("review");
  });
  test("drops invalid status quietly", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskUpdate(s, "a", { status: "bogus" as TaskStatus, title: "B" })).toBe(true);
    expect(at(s.tasks, 0, "s.tasks").status).toBe("todo");
    expect(at(s.tasks, 0, "s.tasks").title).toBe("B");
  });
  test("returns false for missing id", () => {
    expect(applyTaskUpdate(freshState(), "missing", { status: "done" })).toBe(false);
  });
});

describe("applyTaskRemove", () => {
  test("removes by id", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskRemove(s, "a")).toBe(true);
    expect(s.tasks).toHaveLength(0);
  });
  test("returns false for missing id", () => {
    expect(applyTaskRemove(freshState(), "missing")).toBe(false);
  });
});

describe("applyTaskMove", () => {
  function seed(): BoardState {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    applyTaskAdd(s, { id: "b", title: "B", status: "todo" });
    applyTaskAdd(s, { id: "c", title: "C", status: "doing" });
    applyTaskAdd(s, { id: "d", title: "D", status: "doing" });
    return s;
  }

  test("intra-column reorder: move b to position 0", () => {
    const s = seed();
    expect(applyTaskMove(s, "b", "todo", 0)).not.toBe(-1);
    expect(s.tasks.map((t) => t.id)).toEqual(["b", "a", "c", "d"]);
  });
  test("cross-column move to position 0", () => {
    const s = seed();
    expect(applyTaskMove(s, "a", "doing", 0)).not.toBe(-1);
    expect(s.tasks.filter((t) => t.status === "doing").map((t) => t.id)).toEqual(["a", "c", "d"]);
  });
  test("cross-column move to end (index past column length clamps)", () => {
    const s = seed();
    expect(applyTaskMove(s, "a", "doing", 99)).not.toBe(-1);
    expect(s.tasks.filter((t) => t.status === "doing").map((t) => t.id)).toEqual(["c", "d", "a"]);
  });
  test("move to empty column (status with no current tasks)", () => {
    const s = seed();
    applyTaskMove(s, "a", "done", 0);
    expect(s.tasks.find((t) => t.id === "a")?.status).toBe("done");
  });
  test("returns -1 for missing id", () => {
    expect(applyTaskMove(freshState(), "missing", "doing", 0)).toBe(-1);
  });
  test("status flips correctly on move", () => {
    const s = seed();
    applyTaskMove(s, "a", "done", 0);
    expect(s.tasks.find((t) => t.id === "a")?.status).toBe("done");
  });
});

// ── status-transition timestamps (heartbeat substrate) ───────────────────
//
// Every status transition stamps the task: enteredStatusAt (ms it entered its
// current status) + a capped statusHistory. Shared foundation for heartbeat,
// card-aging, metrics, leaderboard. `now` is injected so this is deterministic.

describe("status-transition timestamps", () => {
  const T0 = 1_000_000;
  function seededAt(now: number): BoardState {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" }, now);
    return s;
  }

  test("applyTaskAdd stamps the initial status entry", () => {
    const s = seededAt(T0);
    expect(at(s.tasks, 0, "s.tasks").enteredStatusAt).toBe(T0);
    expect(at(s.tasks, 0, "s.tasks").statusHistory).toEqual([{ status: "todo", at: T0 }]);
  });
  test("applyTaskAdd preserves a restored task's existing stamp", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "r", title: "R", status: "doing", enteredStatusAt: 42 }, T0);
    expect(at(s.tasks, 0, "s.tasks").enteredStatusAt).toBe(42); // not overwritten with T0
  });
  test("applyTaskUpdate re-stamps on a status change and appends history", () => {
    const s = seededAt(T0);
    applyTaskUpdate(s, "a", { status: "doing" }, T0 + 500);
    expect(at(s.tasks, 0, "s.tasks").enteredStatusAt).toBe(T0 + 500);
    expect(at(s.tasks, 0, "s.tasks").statusHistory).toEqual([
      { status: "todo", at: T0 },
      { status: "doing", at: T0 + 500 },
    ]);
  });
  test("a non-status patch does NOT touch the transition stamp", () => {
    const s = seededAt(T0);
    applyTaskUpdate(s, "a", { notes: "hi" }, T0 + 500);
    expect(at(s.tasks, 0, "s.tasks").enteredStatusAt).toBe(T0);
    expect(at(s.tasks, 0, "s.tasks").statusHistory).toHaveLength(1);
  });
  test("a same-status patch does NOT reset the stamp", () => {
    const s = seededAt(T0);
    applyTaskUpdate(s, "a", { status: "todo", notes: "x" }, T0 + 500);
    expect(at(s.tasks, 0, "s.tasks").enteredStatusAt).toBe(T0); // no transition
  });
  test("applyTaskMove stamps a cross-column move", () => {
    const s = seededAt(T0);
    applyTaskMove(s, "a", "doing", 0, T0 + 900);
    expect(at(s.tasks, 0, "s.tasks").enteredStatusAt).toBe(T0 + 900);
    expect(at(s.tasks, 0, "s.tasks").statusHistory?.map((h) => h.status)).toEqual([
      "todo",
      "doing",
    ]);
  });
  test("an intra-column reorder is NOT a transition", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" }, T0);
    applyTaskAdd(s, { id: "b", title: "B", status: "todo" }, T0);
    applyTaskMove(s, "b", "todo", 0, T0 + 900); // reorder within the column
    expect(s.tasks.find((t) => t.id === "b")?.enteredStatusAt).toBe(T0); // unchanged
  });
  test("statusHistory is capped, keeping the most recent transitions", () => {
    const s = seededAt(T0);
    let now = T0;
    for (let i = 0; i < 30; i++) {
      now += 1;
      applyTaskUpdate(s, "a", { status: i % 2 === 0 ? "doing" : "todo" }, now);
    }
    const hist = at(s.tasks, 0, "s.tasks").statusHistory ?? [];
    expect(hist.length).toBeLessThanOrEqual(20);
    expect(hist.at(-1)?.at).toBe(now); // newest kept
  });
});

describe("validateTask transition fields", () => {
  const base = { id: "a", title: "A", status: "todo" as TaskStatus };
  test("preserves a valid enteredStatusAt + statusHistory (restore)", () => {
    const t = validateTask({
      ...base,
      enteredStatusAt: 123,
      statusHistory: [{ status: "todo", at: 123 }],
    });
    expect(t?.enteredStatusAt).toBe(123);
    expect(t?.statusHistory).toEqual([{ status: "todo", at: 123 }]);
  });
  test("drops a non-number enteredStatusAt but keeps the task (legacy-friendly)", () => {
    expect(validateTask({ ...base, enteredStatusAt: "soon" })).toEqual(base);
  });
  test("filters malformed history entries", () => {
    const t = validateTask({
      ...base,
      statusHistory: [
        { status: "todo", at: 1 },
        { status: "bogus", at: 2 },
        { status: "doing" },
        { at: 3 },
      ],
    });
    expect(t?.statusHistory).toEqual([{ status: "todo", at: 1 }]);
  });
});

// ── heartbeat: expected-time + overdue + interval re-poke (#29) ──────────
//
// Opt-in per task via size (S/M/L → 5/10/20 min) or an --expect override. A
// doing task that overruns its expected time pokes its owner, then re-pokes
// once per expected-period until it leaves doing. All pure + clock-injected.

describe("expectedMinutes", () => {
  const t = (over: Partial<Task>): Task => ({ id: "a", title: "A", status: "doing", ...over });
  test("size maps to default minutes (S=5, M=10, L=20)", () => {
    expect(expectedMinutes(t({ size: "S" }))).toBe(5);
    expect(expectedMinutes(t({ size: "M" }))).toBe(10);
    expect(expectedMinutes(t({ size: "L" }))).toBe(20);
  });
  test("expect overrides the size default", () => {
    expect(expectedMinutes(t({ size: "S", expect: 45 }))).toBe(45);
  });
  test("no size/expect → undefined (not watched)", () => {
    expect(expectedMinutes(t({}))).toBeUndefined();
  });
});

describe("computeDuePokes", () => {
  const MIN = 60_000;
  const doing = (over: Partial<Task> = {}): Task => ({
    id: "d",
    title: "D",
    status: "doing",
    owner: "flint",
    size: "S", // 5 min
    enteredStatusAt: 0,
    ...over,
  });

  test("no poke before the expected time elapses", () => {
    expect(computeDuePokes([doing()], new Map(), 4 * MIN).pokes).toHaveLength(0);
  });
  test("fires once the task overruns its expected time", () => {
    const { pokes, pokeState } = computeDuePokes([doing()], new Map(), 6 * MIN);
    expect(pokes).toHaveLength(1);
    expect(pokes[0]).toMatchObject({ taskId: "d", owner: "flint", expectedMinutes: 5 });
    expect(at(pokes, 0, "pokes").overdueByMs).toBe(1 * MIN);
    expect(pokeState.get("d")).toBe(6 * MIN);
  });
  test("does not re-fire on the next sweep within the same interval", () => {
    const { pokes } = computeDuePokes([doing()], new Map([["d", 6 * MIN]]), 7 * MIN);
    expect(pokes).toHaveLength(0);
  });
  test("re-pokes once another expected-period elapses (scales with expected)", () => {
    const { pokes } = computeDuePokes([doing()], new Map([["d", 6 * MIN]]), 11 * MIN);
    expect(pokes).toHaveLength(1);
  });
  test("an unowned overdue task still pokes (owner undefined — caller toasts only)", () => {
    const { pokes } = computeDuePokes([doing({ owner: undefined })], new Map(), 6 * MIN);
    expect(pokes).toHaveLength(1);
    expect(at(pokes, 0, "pokes").owner).toBeUndefined();
  });
  test("a non-doing task is never poked", () => {
    expect(computeDuePokes([doing({ status: "todo" })], new Map(), 100 * MIN).pokes).toHaveLength(
      0,
    );
  });
  test("a task with no size/expect is not watched", () => {
    expect(computeDuePokes([doing({ size: undefined })], new Map(), 100 * MIN).pokes).toHaveLength(
      0,
    );
  });
  test("poke bookkeeping resets when a task leaves doing", () => {
    const { pokeState } = computeDuePokes(
      [doing({ status: "review" })],
      new Map([["d", 6 * MIN]]),
      20 * MIN,
    );
    expect(pokeState.has("d")).toBe(false);
  });
  test("a blocked doing task is not poked even when overdue", () => {
    const blocker: Task = { id: "x", title: "X", status: "doing", enteredStatusAt: 0 };
    const { pokes } = computeDuePokes([doing({ blockedBy: ["x"] }), blocker], new Map(), 100 * MIN);
    expect(pokes.find((p) => p.taskId === "d")).toBeUndefined();
  });
  test("pokes again once the blocker is done", () => {
    const blocker: Task = { id: "x", title: "X", status: "done", enteredStatusAt: 0 };
    const { pokes } = computeDuePokes([doing({ blockedBy: ["x"] }), blocker], new Map(), 100 * MIN);
    expect(pokes.find((p) => p.taskId === "d")).toBeDefined();
  });
});

describe("validateTask size/expect", () => {
  const base = { id: "a", title: "A", status: "todo" as TaskStatus };
  test("accepts a valid size", () => {
    expect(validateTask({ ...base, size: "M" })?.size).toBe("M");
  });
  test("drops an invalid size, keeps the task", () => {
    expect(validateTask({ ...base, size: "XL" })).toEqual(base);
  });
  test("accepts a positive expect; drops 0 / negative / non-number", () => {
    expect(validateTask({ ...base, expect: 30 })?.expect).toBe(30);
    expect(validateTask({ ...base, expect: 0 })).toEqual(base);
    expect(validateTask({ ...base, expect: -5 })).toEqual(base);
    expect(validateTask({ ...base, expect: "soon" })).toEqual(base);
  });
});

// ── the blocker primitive ────────────────────────────────────────────────
//
// ⛔ THIS BLOCK EXISTS BECAUSE THE INVENTORY CLAIMED IT ALREADY DID. bounty's
// behaviour inventory named `scripts/server.test.ts` as the guard for the
// blocked-count row (L5), and this file contained neither `isBlocked` nor
// `liveBlockerCount` — `isBlocked` was reached only THROUGH computeDuePokes and
// cardOverdue, which is coverage of the callers, not of the predicate.
// `liveBlockerCount` was worse: the seam cut (2026-09-06) EXTRACTED it as a new
// exported primitive so the daemon's boolean and the card's "blocked by N"
// could stop being two implementations, and then shipped it with no cell of its
// own in the file the inventory pointed at. Found by the verify pass.
//
// The count is the primitive and the boolean is defined over it, so the cells
// below are written against the count and the boolean is checked for agreement
// at each case rather than re-tested.

describe("liveBlockerCount / isBlocked", () => {
  const t = (id: string, over: Partial<Task> = {}): Task => ({
    id,
    title: id,
    status: "todo",
    ...over,
  });

  test("no blockedBy at all is zero, and not blocked", () => {
    const a = t("a");
    expect(liveBlockerCount(a, [a])).toBe(0);
    expect(isBlocked(a, [a])).toBe(false);
  });

  test("an empty blockedBy is zero — an unblock that removed the last edge", () => {
    const a = t("a", { blockedBy: [] });
    expect(liveBlockerCount(a, [a])).toBe(0);
    expect(isBlocked(a, [a])).toBe(false);
  });

  test("a LIVE blocker counts", () => {
    const a = t("a", { blockedBy: ["b"] });
    const tasks = [a, t("b")];
    expect(liveBlockerCount(a, tasks)).toBe(1);
    expect(isBlocked(a, tasks)).toBe(true);
  });

  test("a DONE blocker does not block", () => {
    const a = t("a", { blockedBy: ["b"] });
    const tasks = [a, t("b", { status: "done" })];
    expect(liveBlockerCount(a, tasks)).toBe(0);
    expect(isBlocked(a, tasks)).toBe(false);
  });

  test("a MISSING blocker does not block — a deleted task cannot hold one back", () => {
    const a = t("a", { blockedBy: ["gone"] });
    expect(liveBlockerCount(a, [a])).toBe(0);
    expect(isBlocked(a, [a])).toBe(false);
  });

  test("the COUNT is what the card renders, so it must count each live edge", () => {
    // The whole reason this is a count and not a boolean: the board says
    // "blocked by 3". A boolean here would have made that a second, unguarded
    // implementation on the surface — which is exactly what it was until the
    // seam cut.
    const a = t("a", { blockedBy: ["b", "c", "d", "done", "gone"] });
    const tasks = [a, t("b"), t("c"), t("d"), t("done", { status: "done" })];
    expect(liveBlockerCount(a, tasks)).toBe(3);
    expect(isBlocked(a, tasks)).toBe(true);
  });

  test("doing/review blockers block; only done clears", () => {
    for (const status of ["todo", "doing", "review"] as const) {
      const a = t("a", { blockedBy: ["b"] });
      expect(liveBlockerCount(a, [a, t("b", { status })])).toBe(1);
    }
    expect(liveBlockerCount(t("a", { blockedBy: ["b"] }), [t("b", { status: "done" })])).toBe(0);
  });

  test("a self-edge is not special-cased — it blocks until the task is done", () => {
    // Not an endorsement: the daemon's cycle guard is what prevents this being
    // created. Pinned so a future change to the guard cannot silently change
    // what an already-persisted snapshot renders.
    const a = t("a", { blockedBy: ["a"] });
    expect(liveBlockerCount(a, [a])).toBe(1);
    const done = t("a", { blockedBy: ["a"], status: "done" });
    expect(liveBlockerCount(done, [done])).toBe(0);
  });
});

// ── card-aging staleness (#2 — surface companion to heartbeat) ───────────
//
// A doing card that overran its expected time reads as "stale" to the human's
// eye. cardOverdue is the canonical, clock-injected decision (the surface
// mirrors it inline, ticking `now` client-side). It returns both overdueByMs
// (for an "Nm over" badge) and ageMs (for a "Doing Nm" badge), so it's
// wording-agnostic. Mirrors heartbeat's opt-in: doing + sized + past expected.

describe("cardOverdue", () => {
  const MIN = 60_000;
  const card = (over: Partial<Task> = {}): Task => ({
    id: "a",
    title: "A",
    status: "doing",
    size: "S", // 5 min
    enteredStatusAt: 0,
    ...over,
  });

  test("null before the expected time elapses", () => {
    expect(cardOverdue(card(), [], 4 * MIN)).toBeNull();
  });
  test("returns overdue-by + age once past the expected time", () => {
    expect(cardOverdue(card(), [], 7 * MIN)).toEqual({ overdueByMs: 2 * MIN, ageMs: 7 * MIN });
  });
  test("null for a doing card with no size/expect (opt-in, mirrors heartbeat)", () => {
    expect(cardOverdue(card({ size: undefined }), [], 100 * MIN)).toBeNull();
  });
  test("null for a non-doing card", () => {
    expect(cardOverdue(card({ status: "review" }), [], 100 * MIN)).toBeNull();
  });
  test("null when the task hasn't been stamped (no enteredStatusAt)", () => {
    expect(cardOverdue(card({ enteredStatusAt: undefined }), [], 100 * MIN)).toBeNull();
  });
  test("expect overrides size for the threshold", () => {
    expect(cardOverdue(card({ size: "S", expect: 10 }), [], 7 * MIN)).toBeNull(); // expect 10 > 7
    expect(cardOverdue(card({ size: "S", expect: 10 }), [], 12 * MIN)?.overdueByMs).toBe(2 * MIN);
  });
  test("null when blocked by a live blocker", () => {
    const blocker: Task = { id: "x", title: "X", status: "doing", enteredStatusAt: 0 };
    expect(cardOverdue(card({ blockedBy: ["x"] }), [blocker], 100 * MIN)).toBeNull();
  });
  test("not blocked once the blocker is done → returns overdue", () => {
    const blocker: Task = { id: "x", title: "X", status: "done", enteredStatusAt: 0 };
    expect(cardOverdue(card({ blockedBy: ["x"] }), [blocker], 100 * MIN)).not.toBeNull();
  });
});

// ── surface filter (surface-filter — human-side view narrowing) ──────────
//
// The board surface lets the human narrow visible cards by tag and/or owner —
// the lens the agent already has via --mine/--owner/--tag. cardPassesFilter is
// the canonical, state-free decision (the inline Alpine surface mirrors it).
// Faceted: OR within a facet (any selected tag matches), AND across facets
// (tag-set AND owner-set). Empty filter sets mean "no filter" → everything
// passes. Hide (not dim) non-matching cards; counts then track the visible set.

describe("cardPassesFilter", () => {
  const card = (over: Partial<Task> = {}): Task => ({
    id: "a",
    title: "A",
    status: "todo",
    ...over,
  });

  test("no active filters → every card passes (default view)", () => {
    expect(cardPassesFilter(card({ tags: ["bug"], owner: "flint" }), [], [])).toBe(true);
    expect(cardPassesFilter(card(), [], [])).toBe(true);
  });

  test("tag facet: a card with a selected tag passes", () => {
    expect(cardPassesFilter(card({ tags: ["bug", "ui"] }), ["bug"], [])).toBe(true);
  });

  test("tag facet: a card without any selected tag is filtered out", () => {
    expect(cardPassesFilter(card({ tags: ["ui"] }), ["bug"], [])).toBe(false);
  });

  test("tag facet OR-within: matching any one selected tag is enough", () => {
    expect(cardPassesFilter(card({ tags: ["ui"] }), ["bug", "ui"], [])).toBe(true);
  });

  test("tag facet: a card with no tags is filtered out by a tag filter", () => {
    expect(cardPassesFilter(card({ tags: undefined }), ["bug"], [])).toBe(false);
    expect(cardPassesFilter(card({ tags: [] }), ["bug"], [])).toBe(false);
  });

  test("owner facet: matching owner passes, non-matching is filtered out", () => {
    expect(cardPassesFilter(card({ owner: "flint" }), [], ["flint"])).toBe(true);
    expect(cardPassesFilter(card({ owner: "tycho" }), [], ["flint"])).toBe(false);
  });

  test("owner facet: a card with no owner is filtered out by an owner filter", () => {
    expect(cardPassesFilter(card({ owner: undefined }), [], ["flint"])).toBe(false);
  });

  test("owner facet OR-within: matching any one selected owner is enough", () => {
    expect(cardPassesFilter(card({ owner: "tycho" }), [], ["flint", "tycho"])).toBe(true);
  });

  test("AND-across facets: both the tag AND owner facet must pass", () => {
    const c = card({ tags: ["bug"], owner: "flint" });
    expect(cardPassesFilter(c, ["bug"], ["flint"])).toBe(true); // both match
    expect(cardPassesFilter(c, ["bug"], ["tycho"])).toBe(false); // tag ok, owner no
    expect(cardPassesFilter(c, ["ui"], ["flint"])).toBe(false); // owner ok, tag no
  });
});

// ── idle-close decision (open-timeout — keep-alive-while-watched) ────────
//
// A board's idle floor (--timeout, default 2h) only counts down while it's
// UNWATCHED. A live subscriber — a WS browser (in `sockets`) or an agent SSE
// tail (in `sseClients`) — keeps it alive indefinitely; the floor means "linger
// this long after the LAST subscriber leaves," not "max idle while connected."
// shouldIdleClose is the clock-free decision; the real sweep also touch()es each
// tick while watched so the floor counts from the last disconnect.

describe("shouldIdleClose", () => {
  const MIN = 60_000;
  const FLOOR = 120 * MIN; // 2h

  test("a watched board never closes, however long it's been idle", () => {
    expect(shouldIdleClose(1, 999 * MIN, FLOOR)).toBe(false);
    expect(shouldIdleClose(3, 999 * MIN, FLOOR)).toBe(false);
  });
  test("unwatched + past the floor → closes", () => {
    expect(shouldIdleClose(0, 121 * MIN, FLOOR)).toBe(true);
  });
  test("unwatched but under the floor → stays open", () => {
    expect(shouldIdleClose(0, 60 * MIN, FLOOR)).toBe(false);
  });
  test("unwatched exactly at the floor → closes (>=)", () => {
    expect(shouldIdleClose(0, FLOOR, FLOOR)).toBe(true);
  });
});

// ── per-owner WIP cue (wip-cue — soft, non-blocking pileup nudge) ────────
//
// A soft signal: an owner with >= threshold cards in DOING gets a gentle "wrap
// one before pulling more" cue on those cards. Per-OWNER (parallel owners each
// under the limit never trip it); UNOWNED doing cards have no worker, so they're
// excluded and don't count toward any tally. ownersOverWip is the pure decision
// (the inline Alpine surface mirrors it); a card shows the cue iff it's in doing
// AND its owner is in this set. Never blocks the move — purely visual.

describe("ownersOverWip", () => {
  const doing = (id: string, owner?: string, status: TaskStatus = "doing"): Task => ({
    id,
    title: id,
    status,
    owner,
  });

  test("an owner with >= threshold cards in Doing is flagged", () => {
    expect(ownersOverWip([doing("a", "flint"), doing("b", "flint")], 2).has("flint")).toBe(true);
  });
  test("an owner with fewer than threshold is not flagged", () => {
    expect(ownersOverWip([doing("a", "flint")], 2).has("flint")).toBe(false);
  });
  test("unowned Doing cards have no worker — excluded, never counted", () => {
    expect(ownersOverWip([doing("a"), doing("b")], 2).size).toBe(0);
  });
  test("only Doing cards count toward the tally", () => {
    // 1 in doing + 1 in todo = 1 in doing → under the limit
    expect(ownersOverWip([doing("a", "flint"), doing("b", "flint", "todo")], 2).has("flint")).toBe(
      false,
    );
  });
  test("per-owner: parallel owners each under the limit don't trip it", () => {
    expect(ownersOverWip([doing("a", "flint"), doing("b", "tycho")], 2).size).toBe(0);
  });
  test("threshold boundary: exactly threshold flags, one under doesn't", () => {
    expect(ownersOverWip([doing("a", "f"), doing("b", "f"), doing("c", "f")], 3).has("f")).toBe(
      true,
    );
    expect(ownersOverWip([doing("a", "f"), doing("b", "f")], 3).has("f")).toBe(false);
  });
  test("flags only the over-limit owner among mixed owners", () => {
    const set = ownersOverWip([doing("a", "flint"), doing("b", "flint"), doing("c", "tycho")], 2);
    expect(set.has("flint")).toBe(true);
    expect(set.has("tycho")).toBe(false);
  });
});

// ── no-op guards (isNoOpUpdate / isNoOpMove) ─────────────────────────────
//
// A redundant patch (doing->doing) or a drag landing in the same status+index
// must be recognized as a no-op so the daemon can skip the broadcast + event
// — otherwise every such call spuriously wakes every scoped tail (#23).

describe("isNoOpUpdate", () => {
  function seed(): BoardState {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "doing", notes: "n", owner: "w1" });
    return s;
  }
  test("true when the patch changes nothing (doing->doing)", () => {
    expect(isNoOpUpdate(seed(), "a", { status: "doing" })).toBe(true);
  });
  test("true for a multi-field patch that matches current values", () => {
    expect(isNoOpUpdate(seed(), "a", { status: "doing", notes: "n", owner: "w1" })).toBe(true);
  });
  test("false when any field actually changes (doing->done)", () => {
    expect(isNoOpUpdate(seed(), "a", { status: "done" })).toBe(false);
  });
  test("false when one field of a multi-field patch differs", () => {
    expect(isNoOpUpdate(seed(), "a", { status: "doing", notes: "changed" })).toBe(false);
  });
  test("treats a dropped invalid status as no-op (nothing valid left to apply)", () => {
    // applyTaskUpdate strips an invalid status; a status-only bogus patch is a no-op.
    expect(isNoOpUpdate(seed(), "a", { status: "bogus" as TaskStatus })).toBe(true);
  });
  test("false for a missing task (not a no-op — let the apply path report not-found)", () => {
    expect(isNoOpUpdate(seed(), "missing", { status: "doing" })).toBe(false);
  });
});

describe("isNoOpMove", () => {
  function seed(): BoardState {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    applyTaskAdd(s, { id: "b", title: "B", status: "todo" });
    applyTaskAdd(s, { id: "c", title: "C", status: "doing" });
    applyTaskAdd(s, { id: "d", title: "D", status: "doing" });
    return s;
  }
  test("true for a drag landing in the same status+index (a is todo[0])", () => {
    expect(isNoOpMove(seed(), "a", "todo", 0)).toBe(true);
  });
  test("true for the second card dropped back on its own slot (b is todo[1])", () => {
    expect(isNoOpMove(seed(), "b", "todo", 1)).toBe(true);
  });
  test("false for an intra-column reorder (b todo[1] -> todo[0])", () => {
    expect(isNoOpMove(seed(), "b", "todo", 0)).toBe(false);
  });
  test("false for a cross-column move even at a matching index (a todo[0] -> doing[0])", () => {
    expect(isNoOpMove(seed(), "a", "doing", 0)).toBe(false);
  });
  test("true when an out-of-range index clamps back onto the card's own last slot (d is doing[1])", () => {
    expect(isNoOpMove(seed(), "d", "doing", 99)).toBe(true);
  });
  test("false for a missing task", () => {
    expect(isNoOpMove(seed(), "missing", "todo", 0)).toBe(false);
  });
});

// ── validateTask (the shared task-shape trust boundary) ──────────────────

describe("validateTask", () => {
  test("accepts a well-formed task and passes notes through", () => {
    expect(validateTask({ id: "a", title: "A", status: "doing", notes: "n" })).toEqual({
      id: "a",
      title: "A",
      status: "doing",
      notes: "n",
    });
  });
  test("accepts without notes (omits the field)", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo" })).toEqual({
      id: "a",
      title: "A",
      status: "todo",
    });
  });
  test("rejects missing id / title", () => {
    expect(validateTask({ title: "A", status: "todo" })).toBeNull();
    expect(validateTask({ id: "a", status: "todo" })).toBeNull();
  });
  test("rejects invalid / missing status", () => {
    expect(validateTask({ id: "a", title: "A", status: "bogus" })).toBeNull();
    expect(validateTask({ id: "a", title: "A" })).toBeNull();
  });
  test("rejects non-string notes", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", notes: 42 })).toBeNull();
  });
  test("carries an owner when present (string)", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", owner: "worker1" })).toEqual({
      id: "a",
      title: "A",
      status: "todo",
      owner: "worker1",
    });
  });
  test("rejects non-string owner", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", owner: 42 })).toBeNull();
  });
  test("carries blockedBy when present (string array)", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", blockedBy: ["b1", "b2"] })).toEqual({
      id: "a",
      title: "A",
      status: "todo",
      blockedBy: ["b1", "b2"],
    });
  });
  test("rejects non-array blockedBy or non-string members", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", blockedBy: "b1" })).toBeNull();
    expect(validateTask({ id: "a", title: "A", status: "todo", blockedBy: [1, 2] })).toBeNull();
  });
  test("rejects non-objects", () => {
    expect(validateTask(null)).toBeNull();
    expect(validateTask("nope")).toBeNull();
    expect(validateTask(undefined)).toBeNull();
  });
});

// ── task tags (#18: cleanTags + validateTask) ────────────────────────────
//
// Tags are a clean string[] on the canonical task: strings only, trimmed,
// deduped, no empties, case preserved (display), field omitted when empty so
// snapshots stay clean and legacy tasks load fine. cleanTags is the shared
// sanitizer; validateTask applies it at the trust boundary.

describe("cleanTags", () => {
  test("passes a clean list through, case preserved", () => {
    expect(cleanTags(["FrontEnd", "bug"])).toEqual(["FrontEnd", "bug"]);
  });
  test("drops non-string entries", () => {
    expect(cleanTags(["a", 42, null, undefined, {}, "b"])).toEqual(["a", "b"]);
  });
  test("trims each and drops empties / whitespace-only", () => {
    expect(cleanTags([" a ", "", "   ", "b "])).toEqual(["a", "b"]);
  });
  test("dedupes exactly (case-sensitive — preserves both casings)", () => {
    expect(cleanTags(["Bug", "bug", "Bug"])).toEqual(["Bug", "bug"]);
  });
  test("a non-array yields an empty list", () => {
    expect(cleanTags("foo")).toEqual([]);
    expect(cleanTags(undefined)).toEqual([]);
    expect(cleanTags(42)).toEqual([]);
  });
});

describe("validateTask tags", () => {
  const base = { id: "a", title: "A", status: "todo" as TaskStatus };
  test("accepts and cleans tags", () => {
    expect(validateTask({ ...base, tags: [" frontend ", "frontend", 7, "bug"] })).toEqual({
      ...base,
      tags: ["frontend", "bug"],
    });
  });
  test("omits the tags field when it cleans to empty (snapshot stays clean)", () => {
    expect(validateTask({ ...base, tags: ["", "   ", 9] })).toEqual(base);
    expect(validateTask({ ...base, tags: [] })).toEqual(base);
  });
  test("a non-array tags value is dropped, the task still validates (legacy-friendly)", () => {
    expect(validateTask({ ...base, tags: "frontend" })).toEqual(base);
  });
  test("a task without tags is unchanged (legacy loads fine)", () => {
    expect(validateTask(base)).toEqual(base);
  });
});

// ── parsePortFromSessionId ───────────────────────────────────────────────

describe("parsePortFromSessionId", () => {
  test("extracts trailing -p<port>", () => {
    expect(parsePortFromSessionId("bounty-abc-p54321")).toBe(54321);
  });
  test("returns null when no -p suffix", () => {
    expect(parsePortFromSessionId("bounty-abc")).toBeNull();
  });
  test("returns null for empty input", () => {
    expect(parsePortFromSessionId("")).toBeNull();
  });
  test("rejects out-of-range port", () => {
    expect(parsePortFromSessionId("bounty-abc-p99999")).toBeNull();
  });
});

// ── htmlEscape ───────────────────────────────────────────────────────────

describe("htmlEscape", () => {
  test("escapes the five interesting chars", () => {
    expect(htmlEscape(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#x27;");
  });
  test("ampersand-first ordering avoids double-escape", () => {
    expect(htmlEscape("<&>")).toBe("&lt;&amp;&gt;");
  });
});

describe("close dismiss", () => {
  // The board is a conjuration ("stands until dismissed"). The old submit/cancel
  // pair collapsed to a single browser "Close board" dismiss: the daemon exits 0
  // (a clean dismiss, never the 130 a "cancel" used to mean), the canonical state
  // is already live to every consumer (+ snapshotted), and all clients get the
  // uniform "session ended" signal before the socket closes.
  test("browser close dismisses the board: exit 0 + session-ended to clients", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "init",
      title: "dismiss-test",
      tasks: [{ id: "x", title: "X", status: "todo" }],
    });

    const browser = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => browser.addEventListener("open", r, { once: true }));
    const msgsP = collectWsUntilClose(browser);

    browser.send(JSON.stringify({ type: "close" }));
    const browserMsgs = await msgsP;
    const code = await proc.exited;

    // Clean dismiss = exit 0 (not 130).
    expect(code).toBe(0);
    // No "submit" or "cancel" frames anymore — the uniform end signal is the
    // "session ended" message broadcast before the socket closes.
    expect(browserMsgs.find((m) => m.type === "submit")).toBeUndefined();
    expect(browserMsgs.find((m) => m.type === "cancel")).toBeUndefined();
    const ended = browserMsgs.find(
      (m) => m.type === "message" && (m.text || "").startsWith("session ended:"),
    );
    expect(ended).toBeDefined();
  }, 15000);
});

describe("input validation from browser", () => {
  test("task.edit with non-string title is rejected silently", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "init",
      title: "T",
      tasks: [{ id: "x", title: "original", status: "todo" }],
    });

    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const msgsP = collectWsUntilClose(ws);

    // Bad edits — should all be silently dropped.
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: null }));
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: 42 }));
    ws.send(JSON.stringify({ type: "task.edit", id: "x" })); // missing title
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: "" })); // empty
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: "   " })); // whitespace
    // Good edit — should land.
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: "updated" }));
    ws.send(JSON.stringify({ type: "close" })); // dismiss to end the session
    const msgs = await msgsP;
    await proc.exited;

    const titleUpdates = msgs.filter(
      (m) => m.type === "task.update" && m.patch?.title !== undefined,
    );
    expect(titleUpdates).toHaveLength(1);
    expect(
      must(at(titleUpdates, 0, "titleUpdates").patch, "the filter kept only updates with a patch")
        .title,
    ).toBe("updated");
  }, 15000);

  test("task.add from browser with missing fields is rejected", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const msgsP = collectWsUntilClose(ws);

    // All bad — should be silently dropped.
    ws.send(JSON.stringify({ type: "task.add", task: { id: "a" } })); // no title/status
    ws.send(JSON.stringify({ type: "task.add", task: { id: "b", title: "B" } })); // no status
    ws.send(JSON.stringify({ type: "task.add", task: { id: "c", title: "C", status: "bogus" } })); // bad status
    ws.send(JSON.stringify({ type: "task.add", task: { id: 42, title: "D", status: "todo" } })); // bad id type
    // Good — should land.
    ws.send(JSON.stringify({ type: "task.add", task: { id: "ok", title: "OK", status: "todo" } }));
    ws.send(JSON.stringify({ type: "close" })); // dismiss to end the session
    const msgs = await msgsP;
    await proc.exited;

    const adds = msgs.filter((m) => m.type === "task.add");
    expect(adds).toHaveLength(1);
    expect(must(at(adds, 0, "adds").task, "a task.add frame carries its task").id).toBe("ok");
  }, 15000);
});

// ── task.edit notes (#19: the modal's editable description) ───────────────
//
// The browser used to edit titles only (task.edit carried `title`). card-detail
// extends it to {id, title?, notes?} so the detail modal can persist an edited
// description over the same verb. Notes are re-sanitized server-side: a string
// (empty allowed — clears), non-strings rejected; the existing title path and
// its non-empty guard are unchanged.

describe("task.edit notes (card-detail #19)", () => {
  async function editAndReadNotes(
    seedNotes: string | undefined,
    edit: Record<string, unknown>,
  ): Promise<string | undefined> {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "init",
      title: "T",
      tasks: [
        {
          id: "x",
          title: "X",
          status: "todo",
          ...(seedNotes !== undefined ? { notes: seedNotes } : {}),
        },
      ],
    });
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.send(JSON.stringify({ type: "task.edit", id: "x", ...edit }));
    await new Promise((r) => setTimeout(r, 200));
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    ws.close();
    proc.kill();
    await proc.exited;
    return body.state.tasks[0]?.notes;
  }

  test("sets notes from the modal (round-trips to canonical state)", async () => {
    expect(await editAndReadNotes("old", { notes: "a new description" })).toBe("a new description");
  }, 15000);

  test("an empty-string notes clears the description", async () => {
    expect(await editAndReadNotes("old", { notes: "" })).toBe("");
  }, 15000);

  test("a non-string notes is rejected silently (notes unchanged)", async () => {
    expect(await editAndReadNotes("keep me", { notes: 42 })).toBe("keep me");
  }, 15000);

  test("title + notes in one edit both land", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "init",
      title: "T",
      tasks: [{ id: "x", title: "old title", status: "todo", notes: "old notes" }],
    });
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: "new title", notes: "new notes" }));
    await new Promise((r) => setTimeout(r, 200));
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    ws.close();
    proc.kill();
    await proc.exited;
    expect(at(body.state.tasks, 0, "body.state.tasks").title).toBe("new title");
    expect(at(body.state.tasks, 0, "body.state.tasks").notes).toBe("new notes");
  }, 15000);

  test("a notes-only edit leaves a non-empty title untouched", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "init",
      title: "T",
      tasks: [{ id: "x", title: "keep title", status: "todo" }],
    });
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.send(JSON.stringify({ type: "task.edit", id: "x", notes: "added a note" }));
    await new Promise((r) => setTimeout(r, 200));
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    ws.close();
    proc.kill();
    await proc.exited;
    expect(at(body.state.tasks, 0, "body.state.tasks").title).toBe("keep title");
    expect(at(body.state.tasks, 0, "body.state.tasks").notes).toBe("added a note");
  }, 15000);
});

// ── Daemon HTTP surface (house pattern: /cmd + /state + /events) ──────────
//
// These exercise the agent-facing HTTP surface directly against a spawned
// server (fetch, not WebSocket). The WS path (browsers + join.ts) is unchanged
// and covered by the broadcast/validation suites above.

describe("GET /state", () => {
  test("returns { state, cursor } for a fresh board", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5", "--title", "state-test"]);
    const res = await fetch(`${ready.url}/state`);
    const body = (await res.json()) as { state?: BoardState; cursor?: number };
    proc.kill();
    await proc.exited;

    expect(res.status).toBe(200);
    expect(body.state).toBeDefined();
    expect(body.state?.title).toBe("state-test");
    expect(body.state?.tasks).toEqual([]);
    expect(typeof body.cursor).toBe("number");
  }, 15000);
});

describe("POST /cmd", () => {
  async function postCmd(url: string, body: unknown) {
    return fetch(`${url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("task.add is applied and reflected in /state (the #8 ack)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const res = await postCmd(ready.url, {
      type: "task.add",
      task: { id: "t1", title: "first task", status: "todo" },
    });
    const ack = (await res.json()) as { ok?: boolean };
    const stateRes = await fetch(`${ready.url}/state`);
    const body = (await stateRes.json()) as { state: BoardState; cursor: number };
    proc.kill();
    await proc.exited;

    expect(res.status).toBe(200);
    expect(ack.ok).toBe(true);
    expect(body.state.tasks).toHaveLength(1);
    expect(body.state.tasks[0]).toMatchObject({ id: "t1", title: "first task", status: "todo" });
  }, 15000);

  test("task.update patches an existing task", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, {
      type: "task.add",
      task: { id: "t1", title: "first", status: "todo" },
    });
    await postCmd(ready.url, { type: "task.update", id: "t1", patch: { status: "doing" } });
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    proc.kill();
    await proc.exited;

    expect(at(body.state.tasks, 0, "body.state.tasks").status).toBe("doing");
    expect(at(body.state.tasks, 0, "body.state.tasks").title).toBe("first");
  }, 15000);

  test("a status transition stamps enteredStatusAt + grows history (live path)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, { type: "task.add", task: { id: "t1", title: "T", status: "todo" } });
    const before = at(
      ((await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState }).state.tasks,
      0,
      "the board holds the task this test added",
    );
    // Stamped on add.
    expect(typeof before.enteredStatusAt).toBe("number");
    expect(before.statusHistory).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    await postCmd(ready.url, { type: "task.update", id: "t1", patch: { status: "doing" } });
    const after = at(
      ((await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState }).state.tasks,
      0,
      "the board holds the task this test added",
    );
    proc.kill();
    await proc.exited;

    expect(after.status).toBe("doing");
    expect(after.enteredStatusAt ?? 0).toBeGreaterThanOrEqual(before.enteredStatusAt ?? 0);
    expect(after.statusHistory).toHaveLength(2);
    expect(after.statusHistory?.at(-1)?.status).toBe("doing");
  }, 15000);

  test("malformed JSON returns 400 { error }", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const res = await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const body = (await res.json()) as { error?: string };
    proc.kill();
    await proc.exited;

    expect(res.status).toBe(400);
    expect(body.error).toBeDefined();
  }, 15000);

  // The daemon is the canonical-state trust boundary: the agent /cmd path must
  // narrow task shapes as strictly as the browser WS path does, not just dedupe
  // ids / filter by status. (Review finding #1.)
  test("init filters malformed tasks (missing id/title), not just bad status", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, {
      type: "init",
      title: "guarded",
      tasks: [
        { id: "good", title: "Good", status: "todo" },
        { status: "todo" }, // no id/title — must be filtered
        { id: "x", status: "todo" }, // no title — must be filtered
        { id: "y", title: "bad status", status: "bogus" }, // invalid status — filtered
      ],
    });
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    proc.kill();
    await proc.exited;

    expect(body.state.tasks).toHaveLength(1);
    expect(at(body.state.tasks, 0, "body.state.tasks").id).toBe("good");
  }, 15000);

  test("task.add rejects a malformed task — nothing stored", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, { type: "task.add", task: {} });
    await postCmd(ready.url, { type: "task.add", task: { id: "n", status: "todo" } }); // no title
    await postCmd(ready.url, { type: "task.add", task: { id: "m", title: "T", status: "bogus" } });
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    proc.kill();
    await proc.exited;

    expect(body.state.tasks).toHaveLength(0);
  }, 15000);

  test("task.add accepts a well-formed task (with optional notes)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, {
      type: "task.add",
      task: { id: "ok", title: "fine", status: "doing", notes: "a note" },
    });
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    proc.kill();
    await proc.exited;

    expect(body.state.tasks).toHaveLength(1);
    expect(body.state.tasks[0]).toMatchObject({
      id: "ok",
      title: "fine",
      status: "doing",
      notes: "a note",
    });
  }, 15000);
});

describe("GET /events (SSE)", () => {
  // Read SSE `data:` frames from a /events stream until `predicate` matches or
  // `maxMs` elapses. Returns the decoded JSON frames seen (in order).
  async function collectEvents(
    url: string,
    since: number,
    predicate: (ev: Record<string, unknown>) => boolean,
    maxMs: number,
  ): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${url}/events?since=${since}`);
    if (!res.body) throw new Error("no SSE body");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const seen: Record<string, unknown>[] = [];
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            seen.push(ev);
            if (predicate(ev)) {
              reader.cancel();
              return seen;
            }
          } catch {
            /* skip */
          }
        }
      }
    }
    reader.cancel();
    return seen;
  }

  test("a browser task.toggle emits a frame with monotonic id + taskId (no id collision)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    // Seed a task via /cmd so there's something to toggle.
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "task.add", task: { id: "t1", title: "T", status: "todo" } }),
    });

    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));

    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.toggle", 4000);
    // tiny delay so the SSE stream is subscribed before we mutate
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: "task.toggle", id: "t1", status: "doing" }));

    const events = await evP;
    ws.close();
    proc.kill();
    await proc.exited;

    const toggle = events.find((e) => e.type === "task.toggle");
    expect(toggle).toBeDefined();
    // The envelope id is the monotonic event cursor — NOT the task id.
    expect(typeof toggle?.id).toBe("number");
    // The task identifier is carried as `taskId` (item-2 rename) so the spread
    // can't clobber the cursor.
    expect(toggle?.taskId).toBe("t1");
    expect(toggle?.status).toBe("doing");
    // Browser-origin frames are stamped by:"user".
    expect(toggle?.by).toBe("user");
  }, 15000);

  test("an agent /cmd write emits a frame stamped by:agent (Model B)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.add", 4000);
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "task.add", task: { id: "a1", title: "A", status: "todo" } }),
    });
    const events = await evP;
    proc.kill();
    await proc.exited;

    const add = events.find((e) => e.type === "task.add");
    expect(add).toBeDefined();
    // Model B: agent /cmd writes reach the event log so scoped tails (Phase C)
    // can wake on agent-to-agent coordination.
    expect(add?.by).toBe("agent");
    expect((add?.task as Task).id).toBe("a1");
    expect(typeof add?.id).toBe("number");
  }, 15000);

  test("replays only events with id > since (resume cursor)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    // Two writes before any tail connects.
    for (const id of ["c1", "c2"]) {
      await fetch(`${ready.url}/cmd`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "task.add", task: { id, title: id, status: "todo" } }),
      });
    }
    // Cursor after both writes.
    const { cursor } = (await (await fetch(`${ready.url}/state`)).json()) as { cursor: number };
    // A third write after we capture the cursor.
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "task.add", task: { id: "c3", title: "c3", status: "todo" } }),
    });
    // Connecting with since=cursor must replay only c3, not c1/c2.
    const events = await collectEvents(
      ready.url,
      cursor,
      (ev) => ev.type === "task.add" && (ev.task as Task)?.id === "c3",
      4000,
    );
    proc.kill();
    await proc.exited;

    const addIds = events.filter((e) => e.type === "task.add").map((e) => (e.task as Task).id);
    expect(addIds).toContain("c3");
    expect(addIds).not.toContain("c1");
    expect(addIds).not.toContain("c2");
  }, 15000);

  // Phase C: the `by` stamp carries the caller's --as identity (set up in A),
  // and task.* frames carry the affected task's owner so cli.ts tail can scope
  // client-side. by is a cooperative attribution, never a security boundary.
  test("/cmd stamps `by` from the caller's `as` and carries owner on the frame", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.add", 4000);
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "task.add",
        as: "lead",
        task: { id: "o1", title: "owned", status: "todo", owner: "worker1" },
      }),
    });
    const events = await evP;
    proc.kill();
    await proc.exited;

    const add = events.find((e) => e.type === "task.add");
    expect(add?.by).toBe("lead"); // actor identity, not the hardcoded "agent"
    expect(add?.owner).toBe("worker1"); // affected task's owner, on the frame
  }, 15000);

  test("a browser mutation carries the task's owner on the frame too", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "task.add",
        task: { id: "t1", title: "T", status: "todo", owner: "worker2" },
      }),
    });
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.toggle", 4000);
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: "task.toggle", id: "t1", status: "doing" }));
    const events = await evP;
    ws.close();
    proc.kill();
    await proc.exited;

    const toggle = events.find((e) => e.type === "task.toggle");
    expect(toggle?.by).toBe("user");
    expect(toggle?.owner).toBe("worker2"); // owner stamped so an owner-scoped tail wakes
  }, 15000);

  // #23: a redundant patch / drag-in-place must NOT reach the event log. We
  // prove the negative with a real "fence" event sent right after the no-op:
  // the fence arrives, and no task.update/task.move for the no-op precedes it.
  test("a redundant doing->doing /cmd update emits no event (no-op guard)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "task.add",
      task: { id: "t1", title: "T", status: "doing" }, // already doing → doing->doing is a no-op
    });
    const evP = collectEvents(
      ready.url,
      0,
      (ev) => ev.type === "task.add" && (ev.task as Task)?.id === "fence",
      4000,
    );
    await new Promise((r) => setTimeout(r, 150));
    await seedCmd(ready.url, { type: "task.update", id: "t1", patch: { status: "doing" } }); // no-op
    await seedCmd(ready.url, {
      type: "task.add",
      task: { id: "fence", title: "F", status: "todo" }, // real event, the fence
    });
    const events = await evP;
    proc.kill();
    await proc.exited;

    expect(events.some((e) => e.type === "task.add" && (e.task as Task)?.id === "fence")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "task.update" && e.taskId === "t1")).toBe(false);
  }, 15000);

  test("a drag landing in the same status+index emits no task.move event (no-op guard)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "init",
      title: "T",
      tasks: [
        { id: "c", title: "C", status: "doing" }, // doing[0]
        { id: "d", title: "D", status: "doing" }, // doing[1]
      ],
    });
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.toggle", 4000);
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: "task.move", id: "c", status: "doing", index: 0 })); // c already doing[0] → no-op
    ws.send(JSON.stringify({ type: "task.toggle", id: "d", status: "review" })); // real fence event
    const events = await evP;
    ws.close();
    proc.kill();
    await proc.exited;

    expect(events.some((e) => e.type === "task.toggle" && e.taskId === "d")).toBe(true);
    expect(events.some((e) => e.type === "task.move")).toBe(false);
  }, 15000);
});

describe("ownership claim guard (Phase C)", () => {
  async function cmd(url: string, body: unknown) {
    const res = await fetch(`${url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
  async function state(url: string) {
    return (await (await fetch(`${url}/state`)).json()) as { state: BoardState };
  }

  test("a cooperative claim on an other-owned task is rejected + reported (apply-result)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await cmd(ready.url, {
      type: "task.add",
      task: { id: "x", title: "X", status: "todo", owner: "alice" },
    });
    // bob tries to claim alice's task
    const res = await cmd(ready.url, {
      type: "task.update",
      id: "x",
      patch: { owner: "bob" },
      as: "bob",
      claim: true,
    });
    const s = await state(ready.url);
    proc.kill();
    await proc.exited;

    // /cmd reports the apply result so cli.ts can surface a rejection (#2 slice).
    expect(res.data.applied).toBe(false);
    expect(String(res.data.error)).toContain("alice");
    // State is unchanged — no silent steal.
    expect(at(s.state.tasks, 0, "s.state.tasks").owner).toBe("alice");
  }, 15000);

  test("claiming an unowned task succeeds", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await cmd(ready.url, { type: "task.add", task: { id: "x", title: "X", status: "todo" } });
    const res = await cmd(ready.url, {
      type: "task.update",
      id: "x",
      patch: { owner: "bob" },
      as: "bob",
      claim: true,
    });
    const s = await state(ready.url);
    proc.kill();
    await proc.exited;

    expect(res.data.applied).toBe(true);
    expect(at(s.state.tasks, 0, "s.state.tasks").owner).toBe("bob");
  }, 15000);

  test("lead update --owner always wins (no claim flag) — reassignment", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await cmd(ready.url, {
      type: "task.add",
      task: { id: "x", title: "X", status: "todo", owner: "alice" },
    });
    // lead reassigns to bob — no claim flag, always applies
    const res = await cmd(ready.url, {
      type: "task.update",
      id: "x",
      patch: { owner: "bob" },
      as: "lead",
    });
    const s = await state(ready.url);
    proc.kill();
    await proc.exited;

    expect(res.data.applied).toBe(true);
    expect(at(s.state.tasks, 0, "s.state.tasks").owner).toBe("bob");
  }, 15000);
});

// ── tail session pinning (#tail-pin: cross-project hijack guard) ─────────
//
// An unpinned long-lived `tail` used to re-resolve the GLOBAL `latest` pointer
// on every reconnect, so a newer board opening on the host silently hijacked
// the stream (dream-flute BUG 1: the lead received another project's events).
// pickTailSession locks onto the first session it resolves; thereafter it reads
// THAT session's own file, never `latest`. Pure (readSession injected) so this
// is deterministic and never touches the real, race-prone global pointer.

describe("pickTailSession (tail pin — cross-project hijack guard)", () => {
  const boardA: Session = { url: "http://127.0.0.1:1", port: 1, session_id: "A", title: "A" };
  const boardB: Session = { url: "http://127.0.0.1:2", port: 2, session_id: "B", title: "B" };
  // Models readSession: read(undefined) follows the global `latest` pointer;
  // read("A")/read("B") read that session's own (pinned) discovery file.
  const reader = (latest: Session | null) => (s: string | undefined) => {
    if (s === undefined) return latest;
    if (s === "A") return boardA;
    if (s === "B") return boardB;
    return null;
  };

  test("unpinned: pins the first session it resolves off `latest`", () => {
    const r = pickTailSession(undefined, reader(boardA));
    expect(r?.pinned).toBe("A");
    expect(r?.session.port).toBe(1);
  });

  test("once pinned, a newer board on `latest` does NOT hijack the tail", () => {
    const r1 = pickTailSession(undefined, reader(boardA)); // pins to A
    expect(r1?.pinned).toBe("A");
    // Board B opens and becomes `latest`; the tail reconnects with its pin.
    const r2 = pickTailSession(r1?.pinned, reader(boardB));
    // Still A (port 1). The old read-latest-each-reconnect logic gave B (port 2).
    expect(r2?.pinned).toBe("A");
    expect(r2?.session.port).toBe(1);
  });

  test("an explicit --session is pinned from the start, ignoring `latest`", () => {
    const r = pickTailSession("A", reader(boardB)); // latest=B but pinned to A
    expect(r?.pinned).toBe("A");
    expect(r?.session.port).toBe(1);
  });

  test("returns null when nothing resolves yet (no board up)", () => {
    expect(pickTailSession(undefined, reader(null))).toBeNull();
  });
});

// ── resolveSession (session targeting precedence — #59) ──────────────────
//
// An un-pinned verb must NOT silently fall onto a stranger board that merely
// opened more recently. resolveSession picks the target in precedence order:
// --session flag > $BOUNTY_SESSION > nearest `.bounty-session` (walking up from
// cwd) > undefined (caller falls back to the `latest` pointer). env/startDir/
// readFile are injected (like pickTailSession's `read`) so precedence is pure
// and testable without a real cwd/filesystem.

describe("resolveSession (session targeting precedence)", () => {
  // A file-reader over a { path: contents } map — everything else is absent.
  const reader = (files: Record<string, string>) => (p: string) => files[p] ?? null;
  const noFiles = reader({});

  test("explicit --session flag wins over everything", () => {
    expect(
      resolveSession(
        { session: "flag-id" },
        { BOUNTY_SESSION: "env-id" },
        "/a/b/c",
        reader({ "/a/b/c/.bounty-session": "file-id" }),
      ),
    ).toBe("flag-id");
  });

  test("$BOUNTY_SESSION used when no flag (over the file)", () => {
    expect(
      resolveSession(
        {},
        { BOUNTY_SESSION: "env-id" },
        "/a/b/c",
        reader({ "/a/b/c/.bounty-session": "file-id" }),
      ),
    ).toBe("env-id");
  });

  test("nearest walked-up .bounty-session used when no flag/env", () => {
    // Marker lives at /a, cwd is /a/b/c → walk up finds it.
    expect(resolveSession({}, {}, "/a/b/c", reader({ "/a/.bounty-session": "  file-id\n" }))).toBe(
      "file-id",
    ); // trimmed
  });

  test("undefined when nothing resolves (falls back to `latest`)", () => {
    expect(resolveSession({}, {}, "/a/b/c", noFiles)).toBeUndefined();
  });

  test("an empty/whitespace .bounty-session keeps walking up", () => {
    expect(
      resolveSession(
        {},
        {},
        "/a/b/c",
        reader({ "/a/b/c/.bounty-session": "   \n", "/a/.bounty-session": "root-id" }),
      ),
    ).toBe("root-id");
  });
});

// ── caller-owned session keys (#69) ──────────────────────────────────────
//
// A coordinating caller binds every command to ITS board via a key IT chooses.
// The key isn't stored opaquely — it DERIVES a stable, project-scoped board id,
// so the existing bounty-<id>.json machinery is reused unchanged. Same key +
// same repo → same id (idempotent attach / intended share); same key + a
// different repo → a different id (the collision guard). All pure/injectable.

describe("session keys (caller-owned board binding — #69)", () => {
  // A `.git`-presence probe over an allow-list of paths — everything else absent.
  const gitAt = (present: string[]) => (p: string) => present.includes(p);

  test("slugifyKey: filesystem-safe, lowercased, trimmed, capped", () => {
    expect(slugifyKey("Anthill Team!")).toBe("anthill-team");
    expect(slugifyKey("  a//b  ")).toBe("a-b");
    expect(slugifyKey("***")).toBe(""); // no alnum → empty slug
    expect(slugifyKey("x".repeat(50)).length).toBe(32); // capped
  });

  test("findScopeRoot: nearest ancestor with .git, else the start dir", () => {
    expect(findScopeRoot("/a/b/c", gitAt(["/a/.git"]))).toBe("/a"); // walked up to repo root
    expect(findScopeRoot("/a/b/c", gitAt(["/a/b/c/.git"]))).toBe("/a/b/c"); // root is the cwd
    expect(findScopeRoot("/a/b/c", gitAt([]))).toBe("/a/b/c"); // no repo → cwd is the scope
  });

  test("deriveSessionId: deterministic, legible, scope-sensitive", () => {
    const idA = deriveSessionId("team", "/repo/a");
    expect(idA).toBe(deriveSessionId("team", "/repo/a")); // stable across calls
    expect(idA.startsWith("k-team-")).toBe(true); // legible slug + `k-` marker
    expect(deriveSessionId("team", "/repo/b")).not.toBe(idA); // different scope → different board
    expect(deriveSessionId("***", "/repo/a").startsWith("k-")).toBe(true); // empty slug still valid
  });

  test("sessionKeyToId: open-at-root and a verb-in-subdir derive the SAME id", () => {
    const present = gitAt(["/repo/.git"]);
    const atRoot = sessionKeyToId("team", "/repo", present);
    const atSubdir = sessionKeyToId("team", "/repo/pkg/x", present);
    expect(atSubdir).toBe(atRoot); // both resolve scope to /repo → identical board
  });

  test("resolveSession: --session-key derives, at the top of precedence", () => {
    const present = gitAt(["/repo/.git"]);
    expect(
      resolveSession({ "session-key": "team", session: "raw" }, {}, "/repo/x", () => null, present),
    ).toBe(sessionKeyToId("team", "/repo/x", present)); // key beats a raw --session
  });

  test("resolveSession: $BOUNTY_SESSION_KEY derives, under the explicit flags", () => {
    const present = gitAt([]);
    expect(resolveSession({}, { BOUNTY_SESSION_KEY: "team" }, "/w", () => null, present)).toBe(
      sessionKeyToId("team", "/w", present),
    );
  });

  test("resolveSession: a raw --session still wins when no key is given", () => {
    expect(resolveSession({ session: "raw-id" }, {}, "/w", () => null, gitAt([]))).toBe("raw-id");
  });

  // #98: a tail that cannot find its board names what it looked for, and only
  // an id TYPED on the command line is a named target (B1: env/file ids are a
  // seat's first arm, which must wait).
  test("resolveSessionSource: names the key, cwd and scope root a derived id came from", () => {
    const present = gitAt(["/repo/.git"]);
    expect(
      resolveSessionSource({ "session-key": "team" }, {}, "/repo/x", () => null, present),
    ).toEqual({
      id: sessionKeyToId("team", "/repo/x", present),
      from: "derived from --session-key 'team' + cwd /repo/x, scope root /repo",
      named: true,
      key: "team",
    });
    expect(
      resolveSessionSource({}, { BOUNTY_SESSION_KEY: "team" }, "/w", () => null, gitAt([])),
    ).toMatchObject({ from: "derived from $BOUNTY_SESSION_KEY 'team' + cwd /w", named: false });
  });

  test("resolveSessionSource: only --session / --session-key are named targets", () => {
    const none = gitAt([]);
    expect(resolveSessionSource({ session: "s1" }, {}, "/w", () => null, none)).toEqual({
      id: "s1",
      from: "from --session",
      named: true,
    });
    expect(
      resolveSessionSource({}, { BOUNTY_SESSION: "s2" }, "/w", () => null, none),
    ).toMatchObject({ id: "s2", named: false });
    const file = (p: string) => (p === "/a/.bounty-session" ? "s3\n" : null);
    expect(resolveSessionSource({}, {}, "/a/b", file, none)).toEqual({
      id: "s3",
      from: "from /a/.bounty-session",
      named: false,
    });
    const bare = resolveSessionSource({}, {}, "/a/b", () => null, none);
    expect(bare.id).toBeUndefined();
    expect(bare.named).toBe(false);
    expect(bare.from).toMatch(/^looked for the latest-board pointer .*bounty-latest\.json$/);
  });
});

// ── liveBoards (running-board lister — `list`) ───────────────────────────
//
// `list` enumerates currently-RUNNING boards (distinct from `sessions`, which
// lists snapshots incl. closed ones). liveBoards takes the discovered sessions
// and an injected liveness probe (task count if the board answers, null if
// dead/stale) and returns only the live ones — so a stale tmpdir discovery file
// is silently skipped. Probe injected → unit-testable without real daemons.

describe("liveBoards", () => {
  const mk = (id: string): Session => ({
    url: `http://127.0.0.1:1${id}`,
    port: 1,
    session_id: `bounty-${id}`,
    title: `Board ${id}`,
  });

  test("includes only boards the probe reports live, carrying their task counts", async () => {
    // b1 — the probe now answers `{tasks} | null`. The OUTER null still means
    // NOT LIVE (dropped); the shape changed so a live board can separately
    // report an unknown count. This test's intent is unchanged.
    const probe = async (s: Session) =>
      s.session_id === "bounty-b" ? null : { tasks: s.session_id === "bounty-a" ? 3 : 0 };
    const live = await liveBoards([mk("a"), mk("b"), mk("c")], probe);
    expect(live.map((l) => l.session_id).sort()).toEqual(["bounty-a", "bounty-c"]); // b stale, skipped
    expect(live.find((l) => l.session_id === "bounty-a")?.tasks).toBe(3);
    expect(live.find((l) => l.session_id === "bounty-a")?.title).toBe("Board a");
  });

  test("b1: a LIVE board with an unreadable count stays listed, with tasks null — not 0, not dropped", async () => {
    // The two nulls must not collapse. A board that ANSWERS but whose body we do
    // not recognise used to report 0 — indistinguishable from empty (b5's defect
    // in this probe). Reporting the DEAD null instead would be worse: liveBoards
    // drops those, so a live board would vanish from `list` entirely.
    const probe = async (s: Session) =>
      s.session_id === "bounty-b" ? null : { tasks: s.session_id === "bounty-a" ? null : 2 };
    const live = await liveBoards([mk("a"), mk("b"), mk("c")], probe);
    // still LISTED — the live-but-uncountable board did not disappear
    expect(live.map((l) => l.session_id).sort()).toEqual(["bounty-a", "bounty-c"]);
    const a = live.find((l) => l.session_id === "bounty-a");
    expect(a?.tasks).toBeNull();
    expect(a?.tasks).not.toBe(0);
    // and a real count is still a real count
    expect(live.find((l) => l.session_id === "bounty-c")?.tasks).toBe(2);
  });

  test("empty list when nothing is live", async () => {
    expect(await liveBoards([mk("a"), mk("b")], async () => null)).toEqual([]);
  });
});

// ── owner scope matching (#owner-case: case-insensitive owner filter) ────
//
// The lead assigns `--owner loom` while the worker filters as `--as Loom`
// (grapevine aliases are often capitalized). A case-sensitive match silently
// emptied `--mine`/`--owner` — the worker looked unassigned. ownerInScope (used
// by both `state` and `tail`) matches owners case-insensitively.

describe("ownerInScope (case-insensitive owner filter)", () => {
  test("--owner matches the owner regardless of case", () => {
    expect(ownerInScope("Loom", { owner: "loom" })).toBe(true);
    expect(ownerInScope("loom", { owner: "LOOM" })).toBe(true);
  });
  test("--owner does not match a different owner", () => {
    expect(ownerInScope("raven", { owner: "loom" })).toBe(false);
  });
  test("--owner does not match an unowned task (exact ownership)", () => {
    expect(ownerInScope(undefined, { owner: "loom" })).toBe(false);
  });
  test("--mine matches an own task across a case mismatch (the bug)", () => {
    expect(ownerInScope("loom", { mine: true, as: "Loom" })).toBe(true);
  });
  test("--mine also matches an unowned (claimable) task", () => {
    expect(ownerInScope(undefined, { mine: true, as: "Loom" })).toBe(true);
  });
  test("--mine does not match another worker's task", () => {
    expect(ownerInScope("raven", { mine: true, as: "Loom" })).toBe(false);
  });
  test("no scope → everything is in scope", () => {
    expect(ownerInScope("anyone", {})).toBe(true);
    expect(ownerInScope(undefined, {})).toBe(true);
  });
});

// ── --tag parsing (#18: comma list → clean string[]) ─────────────────────
//
// `add`/`update --tag a,b,c` — comma-separated, SET semantics (replaces the
// task's tags), mirroring `block --on a,b`. `--tag ""` clears (empty list).

describe("parseTags", () => {
  test("splits a comma list", () => {
    expect(parseTags("frontend,backend,bug")).toEqual(["frontend", "backend", "bug"]);
  });
  test("trims each and drops empty segments", () => {
    expect(parseTags(" frontend , , backend ")).toEqual(["frontend", "backend"]);
  });
  test("dedupes", () => {
    expect(parseTags("bug,bug,ui")).toEqual(["bug", "ui"]);
  });
  test("an empty string clears (empty list)", () => {
    expect(parseTags("")).toEqual([]);
    expect(parseTags("  ,  ")).toEqual([]);
  });
});

describe("join.ts", () => {
  test("discovers via bounty-latest.json when no --url/--id given", async () => {
    // Spawn a host first so bounty-latest.json is real.
    const { proc: hostProc, ready } = await spawnServerReady(["--timeout", "5"]);
    // Give the host time to write the discovery file (it writes synchronously
    // shortly after ready, but the file might race a fast joiner).
    await new Promise((r) => setTimeout(r, 100));

    const joiner = Bun.spawn({
      cmd: ["bun", "run", JOIN, "--timeout", "5"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // join.ts resolves `bounty-latest.json` out of ITS OWN tmpdir, so it must
      // share the host daemon's. Omitting env here inherited the machine-global
      // dir and this test looked for a pointer the host wrote somewhere else.
      env: hermeticEnv(),
    });
    const seen = await collectStdout(joiner, (m) => m.type === "joined", 5000);
    const joined = seen.find((m) => m.type === "joined");
    expect(joined).toBeDefined();
    expect(must(joined, "the joiner printed a joined frame").session_id).toBe(ready.session_id);

    // Cleanup
    joiner.kill();
    hostProc.kill();
    await hostProc.exited;
    await joiner.exited;
  }, 15000);

  test("idle timeout reports reason 'timeout' (not 'server_closed')", async () => {
    const { proc: hostProc, ready } = await spawnServerReady(["--timeout", "10"]);
    // Joiner with very short timeout so it expires before host does.
    const joiner = Bun.spawn({
      cmd: ["bun", "run", JOIN, "--url", ready.url, "--timeout", "0.5"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Benign today — an explicit --url skips discovery entirely — but the
      // harness rule is that no child inherits the ambient environment, so the
      // next edit to this call cannot quietly reintroduce the leak.
      env: hermeticEnv(),
    });
    const seen = await collectStdout(joiner, (m) => m.type === "disconnected", 5000);
    const disc = seen.find((m) => m.type === "disconnected");
    expect(disc).toBeDefined();
    expect(must(disc, "the joiner printed a disconnected frame").reason).toBe("timeout");

    hostProc.kill();
    await hostProc.exited;
    await joiner.exited;
  }, 15000);
});

// ── P0e — test hermeticity: the suite must not touch a LIVE board ────────
// Regression for the defect that killed this team's board mid-session: a seat
// shell exports $BOUNTY_SESSION_KEY, `runCli` inherited it, `open` took the
// idempotent-attach branch onto the real board, and a later `close` clobbered
// its snapshot. BOUNTY_HOME did not help — it scopes the snapshot store, not
// the key path.
//
// Two-directional BY CONSTRUCTION: with the ambient key inherited this fails
// (the CLI reports the keyed board's id and the board is later torn down);
// with HERMETIC_ENV it passes. Do not "simplify" it by dropping the ambient
// set — that variable IS the experiment.
describe("test hermeticity (P0e)", () => {
  test("an ambient BOUNTY_SESSION_KEY does NOT bind the suite to a live board", async () => {
    const key = `p0e-${crypto.randomUUID().slice(0, 8)}`;
    const home = uniqHome();
    const victimId = sessionKeyToId(key);

    // Stand up the "victim" board the way a real seat would, and put a marker
    // on it. This board plays the part of the team's live board.
    await runCli(["open", "--no-open", "--timeout", "30", "--session-key", key], {
      env: { BOUNTY_HOME: home },
    });
    await runCli(["add", "marker", "--id", "marker", "--session-key", key], {
      env: { BOUNTY_HOME: home },
    });

    const readVictim = async () => {
      const r = await runCli(["state", "--session-key", key], { env: { BOUNTY_HOME: home } });
      try {
        return (JSON.parse(r.stdout) as { state: BoardState }).state.tasks.map((t) => t.id);
      } catch {
        return null; // board is down / unreachable
      }
    };

    try {
      // ── PRECONDITION CELL (cassandra, comms #40) ────────────────────────
      // Assert the victim is provably ALIVE and POPULATED *before* measuring.
      // Without this the test passes vacuously when the board never came up:
      // "nothing was killed" and "nothing was ever there" are indistinguishable
      // at the end of the run. This is the P0b degenerate-control scar, pinned.
      expect(await readVictim()).toEqual(["marker"]);

      // ── THE MEASUREMENT ────────────────────────────────────────────────
      // Simulate a seat shell: the ambient key is set for the CLI we spawn.
      // Under the bug this `open` attaches to the victim and returns ITS id.
      // Set the ambient key on the RUNNER, exactly as a seat shell does. This is
      // the channel the fix covers; passing it via opts.env would bypass the
      // scrub by design and test nothing.
      process.env.BOUNTY_SESSION_KEY = key;
      const open = await runCli(["open", "--no-open", "--timeout", "10"], {
        env: { BOUNTY_HOME: uniqHome() },
      });
      const spawned = (JSON.parse(open.stdout) as { session_id: string }).session_id;

      // It must have minted its OWN board, not seized the keyed one.
      expect(spawned).not.toBe(victimId);

      // And the victim must be untouched — still alive, still holding its card.
      expect(await readVictim()).toEqual(["marker"]);

      await runCli(["close", "--session", spawned], { env: { BOUNTY_HOME: home } });
    } finally {
      process.env.BOUNTY_SESSION_KEY = undefined;
      delete process.env.BOUNTY_SESSION_KEY;
      await runCli(["close", "--session-key", key], { env: { BOUNTY_HOME: home } });
    }
  }, 30000);
});

// Structural guard for the hermeticity fix (P0e, hardened after independent
// review). The original fix scrubbed two spawn sites and a comment claimed that
// was "the ONE place both spawn helpers share" — there were five, and the three
// `tail` spawns bypassed the scrub entirely. A prose instruction cannot stop the
// sixth one from being written; this test can. It reads its own source, so a new
// `{ ...process.env }` spawn fails here instead of leaking the ambient session
// key into a live board months later.
test("P0e — no spawn site in this suite inherits a bare process.env", async () => {
  // Comments stripped: this gate is documented in prose that necessarily QUOTES
  // the idiom it forbids, and the first version of the half-2 gate below was
  // tripped by exactly that. A guard must not be able to fail on its own docs.
  const src = await suiteCode();
  // Match the spawn-env idiom only; the hermeticEnv() helper itself legitimately
  // destructures process.env and must not trip this.
  const offenders = [...src.matchAll(/env:\s*\{\s*\.\.\.process\.env/g)];
  expect(offenders).toHaveLength(0);
});

// ── P0e half 2 — the discovery pointer must not escape the suite ─────────
// The behavioural gate. Half 1's regression proves the suite does not SEIZE a
// live board; this one proves a peer cannot PERTURB the suite — the direction
// that shipped unfixed, because the shipped gate asserted only that the victim
// board survived and never that the suite was isolated from strangers.
describe("test hermeticity — discovery pointer (P0e half 2)", () => {
  test("a harness-spawned daemon writes its pointer into the SUITE's tmpdir, never the machine-global one", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const id = ready.session_id;
    try {
      // ── PRECONDITION CELL ───────────────────────────────────────────────
      // "No pointer in the shared dir" is also what you see when the daemon
      // never booted — so the measurement below needs the positive fact stated
      // first, in this test, where a reader can see it.
      //
      // Stated honestly, because overclaiming a control is the thing this team
      // has spent the night finding: this cell is NOT independent of
      // spawnServerReady, which polls the very path being asserted and throws on
      // timeout. Under the mutation that removes the TMPDIR override, the run
      // goes red in that helper (measured: 5043ms, "server did not become
      // ready") rather than here. So this cell's job is to make the vacuity
      // condition VISIBLE and locally checkable, not to be a second detector.
      // A genuinely independent control would need a boot path that does not
      // consult the pointer, and there isn't one.
      expect({
        cell: "precondition",
        pointerInSuiteDir: existsSync(join(TEST_TMPDIR, `bounty-${id}.json`)),
      }).toEqual({ cell: "precondition", pointerInSuiteDir: true });

      // ── THE MEASUREMENT ────────────────────────────────────────────────
      // Scoped to THIS run's unique session id on purpose. The obvious
      // assertion — that `bounty-latest.json` in the shared dir is unchanged —
      // is peer-SENSITIVE: any other suite or agent booting a board during this
      // test would fail it, so the gate would flake for a reason unrelated to
      // the defect. A unique id is untouchable by peers, so a failure here can
      // only mean OUR daemon wrote OUR pointer into the global directory.
      expect(existsSync(join(SHARED_TMPDIR, `bounty-${id}.json`))).toBe(false);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20000);
});

// ── P0 — the drained exit (#78) ──────────────────────────────────────────
// Bun's stdout is ASYNCHRONOUS on a pipe and synchronous on a TTY or file, so
// `process.exit(code)` discards whatever has not drained. Measured in this repo
// on ONE board, one variable, both directions:
//
//   process.exit(code)         pipe  65536   file 114042   parse FAILED
//   process.exitCode + return  pipe 114042   file 114042   parse OK
//
// 65,536 on the nose. The harm is worse than a crash: the payload is complete
// and only the write is lost, so a reader gets well-formed-looking JSON that
// stops mid-string. A team published the false rule "our board is too big to
// read" and three agents worked under it for six messages.
describe("P0 — a >64KiB payload survives a PIPE (#78)", () => {
  test("state through a pipe is byte-identical to state in a file, and parses", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "60"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      // Build a board that clears 64KiB. 200 cards × a ~400-char title is
      // ~114KB — comfortably over, with headroom so ordinary drift in the
      // envelope cannot silently walk the fixture back under the threshold.
      const pad = "x".repeat(400);
      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          runCli(["add", `card-${i}-${pad}`, "--id", `c${i}`, "--session", session], { env }),
        ),
      );

      // ⚠ THE READER IS THE EXPERIMENT, AND `Bun.spawn({stdout:"pipe"})` IS
      // BLIND TO THIS DEFECT. Measured on one board with the fix reverted:
      //
      //   shell pipe  (`cli state | wc -c`)          ->  65536   TRUNCATED
      //   Bun.spawn   (stdout:"pipe", Response.text) -> 114042   COMPLETE
      //   sh -c "cli state | cat"                    ->  65536   TRUNCATED
      //
      // So the obvious gate — call runCli and check the bytes — PASSES IN BOTH
      // WORLDS. It was written that way first here and went green with the
      // `process.exit` restored, which is a non-discriminating gate: the exact
      // thing G2 exists to stop, and it looked completely reasonable.
      //
      // The CLI's own stdout must therefore be a REAL SHELL PIPE. `sh -c` gives
      // it one; Bun's spawn pipe is the outer hop only, where nothing is at
      // stake. (Why Bun's pipe survives is UNVERIFIED — plausibly the parent
      // drains it from the first byte so the writer never blocks on a full
      // 64KiB buffer — and the gate does not depend on that explanation.)
      const shell = Bun.spawn({
        cmd: ["sh", "-c", `bun run ${CLI} state --session ${session} | cat`],
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        env: { ...hermeticEnv(), ...env },
      });
      const piped = { stdout: await new Response(shell.stdout).text() };
      await shell.exited;

      // ── THE VACUITY GUARD, asserted BEFORE the parse ────────────────────
      // A sub-64KiB fixture passes in BOTH worlds and stays green forever,
      // including on the day it breaks: truncating 40KB at 65,536 is a no-op.
      // So the size is a first-class assertion, not a comment — if the fixture
      // ever shrinks this fails loudly instead of passing vacuously.
      const bytes = Buffer.byteLength(piped.stdout);
      expect({ overBuffer: bytes > 65_536, bytes }).toEqual({ overBuffer: true, bytes });

      // Never truncated AT the boundary — the signature of the defect.
      expect(bytes).not.toBe(65_536);

      // And it must actually parse. This is what a caller experiences.
      const parsed = JSON.parse(piped.stdout) as { state: BoardState };
      expect(parsed.state.tasks).toHaveLength(200);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 120000);
});

test("P0e — the source scans read every file of the split suite", () => {
  // The population pin for suiteFiles(): a part renamed out of the
  // server*.test.ts pattern, or the harness moved, would otherwise drop out of
  // the three scans here without a sound.
  expect(suiteFiles()).toEqual([
    "server.cli.test.ts",
    "server.lifecycle.test.ts",
    "server.open.test.ts",
    "server.save-fails.test.ts",
    "server.snapshot-kept.test.ts",
    "server.test.ts",
    "fixtures/serverSuite.ts",
  ]);
});

// Structural companion to the behavioural gate above, and the load-bearing half
// of the two. The behavioural test proves the pointer is contained TODAY, at the
// sites that exist today; it cannot fail for a site written next month. A bare
// `join(tmpdir(), …)` anywhere in this file re-opens the machine-global path
// silently — the failure mode is a green suite that is quietly racing every
// other bounty process on the box.
//
// This is the same instrument that caught half 1's real gap: a mutation test
// reaches only the mechanism it mutates, while a source scan reaches every site
// in the file, including the ones nobody remembered to route through the helper.
// Reading `import.meta.path` (the file as it exists on disk) rather than
// reasoning about the imports is the whole point.
test("P0e half 2 — no site in this suite composes a path from the machine-global tmpdir", async () => {
  const src = await suiteCode();
  // `join(tmpdir(), …)` is the pointer-path idiom. The ONE legitimate use is
  // minting TEST_TMPDIR *under* the machine dir, which is exempted by name
  // rather than by loosening the pattern.
  const offenders = [...src.matchAll(/join\(\s*tmpdir\(\)/g)].filter(
    (m) => !src.slice(Math.max(0, m.index - 14), m.index).includes("mkdtempSync("),
  );
  expect(offenders).toHaveLength(0);
});

// The gap that the half-1 guard could not see, found by this very change: the
// `join.ts` joiner was spawned with NO `env:` key at all. Half 1 matched the
// `env: { ...process.env }` idiom, so a spawn that simply omits `env` was
// invisible to it — inheriting the ambient environment wholesale is the SAME
// defect spelled as an absence rather than as a spread. Half 1 was reported
// complete and independently reviewed with that site sitting in the file.
//
// This is the seat's own principle arriving a third time: an audit anchored on
// one spelling inherits that spelling's blind spot, and the blind spot is always
// a synonym. So this gate asserts a POSITIVE property — every spawn carries an
// env — instead of enumerating the wrong ways to write one.
test("P0e — EVERY Bun.spawn in this suite passes an explicit env", async () => {
  const src = await suiteCode();
  const bare: string[] = [];
  for (const m of src.matchAll(/Bun\.spawn\(/g)) {
    // Walk to the matching close paren so the check sees exactly this call.
    let depth = 0;
    let i = m.index + "Bun.spawn".length;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    const call = src.slice(m.index, i);
    if (!/\benv\s*:/.test(call)) bare.push(call.slice(0, 80));
  }
  expect(bare).toEqual([]);
});

// ── G7 REACHABILITY — the property runOpen's termination cell rests on ────
//
// `runOpen` can decide termination without reading the pipes (see the note in
// it), but a detached grandchild holding a harness handle is still the thing
// that would wedge any harness copied from it. Today `bounty open`'s daemon
// holds NONE of them — `stdio: ["ignore", "ignore", <fd → daemon.log>]`.
//
// ⚠ THAT PROPERTY IS DOCUMENTED FOR A DIFFERENT REASON (#64, capturing Bun's
// own hard-abort output on a durable log) AND IS LOAD-BEARING FOR G7 BY
// ACCIDENT. Nothing asserted it. So a future edit "just piping stdout to read
// the handshake" — one word, entirely reasonable, and exactly what glamour does
// — would silently arm the hang class in every harness that copies this one.
//
// This is a SOURCE-SCANNING guard rather than a behavioural one on purpose: the
// behaviour it protects is the ABSENCE of a hang, and you cannot assert an
// absence by observing a passing run. It goes red on the one-word change and
// names why. (Same instrument as the P0e hermeticity guard, which found five
// spawn sites a mutation test could not reach.)
test("G7 PRECONDITION — the detached daemon holds NO pipe from its spawner", async () => {
  const src = codeLines(await Bun.file(CLI_SRC).text());
  const m = /spawn\(process\.execPath, args, \{([\s\S]*?)\}\);/.exec(src);
  expect(m).not.toBeNull();
  const call = must(m?.[1], "the spawn call's options body was captured");

  // The daemon must be detached — that is what makes it a grandchild of any
  // harness driving the CLI, and therefore what makes its stdio load-bearing.
  expect(call).toContain("detached: true");

  const stdio = /stdio:\s*\[([^\]]*)\]/.exec(call);
  expect(stdio).not.toBeNull();
  const [stdin, stdout] = must(stdio?.[1], "the stdio array was captured")
    .split(",")
    .map((x) => x.trim());

  // stdin + stdout must be "ignore". stderr is deliberately NOT constrained to
  // "ignore" — it is an opened fd to daemon.log (#64), which is a FILE and not
  // a handle the spawner owns, so it cannot hold a harness pipe open.
  expect({ stdin, stdout }).toEqual({ stdin: '"ignore"', stdout: '"ignore"' });

  // And the failure this guard exists for, named so the red is self-explaining:
  // "pipe" or "inherit" here hands the detached daemon a handle belonging to
  // whoever spawned the CLI, so that pipe never reaches EOF and every harness
  // copied from runOpen inherits a hang that reads as a timeout.
  expect(call).not.toContain('"pipe"');
  expect(call).not.toContain('"inherit"');
});

// ── P1a/P1b — the SHRINKAGE guard at the snapshot sink (#73, #74) ────────────
//
// The defect both issues describe: a keyed `open` over a DEAD board respawns
// EMPTY (cmdOpen passes --restore only if the caller typed it), and then any
// write flushes that empty state over the populated snapshot. Measured this
// sprint: one `add`, NO `close` anywhere, took a snapshot 3 tasks -> 1 task
// (452 -> 172 bytes) about a second later via the debounce path.
//
// ⛔ WHY THE PREDICATE IS SHRINKAGE AND NOT EMPTINESS. Both issues ask for a
// guard against writing an EMPTY board over a populated snapshot, and that is
// what the sprint plan assumed. It does not cover the measurement above,
// because 1 is not 0. Emptiness is the WORST CASE of the real predicate, not
// its definition — so it is an input here, never a branch.
//
// ⛔ AND WHY ROTATION IS ONCE PER DAEMON SESSION, NOT PER WRITE. Writes are per
// MUTATION (the flush is a 1s dirty-check), so a human draining a 26-card board
// card-by-card produces up to 26 shrinking writes. With any retention bound N,
// rotation N+1 evicts the pre-drain snapshot — the guard eats the thing it
// exists to protect. Once-per-boot bounds rotations by BOOTS, captures exactly
// the state that existed before this daemon touched it (which is what both
// issues asked to get back), and needs no retention policy at all.
describe("shouldRotateSnapshot — the shrinkage predicate", () => {
  test("a SHRINKING write rotates: the measured 3 -> 1 case", () => {
    expect(shouldRotateSnapshot(3, 1, false)).toBe(true);
  });

  test("EMPTINESS is the worst case of shrinkage, not a separate rule", () => {
    // The case both issues actually filed. It must pass through the same
    // predicate, or the guard has two branches that can disagree.
    expect(shouldRotateSnapshot(18, 0, false)).toBe(true);
  });

  test("a SAME-SIZE write does NOT rotate — this is the common case", () => {
    // Measured live on the team board: a card claim rewrote 26 -> 26. If this
    // rotated, every ordinary edit would mint a backup.
    expect(shouldRotateSnapshot(26, 26, false)).toBe(false);
  });

  test("a GROWING write does NOT rotate", () => {
    expect(shouldRotateSnapshot(3, 4, false)).toBe(false);
  });

  test("ONCE PER SESSION: a second shrink in the same daemon does NOT rotate", () => {
    // The load-bearing cell. Without it the guard is per-write, and a
    // card-by-card drain evicts the pre-drain snapshot with its own backups.
    expect(shouldRotateSnapshot(3, 1, true)).toBe(false);
    expect(shouldRotateSnapshot(1, 0, true)).toBe(false);
  });

  test("NO PRIOR SNAPSHOT never rotates — there is nothing to protect", () => {
    // null = no readable snapshot on disk (fresh store, or unreadable). Copying
    // a file that is absent or corrupt would fail, and a first-ever write is not
    // a loss.
    expect(shouldRotateSnapshot(null, 0, false)).toBe(false);
    expect(shouldRotateSnapshot(null, 5, false)).toBe(false);
  });

  test("a prior of ZERO never rotates, even writing zero", () => {
    // An empty snapshot has nothing to lose, so rotating it is pure litter —
    // and this is the case a naive `next < prior` with a null-coalesce to 0
    // would get right by accident and a `prior >= 0` check would get wrong.
    expect(shouldRotateSnapshot(0, 0, false)).toBe(false);
  });
});

describe("snapshotTaskCount — reading the prior, honestly", () => {
  const dir = mkdtempSync(join(TEST_TMPDIR, "snapcount-"));

  test("counts the tasks in a well-formed snapshot", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ title: "T", tasks: [{ id: "a" }, { id: "b" }] }));
    expect(snapshotTaskCount(p)).toBe(2);
  });

  test("an ABSENT file is null, NOT zero", () => {
    // The distinction the predicate depends on. Zero would mean "a snapshot
    // exists and holds nothing"; null means "there is no snapshot". Collapsing
    // them makes a first-ever write look like a shrink from an empty board.
    expect(snapshotTaskCount(join(dir, "nope.json"))).toBe(null);
  });

  test("a CORRUPT file is null, NOT zero — and that is the safe direction", () => {
    // A half-written snapshot must not read as "0 tasks" and thereby report
    // every subsequent write as a shrink. null declines to answer.
    const p = join(dir, "corrupt.json");
    writeFileSync(p, '{"title":"T","tasks":[{"id":"a"');
    expect(snapshotTaskCount(p)).toBe(null);
  });

  test("a snapshot whose `tasks` is not an array is null, not a guess", () => {
    const p = join(dir, "weird.json");
    writeFileSync(p, JSON.stringify({ title: "T", tasks: "nope" }));
    expect(snapshotTaskCount(p)).toBe(null);
  });
});

// ── P1e + D1.2 — the idle timeout, and the readable blank ────────────────────
describe("P1e — Bun.serve carries an idleTimeout the heartbeat can survive", () => {
  test("the configured idleTimeout EXCEEDS the heartbeat interval", () => {
    // Source-scanned rather than driven, and the reason is that DRIVING it would
    // need a >10s quiet connection per assertion — a 10s+ cell per run, to prove
    // a one-key config fact. The relationship is what matters and it is the
    // relationship that was broken: Bun's default is 10s and the heartbeat is
    // 15s, so on an otherwise-idle connection the heartbeat could NEVER fire.
    //
    // ⚠ This asserts the two numbers stay ordered, NOT that any death was
    // caused by their being unordered. See the source comment: P1e is
    // consistent with #64's clue and untested against it.
    // ⛔ THIS CELL NOW ASSERTS THE DERIVATION, NOT TWO LITERALS — AND THAT IS
    // THE UPGRADE THE PORT BOUGHT. It used to scan `server.ts` with two regexes
    // for `idleTimeout: 255` and the `15000` beside `sseTimers.add(hb)`, and
    // compare the numbers it found. Both literals are gone: they live in
    // `./heartbeat.ts`, where `heartbeatMs()` CLAMPS the beat to half the idle
    // timeout. So the ordering holds for ANY configured pair rather than for the
    // two values that happened to be typed — which is what the old cell was
    // reaching for and could only approximate.
    //
    // ⚠ THE OLD FORM WAS ALSO ONE RENAME FROM VACUOUS. Its second regex was
    // anchored on the literal token `sseTimers.add(hb)`; that registry is gone
    // now (the kit's SSE teardown funnel owns the interval), so the match
    // returns null and the cell fails LOUDLY — which is the good outcome, and
    // is only good because `expect(hb).not.toBe(null)` was there. A source scan
    // without a found-it assertion passes when it stops finding anything.
    expect(SSE_HEARTBEAT_MS).toBeLessThanOrEqual((IDLE_TIMEOUT_SEC * 1000) / 2);
    expect(SSE_HEARTBEAT_MS).toBeGreaterThan(0);
    // The defaults, pinned so the derivation cannot quietly change bounty's
    // shipped behaviour: 255 s (Bun's clamped maximum, bounty's own measured
    // value) and a 15 s beat.
    expect(IDLE_TIMEOUT_SEC).toBe(255);
    expect(SSE_HEARTBEAT_MS).toBe(15_000);
    // ...and the daemon actually PASSES it to Bun.serve rather than keeping a
    // literal beside the import. This is the half that must stay a source scan:
    // the value is right, and the question is whether it reaches the server.
    const src = readFileSync(join(SCRIPT_DIR, "server.ts"), "utf8");
    expect(src).toMatch(/idleTimeout:\s*IDLE_TIMEOUT_SEC\b/);
  });

  test("the shutdown WATCHDOG is cleared AFTER the drain, not before it", () => {
    // ⛔ SOURCE-SCANNED, AND THE REASON IS THAT DRIVING IT NEEDS A PLANTED HANG.
    // The property is "the force-exit still covers the teardown", and the only
    // way to observe it is to make the teardown not finish — which means
    // mutating the artifact, which is a calibration drive and not a suite cell.
    // So this pins the ORDER, which is the thing that was wrong and the thing an
    // ordinary edit would get wrong again.
    //
    // ⚠ WHAT WAS WRONG, MEASURED. `clearTimeout(shutdownWatchdog)` used to sit
    // four lines into a fifteen-line teardown, immediately after
    // `logDaemon("exit")` — under a comment saying it "sits at the end of the
    // teardown". Its real coverage was `await done` plus one fs append; the
    // final snapshot, the `closed` frame, the drain and discovery cleanup all
    // ran unguarded. Driven with a 2 s watchdog and a hang planted in a copy of
    // the shipped artifact: a hang at the snapshot or inside `drainAndStop` was
    // STILL RUNNING at 10 s with the watchdog ARMED — indistinguishable from
    // disarmed, which is the measurement. After the move, both die at ~2 s.
    //
    // ⚠ AND THE ORDER IS THE WHOLE ASSERTION, so `indexOf` is compared rather
    // than "does the file contain a clearTimeout" — the second is true of both
    // the broken and the fixed file.
    const src = readFileSync(join(SCRIPT_DIR, "server.ts"), "utf8");
    const clear = src.lastIndexOf("clearTimeout(shutdownWatchdog)");
    const drain = src.lastIndexOf("await drainAndStop(");
    const done = src.lastIndexOf("const { code, reason } = await done;");
    expect(clear).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(drain);
    expect(drain).toBeGreaterThan(done);
  });

  test("the watchdog is armed by the RESOLVE, so all four teardown entries are covered", () => {
    // ⛔ SOURCE-SCANNED FOR THE SAME REASON AS THE CELL ABOVE — observing it
    // needs a planted hang — and the property is an ABSENCE: no teardown entry
    // without a guarantee. Driven at the repair (D53), hang planted between
    // `drainAndStop` and `cleanupDiscovery`, watchdog 2 s:
    //
    //   entry          before          after
    //   signal         143 @2002ms     143 @2002ms
    //   close verb     RUNNING @10s    143 @2003ms
    //   WS "user"      RUNNING @10s    143 @2004ms
    //   idle timeout   RUNNING @10s    124 @2004ms
    //
    // Three of the four entries had no force-exit at all while the code above
    // them said "this makes the ending unconditional". The arming now lives
    // inside `resolveDone`, which every entry goes through, so a FIFTH entry
    // added later inherits the guarantee instead of needing to remember it.
    const src = readFileSync(join(SCRIPT_DIR, "server.ts"), "utf8");
    // There is exactly ONE arming site in the file, and it is the resolver.
    const armings = src.match(/setTimeout\([\s\S]*?SHUTDOWN_WATCHDOG_MS\)/g) ?? [];
    expect(armings.length).toBe(1);
    const arm = src.indexOf("shutdownWatchdog = setTimeout(");
    const resolverOpen = src.indexOf("resolveDone = (v) => {");
    const resolverClose = src.indexOf("const { code, reason } = await done;");
    expect(arm).toBeGreaterThan(-1);
    expect(resolverOpen).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(resolverOpen);
    expect(arm).toBeLessThan(resolverClose);
    // ⚠ AND NOT IN `requestShutdown`, which is where it used to be — the
    // signal-only placement that made the claim above it false. Anchored on the
    // assignment, so re-adding a second arming there reddens this.
    const reqStart = src.indexOf("requestShutdown = (code, reason, signal) => {");
    expect(reqStart).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(reqStart);
    // All four entries resolve, and none of them arms anything itself.
    for (const entry of [
      "resolveDone({ code, reason: reason as CloseReason })",
      'resolveDone({ code: 0, reason: "close" })',
      'resolveDone({ code: 0, reason: "user" })',
      'resolveDone({ code: EXIT_IDLE_TIMEOUT, reason: "timeout" })',
    ]) {
      expect(src).toContain(entry);
    }
  });

  test("idleTimeout is not ZERO — 0 stalls the initial response rather than disabling", () => {
    // Measured in mind-mapper: `idleTimeout: 0` does not mean "no timeout", it
    // empirically stalls the first response. A future editor reaching for 0 as
    // "disable it" would reintroduce a worse bug than the one this fixes, so the
    // refusal is pinned rather than left in a comment.
    const src = readFileSync(join(SCRIPT_DIR, "server.ts"), "utf8");
    expect(src).not.toMatch(/idleTimeout:\s*0\b/);
  });
});

describe("D1.2 — snapshotBackedUp is a READABLE BLANK on /state, never absent", () => {
  test("a daemon that has rotated NOTHING still carries the field, as null", async () => {
    // The whole point of the ruling: `null` means "not needed" and an ABSENT
    // field means "not reported", and a consumer cannot tell those apart. The
    // event alone cannot satisfy this — an event is absent when nothing
    // happened, by construction.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "d12-"));
    const key = `d12-${crypto.randomUUID().slice(0, 8)}`;
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const { session_id: id, port } = JSON.parse(open.stdout) as {
      session_id: string;
      port: number;
    };
    try {
      const body = (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as Record<
        string,
        unknown
      >;
      // `in` is the assertion with teeth. `=== null` alone passes vacuously
      // against a build that does not emit the field at all — the restoreSkipped
      // lesson (#80.1/D1.2), which is the same ruling's other half.
      expect("snapshotBackedUp" in body).toBe(true);
      expect(body.snapshotBackedUp).toBe(null);
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 40000);
});

// ── P1d — a dropped --size/--expect becomes AUDIBLE, not an error ────────────
//
// Ruled by Cole: KEEP the leniency, make it audible. parseSize/parseExpect
// dropping a bad value is a deliberate anti-typo behaviour (cli.ts comment) and
// reversing it re-opens that hazard. What changes is that the caller is TOLD.
//
// The scaffold's framing -- "add and update disagree about whether a bad --size
// is an error" -- was FALSIFIED by measurement this sprint: they are
// byte-identical, and update's exit 2 is its EMPTY-PATCH guard firing because
// the dropped size left nothing to patch. These cells pin that they stay
// identical, so the asymmetry cannot appear for real later.
describe("P1d — the leniency is audible", () => {
  test("add REPORTS an ignored --size and still succeeds", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p1d-a-"));
    const key = `p1d-a-${crypto.randomUUID().slice(0, 8)}`;
    const env = { BOUNTY_HOME: home };
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const r = await runCli(["add", "x", "--id", "t1", "--size", "ongoing", "--session", id], {
        env,
      });
      const out = JSON.parse(r.stdout) as {
        ok: boolean;
        valuesIgnored: Array<{ flag: string; value: string }> | null;
      };
      expect(out.ok).toBe(true); // the leniency STAYS — this is not an error
      expect(out.valuesIgnored?.[0]?.flag).toBe("size");
      expect(out.valuesIgnored?.[0]?.value).toBe("ongoing");
      expect(r.stderr).toContain("ignored --size"); // mirrored for a human
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("a CLEAN add carries the field as null — present, never absent", async () => {
    // `in` is the assertion with teeth: `=== null` passes vacuously against a
    // build that never emits the field (the restoreSkipped lesson).
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p1d-n-"));
    const key = `p1d-n-${crypto.randomUUID().slice(0, 8)}`;
    const env = { BOUNTY_HOME: home };
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const r = await runCli(["add", "y", "--id", "t2", "--size", "M", "--session", id], { env });
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      expect("valuesIgnored" in out).toBe(true);
      expect(out.valuesIgnored).toBe(null);
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("update with a bad size AND another flag behaves EXACTLY like add", async () => {
    // The discriminating cell from the measurement, now pinned: the two verbs
    // do NOT disagree, and this is what stops the scaffold's claim becoming
    // true later by accident.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p1d-u-"));
    const key = `p1d-u-${crypto.randomUUID().slice(0, 8)}`;
    const env = { BOUNTY_HOME: home };
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "z", "--id", "t3", "--session", id], { env });
      const r = await runCli(
        ["update", "t3", "--size", "bogus", "--owner", "alice", "--session", id],
        { env },
      );
      expect(r.code).toBe(0); // NOT a refusal — identical to add
      const out = JSON.parse(r.stdout) as {
        valuesIgnored: Array<{ flag: string }> | null;
      };
      expect(out.valuesIgnored?.[0]?.flag).toBe("size");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("update with ONLY a bad size names the flag IN THE REFUSAL — no envelope prints here", async () => {
    // The case the envelope cannot reach, and the one a caller actually hits.
    // The patch is empty BECAUSE the size was dropped, so the refusal has to
    // carry the report or it is lost exactly when it is most needed. The old
    // message blamed an empty patch and never mentioned the flag that was
    // passed — and omitted --size from the list of flags that would have worked,
    // which a VALID --size does.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p1d-r-"));
    const key = `p1d-r-${crypto.randomUUID().slice(0, 8)}`;
    const env = { BOUNTY_HOME: home };
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "w", "--id", "t4", "--session", id], { env });
      const r = await runCli(["update", "t4", "--size", "bogus", "--session", id], { env });
      expect(r.code).toBe(2); // still a usage error — that behaviour is unchanged
      expect(r.stderr).toContain("--size");
      expect(r.stderr).toContain("bogus");
      expect(r.stderr).toContain("not one of S|M|L");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("--expect gets the SAME treatment — it had the identical silent drop", async () => {
    // parseExpect has the same shape as parseSize and was on no card. One field
    // covers both, rather than minting the first member of a per-flag family.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p1d-e-"));
    const key = `p1d-e-${crypto.randomUUID().slice(0, 8)}`;
    const env = { BOUNTY_HOME: home };
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const r = await runCli(["add", "e", "--id", "t5", "--expect", "soon", "--session", id], {
        env,
      });
      const out = JSON.parse(r.stdout) as { valuesIgnored: Array<{ flag: string }> | null };
      expect(out.valuesIgnored?.[0]?.flag).toBe("expect");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);
});

// ── P1f — the teardown funnel: signal deaths run it instead of pre-empting it ─
//
// ⛔ THE FAILURE MODE OF THIS FIX IS NON-TERMINATION, so a cell that measures
// the FRAME cannot fail on it. `process.exit` in a signal handler did DOUBLE
// DUTY — it ended the process AND skipped the teardown — and removing it to gain
// the teardown can lose the ending. To a frame-counting cell, a hang and a
// success are identical. So TERMINATION is asserted first and separately, on the
// process itself, never as a side effect of its output being consumed.
//
// Signals are ENUMERATED, never "for each signal" (G4): SIGTERM and SIGINT are
// separate cells because they are separate handlers and one can be wired wrong.
// MUTATION-VERIFIED, both directions, and the SPLIT is the point:
//   pre-fix  3 pass / 2 fail
//   post-fix 5 pass / 0 fail
// The two that fail pre-fix (the `closed` frame, and `subscribers` on the
// signal path) are the evidence. The three that pass in BOTH worlds are
// GUARDS and are labelled so — the old code ended the process correctly, so a
// termination cell cannot discriminate the fix. It exists to catch the fix
// LOSING the ending, which is the failure this whole lane was warned about.
describe("P1f — a signal death runs the teardown AND still ends the process", () => {
  // Budget comes from the FAILURE, not the success: a hang is unbounded, so a
  // tight budget is all cost and no coverage. It sits strictly below the
  // enclosing test(…, N) so the runner cannot kill the test before this
  // assertion executes — otherwise a hang reads as "the suite is slow" instead
  // of a red cell naming the hung path.
  const EXIT_BUDGET_MS = 8000;

  async function exitsOnSignal(signal: "SIGTERM" | "SIGINT", expectCode: number) {
    const { proc, ready } = await spawnServerReady();
    // A REAL consumer, attached before the signal: #73's lesson is that emitting
    // a frame and DELIVERING it are different claims, so the frame is observed
    // where a consumer would see it, not at the emit site.
    const frames: Array<Record<string, unknown>> = [];
    const ac = new AbortController();
    const sse = fetch(`${ready.url}/events?since=0`, { signal: ac.signal })
      .then(async (r) => {
        const reader = r.body?.getReader();
        if (!reader) return;
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (const line of buf.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
            } catch {}
          }
          buf = buf.slice(buf.lastIndexOf("\n") + 1);
        }
      })
      .catch(() => {});
    await Bun.sleep(300); // let the stream attach before we kill the daemon

    proc.kill(signal);

    // ⛔ THE TERMINATION ASSERTION. Observed on the process, with a budget, and
    // NOT inferred from the stream ending — a stream can end because the socket
    // died while the process lives on.
    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(EXIT_BUDGET_MS).then(() => "HUNG" as const),
    ]);
    ac.abort();
    await sse;
    expect(exited).not.toBe("HUNG");
    expect(exited).toBe(expectCode);
    return frames;
  }

  // ⚠ GUARD, MEASURED — this PASSES in both worlds and that is not a defect in
  // the cell. The old code terminated perfectly well; what it skipped was the
  // teardown. So this cell cannot be evidence FOR the fix, and calling it one
  // would be a label assigned before its measurement. Its job is the opposite:
  // to go red if the fix ever LOSES the ending, which is the failure mode the
  // join.ts scar actually shipped. Verified by mutation: 3 pass / 2 fail
  // pre-fix, and this was one of the three.
  test("GUARD — SIGTERM still ends the process, exit 143", async () => {
    await exitsOnSignal("SIGTERM", 143);
  }, 30000);

  // GUARD, same as above — measured passing pre-fix.
  test("GUARD — SIGINT still ends the process, exit 130", async () => {
    // Enumerated rather than inferred from SIGTERM — a separate handler is a
    // separate site, and a per-site precondition is what the join.ts scar was.
    await exitsOnSignal("SIGINT", 130);
  }, 30000);

  test("RED PRE-FIX — a signal death delivers the `closed` frame, reason 'signal'", async () => {
    // This is the cell that must FAIL against the old code: the old handler
    // process.exit'd, so `await done` never resolved and the emit at the end of
    // teardown was unreachable. 156 of 226 recorded deaths carried no frame.
    const frames = await exitsOnSignal("SIGTERM", 143);
    const closed = frames.find((f) => f.type === "closed");
    expect(closed).toBeDefined();
    // "signal", not "close": borrowing another reason's name would leave a
    // consumer unable to tell an orderly shutdown from a kill.
    expect(closed?.reason).toBe("signal");
  }, 30000);

  test("THE INSTRUMENT — the signal path logs `subscribers`", async () => {
    // Without this, nothing in daemon.log changes when the fix lands: `signal`
    // is the only exit class that has never carried the field, so the fix would
    // be unmeasurable afterwards. Captured before teardown closes anything.
    const home = uniqHome();
    const id = `p1f-${crypto.randomUUID().slice(0, 8)}`;
    const proc = Bun.spawn({
      cmd: ["bun", "run", SERVER, "--no-open", "--port", "0", "--id", id],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...hermeticEnv(), BOUNTY_HOME: home },
    });
    const discovery = join(TEST_TMPDIR, `bounty-${id}.json`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !existsSync(discovery)) await Bun.sleep(80);
    proc.kill("SIGTERM");
    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(EXIT_BUDGET_MS).then(() => "HUNG" as const),
    ]);
    expect(exited).not.toBe("HUNG");
    const log = readFileSync(join(home, "daemon.log"), "utf8");
    const sig = log
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { reason?: string; subscribers?: number })
      .filter((e) => e.reason === "signal");
    expect(sig.length).toBeGreaterThan(0);
    expect(typeof sig[0]?.subscribers).toBe("number");
  }, 30000);

  // GUARD, measured passing pre-fix — which is exactly what a blast-radius
  // cell should do: it watches the class the change did NOT intend to touch.
  test("GUARD — blast radius: a clean close still exits 0", async () => {
    // The funnel edits the SHARED teardown path, so the guard against trading
    // one death class for another is that the untouched class still works.
    const { proc, ready } = await spawnServerReady();
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ type: "close" }),
      headers: { "Content-Type": "application/json" },
    });
    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(EXIT_BUDGET_MS).then(() => "HUNG" as const),
    ]);
    expect(exited).not.toBe("HUNG");
    expect(exited).toBe(0);
  }, 30000);
});

describe("pinned, not changed — the re-measure found these already fixed", () => {
  test("SIGTERM saves: a mutation inside the debounce window reaches the snapshot", async () => {
    const home = uniqHome();
    const id = `sigterm-${crypto.randomUUID().slice(0, 8)}`;
    const proc = Bun.spawn({
      cmd: ["bun", "run", SERVER, "--no-open", "--port", "0", "--id", id],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...hermeticEnv(), BOUNTY_HOME: home },
    });
    try {
      const disc = join(TEST_TMPDIR, `bounty-${id}.json`);
      let port = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !port) {
        try {
          port = (JSON.parse(readFileSync(disc, "utf8")) as { port: number }).port;
        } catch {
          await Bun.sleep(80);
        }
      }
      expect(port).toBeGreaterThan(0);
      await fetch(`http://127.0.0.1:${port}/cmd`, {
        method: "POST",
        body: JSON.stringify({
          type: "task.add",
          task: { id: "s1", title: "saved by SIGTERM", status: "todo" },
        }),
      });
      proc.kill("SIGTERM"); // well inside the ~1s debounce
      expect(await proc.exited).toBe(143);
      expect(titlesAt(join(home, "snapshots", `${id}.json`))).toEqual(["saved by SIGTERM"]);
    } finally {
      killBoard(id);
    }
  }, 30000);
});

describe("a restore keeps every task", () => {
  test("point 1 — a dropped task survives restore → add → close, in a copy named on the envelope", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk1-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["good"], env);
    // A status from another bounty version: this build's validateTask rejects it.
    const snap = editSnapshot(home, id, (b) => {
      b.tasks.push({ id: "t-alien", title: "alien", status: "blocked" });
    });
    const original = readFileSync(snap, "utf8");
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      const hs = JSON.parse(o.stdout) as {
        restoreFailed: unknown;
        restoreDropped: Dropped[];
        snapshotBackups: NamedBackupT[];
      };
      expect(hs.restoreFailed).toBeNull();
      expect(hs.restoreDropped).toHaveLength(1);
      expect(hs.restoreDropped[0]?.index).toBe(1);
      expect(hs.restoreDropped[0]?.id).toBe("t-alien");
      expect(hs.restoreDropped[0]?.reason).toContain("status");
      const kept = backupHolding(hs.snapshotBackups, "alien");
      expect(kept?.kind).toBe("partial-restore");
      expect(kept?.reason ?? "").toContain("t-alien");
      expect(kept?.restore ?? "").toContain("--restore");
      // Byte-for-byte: the copy is the file as it was.
      expect(readFileSync(kept?.path as string, "utf8")).toBe(original);

      // Add a card so the count does not shrink and the shrink guard is silent.
      await runCli(["add", "new", "--session", id], { env });
      const c = await runCli(["close", "--session", id], { env });
      expect(c.code).toBe(0);
      expect(titlesAt(snap)).toEqual(["good", "new"]);
      const closed = (JSON.parse(c.stdout) as { snapshotBackups: NamedBackupT[] }).snapshotBackups;
      expect(backupHolding(closed, "alien")?.path).toBe(kept?.path as string);
      expect(titlesAt(kept?.path as string)).toContain("alien");

      // One copy, not one per respawn: the file now holds what the board holds.
      const r = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      const rs = JSON.parse(r.stdout) as { restoreDropped: Dropped[]; snapshotBackups: unknown[] };
      expect(rs.restoreDropped).toEqual([]);
      expect(rs.snapshotBackups).toEqual([]);
      await runCli(["close", "--session", id], { env });
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("point 1 — restoreDropped rides open, /state and the browser init, and is present-and-[] on a clean boot", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk2-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["a"], env);
    editSnapshot(home, id, (b) => {
      b.tasks.push({ title: "no id", status: "todo" });
    });
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      const hs = JSON.parse(o.stdout) as { port: number; restoreDropped: Dropped[] };
      expect(hs.restoreDropped).toHaveLength(1);
      expect(hs.restoreDropped[0]?.index).toBe(1);
      expect(hs.restoreDropped[0]?.id).toBeNull();
      expect(hs.restoreDropped[0]?.reason).toContain("id");
      const st = (await (await fetch(`http://127.0.0.1:${hs.port}/state`)).json()) as {
        restoreDropped: Dropped[];
      };
      expect(st.restoreDropped).toEqual(hs.restoreDropped);
      const ws = new WebSocket(`ws://127.0.0.1:${hs.port}/ws`);
      const init = await new Promise<Record<string, unknown>>((res, rej) => {
        ws.onmessage = (e) => res(JSON.parse(String(e.data)) as Record<string, unknown>);
        ws.onerror = () => rej(new Error("ws error"));
      });
      ws.close();
      expect(init.type).toBe("init");
      expect(init.restoreDropped).toEqual(hs.restoreDropped);
      await runCli(["close", "--session", id], { env });

      // A clean respawn: present and empty, never absent.
      const r = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      const rs = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(Object.hasOwn(rs, "restoreDropped")).toBe(true);
      expect(rs.restoreDropped).toEqual([]);
      await runCli(["close", "--session", id], { env });
      // An unkeyed new board too.
      const u = await runCli(["open", "--no-open", "--timeout", "30"], { env });
      const us = JSON.parse(u.stdout) as Record<string, unknown>;
      expect(Object.hasOwn(us, "restoreDropped")).toBe(true);
      expect(us.restoreDropped).toEqual([]);
      await runCli(["close", "--session", us.session_id as string], { env });
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("point 1 — a task validateTask keeps but CHANGES costs one copy, not one per respawn", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk3-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["a"], env);
    // A field from another bounty version: validateTask keeps the task, drops it.
    editSnapshot(home, id, (b) => {
      (b.tasks[0] as Record<string, unknown>).priority = "high";
    });
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      const hs = JSON.parse(o.stdout) as {
        restoreDropped: Dropped[];
        snapshotBackups: NamedBackupT[];
      };
      expect(hs.restoreDropped).toEqual([]);
      expect(hs.snapshotBackups.map((b) => b.kind)).toEqual(["partial-restore"]);
      expect(readFileSync(hs.snapshotBackups[0]?.path as string, "utf8")).toContain("priority");
      await runCli(["close", "--session", id], { env });
      for (let i = 0; i < 2; i++) {
        const r = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
          env,
        });
        expect((JSON.parse(r.stdout) as { snapshotBackups: unknown[] }).snapshotBackups).toEqual(
          [],
        );
        await runCli(["close", "--session", id], { env });
      }
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("point 1 — no cost: a board whose tasks were sized, claimed and tag-cleared respawns with no copy", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk4-${crypto.randomUUID().slice(0, 8)}`;
    const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
    const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "sized", "--id", "s1", "--size", "M", "--session", id], { env });
      await runCli(["add", "tagged", "--id", "s2", "--tag", "x", "--session", id], { env });
      // Fields added after creation land last in the stored object (key order),
      // and an explicit tag clear stores `tags: []`, which a restore normalises.
      await runCli(["update", "s1", "--owner", "bob", "--status", "doing", "--session", id], {
        env,
      });
      await runCli(["update", "s2", "--tag", "", "--session", id], { env });
      // Notes set then cleared, and more status transitions (round 2: the
      // narrowed empty-array rule must still let an ordinary board through).
      await runCli(["update", "s2", "--notes", "n", "--session", id], { env });
      await runCli(["update", "s2", "--clear-notes", "--session", id], { env });
      await runCli(["update", "s1", "--status", "done", "--session", id], { env });
      await runCli(["update", "s2", "--status", "doing", "--session", id], { env });
      await runCli(["close", "--session", id], { env });
      const r = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect((JSON.parse(r.stdout) as { snapshotBackups: unknown[] }).snapshotBackups).toEqual([]);
      const c = await runCli(["close", "--session", id], { env });
      expect((JSON.parse(c.stdout) as { snapshotBackups: unknown[] }).snapshotBackups).toEqual([]);
      expect(readdirSync(join(home, "snapshots"))).toEqual([`${id}.json`]);
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("round 2 — an unknown field whose value is [] is a difference: it costs the one copy, not a silent erase", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk8-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["a"], env);
    const snap = editSnapshot(home, id, (b) => {
      (b.tasks[0] as Record<string, unknown>).reviewers = [];
    });
    const original = readFileSync(snap, "utf8");
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      const hs = JSON.parse(o.stdout) as { snapshotBackups: NamedBackupT[] };
      expect(hs.snapshotBackups.map((b) => b.kind)).toEqual(["partial-restore"]);
      expect(hs.snapshotBackups[0]?.reason ?? "").toContain("reviewers");
      expect(readFileSync(hs.snapshotBackups[0]?.path as string, "utf8")).toBe(original);
      await runCli(["close", "--session", id], { env });
      expect(readFileSync(snap, "utf8")).not.toContain("reviewers");
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("round 2 — duplicate ids: the first is kept, later ones are named in restoreDropped, and the file is copied once", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk9-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["first"], env);
    let dupId = "";
    const snap = editSnapshot(home, id, (b) => {
      const t0 = b.tasks[0] as Record<string, unknown>;
      dupId = t0.id as string;
      // An identical copy, then a different entry under the same id.
      b.tasks.push({ ...t0 }, { ...t0, title: "second" });
    });
    const original = readFileSync(snap, "utf8");
    const copies = () =>
      readdirSync(join(home, "snapshots")).filter((f) => f.includes(".partial-restore-"));
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      const hs = JSON.parse(o.stdout) as {
        restoreDropped: Dropped[];
        snapshotBackups: NamedBackupT[];
      };
      expect(hs.restoreDropped.map((d) => [d.index, d.id])).toEqual([
        [1, dupId],
        [2, dupId],
      ]);
      expect(hs.restoreDropped[0]?.reason).toBe("duplicate id (index 0 already has it)");
      expect(hs.snapshotBackups.map((b) => b.kind)).toEqual(["partial-restore"]);
      expect(await liveTitles(id, env)).toEqual(["first"]);
      await runCli(["close", "--session", id], { env });
      for (let i = 0; i < 2; i++) {
        const r = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
          env,
        });
        const rs = JSON.parse(r.stdout) as {
          restoreDropped: Dropped[];
          snapshotBackups: unknown[];
        };
        expect(rs.restoreDropped).toEqual([]);
        expect(rs.snapshotBackups).toEqual([]);
        await runCli(["close", "--session", id], { env });
      }
      expect(copies()).toHaveLength(1);
      expect(readFileSync(join(home, "snapshots", copies()[0] as string), "utf8")).toBe(original);
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("round 2 — a partial-restore copy that fails is named on open's envelope, with why and the fix", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk10-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["good"], env);
    const snap = editSnapshot(home, id, (b) => {
      b.tasks.push({ id: "t-bad", title: "bad", status: "blocked" });
    });
    const sn = join(home, "snapshots");
    type Failed = { kind: string; path: string; error: string; fix: string } | null;
    try {
      chmodSync(sn, 0o555);
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      const hs = JSON.parse(o.stdout) as {
        restoreDropped: Dropped[];
        snapshotBackups: unknown[];
        snapshotBackupFailed: Failed;
      };
      expect(hs.restoreDropped.map((d) => d.id)).toEqual(["t-bad"]);
      expect(hs.snapshotBackups).toEqual([]);
      expect(hs.snapshotBackupFailed?.kind).toBe("partial-restore");
      expect(hs.snapshotBackupFailed?.path).toBe(snap);
      expect(hs.snapshotBackupFailed?.error ?? "").toContain("EACCES");
      expect(hs.snapshotBackupFailed?.fix ?? "").toContain(`make the folder ${sn} writable`);
      expect(o.stderr).toContain("could not copy");
      expect(o.stderr).toContain(snap);
      chmodSync(sn, 0o755);
      const c = await runCli(["close", "--session", id], { env });
      expect(c.code).toBe(0);
      const r = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      const rs = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(Object.hasOwn(rs, "snapshotBackupFailed")).toBe(true);
      expect(rs.snapshotBackupFailed).toBeNull();
      await runCli(["close", "--session", id], { env });
    } finally {
      try {
        chmodSync(sn, 0o755);
      } catch {}
      killBoard(id);
    }
  }, 60000);

  test("round 2 — the partial-restore reason names each changed task and its fields, and a board field", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk11-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["a", "b"], env);
    let changedId = "";
    editSnapshot(home, id, (b) => {
      const t0 = b.tasks[0] as Record<string, unknown>;
      changedId = t0.id as string;
      t0.priority = "high";
      t0.size = "XXL";
      (b as Record<string, unknown>).owner = "someone";
    });
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      const hs = JSON.parse(o.stdout) as { snapshotBackups: NamedBackupT[] };
      const reason = hs.snapshotBackups[0]?.reason ?? "";
      expect(reason).toContain(`changed: ${changedId} (priority, size)`);
      expect(reason).toContain("a board field (owner)");
      expect(reason).not.toContain("changed an entry it read");
      await runCli(["close", "--session", id], { env });
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("point 2 — --fresh --restore <own id> with a read-only snapshots/ is a conflict envelope, and the board survives", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk5-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["p1"], env);
    const sn = join(home, "snapshots");
    try {
      await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
      chmodSync(sn, 0o555);
      const f = await runCli(
        ["open", "--session-key", key, "--fresh", "--restore", id, "--no-open", "--timeout", "30"],
        { env },
      );
      expect(f.code).toBe(6);
      expect(f.stdout).toBe("");
      const err = onlyEnvelope(f.stderr);
      expect(err.error.kind).toBe("conflict");
      expect(err.error.message).toContain("copied aside");
      expect(await liveTitles(id, env)).toEqual(["p1"]);
      chmodSync(sn, 0o755);
      expect((await runCli(["close", "--session", id], { env })).code).toBe(0);
      expect(titlesAt(join(sn, `${id}.json`))).toEqual(["p1"]);
    } finally {
      try {
        chmodSync(sn, 0o755);
      } catch {}
      killBoard(id);
    }
  }, 60000);

  test("point 3 — a keyed respawn with snapshots/ at mode 000 says its restore failed, and never blames --fresh", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rk6-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["p1-precious"], env);
    const sn = join(home, "snapshots");
    const snap = join(sn, `${id}.json`);
    try {
      chmodSync(sn, 0o000);
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      const hs = JSON.parse(o.stdout) as { restoreFailed: { path: string; reason: string } | null };
      expect(hs.restoreFailed).not.toBeNull();
      expect(hs.restoreFailed?.path).toBe(snap);
      expect(hs.restoreFailed?.reason ?? "").toContain("EACCES");
      await runCli(["add", "n1", "--session", id], { env });
      chmodSync(sn, 0o755);
      const c = await runCli(["close", "--session", id], { env });
      expect(c.code).toBe(0);
      const named = (JSON.parse(c.stdout) as { snapshotBackups: NamedBackupT[] }).snapshotBackups;
      const kept = backupHolding(named, "p1-precious");
      expect(kept?.kind).toBe("unread");
      expect(kept?.reason ?? "").not.toContain("--fresh");
      expect(kept?.reason ?? "").toContain("restore failed");
    } finally {
      try {
        chmodSync(sn, 0o755);
      } catch {}
      killBoard(id);
    }
  }, 60000);

  test("point 4 — an open that loses the race does not report a restore it did not do", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const keyP = `rk7p-${crypto.randomUUID().slice(0, 8)}`;
    const keyQ = `rk7q-${crypto.randomUUID().slice(0, 8)}`;
    const pid = await seedClosed(keyP, ["p1"], env);
    const qid = await seedClosed(keyQ, ["q1"], env);
    const pointer = join(TEST_TMPDIR, `bounty-${pid}.json`);
    try {
      // P is live (another open's board). Hide its pointer so this open's entry
      // check sees no live board and spawns its own daemon, which then loses the
      // lock to P's daemon; put the pointer back so this open finds P's board.
      await runCli(["open", "--session-key", keyP, "--no-open", "--timeout", "30"], { env });
      const saved = readFileSync(pointer, "utf8");
      rmSync(pointer);
      const racing = runCli(
        ["open", "--session-key", keyP, "--fresh", "--restore", qid, "--no-open"],
        { env },
      );
      await Bun.sleep(1200);
      writeFileSync(pointer, saved);
      const r = await racing;
      expect(r.code).toBe(2);
      const hs = JSON.parse(r.stdout) as {
        session_id: string;
        restoreSkipped: { requested: string[]; reason: string } | null;
      };
      expect(hs.session_id).toBe(pid);
      expect(hs.restoreSkipped?.requested).toEqual(["restore"]);
      expect(hs.restoreSkipped?.reason ?? "").toContain("another open");
      expect(hs.restoreSkipped?.reason ?? "").toContain("configures a daemon at spawn time");
      expect(await liveTitles(pid, env)).toEqual(["p1"]);
      await runCli(["close", "--session", pid], { env });
    } finally {
      killBoard(pid);
      killBoard(qid);
    }
  }, 60000);
});
