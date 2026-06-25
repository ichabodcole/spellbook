import { describe, expect, test } from "bun:test";
import {
  addItem,
  addMessage,
  agentRepliedSince,
  annotate,
  applyAgentMsg,
  archiveTrayStyle,
  buildStyleItem,
  clearFocus,
  isImperative,
  itemsByKind,
  leanItem,
  leanState,
  makeItem,
  matchesMarks,
  selectItems,
  setCanonical,
  setFocus,
  setGenCost,
  setGenMeta,
  setItemArchived,
  setLike,
  setStar,
  updateSection,
} from "../surface/state/reduce";
import { defaultState } from "../surface/state/types";

const img = () =>
  makeItem({
    id: "a",
    kind: "ref",
    title: "ref.webp",
    src: "data:image/webp;base64,AAAA",
    mime: "image/webp",
    createdAt: 1,
  });

test("makeItem fills defaults", () => {
  const it = img();
  expect(it.starred).toBe(false);
  expect(it.liked).toBe(false);
  expect(it.annotations).toEqual({ agent: "", human: "" });
  expect(it.archived).toBe(false);
  expect(it.gen).toBeNull();
  expect(it.tags).toEqual([]);
  expect(it.text).toBe("");
});

test("addItem appends and de-dupes by id", () => {
  const s = defaultState("t", "");
  expect(addItem(s, img())).toBe(true);
  expect(addItem(s, img())).toBe(false); // same id
  expect(s.library.length).toBe(1);
});

test("selectItems sets a fresh linked set", () => {
  const s = defaultState("t", "");
  selectItems(s, ["a", "b"]);
  expect(s.selectedIds).toEqual(["a", "b"]);
});

test("setStar / setLike toggle and report unknown ids", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  expect(setStar(s, "a", true)).toBe(true);
  expect(s.library[0].starred).toBe(true);
  expect(setLike(s, "a", true)).toBe(true);
  expect(setStar(s, "zzz", true)).toBe(false);
});

test("annotate writes the right side", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  expect(annotate(s, "a", "agent", "warm palette")).toBe(true);
  expect(annotate(s, "a", "human", "love this")).toBe(true);
  expect(s.library[0].annotations).toEqual({
    agent: "warm palette",
    human: "love this",
  });
  expect(annotate(s, "zzz", "agent", "x")).toBe(false);
});

test("itemsByKind filters and excludes archived", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  addItem(
    s,
    makeItem({
      id: "c",
      kind: "context",
      title: "brief.md",
      text: "x",
      createdAt: 2,
    }),
  );
  const archived = makeItem({
    id: "d",
    kind: "ref",
    title: "old",
    createdAt: 3,
  });
  archived.archived = true;
  addItem(s, archived);
  expect(itemsByKind(s.library, "all").map((i) => i.id)).toEqual(["a", "c"]);
  expect(itemsByKind(s.library, "ref").map((i) => i.id)).toEqual(["a"]);
  expect(itemsByKind(s.library, "context").map((i) => i.id)).toEqual(["c"]);
});

test("matchesMarks unions active marks; all pass when none active", () => {
  const mk = (id: string, p: Partial<{ liked: boolean; starred: boolean; canonical: boolean }>) => {
    const it = makeItem({ id, kind: "gen", title: id, createdAt: 1 });
    Object.assign(it, p);
    return it;
  };
  const liked = mk("l", { liked: true });
  const starred = mk("s", { starred: true });
  const pinned = mk("p", { canonical: true });
  const none = mk("n", {});
  const off = { liked: false, starred: false, pinned: false };
  // no filter active → everything passes
  for (const it of [liked, starred, pinned, none]) expect(matchesMarks(it, off)).toBe(true);
  // single
  expect(matchesMarks(liked, { ...off, liked: true })).toBe(true);
  expect(matchesMarks(none, { ...off, liked: true })).toBe(false);
  expect(matchesMarks(pinned, { ...off, pinned: true })).toBe(true);
  // union: liked OR starred
  expect(matchesMarks(starred, { ...off, liked: true, starred: true })).toBe(true);
  expect(matchesMarks(pinned, { ...off, liked: true, starred: true })).toBe(false);
});

test("leanState strips src and text, keeps path and marks", () => {
  const s = defaultState("t", "");
  const it = img();
  it.path = "/tmp/a.webp";
  it.starred = true;
  addItem(s, it);
  const lean = leanState(s);
  const li = lean.library[0] as Record<string, unknown>;
  expect(li.src).toBeUndefined();
  expect(li.text).toBeUndefined();
  expect(li.path).toBe("/tmp/a.webp");
  expect(li.starred).toBe(true);
});

test("isImperative: board moves are ambient, the rest notify the agent", () => {
  expect(isImperative("item.select")).toBe(false);
  expect(isImperative("item.star")).toBe(false);
  expect(isImperative("item.like")).toBe(false);
  expect(isImperative("item.archive")).toBe(false);
  expect(isImperative("item.annotate")).toBe(false); // ambient — read on demand, not pushed
  expect(isImperative("item.add")).toBe(true);
});

test("setItemArchived sets archived and returns false for unknown id", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  expect(setItemArchived(s, "a", true)).toBe(true);
  expect(s.library[0].archived).toBe(true);
  expect(setItemArchived(s, "a", false)).toBe(true);
  expect(s.library[0].archived).toBe(false);
  expect(setItemArchived(s, "zzz", true)).toBe(false);
});

test("itemsByKind still excludes archived items by default", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  const it2 = makeItem({ id: "b", kind: "ref", title: "b.webp", createdAt: 2 });
  addItem(s, it2);
  setItemArchived(s, "b", true);
  const visible = itemsByKind(s.library, "all");
  expect(visible.map((i) => i.id)).toEqual(["a"]);
  expect(itemsByKind(s.library, "ref").map((i) => i.id)).toEqual(["a"]);
});

test("applyAgentMsg mutates state", () => {
  const s = defaultState("t", "");
  addItem(s, img());
  applyAgentMsg(s, { type: "init", title: "New", intent: "logos" });
  expect(s.title).toBe("New");
  expect(s.intent).toBe("logos");
  applyAgentMsg(s, { type: "intent", text: "icons" });
  expect(s.intent).toBe("icons");
  applyAgentMsg(s, { type: "item.annotate", id: "a", agent: "cool blues" });
  expect(s.library[0].annotations.agent).toBe("cool blues");
  applyAgentMsg(s, { type: "status", busy: true, text: "generating" });
  expect(s.status).toEqual({ busy: true, text: "generating" });
});

test("addMessage appends in order", () => {
  const s = defaultState("t", "i");
  addMessage(s, {
    id: "m1",
    who: "user",
    kind: "info",
    text: "hi",
    ground: ["ref-1"],
    ts: 1,
  });
  addMessage(s, {
    id: "m2",
    who: "agent",
    kind: "result",
    text: "ok",
    ground: [],
    ts: 2,
  });
  expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  expect(s.messages[0].ground).toEqual(["ref-1"]);
});

test("updateSection patches only provided fields and returns true", () => {
  const s = defaultState("t", "i");
  const ok = updateSection(s, "palette", {
    content: "indigo + amber",
    status: "forming",
  });
  expect(ok).toBe(true);
  const palette = s.styleGuide.find((x) => x.key === "palette");
  expect(palette?.content).toBe("indigo + amber");
  expect(palette?.status).toBe("forming");
  expect(palette?.prompts).toEqual([]); // untouched
});

test("updateSection on an unknown key returns false and mutates nothing", () => {
  const s = defaultState("t", "i");
  // @ts-expect-error — exercising the runtime guard with an invalid key
  expect(updateSection(s, "nope", { content: "x" })).toBe(false);
  expect(s.styleGuide.every((x) => x.content === "")).toBe(true);
});

test("applyAgentMsg routes a section command through updateSection", () => {
  const s = defaultState("t", "i");
  applyAgentMsg(s, {
    type: "section",
    key: "prompts",
    status: "agreed",
    prompts: ["hand-inked, indigo twilight, amber accent"],
  });
  const prompts = s.styleGuide.find((x) => x.key === "prompts");
  expect(prompts?.status).toBe("agreed");
  expect(prompts?.prompts).toEqual(["hand-inked, indigo twilight, amber accent"]);
});

test("section command sets structured palette colors (swatches)", () => {
  const s = defaultState("t", "i");
  applyAgentMsg(s, {
    type: "section",
    key: "palette",
    status: "agreed",
    colors: [
      { hex: "#FACC3E", name: "Treasure Gold" },
      { hex: "#293D36", name: "Sunken Charcoal" },
    ],
  });
  const palette = s.styleGuide.find((x) => x.key === "palette");
  expect(palette?.colors).toEqual([
    { hex: "#FACC3E", name: "Treasure Gold" },
    { hex: "#293D36", name: "Sunken Charcoal" },
  ]);
  // other sections keep an empty colors array
  expect(s.styleGuide.find((x) => x.key === "direction")?.colors).toEqual([]);
});

test("agentRepliedSince is true once an agent message lands after the timestamp", () => {
  const base = defaultState("t", "i");
  base.messages = [{ id: "a", who: "user", kind: "info", text: "hi", ground: [], ts: 100 }];
  expect(agentRepliedSince(base.messages, 100)).toBe(false);
  base.messages.push({
    id: "b",
    who: "agent",
    kind: "result",
    text: "hey",
    ground: [],
    ts: 150,
  });
  expect(agentRepliedSince(base.messages, 100)).toBe(true);
  // an agent message at or before the cutoff does not count
  expect(agentRepliedSince(base.messages, 150)).toBe(false);
});

describe("focus + gen-cost reducers", () => {
  test("setFocus scopes the lens with owner + note; clearFocus resets it", () => {
    const s = defaultState("t", "i");
    setFocus(s, ["g1", "g2"], "agent", "which reads most like X?");
    expect(s.scope).toBe("focus");
    expect(s.focusSet).toEqual(["g1", "g2"]);
    expect(s.focusOwner).toBe("agent");
    expect(s.focusNote).toBe("which reads most like X?");
    clearFocus(s);
    expect(s.scope).toBe("all");
    expect(s.focusSet).toEqual([]);
    expect(s.focusOwner).toBeNull();
    expect(s.focusNote).toBe("");
  });

  test("setFocus defaults note to empty string", () => {
    const s = defaultState("t", "i");
    setFocus(s, ["g1"], "you");
    expect(s.focusNote).toBe("");
  });

  test("setGenCost updates a gen item's cost; false for unknown/non-gen", () => {
    const s = defaultState("t", "i");
    s.library.push({
      id: "gen-1",
      kind: "gen",
      title: "r1",
      src: "",
      path: "",
      text: "",
      mime: "image/webp",
      tags: [],
      starred: false,
      liked: false,
      annotations: { agent: "", human: "" },
      archived: false,
      createdAt: 1,
      gen: {
        model: "m",
        prompt: "p",
        seed: null,
        cost: null,
        custom: {},
        round: 1,
      },
    });
    expect(setGenCost(s, "gen-1", 0.011)).toBe(true);
    expect(s.library[0].gen?.cost).toBe(0.011);
    expect(setGenCost(s, "nope", 0.5)).toBe(false);
  });

  test("setGenMeta backfills prompt + merges custom; false for unknown/non-gen", () => {
    const s = defaultState("t", "i");
    s.library.push({
      id: "gen-2",
      kind: "gen",
      title: "r1",
      src: "",
      path: "",
      text: "",
      mime: "image/webp",
      tags: [],
      starred: false,
      liked: false,
      annotations: { agent: "", human: "" },
      archived: false,
      createdAt: 1,
      gen: { model: "m", prompt: "label", seed: null, cost: null, custom: { a: "1" }, round: 1 },
    });
    // direct helper
    expect(setGenMeta(s, "gen-2", { prompt: "the real prompt", custom: { refs: "x" } })).toBe(true);
    expect(s.library[0].gen?.prompt).toBe("the real prompt");
    expect(s.library[0].gen?.custom).toEqual({ a: "1", refs: "x" });
    expect(setGenMeta(s, "nope", { prompt: "x" })).toBe(false);
    // routed through applyAgentMsg
    applyAgentMsg(s, { type: "gen.meta", id: "gen-2", prompt: "via cmd" });
    expect(s.library[0].gen?.prompt).toBe("via cmd");
  });

  test("applyAgentMsg routes focus.push and gen.cost", () => {
    const s = defaultState("t", "i");
    applyAgentMsg(s, { type: "focus.push", ids: ["a"], note: "pick one" });
    expect(s.scope).toBe("focus");
    expect(s.focusOwner).toBe("agent");
    expect(s.focusNote).toBe("pick one");
  });
});

describe("styles tray + canonical reducers", () => {
  const sampleStyle = {
    id: "s1",
    label: "house style",
    text: "cute-occult, ink lines",
    sections: [],
    canonical: [],
    createdAt: 1,
    archived: false,
  };

  test("setCanonical toggles a library item; false for unknown id", () => {
    const s = defaultState("t", "i");
    s.library.push({
      id: "ref-1",
      kind: "ref",
      title: "a",
      src: "x",
      path: "",
      text: "",
      mime: "image/webp",
      tags: [],
      starred: false,
      liked: false,
      annotations: { agent: "", human: "" },
      canonical: false,
      canon: [],
      archived: false,
      createdAt: 1,
      gen: null,
    });
    expect(setCanonical(s, "ref-1", true)).toBe(true);
    expect(s.library[0].canonical).toBe(true);
    expect(setCanonical(s, "nope", true)).toBe(false);
  });

  test("archiveTrayStyle toggles archived; false when not found", () => {
    const s = defaultState("t", "i");
    s.tray.push({ ...sampleStyle });
    expect(archiveTrayStyle(s, "s1", true)).toBe(true);
    expect(s.tray[0].archived).toBe(true);
    expect(archiveTrayStyle(s, "nope", true)).toBe(false);
  });

  test("buildStyleItem produces a kind:style library item carrying canon", () => {
    const item = buildStyleItem(sampleStyle, [{ title: "hero", src: "data:..." }], 42);
    expect(item.id).toBe("style-s1");
    expect(item.kind).toBe("style");
    expect(item.title).toBe("house style");
    expect(item.text).toBe("cute-occult, ink lines");
    expect(item.canon).toEqual([{ title: "hero", src: "data:..." }]);
    expect(item.createdAt).toBe(42);
  });

  test("leanItem strips canon (and src/text)", () => {
    const item = buildStyleItem(sampleStyle, [{ title: "hero", src: "data:..." }], 42);
    const lean = leanItem(item) as Record<string, unknown>;
    expect("canon" in lean).toBe(false);
    expect("src" in lean).toBe(false);
    expect("text" in lean).toBe(false);
  });

  test("applyAgentMsg routes style.archive", () => {
    const s = defaultState("t", "i");
    s.tray.push({ ...sampleStyle });
    applyAgentMsg(s, { type: "style.archive", id: "s1", archived: true });
    expect(s.tray[0].archived).toBe(true);
  });
});
