import { expect, test } from "bun:test";
import { resolveInitialTheme } from "./theme";

test("a stored choice beats the OS preference, which beats dark", () => {
  expect(resolveInitialTheme("light", false)).toBe("light");
  expect(resolveInitialTheme("dark", true)).toBe("dark");
  expect(resolveInitialTheme(null, true)).toBe("light");
  expect(resolveInitialTheme(null, false)).toBe("dark");
  expect(resolveInitialTheme("purple", false)).toBe("dark");
});
