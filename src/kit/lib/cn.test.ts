import { describe, expect, test } from "bun:test";
import { cn } from "./cn.ts";
import { safeStorage } from "./storage.ts";

describe("cn", () => {
  test("joins what is truthy", () => {
    expect(cn("a", false, null, undefined, "", "b", 0)).toBe("a b");
  });

  test("returns a function of the state when any input is one", () => {
    const joined = cn<{ open: boolean }>("base", (s) => (s.open ? "open" : undefined), "end");
    expect(typeof joined).toBe("function");
    expect((joined as (s: { open: boolean }) => string)({ open: true })).toBe("base open end");
    expect((joined as (s: { open: boolean }) => string)({ open: false })).toBe("base end");
  });
});

describe("safeStorage", () => {
  test("reads null and writes nothing when there is no storage at all", () => {
    // Under Bun there is no localStorage until a DOM is registered: the accessor throws.
    expect(safeStorage.getItem("k")).toBeNull();
    expect(() => safeStorage.setItem("k", "v")).not.toThrow();
  });
});
