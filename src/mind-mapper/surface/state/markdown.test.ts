import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  test("CommonMark structure renders — paragraphs, emphasis, lists, code", () => {
    const html = renderMarkdown("# Plan\n\nSome **bold** and `inline`.\n\n- one\n- two");
    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>inline</code>");
    expect(html).toContain("<li>one</li>");
  });

  test("fenced code blocks survive with content escaped", () => {
    const html = renderMarkdown("```\nconst a = 1 < 2;\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("1 &lt; 2");
  });

  test("raw HTML in the source is encoded, never emitted live (safe default)", () => {
    const html = renderMarkdown('hi <script>alert("x")</script> <b>there</b>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("links open in a new tab without an opener handle", () => {
    const html = renderMarkdown("[the map](https://example.com)");
    expect(html).toContain('<a target="_blank" rel="noopener" href="https://example.com">');
  });

  test("a literal '<a href=' in prose cannot ride the anchor post-pass", () => {
    // Encoded by micromark before the post-pass ever sees it.
    const html = renderMarkdown('type <a href="x"> to link');
    expect(html).not.toContain('<a target="_blank" rel="noopener" href="x"');
    expect(html).toContain("&lt;a href=");
  });

  test("plain multi-paragraph text becomes separate paragraphs", () => {
    const html = renderMarkdown("first thought\n\nsecond thought");
    expect(html).toBe("<p>first thought</p>\n<p>second thought</p>");
  });
});
