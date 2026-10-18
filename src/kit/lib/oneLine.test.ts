// One line of text, and one line of plain text from markdown.
import { describe, expect, test } from "bun:test";
import { oneLine, plainLine } from "./oneLine.ts";

describe("oneLine", () => {
  test("every run of whitespace, newlines included, is one space, and the ends are trimmed", () => {
    expect(oneLine("  The harbour\n\n  at  dawn \t")).toBe("The harbour at dawn");
  });
});

describe("plainLine — an agent's markdown as words on one row", () => {
  test("emphasis, strikethrough and code marks go, their words stay", () => {
    expect(plainLine("**Done.** I moved *two* notes and ~~one~~ `maren.md`.")).toBe(
      "Done. I moved two notes and one maren.md.",
    );
    expect(plainLine("__bold__ and _soft_")).toBe("bold and soft");
  });

  test("snake_case and a lone star are left as typed", () => {
    expect(plainLine("set max_width to 3 * 4")).toBe("set max_width to 3 * 4");
  });

  test("links keep their text, images their alt, wiki links their label or target", () => {
    expect(
      plainLine(
        "See [the map](./map.md), ![a fox](fox.png), [[maren]] and [[harbour|the harbour]]",
      ),
    ).toBe("See the map, a fox, maren and the harbour");
  });

  test("headings, quotes, list and task markers go, and lines join", () => {
    expect(plainLine("# Plan\n\n> quoted\n- one\n2. two\n- [x] three")).toBe(
      "Plan quoted one two three",
    );
  });

  test("a fenced block keeps its code and loses its fences", () => {
    expect(plainLine("Try:\n```ts\nconst a = 1;\n```")).toBe("Try: const a = 1;");
  });
});
