// The menu's rules. The module also holds the menu, which loads Base UI, so a DOM is
// registered first: Base UI decides once, when it loads, whether it runs in a browser,
// and a later component test in the same process would otherwise get no popups.
import "../lib/registerDom.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, removeDom } from "../lib/registerDom.ts";
import type { Version } from "../workspace/protocol";
import { authorLabel, ordered, versionLabel, versionSummary } from "./VersionMenu";

beforeAll(installDom);
afterAll(removeDom);

const v = (n: number, extra: Partial<Version> = {}): Version => ({
  n,
  by: "human",
  createdAt: new Date(Date.UTC(2026, 8, 30, 10, n)).toISOString(),
  ...extra,
});

describe("versionLabel", () => {
  test("the label is the identity, trimmed; a blank one is not a name", () => {
    expect(versionLabel(v(2, { label: "  slower induction " }))).toBe("slower induction");
    expect(versionLabel(v(3))).toBe("v3");
    expect(versionLabel(v(4, { label: "   " }))).toBe("v4");
  });
});

describe("ordered", () => {
  test("the active version first, then newest first", () => {
    expect(ordered([v(1), v(2), v(3)], 1).map((x) => x.n)).toEqual([1, 3, 2]);
    expect(ordered([v(1), v(2), v(3)], 2).map((x) => x.n)).toEqual([2, 3, 1]);
  });
});

describe("versionSummary", () => {
  test("the number, and as much of the name as fits", () => {
    expect(versionSummary(undefined, 2)).toBe("v2");
    expect(versionSummary(v(2, { label: "tight" }), 2)).toBe("v2 · tight");
    expect(versionSummary(v(2, { label: "x".repeat(60) }), 2, 10)).toBe("v2 · xxxxxxxxx…");
  });
});

describe("authorLabel", () => {
  test("a person, the agent, and what the daemon kept from a stray write", () => {
    expect(authorLabel(v(1))).toBe("You");
    expect(authorLabel(v(2, { by: "agent" }))).toBe("Agent");
    expect(authorLabel(v(3, { by: "agent", label: "outside write to v1" }))).toBe("Outside write");
  });
});
