// Where markdown is code: what the relation vocabulary skips and where typing
// `](` or `[[` must not open the link picker.
import { describe, expect, test } from "bun:test";
import { caretInCode, codeBlockLines, inInlineCode, withoutCode } from "./markdownCode.ts";

describe("code blocks", () => {
  test("a fenced block, fences included, closed by its own marker", () => {
    const lines = ["a", "```js", "x ~~~", "```", "b", "~~~~", "y", "~~~~", "c"];
    expect([...codeBlockLines(lines)]).toEqual([1, 2, 3, 5, 6, 7]);
  });

  test("a fence indented inside a list item, and one inside a blockquote", () => {
    const list = ["1. item", "", "    ```", "    [x](./x.md?rel=listed)", "    ```", "after"];
    expect([...codeBlockLines(list)]).toEqual([2, 3, 4]);
    const quote = ["> said:", "> ```", "> [y](./y.md?rel=quoted)", "> ```", "plain"];
    expect([...codeBlockLines(quote)]).toEqual([1, 2, 3]);
    expect(caretInCode("> ```\n> [z](")).toBe(true);
    expect(caretInCode("- item\n\n    ```\n    [z](")).toBe(true);
  });

  test("an unclosed fence runs to the end", () => {
    expect([...codeBlockLines(["a", "```", "b", "c"])]).toEqual([1, 2, 3]);
  });

  test("an indented block after a blank line, but not a list's continuation", () => {
    const lines = [
      "para",
      "",
      "    code one",
      "\tcode two",
      "",
      "- item",
      "",
      "    still the item",
      "",
      "back",
      "    not code: no blank line before",
    ];
    expect([...codeBlockLines(lines)]).toEqual([2, 3, 4]);
  });
});

describe("inline code", () => {
  test("an open run with no close yet is code being written", () => {
    expect(inInlineCode("see `a ](")).toBe(true);
    expect(inInlineCode("see `a` and ](")).toBe(false);
    expect(inInlineCode("``a ` b`` then ](")).toBe(false);
    expect(inInlineCode("``a ` b ](")).toBe(true);
    expect(inInlineCode("an escaped \\` tick ](")).toBe(false);
  });
});

describe("the caret", () => {
  test("in a fence, an indented block or an inline span is in code; prose is not", () => {
    expect(caretInCode("text\n```\n[x](")).toBe(true);
    expect(caretInCode("text\n```\ncode\n```\n[x](")).toBe(false);
    expect(caretInCode("text\n\n    [x](")).toBe(true);
    expect(caretInCode("text `[x](")).toBe(true);
    expect(caretInCode("text [x](")).toBe(false);
  });
});

describe("removing code", () => {
  test("blocks become blank lines and inline spans vanish; prose stays", () => {
    expect(withoutCode("a `b` c\n```\nd\n```\ne")).toBe("a  c\n\n\n\ne");
    expect(withoutCode("p\n\n    q\nr")).toBe("p\n\n\nr");
  });
});
