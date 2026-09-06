import { describe, expect, test } from "bun:test";
import {
  ALIAS_KEY,
  commitAlias,
  initialMode,
  type KV,
  loadAlias,
  modeKey,
  nextMode,
  saveMode,
  subscribedStatus,
  tailUrl,
  toggleDisabled,
  toggleLabel,
} from "./identity";

function fakeKV(init: Record<string, string> = {}): KV & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

describe("identity (inventory I1–I7)", () => {
  test("I1 — the stored override, else empty", () => {
    expect(loadAlias(fakeKV())).toBe("");
    expect(loadAlias(fakeKV({ [ALIAS_KEY]: "cole" }))).toBe("cole");
  });
  test("I3 — commit trims and stores; an empty alias REMOVES the key rather than storing an empty one", () => {
    const kv = fakeKV();
    expect(commitAlias(kv, "  cole ")).toBe("cole");
    expect(kv.dump()).toEqual({ [ALIAS_KEY]: "cole" });
    expect(commitAlias(kv, "   ")).toBe("");
    expect(kv.dump()).toEqual({});
  });
  test("I4 — lurk by default; join only when this channel was joined AND an alias resolved", () => {
    expect(initialMode(fakeKV(), "a", "cole")).toBe("lurk");
    expect(initialMode(fakeKV({ [modeKey("a")]: "join" }), "a", "cole")).toBe("join");
    expect(initialMode(fakeKV({ [modeKey("a")]: "join" }), "a", "")).toBe("lurk");
    // per channel: b was never joined
    expect(initialMode(fakeKV({ [modeKey("a")]: "join" }), "b", "cole")).toBe("lurk");
  });
  test("I6 — saveMode is per channel", () => {
    const kv = fakeKV();
    saveMode(kv, "a", "join");
    expect(kv.dump()).toEqual({ [modeKey("a")]: "join" });
  });
  test("I6 — lurk → join needs an alias; join → lurk always", () => {
    expect(nextMode("lurk", "")).toBeNull();
    expect(nextMode("lurk", "  ")).toBeNull();
    expect(nextMode("lurk", "cole")).toBe("join");
    expect(nextMode("join", "")).toBe("lurk");
  });
  test("I5 — label and disabled state", () => {
    expect(toggleLabel("lurk")).toBe("Join channel");
    expect(toggleLabel("join")).toBe("Joined — click to lurk");
    expect(toggleDisabled("lurk", "")).toBe(true);
    expect(toggleDisabled("lurk", "cole")).toBe(false);
    expect(toggleDisabled("join", "")).toBe(false);
  });
  test("R2 / I7 — join registers named human presence; lurk registers none", () => {
    expect(tailUrl("roundtable", 0, "join", "cole")).toBe(
      "/channels/roundtable/tail?since=0&as=cole&human=1",
    );
    expect(tailUrl("roundtable", 42, "lurk", "cole")).toBe(
      "/channels/roundtable/tail?since=42&lurk=1",
    );
    // join with no alias cannot register a name — falls back to lurk params
    expect(tailUrl("a b", 0, "join", "")).toBe("/channels/a%20b/tail?since=0&lurk=1");
    // the alias is URL-encoded
    expect(tailUrl("a", 0, "join", "c d")).toBe("/channels/a/tail?since=0&as=c%20d&human=1");
  });
  test("E1 — the subscribed status text per mode", () => {
    expect(subscribedStatus("join", "a", "cole")).toBe("joined a as cole");
    expect(subscribedStatus("lurk", "a", "cole")).toBe("subscribed to a");
  });
});
