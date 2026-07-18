// Pure-logic tests for the project-in-URL precedence — no DOM, no network.

import { expect, test } from "bun:test";
import { resolveInitialProject, withProjectParam } from "./urlProject";

test("URL ?project= wins over a stored value", () => {
  expect(resolveInitialProject("?project=atlas", "stored-proj")).toBe("atlas");
});

test("no URL param falls back to localStorage", () => {
  expect(resolveInitialProject("", "stored-proj")).toBe("stored-proj");
  expect(resolveInitialProject("?other=1", "stored-proj")).toBe("stored-proj");
});

test("neither URL nor storage yields undefined (daemon default decides)", () => {
  expect(resolveInitialProject("", null)).toBeUndefined();
  expect(resolveInitialProject("?q=x", null)).toBeUndefined();
});

test("blank or whitespace values don't count as a choice", () => {
  expect(resolveInitialProject("?project=", "stored-proj")).toBe("stored-proj");
  expect(resolveInitialProject("?project=%20%20", null)).toBeUndefined();
  expect(resolveInitialProject("", "   ")).toBeUndefined();
});

test("URL param values are trimmed", () => {
  expect(resolveInitialProject("?project=%20atlas%20", null)).toBe("atlas");
});

test("URL-encoded project ids decode", () => {
  expect(resolveInitialProject("?project=my%20project", null)).toBe("my project");
});

test("withProjectParam sets the param on an empty search", () => {
  expect(withProjectParam("", "atlas")).toBe("?project=atlas");
});

test("withProjectParam replaces an existing project param", () => {
  expect(withProjectParam("?project=old", "new")).toBe("?project=new");
});

test("withProjectParam preserves unrelated params", () => {
  const out = withProjectParam("?theme=night&project=old", "atlas");
  const params = new URLSearchParams(out);
  expect(params.get("project")).toBe("atlas");
  expect(params.get("theme")).toBe("night");
});
