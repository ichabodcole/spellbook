import { describe, expect, test } from "bun:test";
import {
  AGENT_EVENT_TYPES,
  defaultState,
  defaultStyleGuide,
  VALID_KIND,
} from "../surface/state/types";

test("defaultState is an empty library session", () => {
  const s = defaultState("My Style", "logo set");
  expect(s.title).toBe("My Style");
  expect(s.intent).toBe("logo set");
  expect(s.library).toEqual([]);
  expect(s.selectedIds).toEqual([]);
  expect(s.status).toEqual({ busy: false, text: "" });
});

test("VALID_KIND covers the four tile kinds", () => {
  expect([...VALID_KIND]).toEqual(["ref", "context", "gen", "style"]);
});

test("every imperative client message has an agent event type", () => {
  // The structural guard against V1's dropped-input bug: any browser message
  // that is NOT a pure board move must be representable as an agent event.
  for (const t of ["item.add"]) {
    expect(AGENT_EVENT_TYPES).toContain(t);
  }
  // item.annotate is ambient (a per-item note read on demand) — NOT pushed.
  expect(AGENT_EVENT_TYPES).not.toContain("item.annotate");
});

describe("Slice 2 contract", () => {
  test("defaultState seeds an empty conversation and a full style guide", () => {
    const s = defaultState("t", "i");
    expect(s.messages).toEqual([]);
    expect(s.styleGuide).toHaveLength(6);
    expect(s.styleGuide.map((x) => x.key)).toEqual([
      "understanding",
      "direction",
      "palette",
      "consistency",
      "prompts",
      "canonical",
    ]);
    expect(s.styleGuide.every((x) => x.status === "empty")).toBe(true);
  });

  test("defaultStyleGuide carries the mockup's display labels", () => {
    const labels = defaultStyleGuide().map((x) => x.label);
    expect(labels).toEqual([
      "Understanding",
      "Direction",
      "Palette",
      "Consistency",
      "Re-cast prompts",
      "Canonical images",
    ]);
  });

  test("message.user is the only new agent event type", () => {
    expect(AGENT_EVENT_TYPES).toContain("message.user");
    // Ambient board moves are never agent events.
    expect(AGENT_EVENT_TYPES).not.toContain("item.select");
    expect(AGENT_EVENT_TYPES).not.toContain("message.send");
  });
});

describe("Slice 3 contract", () => {
  test("defaultState seeds an unfocused lens", () => {
    const s = defaultState("t", "i");
    expect(s.scope).toBe("all");
    expect(s.focusSet).toEqual([]);
    expect(s.focusOwner).toBeNull();
    expect(s.focusNote).toBe("");
  });

  test("focus moves and generate stay ambient (no agent event)", () => {
    expect(AGENT_EVENT_TYPES).not.toContain("generate");
    expect(AGENT_EVENT_TYPES).not.toContain("focus.set");
    expect(AGENT_EVENT_TYPES).not.toContain("focus.clear");
    expect(AGENT_EVENT_TYPES).not.toContain("focus.push");
    expect(AGENT_EVENT_TYPES).not.toContain("gen.add");
    expect(AGENT_EVENT_TYPES).not.toContain("gen.cost");
  });
});

describe("Slice 4 contract", () => {
  test("defaultState seeds an empty tray", () => {
    expect(defaultState("t", "i").tray).toEqual([]);
  });

  test("style + canonical commands add NO new agent event type", () => {
    // bring-in reuses item.add; canonical is ambient; save/archive agent-origin.
    expect(AGENT_EVENT_TYPES).not.toContain("style.bringIn");
    expect(AGENT_EVENT_TYPES).not.toContain("style.save");
    expect(AGENT_EVENT_TYPES).not.toContain("style.archive");
    expect(AGENT_EVENT_TYPES).not.toContain("item.canonical");
    expect(AGENT_EVENT_TYPES).toContain("item.add"); // bring-in rides this
  });
});
