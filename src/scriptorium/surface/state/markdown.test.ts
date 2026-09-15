// The rendered view's rules, as cells rather than as something to eyeball.
// The security-relevant ones come first: this renderer's whole claim is that
// every tag it emits was minted by it.
import { describe, expect, test } from "bun:test";
import { renderMarkdown, safeHref } from "./markdown";

describe("raw HTML in a document is TEXT, never markup", () => {
  test("a script tag is encoded", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  test("an event handler on an img is encoded", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
  test("an inline style or iframe is encoded too", () => {
    expect(renderMarkdown("<iframe src=//evil></iframe>\n")).not.toContain("<iframe");
  });
});

describe("link targets", () => {
  test("http, https, mailto and relative targets are kept", () => {
    for (const href of ["https://x.dev", "http://x.dev", "mailto:a@b.c", "./other.md", "#anchor"])
      expect(safeHref(href)).toBe(href);
  });
  test("javascript: and data: are refused, however they are spelled", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      " javascript:alert(1)",
      "java&#9;script:alert(1)",
      "java&#x9script:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
    ])
      expect(safeHref(href)).toBeNull();
  });
  test("micromark itself refuses the scheme — MEASURED, and the reason safeHref is a second layer", () => {
    // `[a](javascript:…)` compiles to `<a href="">a</a>`: the renderer's own
    // protocol allowlist empties the target before this module sees it. The
    // cell is here so that a renderer change which DROPS that behaviour reds
    // something, rather than silently leaving safeHref as the only guard.
    for (const scheme of ["javascript:alert(1)", "data:text/html,x", "vbscript:x"]) {
      const html = renderMarkdown(`[click me](${scheme})\n`);
      expect(html).toContain("data-blocked-link"); // shown as refused, not as a live link
      expect(html).not.toContain('href=""');
      expect(html).not.toContain(scheme);
      expect(html).toContain("click me"); // the words survive either way
    }
  });
  test("a safe link survives rendering whole", () => {
    expect(renderMarkdown("[docs](https://x.dev/a?b=1&c=2)\n")).toContain(
      'href="https://x.dev/a?b=1&amp;c=2"',
    );
  });
});

describe("GFM, which is why the extension is carried at all", () => {
  test("tables render as tables", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
  });
  test("task lists render as checkboxes", () => {
    const html = renderMarkdown("- [x] done\n- [ ] not\n");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });
  test("strikethrough and autolinks", () => {
    expect(renderMarkdown("~~gone~~\n")).toContain("<del>");
    expect(renderMarkdown("see https://x.dev now\n")).toContain('href="https://x.dev"');
  });
});

describe("the ordinary shapes a document is made of", () => {
  test("headings, emphasis, code and quotes", () => {
    expect(renderMarkdown("# Title\n")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("*em* and **strong**\n")).toContain("<em>em</em>");
    expect(renderMarkdown("`x`\n")).toContain("<code>x</code>");
    expect(renderMarkdown("> quoted\n")).toContain("<blockquote>");
    expect(renderMarkdown("```js\nconst a = 1;\n```\n")).toContain("<pre>");
  });
  test("an empty document renders to nothing", () => {
    expect(renderMarkdown("").trim()).toBe("");
  });
});
