// The four selector cells, moved out of tests/reduce.test.ts with the S1 split
// and co-located beside their module (the src/ precedent: every test under src/
// sits beside its subject). Fixtures are LITERAL LibraryItems rather than
// makeItem()/addItem() — those are backend mutators (scripts/reduce.ts after
// the split) and a surface test must never import the backend to build a value.
import { expect, test } from "bun:test";
import type {
  ItemKind,
  LibraryItem,
  Message,
} from "../../../../plugins/spellbook/skills/glamour/shared/types";
import { agentRepliedSince, itemsByKind, matchesMarks } from "./derive";

const item = (id: string, kind: ItemKind, extra: Partial<LibraryItem> = {}): LibraryItem => ({
  id,
  kind,
  title: id,
  src: "",
  path: "",
  text: "",
  mime: "",
  tags: [],
  starred: false,
  liked: false,
  annotations: { agent: "", human: "" },
  canonical: false,
  canon: [],
  archived: false,
  createdAt: 1,
  gen: null,
  ...extra,
});

test("itemsByKind filters and excludes archived", () => {
  const library = [
    item("a", "ref", { title: "ref.webp", src: "data:image/webp;base64,AAAA", mime: "image/webp" }),
    item("c", "context", { title: "brief.md", text: "x", createdAt: 2 }),
    item("d", "ref", { title: "old", createdAt: 3, archived: true }),
  ];
  // PRECONDITION, not decoration: with no archived row in the fixture the
  // assertions below pass whether or not the filter exists (cassandra D4).
  expect(library.some((i) => i.archived)).toBe(true);
  expect(itemsByKind(library, "all").map((i) => i.id)).toEqual(["a", "c"]);
  expect(itemsByKind(library, "ref").map((i) => i.id)).toEqual(["a"]);
  expect(itemsByKind(library, "context").map((i) => i.id)).toEqual(["c"]);
});

test("matchesMarks unions active marks; all pass when none active", () => {
  const liked = item("l", "gen", { liked: true });
  const starred = item("s", "gen", { starred: true });
  const pinned = item("p", "gen", { canonical: true });
  const none = item("n", "gen");
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

test("itemsByKind still excludes archived items by default", () => {
  const library = [
    item("a", "ref"),
    item("b", "ref", { title: "b.webp", createdAt: 2, archived: true }),
  ];
  // PRECONDITION, not decoration: with no archived row in the fixture the
  // assertions below pass whether or not the filter exists (cassandra D4).
  expect(library.some((i) => i.archived)).toBe(true);
  expect(itemsByKind(library, "all").map((i) => i.id)).toEqual(["a"]);
  expect(itemsByKind(library, "ref").map((i) => i.id)).toEqual(["a"]);
});

test("agentRepliedSince is true once an agent message lands after the timestamp", () => {
  const messages: Message[] = [
    { id: "a", who: "user", kind: "info", text: "hi", ground: [], ts: 100 },
  ];
  expect(agentRepliedSince(messages, 100)).toBe(false);
  messages.push({ id: "b", who: "agent", kind: "result", text: "hey", ground: [], ts: 150 });
  expect(agentRepliedSince(messages, 100)).toBe(true);
  // an agent message at or before the cutoff does not count
  expect(agentRepliedSince(messages, 150)).toBe(false);
});
