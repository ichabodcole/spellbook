// R4 ACT1 — pure-logic tests for the activity vocabulary (the effect wiring
// in App/useProjectState is DOM glue, verified live per the house split).

import { expect, test } from "bun:test";
import { badgeFor, badgeHasClientTtl, parseActivityState } from "./activity";

test("parseActivityState narrows the four known states, stalled included", () => {
  expect(parseActivityState("received")).toBe("received");
  expect(parseActivityState("thinking")).toBe("thinking");
  expect(parseActivityState("idle")).toBe("idle");
  expect(parseActivityState("stalled")).toBe("stalled");
});

test("parseActivityState drops unknown vocabulary silently (never a crash)", () => {
  expect(parseActivityState("daydreaming")).toBeNull();
  expect(parseActivityState(undefined)).toBeNull();
  expect(parseActivityState(42)).toBeNull();
});

test("received and thinking wear the pulse; idle clears", () => {
  expect(badgeFor("received")).toBe("thinking");
  expect(badgeFor("thinking")).toBe("thinking");
  expect(badgeFor("idle")).toBeNull();
});

test("stalled gets its OWN badge — never the thinking pulse (false-liveness)", () => {
  expect(badgeFor("stalled")).toBe("stalled");
});

test("only the pulse gets the client TTL backstop — stalled persists until resolved", () => {
  expect(badgeHasClientTtl("thinking")).toBe(true);
  expect(badgeHasClientTtl("stalled")).toBe(false);
  expect(badgeHasClientTtl(null)).toBe(false);
});
