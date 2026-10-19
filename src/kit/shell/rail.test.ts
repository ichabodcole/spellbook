// The chat rail's mark: whether the agent spoke after what the human last saw.

import { describe, expect, test } from "bun:test";
import { lastMessageId, unseenFromAgent } from "./rail.ts";

const human = (id: string) => ({ id, from: "human" as const });
const agent = (id: string) => ({ id, from: "agent" as const });
const system = (id: string) => ({ id, from: "system" as const });

describe("the chat rail's unseen mark", () => {
  test("nothing after the mark is nothing unseen", () => {
    const chat = [human("a"), agent("b")];
    expect(unseenFromAgent(chat, lastMessageId(chat))).toBe(false);
  });

  test("an agent line after the mark is unseen", () => {
    expect(unseenFromAgent([human("a"), agent("b")], "a")).toBe(true);
  });

  test("only the agent counts: the human's own lines and system lines do not", () => {
    expect(unseenFromAgent([agent("a"), human("b"), system("c")], "a")).toBe(false);
  });

  test("an empty log when the column shut, then the agent speaks", () => {
    expect(unseenFromAgent([agent("a")], null)).toBe(true);
    expect(lastMessageId([])).toBeNull();
  });

  test("a mark trimmed out of the log counts the agent lines kept", () => {
    expect(unseenFromAgent([human("x"), agent("y")], "gone")).toBe(true);
    expect(unseenFromAgent([human("x")], "gone")).toBe(false);
  });
});
