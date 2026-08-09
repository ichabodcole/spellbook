// Tests for bounty server.ts (the daemon), cli.ts, and join.ts.
//
// Coverage:
//   - Pure state-mutation helpers (applyTaskAdd/Update/Remove/Move).
//   - parsePortFromSessionId (the relaunch-port-reuse contract).
//   - htmlEscape (the 5 interesting chars + ampersand-first ordering).
//   - The daemon HTTP surface: GET /state, POST /cmd, GET /events (SSE).
//   - End-to-end via subprocess for the bits that need a real server:
//       * submit broadcasts to all WS clients (browsers + joiners)
//       * cancel broadcasts a structured event to all WS clients
//       * task.edit rejects non-string titles silently
//       * task.add from browser rejects malformed task objects
//       * cli.ts ↔ daemon parity: state ack, --stdin quoting, tail
//         resume-from-cursor, idle-touch (the Phase A gate)
//       * join.ts discovers via bounty-latest.json when --url/--id omitted
//       * join.ts idle timeout reports reason: "timeout"

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveSessionId,
  findScopeRoot,
  liveBoards,
  ownerInScope,
  parseTags,
  pickTailSession,
  resolveSession,
  type Session,
  sessionKeyToId,
  slugifyKey,
} from "./cli.ts";
import {
  applyTaskAdd,
  applyTaskMove,
  applyTaskRemove,
  applyTaskUpdate,
  type BoardState,
  cardOverdue,
  cardPassesFilter,
  cleanTags,
  computeDuePokes,
  expectedMinutes,
  htmlEscape,
  isNoOpMove,
  isNoOpUpdate,
  ownersOverWip,
  parsePortFromSessionId,
  shouldIdleClose,
  shouldRotateSnapshot,
  snapshotTaskCount,
  type Task,
  type TaskStatus,
  validateTask,
} from "./server.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// A decoded protocol frame as observed on stdout / the WebSocket. The
// helpers collect heterogeneous frames (ready, meta, task.*, submit, init,
// joined, disconnected, …); fields are optional and narrowed per assertion.
type WireMsg = {
  type?: string;
  task?: Task;
  tasks?: Task[];
  patch?: Partial<Task>;
  id?: string;
  status?: TaskStatus;
  index?: number;
  title?: string;
  text?: string;
  reason?: string;
  url?: string;
  port?: number;
  session_id?: string;
};
const SERVER = join(SCRIPT_DIR, "server.ts");
const JOIN = join(SCRIPT_DIR, "join.ts");

function freshState(): BoardState {
  return { title: "T", tasks: [] };
}

// ── Pure state mutation tests ────────────────────────────────────────────

describe("applyTaskAdd", () => {
  test("appends a task", () => {
    const s = freshState();
    expect(applyTaskAdd(s, { id: "a", title: "A", status: "todo" })).toBe(true);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0].id).toBe("a");
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
    expect(s.tasks[0].status).toBe("doing");
    expect(s.tasks[0].title).toBe("A");
  });
  test("accepts the review status", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskUpdate(s, "a", { status: "review" })).toBe(true);
    expect(s.tasks[0].status).toBe("review");
  });
  test("drops invalid status quietly", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskUpdate(s, "a", { status: "bogus" as TaskStatus, title: "B" })).toBe(true);
    expect(s.tasks[0].status).toBe("todo");
    expect(s.tasks[0].title).toBe("B");
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
    expect(s.tasks[0].enteredStatusAt).toBe(T0);
    expect(s.tasks[0].statusHistory).toEqual([{ status: "todo", at: T0 }]);
  });
  test("applyTaskAdd preserves a restored task's existing stamp", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "r", title: "R", status: "doing", enteredStatusAt: 42 }, T0);
    expect(s.tasks[0].enteredStatusAt).toBe(42); // not overwritten with T0
  });
  test("applyTaskUpdate re-stamps on a status change and appends history", () => {
    const s = seededAt(T0);
    applyTaskUpdate(s, "a", { status: "doing" }, T0 + 500);
    expect(s.tasks[0].enteredStatusAt).toBe(T0 + 500);
    expect(s.tasks[0].statusHistory).toEqual([
      { status: "todo", at: T0 },
      { status: "doing", at: T0 + 500 },
    ]);
  });
  test("a non-status patch does NOT touch the transition stamp", () => {
    const s = seededAt(T0);
    applyTaskUpdate(s, "a", { notes: "hi" }, T0 + 500);
    expect(s.tasks[0].enteredStatusAt).toBe(T0);
    expect(s.tasks[0].statusHistory).toHaveLength(1);
  });
  test("a same-status patch does NOT reset the stamp", () => {
    const s = seededAt(T0);
    applyTaskUpdate(s, "a", { status: "todo", notes: "x" }, T0 + 500);
    expect(s.tasks[0].enteredStatusAt).toBe(T0); // no transition
  });
  test("applyTaskMove stamps a cross-column move", () => {
    const s = seededAt(T0);
    applyTaskMove(s, "a", "doing", 0, T0 + 900);
    expect(s.tasks[0].enteredStatusAt).toBe(T0 + 900);
    expect(s.tasks[0].statusHistory?.map((h) => h.status)).toEqual(["todo", "doing"]);
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
    const hist = s.tasks[0].statusHistory ?? [];
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
    expect(pokes[0].overdueByMs).toBe(1 * MIN);
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
    expect(pokes[0].owner).toBeUndefined();
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

// ── End-to-end subprocess tests ──────────────────────────────────────────

type ReadyInfo = { url: string; port: number; session_id: string };

// ── Test hermeticity (#P0e) ──────────────────────────────────────────────
// The ambient environment binds every bounty verb to a REAL board: `cmdOpen`
// reads $BOUNTY_SESSION_KEY and derives a board id from it, and `resolveSession`
// falls back to $BOUNTY_SESSION. BOUNTY_HOME isolates the SNAPSHOT STORE only —
// it does NOT cover the key path — so a suite that scrubs only BOUNTY_HOME is
// still bound to whatever live board the shell points at. Measured: running
// this file inside an anthill seat shell (which exports BOUNTY_SESSION_KEY)
// made `open` take the idempotent-attach branch onto the TEAM's live board,
// write fixture cards into it, and then `close` it — the verb that clobbers the
// snapshot. Scrub the key path here, at the ONE place both spawn helpers share,
// so the hermeticity cannot drift between them.
// Computed per CALL, not once at module load: a module-load snapshot would make
// the regression test below vacuous (it sets the ambient key *during* the test,
// which a snapshot taken at import time could never have contained), and it
// would also miss anything that sets the variable after import.
//
// ── HALF 2: the discovery pointer (P0e reopened) ─────────────────────────
// Scrubbing the key path was only half the isolation. Session DISCOVERY does
// not go through BOUNTY_HOME at all: `cli.ts`, `join.ts` and `server.ts` all
// compose `join(tmpdir(), "bounty-latest.json")` — a MACHINE-GLOBAL singleton.
// Every daemon that boots anywhere on the machine overwrites it, so a peer
// suite (or another agent, or another project) can land inside the ~200ms
// window between this suite writing the pointer and reading it back. Measured:
// an injected daemon made this file's own assertions come back holding a
// FOREIGN session id, and 410 of 412 pointer writes on this machine in ten
// minutes were test fixtures — i.e. the peer is almost always another suite.
//
// So the harness assigns its own private TMPDIR and every spawn inherits it.
// A peer cannot reach a directory it cannot name.
//
// Note the deliberate asymmetry with the scrub above, because it looks like an
// inconsistency and is not: the SCRUB is recomputed per call (the ambient key
// changes during the run and a snapshot would miss it), while the TMPDIR is
// resolved ONCE and held (every spawn in this file must agree on one pointer
// directory — a fresh dir per call would hide each daemon from the very next
// CLI invocation that has to discover it).
//
// NOT put in the consumer's gate string on purpose: a `TMPDIR=$(mktemp -d)`
// pasted into `config.json` is a workaround living outside the thing it fixes,
// which is the shape this phase already deleted once. The harness owns it.
const TEST_TMPDIR = mkdtempSync(join(tmpdir(), "bounty-suite-"));

// The machine-global temp dir — the one every OTHER bounty process on this box
// resolves to. Captured for the half-2 regression to assert AGAINST; nothing in
// this suite may compose a pointer path from it (the structural guard enforces
// that). Safe to read here because this file never mutates process.env.TMPDIR:
// the private dir travels to children through hermeticEnv(), not through us.
const SHARED_TMPDIR = tmpdir();

// ⛔ The scrub list is NOT a set someone remembered — it is the env-typed half of
// AMBIENT_BINDINGS in preflight.ts, and preflight.test.ts source-scans this
// destructure to prove they agree. Adding a binding there without adding it here
// is RED, which is the only reason this list can be trusted later.
//
// BOUNTY_AS joined it in sprint 03: the enumeration that found it also found why
// it had been missed for two sprints — `grep 'process.env.'` cannot see
// BOUNTY_SESSION at all, because resolveSession reads it off an INJECTED env
// param (cli.ts:182). A scrub list derived by that grep is short and looks
// complete. TMPDIR is assigned rather than deleted (children need a private
// one); BOUNTY_HOME is assigned per-test by uniqHome().
function hermeticEnv(): Record<string, string | undefined> {
  const { BOUNTY_SESSION_KEY: _k, BOUNTY_SESSION: _s, BOUNTY_AS: _a, ...rest } = process.env;
  return { ...rest, TMPDIR: TEST_TMPDIR };
}

// Spawn the daemon and wait until it's reachable. Readiness is discovered via
// the daemon's discovery file (`bounty-<id>.json`) + a /state probe — the
// daemon no longer prints a `ready` line on stdout (the SSE event log is the
// sole agent channel since the file-pump was retired).
async function spawnServerReady(
  args: string[] = [],
): Promise<{ proc: ReturnType<typeof Bun.spawn>; ready: ReadyInfo }> {
  const id = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const proc = Bun.spawn({
    cmd: ["bun", "run", SERVER, "--no-open", "--port", "0", "--id", id, ...args],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Isolate persistence to a throwaway dir — a test suite must NOT write
    // snapshots into the user's real ~/.bounty (the default BOUNTY_HOME).
    env: { ...hermeticEnv(), BOUNTY_HOME: uniqHome() },
  });
  // TEST_TMPDIR, not tmpdir(): the daemon we just spawned writes its discovery
  // file into the TMPDIR we handed it, so the parent must look in the same place.
  const discoveryFile = join(TEST_TMPDIR, `bounty-${id}.json`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const info = JSON.parse(readFileSync(discoveryFile, "utf8")) as ReadyInfo;
      const r = await fetch(`${info.url}/state`);
      if (r.ok) return { proc, ready: info };
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 80));
  }
  proc.kill();
  throw new Error("server did not become ready");
}

// Seed board state over the daemon's HTTP write path (replaces the retired
// stdin JSON-lines seeding).
async function seedCmd(url: string, body: unknown): Promise<void> {
  await fetch(`${url}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function collectStdout(
  proc: ReturnType<typeof Bun.spawn>,
  predicate: (m: WireMsg) => boolean,
  maxMs: number,
): Promise<WireMsg[]> {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen: WireMsg[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line) as WireMsg;
      seen.push(m);
      if (predicate(m)) {
        reader.releaseLock();
        return seen;
      }
    }
    if (done) break;
  }
  reader.releaseLock();
  return seen;
}

// Helper: wait for either the WS to close OR a target message to arrive,
// whichever comes first. Returns when both are settled so we can assert.
async function collectWsUntilClose(ws: WebSocket): Promise<WireMsg[]> {
  const msgs: WireMsg[] = [];
  ws.addEventListener("message", (ev) => {
    try {
      msgs.push(JSON.parse(ev.data) as WireMsg);
    } catch {
      /* skip */
    }
  });
  await new Promise<void>((r) => {
    if (ws.readyState === WebSocket.CLOSED) return r();
    ws.addEventListener("close", () => r(), { once: true });
  });
  return msgs;
}

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
    expect(titleUpdates[0].patch.title).toBe("updated");
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
    expect(adds[0].task.id).toBe("ok");
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
    expect(body.state.tasks[0].title).toBe("new title");
    expect(body.state.tasks[0].notes).toBe("new notes");
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
    expect(body.state.tasks[0].title).toBe("keep title");
    expect(body.state.tasks[0].notes).toBe("added a note");
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

    expect(body.state.tasks[0].status).toBe("doing");
    expect(body.state.tasks[0].title).toBe("first");
  }, 15000);

  test("a status transition stamps enteredStatusAt + grows history (live path)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, { type: "task.add", task: { id: "t1", title: "T", status: "todo" } });
    const before = ((await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState })
      .state.tasks[0];
    // Stamped on add.
    expect(typeof before.enteredStatusAt).toBe("number");
    expect(before.statusHistory).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    await postCmd(ready.url, { type: "task.update", id: "t1", patch: { status: "doing" } });
    const after = ((await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState })
      .state.tasks[0];
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
    expect(body.state.tasks[0].id).toBe("good");
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
    expect(s.state.tasks[0].owner).toBe("alice");
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
    expect(s.state.tasks[0].owner).toBe("bob");
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
    expect(s.state.tasks[0].owner).toBe("bob");
  }, 15000);
});

// ── cli.ts ↔ daemon parity (Phase A gate) ────────────────────────────────
//
// These drive the real cli.ts as a subprocess against a daemon it spawns —
// the agent-facing path that replaces bg.ts. Proving these green is the gate
// that lets bg.ts / watch-events.sh / the stdin reader be retired. Each test
// targets its daemon by explicit --session <id> (never the shared "latest"
// pointer) so concurrent/stale discovery files can't cross-wire the assertions.

const CLI = join(SCRIPT_DIR, "cli.ts");

// A fresh per-test BOUNTY_HOME so snapshot/discovery state never leaks between
// tests (Phase B writes snapshots here; Phase A keeps tests isolated up front).
function uniqHome(): string {
  return join(TEST_TMPDIR, `bounty-test-${crypto.randomUUID().slice(0, 8)}`);
}

type CliResult = { stdout: string; stderr: string; code: number };

async function runCli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI, ...args],
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...hermeticEnv(), ...opts.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code } as CliResult;
}

describe("cli.ts ↔ daemon parity", () => {
  test("state read-back reflects an add then an update (the #8 ack)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "first task", "--id", "t1", "--session", session], { env });
      const s1 = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
        cursor: number;
      };
      expect(s1.state.tasks).toHaveLength(1);
      expect(s1.state.tasks[0]).toMatchObject({ id: "t1", title: "first task", status: "todo" });
      expect(typeof s1.cursor).toBe("number");

      await runCli(["update", "t1", "--status", "doing", "--session", session], { env });
      const s2 = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      expect(s2.state.tasks[0].status).toBe("doing");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("daemon.log records ready + exit lifecycle lines (#64 diagnostics)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["close", "--session", session], { env });
    const logPath = join(home, "daemon.log");
    // The `exit` line lands as the daemon tears down, which races the CLI close
    // returning — poll briefly for it rather than reading once.
    // The shutdown line carries the CloseReason as `reason` (the extra spread
    // wins over the "exit" label) plus the subscribers/idleMs signal — that
    // subscribers/idleMs pair is how we tell it apart from a `ready` line.
    const isExit = (l: { reason: string; subscribers?: number }) =>
      l.subscribers !== undefined && l.reason !== "ready";
    const readMine = () =>
      (existsSync(logPath) ? readFileSync(logPath, "utf8") : "")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { reason: string; session_id: string; subscribers?: number })
        .filter((l) => l.session_id === session);
    let mine = readMine();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !mine.some(isExit)) {
      await new Promise((r) => setTimeout(r, 80));
      mine = readMine();
    }
    expect(existsSync(logPath)).toBe(true);
    expect(mine.some((l) => l.reason === "ready")).toBe(true);
    expect(mine.some(isExit)).toBe(true);
    // A CLI close resolves the daemon with reason "close".
    expect(mine.find(isExit)?.reason).toBe("close");
  }, 20000);

  test("add --stdin lands arbitrary text verbatim (the #7 quoting guard)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const nasty = `it's a "quoted" & <ok> $title \`x\``;
    try {
      await runCli(["add", "--stdin", "--id", "t1", "--session", session], { env, stdin: nasty });
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      // Character-for-character — no shell truncation, no escaping artifacts.
      expect(s.state.tasks[0].title).toBe(nasty);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test('--tag sets (cleaned + deduped), replaces on update, and clears with "" (#18)', async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const tags = async () => {
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      return s.state.tasks[0]?.tags ?? [];
    };
    try {
      // add: messy input → stored clean (trim + dedupe).
      await runCli(
        ["add", "tagged", "--id", "t1", "--tag", " frontend, bug ,frontend", "--session", session],
        { env },
      );
      expect(await tags()).toEqual(["frontend", "bug"]);
      // update: SET semantics — the list replaces, not merges.
      await runCli(["update", "t1", "--tag", "ui,ux", "--session", session], { env });
      expect(await tags()).toEqual(["ui", "ux"]);
      // clear: --tag "" empties the list.
      await runCli(["update", "t1", "--tag", "", "--session", session], { env });
      expect(await tags()).toEqual([]);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("--size (case-insensitive) + --expect override set the heartbeat estimate (#29)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const task = async () => {
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      return s.state.tasks[0];
    };
    try {
      await runCli(["add", "sized", "--id", "t1", "--size", "m", "--session", session], { env });
      expect((await task()).size).toBe("M"); // normalized to uppercase
      await runCli(["update", "t1", "--expect", "45", "--session", session], { env });
      expect((await task()).expect).toBe(45);
      // A bogus size alongside a real field is dropped; the rest of the patch lands.
      await runCli(["update", "t1", "--notes", "go", "--size", "XL", "--session", session], {
        env,
      });
      const t = await task();
      expect(t.notes).toBe("go");
      expect(t.size).toBe("M"); // unchanged — XL rejected
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("tail streams JSONL events and exits 0 on the closed frame", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;

    // Start a tail subprocess capturing stdout (the Monitor-wrapped path).
    const tail = Bun.spawn({
      cmd: ["bun", "run", CLI, "tail", "--since", "0", "--session", session],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...hermeticEnv(), ...env },
    });
    await new Promise((r) => setTimeout(r, 300)); // let the tail subscribe
    await runCli(["add", "tailed task", "--id", "tt", "--session", session], { env });
    await new Promise((r) => setTimeout(r, 300));
    await runCli(["close", "--session", session], { env });

    const out = await new Response(tail.stdout).text();
    const code = await tail.exited;

    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const add = lines.find((e) => e.type === "task.add");
    expect(add).toBeDefined();
    expect((add?.task as Task).id).toBe("tt");
    // Frames are monotonic on `id`; the closed frame ends the stream, exit 0.
    expect(lines.some((e) => e.type === "closed")).toBe(true);
    expect(code).toBe(0);
  }, 20000);

  test("tail --since <cursor> resumes: only newer events replay", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "early", "--id", "e1", "--session", session], { env });
      const { cursor } = JSON.parse(
        (await runCli(["state", "--session", session], { env })).stdout,
      ) as { cursor: number };
      await runCli(["add", "late", "--id", "l1", "--session", session], { env });

      // A tail resuming from `cursor` must replay only the post-cursor add.
      const tail = Bun.spawn({
        cmd: ["bun", "run", CLI, "tail", "--since", String(cursor), "--session", session],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...hermeticEnv(), ...env },
      });
      await new Promise((r) => setTimeout(r, 500));
      tail.kill();
      const out = await new Response(tail.stdout).text();

      const addIds = out
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.type === "task.add")
        .map((e) => (e.task as Task).id);
      expect(addIds).toContain("l1");
      expect(addIds).not.toContain("e1");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("agent activity keeps the daemon alive past the idle window (#6 idle-touch)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "1"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;

    // Touch via /state every ~400ms for ~2s — well past the 1s idle window.
    for (let i = 0; i < 5; i++) {
      const r = await runCli(["state", "--session", session], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"cursor"');
      await new Promise((res) => setTimeout(res, 400));
    }
    // Now go quiet — after genuine inactivity the daemon should exit 124 and
    // the session discovery file/port become unreachable.
    await new Promise((res) => setTimeout(res, 2000));
    const dead = await runCli(["state", "--session", session], { env });
    expect(dead.code).toBe(2); // cli.ts `die`s when the daemon is gone
  }, 25000);
});

// ── Ownership + scoping (Phase C) ────────────────────────────────────────
//
// The multi-agent value: a worker tailing its scope is woken by its own +
// claimable tasks, never the whole board; its own writes are suppressed; and a
// cooperative claim can't steal an already-owned task.

describe("ownership scoping (Phase C E2E)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Run a scoped tail, mutate the board, return the JSONL frames the tail saw.
  async function tailFrames(
    session: string,
    env: Record<string, string>,
    scopeArgs: string[],
    mutate: () => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    const tail = Bun.spawn({
      cmd: ["bun", "run", CLI, "tail", "--since", "0", "--session", session, ...scopeArgs],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...hermeticEnv(), ...env },
    });
    await wait(400); // subscribe
    await mutate();
    await wait(400); // let frames arrive
    tail.kill();
    const out = await new Response(tail.stdout).text();
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test("--owner scopes to owned, filters others, suppresses self-echo", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "15"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "X", "--id", "X", "--owner", "worker1", "--session", session], { env });
    await runCli(["add", "Y", "--id", "Y", "--owner", "worker2", "--session", session], { env });

    const frames = await tailFrames(
      session,
      env,
      ["--owner", "worker1", "--as", "worker1"],
      async () => {
        // a third actor (lead) mutates worker1's X → should reach worker1's tail
        await runCli(["update", "X", "--status", "doing", "--as", "lead", "--session", session], {
          env,
        });
        // lead mutates worker2's Y → filtered out (not worker1's)
        await runCli(["update", "Y", "--status", "doing", "--as", "lead", "--session", session], {
          env,
        });
        // worker1 mutates its OWN X → self-echo, suppressed from worker1's tail
        await runCli(["update", "X", "--notes", "mine", "--as", "worker1", "--session", session], {
          env,
        });
      },
    );
    await runCli(["close", "--session", session], { env });

    // Woken by the lead's mutation of an owned task.
    expect(frames.some((f) => f.taskId === "X" && f.by === "lead")).toBe(true);
    // Never woken by another owner's task.
    expect(frames.some((f) => f.taskId === "Y")).toBe(false);
    // Own writes suppressed.
    expect(frames.some((f) => f.by === "worker1")).toBe(false);
  }, 30000);

  test("--mine wakes on own + claimable (unowned), not another owner's", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "15"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "M", "--id", "M", "--owner", "worker1", "--session", session], { env });
    await runCli(["add", "U", "--id", "U", "--session", session], { env }); // unowned/claimable
    await runCli(["add", "Z", "--id", "Z", "--owner", "worker2", "--session", session], { env });

    const frames = await tailFrames(session, env, ["--mine", "--as", "worker1"], async () => {
      await runCli(["update", "M", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
      await runCli(["update", "U", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
      await runCli(["update", "Z", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
    });
    await runCli(["close", "--session", session], { env });

    expect(frames.some((f) => f.taskId === "M" && f.type === "task.update")).toBe(true); // mine
    expect(frames.some((f) => f.taskId === "U" && f.type === "task.update")).toBe(true); // claimable
    expect(frames.some((f) => f.taskId === "Z" && f.type === "task.update")).toBe(false); // another's
  }, 30000);

  test("claim: rejected (visible, nonzero) on other-owned; succeeds on unowned", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "O", "--id", "O", "--owner", "alice", "--session", session], { env });
    await runCli(["add", "F", "--id", "F", "--session", session], { env });
    try {
      const rejected = await runCli(["claim", "O", "--as", "bob", "--session", session], { env });
      expect(rejected.code).toBe(1); // visible nonzero — not a silent {ok:true}
      expect(rejected.stderr).toContain("alice");

      const ok = await runCli(["claim", "F", "--as", "bob", "--session", session], { env });
      expect(ok.code).toBe(0);
      expect((JSON.parse(ok.stdout) as { owner?: string }).owner).toBe("bob");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);

  test("update/remove of a not-found id fail visibly (nonzero, no {ok:true}) — #62", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "real", "--id", "real", "--session", session], { env });
    try {
      // A mis-routed (not-found) update must NOT print a silent {ok:true}.
      const badUpd = await runCli(["update", "ghost", "--status", "done", "--session", session], {
        env,
      });
      expect(badUpd.code).toBe(1);
      expect(badUpd.stdout).not.toContain('"ok":true');
      expect(badUpd.stderr).toContain("ghost");

      // A not-found remove is the same visible failure.
      const badRm = await runCli(["remove", "ghost", "--session", session], { env });
      expect(badRm.code).toBe(1);
      expect(badRm.stdout).not.toContain('"ok":true');

      // An EXISTING task still updates + removes with exit 0 + a success line.
      const okUpd = await runCli(["update", "real", "--status", "doing", "--session", session], {
        env,
      });
      expect(okUpd.code).toBe(0);
      expect((JSON.parse(okUpd.stdout) as { updated?: string }).updated).toBe("real");

      // A legitimate NO-OP update (doing→doing) is applied:false with NO error —
      // it must stay benign (exit 0), not be mistaken for a mis-route (#62 edge).
      const noop = await runCli(["update", "real", "--status", "doing", "--session", session], {
        env,
      });
      expect(noop.code).toBe(0);
      expect(noop.stderr).not.toContain("no such task");
      expect((JSON.parse(noop.stdout) as { noop?: boolean }).noop).toBe(true);

      const okRm = await runCli(["remove", "real", "--session", session], { env });
      expect(okRm.code).toBe(0);
      expect((JSON.parse(okRm.stdout) as { removed?: string }).removed).toBe("real");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);
});

// ── Dependencies (Phase D) — blockedBy, cycle guard, unblocked ───────────

describe("dependencies (Phase D)", () => {
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
  const find = (s: { state: BoardState }, id: string) => s.state.tasks.find((t) => t.id === id);

  // Read SSE frames until predicate or timeout (local to this describe).
  async function collect(
    url: string,
    since: number,
    pred: (ev: Record<string, unknown>) => boolean,
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
            if (pred(ev)) {
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

  async function seedTasks(url: string, tasks: Record<string, unknown>[]) {
    for (const task of tasks) await cmd(url, { type: "task.add", task });
  }

  test("b10: block on a NONEXISTENT task is refused — it would constrain nothing", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [{ id: "R", title: "R", status: "todo" }]);
    // RED PRE-FIX: this answered {ok:true, applied:true} and wrote a dangling
    // edge. The subject's existence was checked; the blocker's was not.
    const res = await cmd(ready.url, { type: "task.block", id: "R", on: ["ghost"] });
    expect(res.data.applied).toBe(false);
    expect(String(res.data.error)).toContain("ghost");
    // and nothing was written — a refused command must not half-apply
    const s = await state(ready.url);
    expect(find(s, "R")?.blockedBy ?? []).toEqual([]);
    proc.kill();
    await proc.exited;
  }, 15000);

  test("b10: a partly-unknown blocker list is refused WHOLE and names every unknown id", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "R", title: "R", status: "todo" },
      { id: "REAL", title: "REAL", status: "todo" },
    ]);
    // All-or-nothing, mirroring the cycle guard: a 44-id cleanup must not become
    // a bisect, and a partial apply would leave the caller's model wrong.
    const res = await cmd(ready.url, { type: "task.block", id: "R", on: ["REAL", "g1", "g2"] });
    expect(res.data.applied).toBe(false);
    const err = String(res.data.error);
    expect(err).toContain("g1");
    expect(err).toContain("g2");
    const s = await state(ready.url);
    // the VALID edge was not applied either — whole-command refusal
    expect(find(s, "R")?.blockedBy ?? []).toEqual([]);
    proc.kill();
    await proc.exited;
  }, 15000);

  test("block adds edges; unblock removes them", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo" },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "todo" },
    ]);
    await cmd(ready.url, { type: "task.block", id: "X", on: ["B1", "B2"] });
    let s = await state(ready.url);
    expect(find(s, "X")?.blockedBy?.sort()).toEqual(["B1", "B2"]);
    await cmd(ready.url, { type: "task.unblock", id: "X", on: ["B1"] });
    s = await state(ready.url);
    expect(find(s, "X")?.blockedBy).toEqual(["B2"]);
    proc.kill();
    await proc.exited;
  }, 15000);

  test("cycle guard rejects self-ref / 2-node / 3-node, state unmutated", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "A", title: "A", status: "todo" },
      { id: "B", title: "B", status: "todo" },
      { id: "C", title: "C", status: "todo" },
    ]);
    // self-ref
    const selfRes = await cmd(ready.url, { type: "task.block", id: "A", on: ["A"] });
    expect(selfRes.data.applied).toBe(false);
    expect(String(selfRes.data.error).toLowerCase()).toContain("cycle");
    expect(find(await state(ready.url), "A")?.blockedBy).toBeUndefined();
    // 2-node: A on B (ok), then B on A (cycle)
    await cmd(ready.url, { type: "task.block", id: "A", on: ["B"] });
    const twoRes = await cmd(ready.url, { type: "task.block", id: "B", on: ["A"] });
    expect(twoRes.data.applied).toBe(false);
    expect(find(await state(ready.url), "B")?.blockedBy).toBeUndefined();
    // 3-node: B on C (ok), then C on A (A→B→C→A cycle)
    await cmd(ready.url, { type: "task.block", id: "B", on: ["C"] });
    const threeRes = await cmd(ready.url, { type: "task.block", id: "C", on: ["A"] });
    expect(threeRes.data.applied).toBe(false);
    expect(find(await state(ready.url), "C")?.blockedBy).toBeUndefined();
    proc.kill();
    await proc.exited;
  }, 15000);

  test("blockedBy can't be set via a raw task.update (bypass closed)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo" },
      { id: "Y", title: "Y", status: "todo" },
    ]);
    await cmd(ready.url, {
      type: "task.update",
      id: "X",
      patch: { status: "doing", blockedBy: ["Y"] },
    });
    const x = find(await state(ready.url), "X");
    proc.kill();
    await proc.exited;
    expect(x?.status).toBe("doing"); // the rest of the patch still applies
    expect(x?.blockedBy).toBeUndefined(); // blockedBy stripped — guard stays load-bearing
  }, 15000);

  test("unblocked fires once when the LAST blocker reaches done, targets the owner", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", owner: "worker1", blockedBy: ["B1", "B2"] },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "todo" },
    ]);
    const evP = collect(ready.url, 0, (ev) => ev.type === "unblocked", 4000);
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B1", patch: { status: "done" } });
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B2", patch: { status: "done" } });
    const events = await evP;
    proc.kill();
    await proc.exited;

    const unblocked = events.filter((e) => e.type === "unblocked");
    expect(unblocked).toHaveLength(1); // not on B1, only when B2 (the last) clears; fired once
    expect(unblocked[0].taskId).toBe("X");
    expect(unblocked[0].owner).toBe("worker1"); // targeted via owner-on-frame
  }, 15000);

  test("removing the last remaining blocker edge also unblocks", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", owner: "w", blockedBy: ["B1", "B2"] },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "done" }, // already done
    ]);
    const evP = collect(ready.url, 0, (ev) => ev.type === "unblocked", 4000);
    await new Promise((r) => setTimeout(r, 150));
    // B2 already done; dropping the B1 edge leaves no live blocker → unblocked
    await cmd(ready.url, { type: "task.unblock", id: "X", on: ["B1"] });
    const events = await evP;
    proc.kill();
    await proc.exited;
    expect(events.filter((e) => e.type === "unblocked" && e.taskId === "X")).toHaveLength(1);
  }, 15000);

  test("no unblocked for an already-done task", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "done", blockedBy: ["B1"] }, // X itself done
      { id: "B1", title: "B1", status: "todo" },
    ]);
    const evP = collect(
      ready.url,
      0,
      (ev) => ev.type === "task.update" && ev.taskId === "B1",
      3000,
    );
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B1", patch: { status: "done" } });
    const events = await evP;
    proc.kill();
    await proc.exited;
    expect(events.some((e) => e.type === "unblocked")).toBe(false);
  }, 15000);

  test("/state derives `blocked` + `liveBlockers` (computed readback parity)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", blockedBy: ["B1", "B2", "gone"] },
      { id: "B1", title: "Build engine", status: "review" },
      { id: "B2", title: "B2", status: "done" }, // done → not a live blocker
    ]);
    // 'gone' refers to no task → not live. B2 is done → not live. Only B1 lives.
    const raw = await (await fetch(`${ready.url}/state`)).json();
    const s = raw as { state: { tasks: Record<string, unknown>[] } };
    proc.kill();
    await proc.exited;

    const x = s.state.tasks.find((t) => t.id === "X");
    expect(x?.blocked).toBe(true);
    expect(x?.liveBlockers).toEqual([{ id: "B1", title: "Build engine", status: "review" }]);
    const b1 = s.state.tasks.find((t) => t.id === "B1");
    expect(b1?.blocked).toBe(false);
    expect(b1?.liveBlockers).toEqual([]);
  }, 15000);

  test("state --mine/--owner scopes the readback; a blocked task stays actionable", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "my task", "--id", "mine", "--owner", "w1", "--session", session], {
      env,
    });
    await runCli(["add", "other", "--id", "other", "--owner", "w2", "--session", session], { env });
    await runCli(["add", "free", "--id", "free", "--session", session], { env }); // unowned/claimable
    // 'mine' (w1's) is blocked on 'other' (w2's) — which is filtered out of w1's view
    await runCli(["block", "mine", "--on", "other", "--session", session], { env });
    type ST = { state: { tasks: Record<string, unknown>[] } };
    try {
      const sMine = JSON.parse(
        (await runCli(["state", "--mine", "--as", "w1", "--session", session], { env })).stdout,
      ) as ST;
      expect(sMine.state.tasks.map((t) => t.id).sort()).toEqual(["free", "mine"]); // own + claimable
      const mine = sMine.state.tasks.find((t) => t.id === "mine");
      expect(mine?.blocked).toBe(true);
      // liveBlockers survives the filter — actionable even though 'other' is hidden
      expect(mine?.liveBlockers).toEqual([{ id: "other", title: "other", status: "todo" }]);

      const sOwner = JSON.parse(
        (await runCli(["state", "--owner", "w2", "--session", session], { env })).stdout,
      ) as ST;
      expect(sOwner.state.tasks.map((t) => t.id)).toEqual(["other"]); // exactly w2's
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);

  test("b14: close waits for the daemon to be DOWN, and an immediate reopen gets a fresh board", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `b14-${crypto.randomUUID().slice(0, 8)}`;
    const open1 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s1 = (JSON.parse(open1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "one", "--session", s1], { env });
    await runCli(["add", "two", "--session", s1], { env });

    const closed = await runCli(["close", "--session", s1], { env });
    // RED PRE-FIX: `close` acked as soon as the daemon received the command, and
    // the daemon acks before it finishes tearing down.
    expect((JSON.parse(closed.stdout) as { down?: boolean }).down).toBe(true);

    // The board must be gone the instant close returns — previously `state`
    // still answered here with the full board.
    const after = await runCli(["state", "--session", s1], { env });
    expect(after.code).not.toBe(0);

    // And the race itself: a reopen issued immediately must respawn rather than
    // attach to the dying daemon. This is the assertion that convicts the bug —
    // pre-fix it saw the OLD board's two tasks.
    const open2 = await runCli(["open", "--no-open", "--session-key", key, "--timeout", "20"], {
      env,
    });
    const s2 = (JSON.parse(open2.stdout) as { session_id: string }).session_id;
    try {
      const st = await runCli(["state", "--session", s2], { env });
      expect((JSON.parse(st.stdout) as { state: { tasks: unknown[] } }).state.tasks).toEqual([]);
    } finally {
      await runCli(["close", "--session", s2], { env });
    }
  }, 30000);

  test("b14: `down` is present on EVERY close, never absent", async () => {
    // ⚠ NOT a guard, and I labelled it one until the mutation run said otherwise:
    // this is RED PRE-FIX (expected true, received false) because the field does
    // not exist before the fix, so it cannot pass in both worlds. The label was
    // written when the assertions were, which records intent rather than
    // behaviour — the mutation run audits LABELS, not only code.
    //
    // What it asserts: a field that appears only when it has something to say
    // cannot be distinguished from a daemon that does not report it, so `down`
    // is present on every close as a readable blank.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "20"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const closed = await runCli(["close", "--session", session], { env });
    const body = JSON.parse(closed.stdout) as Record<string, unknown>;
    expect(Object.hasOwn(body, "down")).toBe(true);
    expect(typeof body.down).toBe("boolean");
  }, 30000);

  test("b6: state reads FULL by default and SAYS which mode answered it", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "T", "--id", "T", "--session", session], { env });

      // The defect cassandra measured at r4: `state` and `state --full` returned
      // byte-identical payloads, and NOTHING in either said which mode produced
      // it. Zero semantic coverage is why the no-op survived, so this is the
      // cell that was missing rather than an extra.
      const def = await runCli(["state", "--session", session], { env });
      expect(def.code).toBe(0);
      const d = JSON.parse(def.stdout) as { readMode?: string };
      expect(d.readMode).toBe("full");

      // `--full` is KEPT for compatibility and now names the default: it must
      // still be ACCEPTED (a strict parser exits 2 on an unknown flag, so
      // removing it would break existing callers) and must answer the same.
      const full = await runCli(["state", "--full", "--session", session], { env });
      expect(full.code).toBe(0);
      expect((JSON.parse(full.stdout) as { readMode?: string }).readMode).toBe("full");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);

  test("cli block/unblock works; a cycle is rejected visibly (exit 1)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "X", "--id", "X", "--session", session], { env });
    await runCli(["add", "B", "--id", "B", "--session", session], { env });
    try {
      const ok = await runCli(["block", "X", "--on", "B", "--session", session], { env });
      expect(ok.code).toBe(0);
      expect((JSON.parse(ok.stdout) as { blocked?: string }).blocked).toBe("X");

      const cyc = await runCli(["block", "B", "--on", "X", "--session", session], { env });
      expect(cyc.code).toBe(1); // visible nonzero, like a rejected claim
      expect(cyc.stderr.toLowerCase()).toContain("cycle");

      const un = await runCli(["unblock", "X", "--on", "B", "--session", session], { env });
      expect(un.code).toBe(0);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);
});

// ── Durability (Phase B) — snapshot + restore ────────────────────────────

describe("durability (Phase B)", () => {
  function snapshotPath(home: string, sessionId: string): string {
    return join(home, "snapshots", `${sessionId}.json`);
  }

  test("snapshots board state to $BOUNTY_HOME on close", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "persisted task", "--id", "p1", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const snapFile = snapshotPath(home, session);
    expect(existsSync(snapFile)).toBe(true);
    const snap = JSON.parse(readFileSync(snapFile, "utf8")) as BoardState;
    expect(snap.tasks.find((t) => t.id === "p1")).toBeDefined();
  }, 20000);

  test("open --restore <id> brings the seeded board back", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open1 = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "design", "--id", "a", "--status", "doing", "--session", session], {
      env,
    });
    await runCli(["add", "build", "--id", "b", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const open2 = await runCli(["open", "--no-open", "--timeout", "10", "--restore", session], {
      env,
    });
    const restored = (JSON.parse(open2.stdout) as { session_id: string }).session_id;
    try {
      const s = JSON.parse((await runCli(["state", "--session", restored], { env })).stdout) as {
        state: BoardState;
      };
      expect(s.state.tasks.map((t) => t.id).sort()).toEqual(["a", "b"]);
      expect(s.state.tasks.find((t) => t.id === "a")?.status).toBe("doing");
    } finally {
      await runCli(["close", "--session", restored], { env });
    }
  }, 25000);

  test("restores a legacy snapshot missing newer fields (merge-over-defaults)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    // Hand-write a minimal snapshot — just { title, tasks }, no future optional
    // fields, with one invalid-status task that must be filtered on restore
    // (filter-and-keep-valid: the good task survives, the snapshot isn't rejected).
    const legacyId = "legacy-001";
    mkdirSync(join(home, "snapshots"), { recursive: true });
    writeFileSync(
      snapshotPath(home, legacyId),
      JSON.stringify({
        title: "Legacy Board",
        tasks: [
          { id: "ok", title: "valid", status: "todo" },
          { id: "bad", title: "filtered", status: "bogus" },
        ],
      }),
    );
    const open = await runCli(["open", "--no-open", "--timeout", "10", "--restore", legacyId], {
      env,
    });
    const restored = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const s = JSON.parse((await runCli(["state", "--session", restored], { env })).stdout) as {
        state: BoardState;
      };
      expect(s.state.title).toBe("Legacy Board");
      expect(s.state.tasks.find((t) => t.id === "ok")).toBeDefined();
      expect(s.state.tasks.find((t) => t.id === "bad")).toBeUndefined();
    } finally {
      await runCli(["close", "--session", restored], { env });
    }
  }, 20000);

  test("sessions lists a saved snapshot", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "x", "--id", "x", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const sessions = await runCli(["sessions"], { env });
    expect(sessions.stdout).toContain(session);
  }, 20000);
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
    expect(joined.session_id).toBe(ready.session_id);

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
    expect(disc.reason).toBe("timeout");

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
test("P0e — no spawn site in this file inherits a bare process.env", async () => {
  // Comments stripped: this gate is documented in prose that necessarily QUOTES
  // the idiom it forbids, and the first version of the half-2 gate below was
  // tripped by exactly that. A guard must not be able to fail on its own docs.
  const src = codeLines(await Bun.file(import.meta.path).text());
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
// Strip `//` line comments before any source scan. Learned the hard way, twice
// in one edit: the first cut of the gate below matched the sentence in its own
// documentation and reported four offenders when the code had one. A guard that
// its own prose can trip gets "fixed" by softening the regex, which is how a
// real offender slips through later.
function codeLines(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

test("P0e half 2 — no site in this file composes a path from the machine-global tmpdir", async () => {
  const src = codeLines(await Bun.file(import.meta.path).text());
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
test("P0e — EVERY Bun.spawn in this file passes an explicit env", async () => {
  const src = codeLines(await Bun.file(import.meta.path).text());
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

// ── P0b (#80.1) — the early return that discards a flag set ───────────────
//
// `open --session-key K` against a LIVE board takes the idempotent-attach branch
// and returns before the daemon argument list is built, so --title, --timeout
// and --restore are silently discarded: the caller asks for four hours and gets
// thirty seconds, at exit 0, with nothing said. The fix REFUSES (exit 2) and
// carries `restoreSkipped`.
//
// GATE LAW, as it applies here — stated rather than assumed:
//  · G1  every cell passes an explicit --session-key under a unique BOUNTY_HOME;
//        hermeticEnv() scrubs the two env routes. The explicit key is the
//        isolation — the scrub alone is NOT (a .bounty-session walk-up resolves
//        to the same team board the env var would have named).
//  · G5  every spawn inherits TEST_TMPDIR via hermeticEnv().
//  · G6  does NOT bind this lane. G6 is the DRAIN defect, where Bun.spawn's pipe
//        cannot reproduce a truncation. These cells assert an EXIT CODE and a
//        small envelope, neither of which the reader can mask. Named explicitly
//        so nobody reads its absence as an oversight.
//  · G7  binds: `runOpen` fails the cell if the process does not RETURN. A
//        drained-exit fix trades truncation for a hang wherever process.exit was
//        load-bearing, and a hang is invisible to a suite that only awaits.
//  · G8  the precondition prints VALID-CONTROL / DEGENERATE and is asserted, so
//        a setup that silently no-ops cannot pass as evidence.

// Spawn `open` with an explicit cwd and a HARD deadline.
//
// cwd matters twice: --pin writes `<cwd>/.bounty-session` (a cell running in the
// repo would rebind the team's own board), and sessionKeyToId hashes the project
// root, so every cell must derive its id from one stable directory.
//
// The deadline is G7: `await proc.exited` alone turns a hang into a suite
// timeout, which reads as flakiness rather than as the regression it is.
async function runOpen(
  args: string[],
  opts: { home: string; cwd: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number; ms: number }> {
  const started = performance.now();
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI, "open", ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: { ...hermeticEnv(), BOUNTY_HOME: opts.home },
  });
  const budget = opts.timeoutMs ?? 15000;

  // ⚠ G7 REACHABILITY — EXIT IS OBSERVED BEFORE THE PIPES ARE READ, and the
  // order is the whole point.
  //
  // The previous version read BOTH pipes to completion and only then awaited
  // `proc.exited`, so its G7 assertion sat downstream of an EOF it might never
  // receive. A pipe reaches EOF when EVERY holder closes it — including a
  // DETACHED GRANDCHILD. `bounty open` spawns exactly such a grandchild, so if
  // that daemon ever held one of these handles, the reads would block forever,
  // the assertion below would never execute, and the failure would surface as a
  // suite timeout — which reads as flakiness, not as the hang it is. The cell
  // would not go red; it would become UNREACHABLE.
  //
  // `SIGKILL` at the budget does NOT rescue it: it kills `proc`, not a detached
  // grandchild, so pipes held by the daemon stay open after the kill.
  //
  // So termination is decided by racing `proc.exited` against a timer, touching
  // no pipe. The reads happen afterwards and are themselves bounded, so this
  // helper always returns a verdict rather than hanging.
  const verdict = await Promise.race([
    proc.exited.then((code) => ({ timedOut: false, code })),
    Bun.sleep(budget).then(() => ({ timedOut: true, code: -1 })),
  ]);
  if (verdict.timedOut) proc.kill("SIGKILL");
  const ms = performance.now() - started;

  // G7, asserted on the pipe-independent verdict.
  expect({ verb: `open ${args.join(" ")}`, returnedOnItsOwn: !verdict.timedOut }).toEqual({
    verb: `open ${args.join(" ")}`,
    returnedOnItsOwn: true,
  });

  // Reads come last and are bounded — a grandchild still holding a handle
  // degrades this to empty output instead of wedging the suite.
  const drain = (s: ReadableStream<Uint8Array>) =>
    Promise.race([new Response(s).text(), Bun.sleep(2000).then(() => "")]);
  const [stdout, stderr] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  return { stdout, stderr, code: verdict.code, ms };
}

// Renamed from `snapshotTaskCount` in sprint 03: that name is now a REAL
// export of server.ts (the shrinkage guard's prior-count reader), and an
// import of it here was SILENTLY SHADOWED by this local declaration —
// no runtime error, just the wrong function with the wrong arity. `bun test`
// cannot see that; `tsc` reports it as TS2440 and the repo gate does not run
// tsc. This helper resolves home+id, which the exported one deliberately does
// not, so it stays — under a name that cannot collide.
function snapshotTaskCountAt(home: string, id: string): number | null {
  try {
    const raw = readFileSync(join(home, "snapshots", `${id}.json`), "utf8");
    return (JSON.parse(raw) as { tasks?: unknown[] }).tasks?.length ?? 0;
  } catch {
    return null; // no snapshot on disk yet
  }
}

async function liveTaskCount(port: number): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/state?lean=1`);
  const d = (await r.json()) as { state: { tasks: unknown[] } };
  return d.state.tasks.length;
}

describe("P0b — open refuses rather than discarding flags on the attach path", () => {
  test("PRECONDITION + RED PRE-FIX — live 0 over snapshot 2, then --restore is REFUSED", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-"));
    const key = `p0b-${crypto.randomUUID().slice(0, 8)}`;

    // Step 1 — a board with two tasks.
    const first = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const board = JSON.parse(first.stdout) as { session_id: string; port: number };
    const id = board.session_id;
    await runCli(["add", "alpha", "--id", "a1", "--session", id], { env: { BOUNTY_HOME: home } });
    await runCli(["add", "beta", "--id", "b1", "--session", id], { env: { BOUNTY_HOME: home } });

    // Step 2 — POLL the snapshot to 2. Never a fixed sleep: the flush is a ~1s
    // debounce (server.ts:708 marks dirty, :1238 drains), so a sleep either
    // races or is pure padding.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && snapshotTaskCountAt(home, id) !== 2) await Bun.sleep(100);
    expect(snapshotTaskCountAt(home, id)).toBe(2);

    // Step 3 — kill -9. NOT close: close writes the snapshot (server.ts:1286),
    // which would flush the board we are about to empty OVER the fixture. And
    // the PID does not come from the discovery file, which carries url/port/
    // session_id/title and NO pid — a kill built on it silently no-ops, step 4
    // "respawns" onto the still-live board, and the precondition degenerates to
    // live=2/snapshot=2 while looking clean. The --id is unique, unlike the
    // shared `scripts/server.ts` argv that once cost this repo a live daemon.
    const pgrep = Bun.spawn({
      cmd: ["pgrep", "-f", "--", `--id ${id}`],
      stdout: "pipe",
      stderr: "ignore",
      env: { ...hermeticEnv() },
    });
    const pids = (await new Response(pgrep.stdout).text()).trim().split("\n").filter(Boolean);
    await pgrep.exited;
    expect(pids.length).toBeGreaterThan(0); // the kill has a target
    for (const pid of pids) process.kill(Number(pid), "SIGKILL");
    const gone = Date.now() + 5000;
    while (Date.now() < gone) {
      try {
        await fetch(`http://127.0.0.1:${board.port}/state?lean=1`);
        await Bun.sleep(100);
      } catch {
        break; // refused — it is down
      }
    }

    // Step 4 — respawn EMPTY under the same key, without mutating anything.
    const second = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const revived = JSON.parse(second.stdout) as { session_id: string; port: number };
    expect(revived.session_id).toBe(id); // same key ⇒ same board id

    // Step 5 — THE PRECONDITION AS ITS OWN ASSERTED CELL. Printed as
    // VALID-CONTROL / DEGENERATE, because a probe that cannot announce its own
    // control is invalid is a probe that will eventually lie — and this exact
    // control has been degenerate three separate times in this project.
    const liveNow = await liveTaskCount(revived.port);
    const snapNow = snapshotTaskCountAt(home, id);
    const control = liveNow === 0 && snapNow === 2 ? "VALID-CONTROL" : "DEGENERATE";
    expect({ control, live: liveNow, snapshot: snapNow }).toEqual({
      control: "VALID-CONTROL",
      live: 0,
      snapshot: 2,
    });

    try {
      // Step 6 — THE MEASUREMENT. This is the reported user situation exactly:
      // board live and empty, the only real data in the snapshot, --restore the
      // only lever. Today it exits 0 and says nothing.
      const measured = await runOpen(["--session-key", key, "--restore", id, "--no-open"], {
        home,
        cwd,
      });
      expect(measured.code).not.toBe(0);
      const env = JSON.parse(measured.stdout) as {
        restoreSkipped: { requested: string[]; reason: string } | null;
      };
      expect(env.restoreSkipped).not.toBeNull();
      expect(env.restoreSkipped?.requested).toContain("restore");

      // The refusal names NO corrective verb (Cole, 2026-08-06). --fresh
      // --restore is MEASURED to destroy the snapshot it restores from, so a
      // user in exactly this situation would follow the advice and lose the
      // only copy of their data. This cell is what keeps a later "helpful"
      // edit from putting it back.
      const spoken = `${measured.stdout}\n${measured.stderr}`;
      expect(spoken).not.toContain("--fresh");
      expect(spoken).not.toContain("kill");
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 60000);

  test("RED PRE-FIX — restoreSkipped is PRESENT and null when nothing was skipped", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-null-"));
    const key = `p0b-null-${crypto.randomUUID().slice(0, 8)}`;
    const spawned = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(spawned.stdout) as { session_id: string }).session_id;
    try {
      // Both success paths carry it: the SPAWN path here, the ATTACH path below.
      // `in` is the assertion with teeth — `=== null` alone passes when the key
      // is absent entirely, so a fix that emits the field only when it skips
      // would sail through the weaker check while violating the ruling.
      for (const [path, out] of [
        ["spawn", spawned.stdout],
        ["attach", (await runOpen(["--session-key", key, "--no-open"], { home, cwd })).stdout],
      ] as const) {
        const env = JSON.parse(out) as Record<string, unknown>;
        expect({ path, present: "restoreSkipped" in env }).toEqual({ path, present: true });
        expect({ path, value: env.restoreSkipped }).toEqual({ path, value: null });
      }
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 40000);

  test("RED PRE-FIX — EACH discarded flag refuses (the lane is the SET, not --restore)", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-set-"));
    const key = `p0b-set-${crypto.randomUUID().slice(0, 8)}`;
    const first = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    try {
      // G4: the invocations are named, not "for each discarded flag". A fix that
      // refuses on --restore alone — which is how this lane was described for a
      // whole sprint — must FAIL this cell. --title and --timeout are appended
      // BEFORE --restore, so a positional reading of the bug misses both.
      for (const [flag, args] of [
        ["restore", ["--restore", id]],
        ["timeout", ["--timeout", "14400"]],
        ["title", ["--title", "a new title"]],
      ] as const) {
        const r = await runOpen(["--session-key", key, "--no-open", ...args], { home, cwd });
        const env = JSON.parse(r.stdout) as { restoreSkipped: { requested: string[] } | null };
        expect({ flag, code: r.code === 0 }).toEqual({ flag, code: false });
        expect({ flag, requested: env.restoreSkipped?.requested }).toEqual({
          flag,
          requested: [flag],
        });
      }
      // And the SET together, in one invocation: all three named at once.
      const all = await runOpen(
        ["--session-key", key, "--no-open", "--title", "t", "--timeout", "99", "--restore", id],
        { home, cwd },
      );
      const allEnv = JSON.parse(all.stdout) as { restoreSkipped: { requested: string[] } | null };
      expect(allEnv.restoreSkipped?.requested.sort()).toEqual(["restore", "timeout", "title"]);
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 60000);

  test("BLAST-RADIUS GUARD — --pin and --no-open are HONOURED on attach and still exit 0", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-guard-"));
    const key = `p0b-guard-${crypto.randomUUID().slice(0, 8)}`;
    const first = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    try {
      // ⛔ THIS PASSES TODAY AND MUST KEEP PASSING. It is not a red cell and
      // demanding it fail would send someone to manufacture a break.
      //
      // The literal invocation is how EVERY anthill seat rejoins a live team
      // board. An implementation that refuses on "any flag appended past the
      // return" makes every seat's rejoin exit non-zero — this lane inflicting
      // an instance of the very thesis it was written to cure. --no-open is
      // VACUOUSLY honoured (nothing to open on an attach) and --pin is REALLY
      // honoured (it runs inside the attach branch), so neither is in the set.
      // ⚠ THIS CELL ASSERTS ONLY WHAT IS TRUE IN BOTH WORLDS — exit 0, and the
      // pin written. Nothing about `restoreSkipped` belongs here: that field
      // does not exist pre-fix, so asserting it would make this cell FAIL under
      // the mutation and it would no longer be a blast-radius guard at all. It
      // would be a red cell wearing a guard's label, and a report counting it as
      // a guard would overstate the guard population by one — the exact
      // success-shaped arithmetic this sprint is named after.
      //
      // MEASURED: the first version of this cell did exactly that. It carried
      // the `restoreSkipped` assertions and failed under the mutation, which is
      // how the mislabelling was found. The null-arm cell above owns that
      // property, on both the spawn and attach paths.
      const rejoin = await runOpen(["--session-key", key, "--pin", "--no-open"], { home, cwd });
      expect(rejoin.code).toBe(0);
      expect(readFileSync(join(cwd, ".bounty-session"), "utf8").trim()).toBe(id);
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 60000);

  test("RED PRE-FIX — a REFUSED invocation still honours --pin (honour-what-you-can)", async () => {
    // Ruled by prospero 2026-08-06, and pinned separately from the guard above
    // because it is a DIFFERENT label: pre-fix this invocation exits 0 and never
    // refuses at all, so this cell is red today. The behaviour it fixes: --pin
    // is not in the lost-effect set, so withholding it on a refusal would make
    // one flag's outcome depend on an unrelated flag — the over-inclusive error
    // spelled as a side effect instead of an exit code.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-hwyc-"));
    const key = `p0b-hwyc-${crypto.randomUUID().slice(0, 8)}`;
    const first = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    try {
      const both = await runOpen(["--session-key", key, "--pin", "--restore", id, "--no-open"], {
        home,
        cwd,
      });
      expect(both.code).not.toBe(0); // refused, for --restore
      expect(readFileSync(join(cwd, ".bounty-session"), "utf8").trim()).toBe(id); // pinned anyway
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 40000);
});

// ── P0b's two load-bearing snapshot facts ────────────────────────────────
// Both cells below are PRECONDITION, never counted as evidence about the fix:
// they pin facts about server.ts that are TRUE IN BOTH WORLDS and that the
// construction above depends on. They pass under the mutation, by design.
// Both were measured on 2026-08-06 and NEITHER was guarded by a test. They are
// the facts the construction above depends on, and a doc claim drifts under its
// own code while failing no gate — so they are pinned here, in this lane, not as
// a follow-up.
describe("P0b — the snapshot facts the construction rests on", () => {
  test("FACT 1 — `close` WRITES the snapshot, so closing an empty board clobbers a full one", async () => {
    // This is #73, and it is why the construction kills -9 instead of closing.
    // It is also why the refusal names no corrective verb: `--fresh` tears down
    // by POSTing {type:"close"}, so advising `--fresh --restore` tells a user
    // whose only data is in the snapshot to destroy it first.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-f1-"));
    const key = `p0b-f1-${crypto.randomUUID().slice(0, 8)}`;
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "keep me", "--id", "k1", "--session", id], { env: { BOUNTY_HOME: home } });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && snapshotTaskCountAt(home, id) !== 1) await Bun.sleep(100);
    expect(snapshotTaskCountAt(home, id)).toBe(1); // PRECONDITION: a full snapshot exists

    await runCli(["remove", "k1", "--session", id], { env: { BOUNTY_HOME: home } });
    await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    await Bun.sleep(500);
    // close flushed the NOW-EMPTY board over the snapshot that held the task.
    expect(snapshotTaskCountAt(home, id)).toBe(0);
  }, 40000);

  test("FACT 2 — snapshots are NOT close-only: a mutation flushes on the ~1s debounce", async () => {
    // Why the construction POLLS the snapshot instead of sleeping, and why
    // "empty the live board, then read the snapshot" destroys its own fixture:
    // the emptying is itself a mutation and it flushes.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-f2-"));
    const key = `p0b-f2-${crypto.randomUUID().slice(0, 8)}`;
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "solo", "--id", "s1", "--session", id], { env: { BOUNTY_HOME: home } });
      // No close anywhere in this cell — the flush must happen on its own.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && snapshotTaskCountAt(home, id) !== 1) await Bun.sleep(100);
      expect(snapshotTaskCountAt(home, id)).toBe(1);
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 40000);
});

// ── P0d / #83 — `add` was the only write verb that ignored `applied` ──────
//
// ⛔ THIS GATE REPLACES A DEFECTIVE ORIGINAL, which read: "`add` with a
// duplicate --id exits non-zero AND a subsequent `state` does not show the
// task." That is an INVERTED CONTROL — it FAILS against a correct fix. On a
// duplicate id `applyTaskAdd` returns false without touching state, so the
// ORIGINAL keeps that id by construction; the only implementation satisfying
// the old cell's literal reading is one that also destroys the original. A gate
// whose plain reading fails the correct implementation is worse than a
// decorative one: decoration passes silently, this produces a false FAIL and
// dispatches a builder to "fix" code that is already right.
//
// Labels below, and they are NOT all discriminating: 1 RED PRE-FIX + 2
// BLAST-RADIUS GUARDS. Reporting "3 cells green" would be a coverage claim
// three times its true size.
describe("P0d #83 — a duplicate add is a REFUSAL, not a silent success", () => {
  test("RED PRE-FIX — duplicate --id exits non-zero and the envelope says applied:false", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const first = await runCli(
        ["add", "ORIGINAL TITLE", "--id", "dup-probe", "--owner", "alice", "--session", session],
        { env },
      );
      expect(first.code).toBe(0);

      // Today: {"ok":true,"sent":"task.add"} at exit 0 — the success-shaped lie.
      const second = await runCli(
        ["add", "IMPOSTOR TITLE", "--id", "dup-probe", "--owner", "bob", "--session", session],
        { env },
      );
      expect(second.code).not.toBe(0);
      const envelope = JSON.parse(second.stdout) as { applied?: boolean; error?: string };
      expect(envelope.applied).toBe(false);
      // The reason is named, not merely signalled — `applied:false` alone
      // conflated an invalid shape with a taken id and told the caller neither.
      expect(envelope.error).toContain("dup-probe");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 40000);

  test("BLAST-RADIUS GUARD — the surviving row is the ORIGINAL, field for field", async () => {
    // ⚠ ALREADY TRUE PRE-FIX. Do not try to make it red. It catches a fix that
    // "resolves" the duplicate by overwriting — the failure mode the retired
    // literal reading could not see at all, and one that only the change itself
    // can introduce.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(
        ["add", "ORIGINAL TITLE", "--id", "dup2", "--owner", "alice", "--session", session],
        { env },
      );
      const before = JSON.parse(
        (await runCli(["state", "--session", session], { env })).stdout,
      ) as {
        state: BoardState;
      };
      const original = before.state.tasks.find((t) => t.id === "dup2");

      await runCli(
        ["add", "IMPOSTOR TITLE", "--id", "dup2", "--owner", "bob", "--session", session],
        { env },
      );
      const after = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      const survivor = after.state.tasks.find((t) => t.id === "dup2");
      expect(survivor).toEqual(original);
      expect(survivor).toMatchObject({ title: "ORIGINAL TITLE", owner: "alice", status: "todo" });
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 40000);

  test("BLAST-RADIUS GUARD — task count AND cursor unchanged by the refusal", async () => {
    // ⚠ ALSO ALREADY TRUE PRE-FIX. The cursor is the cheapest strong tell that
    // the daemon REFUSED rather than applied-then-reverted: an apply would have
    // emitted an event and advanced it. Worth keeping for exactly that, and not
    // evidence that the fix works.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "one", "--id", "c1", "--session", session], { env });
      const before = JSON.parse(
        (await runCli(["state", "--session", session], { env })).stdout,
      ) as {
        state: BoardState;
        cursor: number;
      };
      await runCli(["add", "impostor", "--id", "c1", "--session", session], { env });
      const after = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
        cursor: number;
      };
      expect(after.state.tasks).toHaveLength(before.state.tasks.length);
      expect(after.cursor).toBe(before.cursor);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 40000);

  // ⚠ LABEL CORRECTED AFTER MEASUREMENT — it read RED PRE-FIX and it is not.
  // This cell passes pre-fix, because the DAEMON already answered honestly;
  // #83's defect was the CLI discarding that answer, and this cell drives the
  // daemon directly. The comment inside it said so while the label contradicted
  // it — the second time in one session I wrote the label and the assertions in
  // one act and the label recorded my INTENT rather than the cell's measured
  // behaviour. A label is a claim about a measurement and cannot be assigned
  // before the measurement is taken.
  test("BLAST-RADIUS GUARD — an UNRECOGNISED command type still answers applied:false", async () => {
    // bounty's own instance of #84's shape: the daemon's dispatch ends in
    // `return {ok:true, applied:false}` for any type it does not recognise, and
    // the CLI's generic path printed the transport ack regardless. This drives
    // it through the real wire rather than the CLI, because no CLI verb can
    // send an unknown type — the defect lives at the /cmd contract.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const board = JSON.parse(open.stdout) as { session_id: string; port: number };
    try {
      const r = await fetch(`http://127.0.0.1:${board.port}/cmd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "zzz-not-a-real-command" }),
      });
      const body = (await r.json()) as { ok?: boolean; applied?: boolean };
      // The daemon already reported the truth here; #83 is that the CLI threw
      // it away. Pinning it means a future dispatch refactor cannot quietly
      // start answering `applied:true` to a command it drops.
      expect(body.applied).toBe(false);
    } finally {
      await runCli(["close", "--session", board.session_id], { env });
    }
  }, 40000);
});

// ── P0f (slice) — the `tail` write→exit pair ─────────────────────────────
//
// `tail` wrote the terminal frame and exited on the NEXT statement. Bun's
// stdout is async on a PIPE, so an explicit exit discards whatever has not
// drained — measured in this repo at exactly 65,536 bytes. `tail` is the verb
// agents leave running for hours, and the frames it loses are the ones saying
// the stream ended.
//
// G6 — DRIVEN THROUGH A REAL SHELL PIPE, `sh -c "… | cat"`. This is not a
// stylistic choice and a `runCli`-style `Bun.spawn({stdout:"pipe"})` CANNOT
// FAIL on this defect: measured on one board, the same payload read three ways
// gave 65536 / 114042 / 65536 — Bun.spawn's pipe is the one that reads
// COMPLETE. The engine seat wrote that gate last sprint, it passed, he restored
// the bug, and it passed again.
//
// G8 — the fixture is ONE event over the buffer, not many small ones, and the
// byte assertion comes BEFORE the parse so a fixture that silently shrinks
// fails loudly instead of passing vacuously.
//
// G7 — the process must EXIT. A drain fix trades a truncation for a hang
// wherever process.exit was load-bearing, and here the exit sits three loops
// deep. A hang would otherwise surface as a test timeout, which reads as
// flakiness rather than as the regression it is.
describe("P0f — tail drains its terminal frame before exiting", () => {
  test("RED PRE-FIX — a >64KiB replay survives tail's exit, and tail RETURNS", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "60"], { env });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;

    // ONE event whose payload exceeds 64 KiB — a single 100 KB title, not many
    // small events. `bounty tail` replays its entire event history, so a
    // --since 0 tail re-emits this frame and then the `closed` frame.
    const big = "x".repeat(1_000_000);
    const added = await runCli(["add", "--id", "big-1", "--stdin", "--session", id], {
      env,
      stdin: big,
    });
    expect(added.code).toBe(0);

    const proc = Bun.spawn({
      // ⚠ `| ( sleep 2; cat )` — a NON-DRAINING consumer, and it is the whole
      // fixture. See the note above the sleep below.
      cmd: ["sh", "-c", `bun run ${CLI} tail --since 0 --session ${id} | ( sleep 2; cat )`],
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...hermeticEnv(), BOUNTY_HOME: home },
    });

    // ⚠⚠ THE NON-DRAINING CONSUMER IS THE FIXTURE — a big payload alone is NOT
    // enough, and this cell was VACUOUS twice before it discriminated.
    //
    // MEASURED, bug restored, 10 MB of replay through `| cat`, closing at
    // 0.02s / 0.05s / 0.15s / 0.3s / 1.0s: **10001074 bytes every time —
    // complete, at every timing.** A reader that keeps draining lets each write
    // complete before the next arrives, and the write immediately preceding the
    // exit is the small `closed` frame, which fits under the buffer. So a gate
    // built only to "ONE event over 64 KiB" passes with the bug in place.
    //
    // What discriminates is whether bytes are UNDRAINED at the instant of exit.
    // With `| ( sleep 2; cat )` the pipe stays full and the tail's writes sit
    // buffered, so the exit discards them:
    //
    //     bug restored -> 65536 bytes    (exactly the buffer)
    //     with the fix -> 3000440 bytes  (complete)
    //
    // That is realistic, not contrived: any consumer momentarily not reading —
    // a busy Monitor, a slow downstream — is in this state.
    await Bun.sleep(300);
    await runCli(["close", "--session", id], { env });

    const budget = 25_000;
    const killer = setTimeout(() => proc.kill("SIGKILL"), budget);
    const started = performance.now();
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(killer);
    const ms = performance.now() - started;

    // G7 FIRST — a hang is a different failure from a truncation and must not
    // be reported as one.
    expect({ returnedOnItsOwn: ms < budget, code }).toEqual({ returnedOnItsOwn: true, code: 0 });

    // G8 — the over-buffer assertion BEFORE any parse. A fixture that shrank
    // below the buffer would pass every assertion below it while proving
    // nothing. The threshold is the 64 KiB buffer; the fixture is ~15x it.
    expect(out.length).toBeGreaterThan(65_536);

    // And the payload is INTACT, not merely large: the big frame parses and
    // carries all 100,000 characters. A truncated frame is cut mid-value, so it
    // cannot parse — that is the whole check.
    const bigLine = out.split("\n").find((l) => l.includes("big-1") && l.includes("task.add"));
    expect(bigLine).toBeDefined();
    const ev = JSON.parse(bigLine as string) as { task?: { title?: string } };
    expect(ev.task?.title?.length).toBe(1_000_000);
  }, 60000);
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
  const src = codeLines(await Bun.file(CLI).text());
  const m = /spawn\(process\.execPath, args, \{([\s\S]*?)\}\);/.exec(src);
  expect(m).not.toBeNull();
  const call = (m as RegExpExecArray)[1];

  // The daemon must be detached — that is what makes it a grandchild of any
  // harness driving the CLI, and therefore what makes its stdio load-bearing.
  expect(call).toContain("detached: true");

  const stdio = /stdio:\s*\[([^\]]*)\]/.exec(call);
  expect(stdio).not.toBeNull();
  const [stdin, stdout] = (stdio as RegExpExecArray)[1].split(",").map((x) => x.trim());

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

// ── P0c (#81) — `--flag=value`, and the verb that ran anyway ─────────────
//
// The hand-rolled parser had three silent defects. The `=` form dropped the
// value (so a read FILTER matched nothing and returned the WHOLE BOARD),
// unknown flags were accepted at exit 0, and free prose containing a `--word`
// was silently truncated at that word.
//
// Fixed at PARSER ALTITUDE by deleting the bespoke parser for `node:util`
// strict — anthill scoped the same guard to one verb's run() and reached 1 of
// 13 leaves, which is why this is not done per verb.
//
// ⚠ Cell 1 uses a BOGUS value on purpose. `--owner=alice` returning tasks is
// the paraphrase that hid this bug for a round: it "works" pre-fix too, because
// the unfiltered whole board contains alice. Only a value matching NOTHING can
// tell a working filter from an absent one.
describe("P0c #81 — the equals form, and unknown flags", () => {
  async function board(env: { BOUNTY_HOME: string }) {
    const open = await runCli(["open", "--no-open", "--timeout", "60"], { env });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "alice task", "--owner", "alice", "--id", "a1", "--session", id], { env });
    await runCli(["add", "maestro task", "--owner", "maestro", "--id", "m1", "--session", id], {
      env,
    });
    return id;
  }

  test("RED PRE-FIX — a bogus --owner=<value> returns ZERO tasks, not the whole board", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      const r = await runCli(["state", "--owner=zzz-nobody-zzz", "--session", id], { env });
      const d = JSON.parse(r.stdout) as { state: BoardState };
      expect(d.state.tasks).toHaveLength(0); // pre-fix: 2 — the whole board
      const hit = await runCli(["state", "--owner=alice", "--session", id], { env });
      expect((JSON.parse(hit.stdout) as { state: BoardState }).state.tasks).toHaveLength(1);
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("RED PRE-FIX — an unknown flag exits non-zero and NAMES the flag", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      const r = await runCli(["state", "--totally-bogus-flag", "z", "--session", id], { env });
      expect(r.code).not.toBe(0); // pre-fix: 0, and the verb ran
      expect(r.stderr).toContain("--totally-bogus-flag");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("RED PRE-FIX — `close --help` does NOT close the board", async () => {
    // ⚠ THE DESTRUCTIVE ARM, and the most important user-facing fix in the
    // lane. Pre-fix `--help` was swallowed as an unknown flag and `close` ran:
    // asking for help DESTROYED the board — and `close` also writes the
    // snapshot, so it takes the resume point with it.
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      const r = await runCli(["close", "--help", "--session", id], { env });
      expect(r.code).not.toBe(0);
      const after = await runCli(["state", "--session", id], { env });
      expect(after.code).toBe(0); // the board is STILL THERE
      expect((JSON.parse(after.stdout) as { state: BoardState }).state.tasks).toHaveLength(2);
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("RED PRE-FIX — the WRITE path: add --owner=<name> stores the owner", async () => {
    // A read-only gate misses the worse half: pre-fix the value was dropped, so
    // the task was created UNOWNED at exit 0 — a silent write corruption.
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      await runCli(["add", "bob task", "--owner=bob", "--id", "b1", "--session", id], { env });
      const d = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      expect(d.state.tasks.find((t) => t.id === "b1")?.owner).toBe("bob");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("RED PRE-FIX — free prose with a --word is REFUSED, not silently truncated", async () => {
    // Pre-fix `add write the --draft section` stored the title "write the" and
    // exited 0. So the trade this lane makes is NOT "working prose → hard
    // error"; it is "silent truncation → hard error", which is strictly an
    // improvement. The plan's risk section argued against the fix using a
    // capability the tool does not have.
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      const r = await runCli(
        ["add", "write", "the", "--draft", "section", "--id", "p1", "--session", id],
        { env },
      );
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("--draft");
      const d = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      expect(d.state.tasks.find((t) => t.id === "p1")).toBeUndefined(); // nothing stored
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  // ⚠ LABEL SPLIT AFTER MEASUREMENT — the THIRD time this session I put a
  // guard's label on assertions that cannot hold pre-fix. The `--` terminator
  // does not exist in the bespoke parser, so ANY cell exercising it is RED by
  // construction. The pre-fix-passing shapes are the real guard, below.
  test("RED PRE-FIX — the `--` terminator carries prose containing a --word", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      await runCli(["add", "--id", "p3", "--session", id, "--", "write the --draft section"], {
        env,
      });
      const d = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      expect(d.state.tasks.find((t) => t.id === "p3")?.title).toBe("write the --draft section");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("BLAST-RADIUS GUARD — positionals survive, per POSITIONAL SHAPE", async () => {
    // ⚠ POSITIONALS ARE WHAT BREAK. anthill's first guard at this altitude broke
    // seven tests, and bounty is MORE exposed — it had no `--` terminator at
    // all. Pinned by SHAPE rather than by verb (anthill's three cells hold
    // thirteen leaves): free prose, --stdin, and single-token ids.
    //
    // Every arm here PASSES PRE-FIX — that is what makes it a guard. It catches
    // the conversion breaking what already worked. The terminator arm lived
    // here until a mutation run showed it could not pass pre-fix; it is a red
    // cell and now has its own.
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      // free prose, multi-word, no dashes — the ordinary case
      await runCli(["add", "write", "the", "section", "--id", "p2", "--session", id], { env });
      // the --stdin escape hatch — the OLD parser honoured this one too
      await runCli(["add", "--id", "p4", "--stdin", "--session", id], {
        env,
        stdin: "write the --draft section",
      });
      // single-token positional id
      await runCli(["update", "p2", "--status", "doing", "--session", id], { env });

      const d = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      const byId = (x: string) => d.state.tasks.find((t) => t.id === x);
      expect(byId("p2")?.title).toBe("write the section");
      expect(byId("p2")?.status).toBe("doing");
      expect(byId("p4")?.title).toBe("write the --draft section");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);
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

// ── P1a/P1b — the guard END TO END, on the real defect ───────────────────────
// The predicate cells above prove the DECISION. This proves the SINK is wired to
// it — a pure predicate nobody calls is a helper, not a fix.
//
// The construction is #73/#74's actual shape: seed a snapshot, kill the daemon
// so it writes NOTHING on the way out, respawn under the SAME KEY (which does
// not hydrate — measured), then make ONE ordinary mutation and let the ~1s
// debounce flush it. No `close`, no `--fresh`, no `--restore` anywhere.
describe("P1a/P1b — the shrinkage guard, end to end", () => {
  test("a respawned-empty board's first write COPIES the old snapshot aside, and SAYS so", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p1a-"));
    const key = `p1a-${crypto.randomUUID().slice(0, 8)}`;
    const env = { BOUNTY_HOME: home };

    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string; port: number }).session_id;
    const port = (JSON.parse(open.stdout) as { port: number }).port;
    for (const t of ["a", "b", "c"])
      await runCli(["add", t, "--id", `p1a-${t}`, "--session", id], { env });
    const seeded = Date.now() + 10000;
    while (Date.now() < seeded && snapshotTaskCountAt(home, id) !== 3) await Bun.sleep(100);
    // PRECONDITION, printable as a failure rather than assumed: if the snapshot
    // never reached 3, everything below is vacuous and would read as "no loss".
    expect(snapshotTaskCountAt(home, id)).toBe(3);

    // SIGKILL, by exact PID off the port. NOT `pkill -f`, and not a pattern on
    // the board id — the id appears in the argv of the process doing the
    // matching, so such a pattern lists the harness's own shell.
    const lsof = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pids = new TextDecoder().decode(lsof.stdout).trim().split("\n").filter(Boolean);
    expect(pids.length).toBeGreaterThan(0); // a kill that no-ops makes the run read clean
    for (const pid of pids) Bun.spawnSync(["kill", "-9", pid]);
    await Bun.sleep(600);
    // A killed daemon writes nothing on the way out — so the snapshot is intact
    // and the cell below is measuring the RESPAWN, not the kill.
    expect(snapshotTaskCountAt(home, id)).toBe(3);

    const respawn = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id2 = (JSON.parse(respawn.stdout) as { session_id: string }).session_id;
    expect(id2).toBe(id); // same key, same board id — that is what makes it a clobber
    try {
      // ONE mutation. This is the write that used to take the snapshot 3 -> 1.
      await runCli(["add", "d", "--id", "p1a-d", "--session", id], { env });
      const flushed = Date.now() + 10000;
      while (Date.now() < flushed && snapshotTaskCountAt(home, id) !== 1) await Bun.sleep(100);
      expect(snapshotTaskCountAt(home, id)).toBe(1); // the shrink still HAPPENS

      // ...but the old one was copied aside first. THIS is the fix.
      const backups = readdirSync(join(home, "snapshots")).filter((f) =>
        f.startsWith(`${id}.pre-`),
      );
      expect(backups.length).toBe(1);
      const rescued = JSON.parse(
        readFileSync(join(home, "snapshots", backups[0] as string), "utf8"),
      ) as { tasks: unknown[] };
      expect(rescued.tasks.length).toBe(3);

      // AND IT SAID SO. A silent rescue is a success-shaped lie: the user is
      // protected and never learns they needed protecting.
      const log = readFileSync(join(home, "daemon.log"), "utf8");
      // daemon.log is NOT pure JSONL: cli.ts points the daemon's native stderr
      // at this same file (#64, so Bun's own hard-abort output is captured), so
      // the structured lines are interleaved with plain prose. Parsing every
      // line blows up on our OWN human-readable announcement — which is how this
      // cell first discovered that the stderr half lands here too.
      const said = log
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { reason?: string; priorTasks?: number; nextTasks?: number })
        .filter((e) => e.reason === "snapshotBackedUp");
      expect(said.length).toBe(1);
      expect(said[0]?.priorTasks).toBe(3);
      expect(said[0]?.nextTasks).toBe(1);
      // The human-readable half, in the same file, naming the numbers and the
      // file — this is what someone reading a log after a scare actually finds.
      expect(log).toContain("snapshot was about to shrink 3 → 1 tasks");
      expect(log).toContain(`${id}.pre-`);

      // ONCE PER SESSION: a SECOND shrink in the same daemon must NOT rotate
      // again. Without this the guard is per-write, and a card-by-card drain
      // evicts the rescued snapshot with the guard's own backups.
      await runCli(["remove", "p1a-d", "--session", id], { env });
      await Bun.sleep(1600);
      expect(snapshotTaskCountAt(home, id)).toBe(0);
      expect(
        readdirSync(join(home, "snapshots")).filter((f) => f.startsWith(`${id}.pre-`)).length,
      ).toBe(1);
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 60000);
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
    const src = readFileSync(join(SCRIPT_DIR, "server.ts"), "utf8");
    const idle = src.match(/idleTimeout:\s*(\d+)/);
    const hb = src.match(/\}, (\d+)\);\n\s*sseTimers\.add\(hb\);/);
    expect(idle).not.toBe(null);
    expect(hb).not.toBe(null);
    const idleMs = Number(idle?.[1]) * 1000;
    const hbMs = Number(hb?.[1]);
    expect(idleMs).toBeGreaterThan(hbMs);
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
