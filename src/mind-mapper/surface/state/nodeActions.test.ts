// drive7 #1/#2a — pure tests for the shared node-action model. The renderers
// (NodeContextMenu / NodeDetail) are exercised live per the GraphCanvas
// precedent; here we pin the SET, its order, the uniform tier picker (#1), and
// that each item's `run` dispatches the right handler (the one-source invariant
// the extraction exists to protect).

import { expect, test } from "bun:test";
import type { MapNode } from "../types";
import { buildNodeActions, type NodeActionDispatch, ratifyTierOptions } from "./nodeActions";
import type { NodeMenuInfo } from "./nodeMenu";

function node(overrides: Partial<MapNode> = {}): MapNode {
  return { id: "n1", title: "Maren", kind: "concept", tier: "thread", synopsis: "", ...overrides };
}

function spyDispatch() {
  const calls: string[] = [];
  const dispatch: NodeActionDispatch = {
    onCommand: (c) => calls.push(`command:${c}`),
    onRule: (id, r) => calls.push(`rule:${id}:${r}`),
    onAction: (a) => calls.push(`action:${a.id}`),
  };
  return { dispatch, calls };
}

const labels = (m: ReturnType<typeof buildNodeActions>) => m.map((i) => i.label);

// #1 — the uniform tier picker.

test("ratifyTierOptions: a valid suggested tier leads, and the OTHER two are always offered", () => {
  const opts = ratifyTierOptions("thread");
  expect(opts.map((o) => o.tier)).toEqual(["thread", "canon", "story-local"]);
  expect(opts[0]?.suggested).toBe(true);
  expect(opts.slice(1).every((o) => !o.suggested)).toBe(true);
});

test("ratifyTierOptions: a null suggestion still offers all three (no dead end, none highlighted)", () => {
  const opts = ratifyTierOptions(null);
  expect(opts.map((o) => o.tier)).toEqual(["canon", "thread", "story-local"]);
  expect(opts.every((o) => !o.suggested)).toBe(true);
});

test("#1: a valid-tier agent proposal offers 1 highlighted + 2 others (never '1 only')", () => {
  const { dispatch } = spyDispatch();
  const menu: NodeMenuInfo = {
    ruling: { proposalId: "p1", ratifyAs: "thread", author: "agent" },
  };
  const model = buildNodeActions(node({ id: "p1", pending: true }), menu, false, dispatch);
  const ratify = model.filter((i) => i.group === "ratify");
  expect(ratify.map((i) => i.label)).toEqual([
    "Ratify as thread",
    "Ratify as canon",
    "Ratify as story-local",
    "Reject",
  ]);
  expect(ratify.find((i) => i.label === "Ratify as thread")?.suggested).toBe(true);
});

test("#1: an unrecognized-tier agent proposal still offers all three (the RATIFYFIX case, now uniform)", () => {
  const { dispatch } = spyDispatch();
  const menu: NodeMenuInfo = { ruling: { proposalId: "p1", ratifyAs: null, author: "agent" } };
  const model = buildNodeActions(node({ id: "p1", pending: true }), menu, false, dispatch);
  const ratify = model.filter((i) => i.group === "ratify").map((i) => i.label);
  expect(ratify).toEqual([
    "Ratify as canon",
    "Ratify as thread",
    "Ratify as story-local",
    "Reject",
  ]);
});

test("a user sketch offers withdraw only — never a ratify the daemon refuses (Claim-D asymmetry)", () => {
  const { dispatch } = spyDispatch();
  const menu: NodeMenuInfo = { ruling: { proposalId: "p1", ratifyAs: "thread", author: "user" } };
  const model = buildNodeActions(node({ id: "p1", pending: true }), menu, false, dispatch);
  const ratify = model.filter((i) => i.group === "ratify").map((i) => i.label);
  expect(ratify).toEqual(["Withdraw sketch"]);
});

// #2b — the Select flyout.

test("#2b: the directional-select trio is one 'Select' flyout, not three top-level items", () => {
  const { dispatch } = spyDispatch();
  const model = buildNodeActions(node(), undefined, false, dispatch);
  const select = model.find((i) => i.key === "select");
  // F3 — items drop the redundant verb; the flyout title carries "Select".
  expect(select?.label).toBe("Select");
  expect(select?.submenu?.map((s) => s.label)).toEqual(["Connected", "Children", "Parents"]);
  // The trio must NOT also appear as top-level items (only the flyout parent).
  expect(labels(model).filter((l) => ["Connected", "Children", "Parents"].includes(l))).toEqual([]);
});

// Conditional items.

test("Enter submap only appears when the node has a submap; Promote only when promotable", () => {
  const { dispatch } = spyDispatch();
  const plain = labels(buildNodeActions(node(), undefined, false, dispatch));
  expect(plain).not.toContain("Enter submap");
  expect(plain).not.toContain("Promote to main");

  const withSubmap = labels(
    buildNodeActions(node({ submapChildCount: 3 }), undefined, true, dispatch),
  );
  expect(withSubmap).toContain("Enter submap");
  expect(withSubmap).toContain("Promote to main");
});

test("agent action slots surface in the model, tagged as the agent tone", () => {
  const { dispatch } = spyDispatch();
  const menu: NodeMenuInfo = { actions: [{ id: "jung", label: "Explore archetypes", seed: "…" }] };
  const model = buildNodeActions(node(), menu, false, dispatch);
  const slot = model.find((i) => i.group === "slots");
  expect(slot?.label).toBe("Explore archetypes");
  expect(slot?.tone).toBe("agent");
});

// The one-source invariant: each item's run dispatches the right handler.

test("run() dispatches through the injected handlers (the drift-proofing contract)", () => {
  const { dispatch, calls } = spyDispatch();
  const menu: NodeMenuInfo = {
    ruling: { proposalId: "p1", ratifyAs: "thread", author: "agent" },
    actions: [{ id: "jung", label: "Explore", seed: "…" }],
  };
  const model = buildNodeActions(node({ id: "p1", pending: true }), menu, false, dispatch);
  const run = (key: string) => model.find((i) => i.key === key)?.run();
  run("focus");
  run("ratify-thread");
  run("reject");
  run("slot-jung");
  run("delete");
  // Flyout child:
  model
    .find((i) => i.key === "select")
    ?.submenu?.find((s) => s.key === "select-parents")
    ?.run();
  expect(calls).toEqual([
    "command:Focus",
    "rule:p1:thread",
    "rule:p1:reject",
    "action:jung",
    "command:Delete",
    "command:Select parents",
  ]);
});

test("Delete is always offered (the human's retract, equal-capability with the agent)", () => {
  const { dispatch } = spyDispatch();
  expect(labels(buildNodeActions(node(), undefined, false, dispatch))).toContain("Delete");
});
