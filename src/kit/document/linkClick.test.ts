// Which link a Mod-click in the raw editor lands on (kit-heading-links-build):
// read from the clicked line, in the shapes the link layer reads.
import { describe, expect, test } from "bun:test";
import { linkAt } from "./linkClick.ts";

const LINE =
  "See [the *Arcturus* entry](./touchstones.md?rel=grounded-in#A%20Voyage) and [[the-glade#Paths|the Glade]], or https://example.com/x.";

describe("the link under the pointer", () => {
  test("a markdown link, anywhere on it, gives its target as written", () => {
    const at = LINE.indexOf("Arcturus");
    expect(linkAt(LINE, at)).toEqual({
      href: "./touchstones.md?rel=grounded-in#A%20Voyage",
      from: LINE.indexOf("[the"),
      to: LINE.indexOf(") and") + 1,
    });
    expect(linkAt(LINE, LINE.indexOf("grounded-in"))?.href).toBe(
      "./touchstones.md?rel=grounded-in#A%20Voyage",
    );
  });

  test("a wiki link gives its name, heading and all, not its label", () => {
    expect(linkAt(LINE, LINE.indexOf("the Glade"))?.href).toBe("the-glade#Paths");
  });

  test("a bare web address is a link", () => {
    expect(linkAt(LINE, LINE.indexOf("example"))?.href).toBe("https://example.com/x.");
  });

  test("an angle-bracket target, an image, a fragment, and escapes undone", () => {
    expect(linkAt("[x](<a b.md#The lens>)", 1)?.href).toBe("a b.md#The lens");
    expect(linkAt("![fox](./images/fox.png)", 2)?.href).toBe("./images/fox.png");
    expect(linkAt("[up](#Stacking%20lenses)", 1)?.href).toBe("#Stacking%20lenses");
    expect(linkAt("[x](a\\(1\\).md)", 1)?.href).toBe("a(1).md");
  });

  test("text that is not a link is nothing", () => {
    expect(linkAt(LINE, 1)).toBeNull();
    expect(linkAt("[not a link] (x.md)", 2)).toBeNull();
    expect(linkAt("[empty]()", 2)).toBeNull();
  });
});
