// R4 R1 — pure-logic tests for the ratify-anywhere menu derivation and the
// ruling error surface (the chassis component itself is exercised live, per
// the GraphCanvas precedent — no DOM test infra in this suite, deliberately).

import { expect, test } from "bun:test";
import type { MapNode, Proposal } from "../types";
import { menuInfoFor, rulingErrorMessage } from "./nodeMenu";

function node(id: string): MapNode {
  return { id, title: id, kind: "concept", tier: "thread", synopsis: "" };
}

function proposal(overrides: Partial<Proposal> & { id: string }): Proposal {
  return {
    kind: "node",
    draft: { title: "The Hollow" },
    evidence: { docId: "ramble-01", messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    zoneId: null,
    ...overrides,
  };
}

test("a pending agent proposal gets a ruling entry keyed by its synthetic node id", () => {
  const menus = menuInfoFor([node("maren")], [proposal({ id: "prop-1", suggestedTier: "canon" })]);
  expect(menus.get("prop-1")?.ruling).toEqual({
    proposalId: "prop-1",
    ratifyAs: "canon",
    author: "agent",
  });
});

test("a background suggestion has NO one-keystroke accept — background is a Tier, not a Ruling", () => {
  const menus = menuInfoFor([], [proposal({ id: "bg-1", suggestedTier: "background" })]);
  expect(menus.get("bg-1")?.ruling?.ratifyAs).toBeNull();
});

test("a user-authored sketch carries its author so the menu can offer withdraw only", () => {
  const menus = menuInfoFor([], [proposal({ id: "sketch-1", author: "user" })]);
  expect(menus.get("sketch-1")?.ruling?.author).toBe("user");
});

test("ratified and rejected proposals get NO menu entry (they never render on the board)", () => {
  const menus = menuInfoFor(
    [],
    [
      proposal({ id: "done-1", status: "ratified" }),
      proposal({ id: "done-2", status: "rejected" }),
    ],
  );
  expect(menus.has("done-1")).toBe(false);
  expect(menus.has("done-2")).toBe(false);
});

test("zoned pending proposals get a ruling entry too — the refusal is the daemon's to make", () => {
  const menus = menuInfoFor([], [proposal({ id: "zoned-1", zoneId: "sandbox" })]);
  expect(menus.get("zoned-1")?.ruling?.proposalId).toBe("zoned-1");
});

test("a plain ratified node gets no entry (nothing to rule)", () => {
  const menus = menuInfoFor([node("maren")], []);
  expect(menus.has("maren")).toBe(false);
});

// R4 A1 — action slots ride the menu info from BOTH stores.

test("a node's action slots surface in its menu entry", () => {
  const actions = [{ id: "jungian", label: "Explore archetypes", seed: "Explore — " }];
  const menus = menuInfoFor([{ ...node("maren"), actions }], []);
  expect(menus.get("maren")?.actions).toEqual(actions);
  expect(menus.get("maren")?.ruling).toBeUndefined();
});

test("a pending proposal's action slots ride alongside its ruling entry", () => {
  const actions = [{ id: "a", label: "A", seed: "A — " }];
  const menus = menuInfoFor([], [proposal({ id: "prop-1", actions })]);
  expect(menus.get("prop-1")?.actions).toEqual(actions);
  expect(menus.get("prop-1")?.ruling?.proposalId).toBe("prop-1");
});

test("empty action arrays never land in the menu info (absent = none)", () => {
  const menus = menuInfoFor(
    [{ ...node("maren"), actions: [] }],
    [proposal({ id: "p", actions: [] })],
  );
  expect(menus.get("maren")).toBeUndefined();
  expect(menus.get("p")?.actions).toBeUndefined();
});

test("the typed zoned 409 renders the promote-first refusal, naming the zone", () => {
  const msg = rulingErrorMessage(409, { error: "zoned", zoneId: "sandbox" });
  expect(msg).toContain('zone "sandbox"');
  expect(msg).toContain("promote");
});

test("a zoned 409 without a usable zoneId still says promote-first", () => {
  expect(rulingErrorMessage(409, { error: "zoned" })).toContain("promote");
});

test("any other body.error surfaces verbatim (the promoteProposal precedent)", () => {
  expect(rulingErrorMessage(400, { error: "proposal p1 is not pending" })).toBe(
    "proposal p1 is not pending",
  );
});

test("an unparsable body degrades to the status code", () => {
  expect(rulingErrorMessage(500, null)).toBe("ruling 500");
  expect(rulingErrorMessage(404, "nope")).toBe("ruling 404");
});
