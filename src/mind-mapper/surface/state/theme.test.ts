import { describe, expect, test } from "bun:test";
import { resolveInitialTheme } from "./theme";

describe("resolveInitialTheme", () => {
  test("an explicit stored choice wins over the OS preference", () => {
    expect(resolveInitialTheme("light", false)).toBe("light");
    expect(resolveInitialTheme("dark", true)).toBe("dark");
  });

  test("no stored value falls back to prefers-color-scheme", () => {
    expect(resolveInitialTheme(null, true)).toBe("light");
    expect(resolveInitialTheme(null, false)).toBe("dark");
  });

  test("a corrupted stored value degrades to the preference, never throws", () => {
    expect(resolveInitialTheme("solarized", true)).toBe("light");
    expect(resolveInitialTheme("", false)).toBe("dark");
  });
});
