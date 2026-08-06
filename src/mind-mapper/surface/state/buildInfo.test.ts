// R4 B1 — pure-logic tests for the build-stamp footer text.

import { expect, test } from "bun:test";
import { buildFooterText, formatAge } from "./buildInfo";

const NOW = Date.parse("2026-07-19T12:00:00Z");

test("formatAge buckets: just now, minutes, hours, days", () => {
  expect(formatAge("2026-07-19T11:59:40Z", NOW)).toBe("just now");
  expect(formatAge("2026-07-19T11:26:00Z", NOW)).toBe("34m ago");
  expect(formatAge("2026-07-19T07:00:00Z", NOW)).toBe("5h ago");
  expect(formatAge("2026-07-16T12:00:00Z", NOW)).toBe("3d ago");
});

test("an unparsable builtAt yields null, never NaN text", () => {
  expect(formatAge("not-a-date", NOW)).toBeNull();
});

test("footer text carries short commit + age", () => {
  expect(
    buildFooterText({ commit: "ab12cd3", builtAt: "2026-07-19T07:00:00Z", stale: false }, NOW),
  ).toBe("build ab12cd3 · 5h ago");
});

test("a corrupt stamp date degrades to commit-only, no dangling separator", () => {
  expect(buildFooterText({ commit: "ab12cd3", builtAt: "???", stale: false }, NOW)).toBe(
    "build ab12cd3",
  );
});

test("stale dist is said plainly", () => {
  const text = buildFooterText(
    { commit: "ab12cd3", builtAt: "2026-07-19T07:00:00Z", stale: true },
    NOW,
  );
  expect(text).toContain("stale");
  expect(text).toContain("newer than this dist");
});
