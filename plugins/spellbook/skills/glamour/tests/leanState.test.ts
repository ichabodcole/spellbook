import { expect, test } from "bun:test";
import { leanState } from "../scripts/server";
import { defaultState } from "../surface/state/types";

test("leanState strips inlined image/text src from agent view", () => {
  const s = defaultState("X", "");
  s.influences.push({
    id: "i1",
    src: "data:image/webp;base64,AAAA",
    path: "/tmp/i1.webp",
    name: "a",
    aspects: [],
    starred: false,
    note: "",
    read: "",
  });
  s.variants.push({
    id: "v1",
    src: "data:image/png;base64,BBBB",
    prompt: "p",
    label: "L",
    round: 1,
    liked: false,
    canonical: false,
  });
  s.contexts.push({
    id: "c1",
    name: "c.md",
    text: "hello",
    path: "/tmp/c1.md",
    starred: false,
    note: "",
  });
  const lean = leanState(s);
  expect((lean.influences[0] as Record<string, unknown>).src).toBeUndefined();
  expect((lean.variants[0] as Record<string, unknown>).src).toBeUndefined();
  expect((lean.contexts[0] as Record<string, unknown>).text).toBeUndefined();
  expect(lean.influences[0].path).toBe("/tmp/i1.webp");
  expect(lean.variants[0].label).toBe("L");
  expect(lean.contexts[0].path).toBe("/tmp/c1.md");
});
