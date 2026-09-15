import { describe, expect, test } from "bun:test";
import {
  browserStorage,
  clearSnapshot,
  type DraftStorage,
  draftKey,
  KEY_PREFIX,
  LS_TTL_MS,
  loadSnapshot,
  pruneDrafts,
  restoreAnswers,
  restoreComments,
  saveSnapshot,
} from "./draft";

/** A Map behind the DraftStorage interface. This is what R2's "storage
 *  INJECTED" buys: every silent `catch {}` below runs for real, against a store
 *  whose failures the test chooses. */
function mapStorage(
  seed: Record<string, string> = {},
): DraftStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    keys: () => [...map.keys()],
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v);
    },
    remove: (k) => {
      map.delete(k);
    },
  };
}

/** A store that throws on everything — private browsing, a storage policy, a
 *  filled quota. Every caller must swallow it. */
const throwingStorage: DraftStorage = {
  keys: () => {
    throw new DOMException("denied", "SecurityError");
  },
  get: () => {
    throw new DOMException("denied", "SecurityError");
  },
  set: () => {
    throw new DOMException("quota", "QuotaExceededError");
  },
  remove: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

const NOW = 1_800_000_000_000;
const snap = (savedAt: number, extra: object = {}) =>
  JSON.stringify({ answers: {}, comments: [], savedAt, ...extra });

describe("draftKey (inventory L1)", () => {
  test("prefix + session id", () => {
    expect(draftKey("digestify-abcd-p1234")).toBe("digestify:digestify-abcd-p1234");
    expect(KEY_PREFIX).toBe("digestify:");
  });
});

describe("pruneDrafts (inventory L2, L3, L4, L5)", () => {
  test("the TTL is seven days", () => {
    expect(LS_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("drops drafts older than the TTL, keeps the rest", () => {
    const s = mapStorage({
      "digestify:old": snap(NOW - LS_TTL_MS - 1),
      "digestify:fresh": snap(NOW - 1000),
      "digestify:exactly-at-the-ttl": snap(NOW - LS_TTL_MS),
    });
    pruneDrafts(s, NOW);
    expect([...s.map.keys()].sort()).toEqual(["digestify:exactly-at-the-ttl", "digestify:fresh"]);
  });

  test("drops a draft with NO savedAt", () => {
    const s = mapStorage({ "digestify:undated": JSON.stringify({ answers: {} }) });
    pruneDrafts(s, NOW);
    expect(s.map.size).toBe(0);
  });

  test("REMOVES an unparseable value rather than skipping it (silent branch L4)", () => {
    const s = mapStorage({ "digestify:corrupt": "{", "digestify:fresh": snap(NOW) });
    pruneDrafts(s, NOW);
    expect([...s.map.keys()]).toEqual(["digestify:fresh"]);
  });

  test("never touches a key outside the digestify namespace", () => {
    const s = mapStorage({ "someone-else:x": "{", theme: "dark", "digestify:old": snap(0) });
    pruneDrafts(s, NOW);
    expect([...s.map.keys()].sort()).toEqual(["someone-else:x", "theme"]);
  });

  test("a store that throws on ACCESS does not throw out of prune (silent branch L5)", () => {
    expect(() => pruneDrafts(throwingStorage, NOW)).not.toThrow();
  });

  test("a store that throws on REMOVE does not throw out of prune", () => {
    const s: DraftStorage = {
      keys: () => ["digestify:old"],
      get: () => snap(0),
      set: () => {},
      remove: () => {
        throw new Error("nope");
      },
    };
    expect(() => pruneDrafts(s, NOW)).not.toThrow();
  });
});

describe("loadSnapshot (inventory L6, L7)", () => {
  test("returns a snapshot inside the TTL", () => {
    const s = mapStorage({ "digestify:a": snap(NOW - 1000, { answers: { q: "hi" } }) });
    expect(loadSnapshot(s, "digestify:a", NOW)?.answers).toEqual({ q: "hi" });
  });

  test("null for an absent key", () => {
    expect(loadSnapshot(mapStorage(), "digestify:a", NOW)).toBeNull();
  });

  test("null for a stale snapshot", () => {
    const s = mapStorage({ "digestify:a": snap(NOW - LS_TTL_MS - 1) });
    expect(loadSnapshot(s, "digestify:a", NOW)).toBeNull();
  });

  test("null, silently, for a corrupt snapshot (silent branch L7)", () => {
    const s = mapStorage({ "digestify:a": "{" });
    expect(loadSnapshot(s, "digestify:a", NOW)).toBeNull();
  });

  test("null for a snapshot with no savedAt, and for a JSON null", () => {
    expect(loadSnapshot(mapStorage({ "digestify:a": "{}" }), "digestify:a", NOW)).toBeNull();
    expect(loadSnapshot(mapStorage({ "digestify:a": "null" }), "digestify:a", NOW)).toBeNull();
  });

  test("a throwing store yields null, not an exception", () => {
    expect(loadSnapshot(throwingStorage, "digestify:a", NOW)).toBeNull();
  });
});

describe("saveSnapshot / clearSnapshot (inventory L11, L12, L13)", () => {
  test("writes answers, comments and savedAt", () => {
    const s = mapStorage();
    saveSnapshot(s, "digestify:a", { q: "hi" }, [{ anchor: "x", text: "y" }], NOW);
    expect(JSON.parse(s.map.get("digestify:a") ?? "")).toEqual({
      answers: { q: "hi" },
      comments: [{ anchor: "x", text: "y" }],
      savedAt: NOW,
    });
  });

  test("a quota throw is swallowed — typing must never break on storage (L12)", () => {
    expect(() => saveSnapshot(throwingStorage, "digestify:a", {}, [], NOW)).not.toThrow();
  });

  test("clear removes the key, and a throwing remove is swallowed (L13)", () => {
    const s = mapStorage({ "digestify:a": snap(NOW) });
    clearSnapshot(s, "digestify:a");
    expect(s.map.size).toBe(0);
    expect(() => clearSnapshot(throwingStorage, "digestify:a")).not.toThrow();
  });
});

describe("restoreAnswers (inventory L8)", () => {
  test("keeps only answers whose question id still exists", () => {
    const snapshot = {
      answers: { alive: "a", gone: "b" },
      comments: [],
      savedAt: NOW,
    };
    expect(restoreAnswers(snapshot, new Set(["alive"]))).toEqual({ alive: "a" });
  });

  test("an empty payload restores nothing, and null restores nothing", () => {
    expect(restoreAnswers(null, new Set(["alive"]))).toEqual({});
    expect(restoreAnswers({ answers: { a: "1" }, comments: [], savedAt: NOW }, new Set())).toEqual(
      {},
    );
  });
});

describe("restoreComments (inventory L9)", () => {
  test("requires BOTH anchor and text, and re-mints ids c1..cN", () => {
    const snapshot = {
      answers: {},
      comments: [
        { anchor: "a", text: "one" },
        { anchor: "", text: "no anchor" },
        { anchor: "c", text: "" },
        { anchor: "d", text: "two" },
      ],
      savedAt: NOW,
    };
    expect(restoreComments(snapshot)).toEqual([
      { id: "c1", anchor: "a", text: "one" },
      { id: "c2", anchor: "d", text: "two" },
    ]);
  });

  test("null restores nothing", () => {
    expect(restoreComments(null)).toEqual([]);
  });
});

describe("browserStorage", () => {
  test("is the real localStorage adapter, not a stub", () => {
    // Named so a future refactor cannot quietly point production at the Map.
    expect(typeof browserStorage.keys).toBe("function");
    expect(browserStorage.keys.toString()).toContain("localStorage");
  });
});
