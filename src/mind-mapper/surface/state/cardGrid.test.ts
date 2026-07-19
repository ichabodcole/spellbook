import { describe, expect, test } from "bun:test";
import type { MapNode, NodeKind, Tier } from "../types";
import { groupByTierKind } from "./cardGrid";

const node = (id: string, tier: Tier, kind: NodeKind, pending = false): MapNode => ({
  id,
  title: id,
  kind,
  tier,
  synopsis: "",
  ...(pending ? { pending } : {}),
});

describe("groupByTierKind", () => {
  test("groups tier-then-kind in canonical order regardless of input order", () => {
    const grouped = groupByTierKind([
      node("bg-concept", "background", "concept"),
      node("canon-place", "canon", "place"),
      node("canon-cast", "canon", "cast"),
      node("thread-thread", "thread", "thread"),
    ]);
    expect(grouped.map((g) => g.tier)).toEqual(["canon", "thread", "background"]);
    expect(grouped[0]?.kinds.map((k) => k.kind)).toEqual(["cast", "place"]);
  });

  test("empty tiers and kinds are omitted, never rendered as scaffolding", () => {
    const grouped = groupByTierKind([node("a", "story-local", "concept")]);
    expect(grouped).toEqual([
      {
        tier: "story-local",
        kinds: [{ kind: "concept", nodes: [node("a", "story-local", "concept")] }],
      },
    ]);
  });

  test("input order survives within a kind group", () => {
    const grouped = groupByTierKind([
      node("first", "canon", "cast"),
      node("second", "canon", "cast"),
    ]);
    expect(grouped[0]?.kinds[0]?.nodes.map((n) => n.id)).toEqual(["first", "second"]);
  });

  test("pending nodes ride their tier group like any other (staging is styling, not placement)", () => {
    const grouped = groupByTierKind([
      node("real", "canon", "cast"),
      node("draft", "canon", "cast", true),
    ]);
    expect(grouped[0]?.kinds[0]?.nodes.map((n) => n.id)).toEqual(["real", "draft"]);
  });

  test("no nodes → no groups", () => {
    expect(groupByTierKind([])).toEqual([]);
  });
});
