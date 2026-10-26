// The rendered view's rules, as cells rather than as something to eyeball.
// The security-relevant ones come first: this renderer's whole claim is that
// every tag it emits was minted by it.
import { describe, expect, test } from "bun:test";
import {
  EMBED_BLOCKED,
  EMBED_IN_CHAT,
  EMBED_REMOTE,
  EMBED_SVG,
  renderMarkdown,
  safeHref,
} from "./markdown";
import { codeParses } from "./markdownCode";

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

describe("embeds: no <img> leaves the renderer, so nothing is fetched", () => {
  const spanOf = (md: string) => {
    const html = renderMarkdown(md);
    expect(html).not.toContain("<img");
    const m = html.match(/<span class="md-embed"[^>]*><\/span>/);
    if (!m) throw new Error(`no embed in ${html}`);
    const attr = (name: string) => m[0].match(new RegExp(` ${name}="([^"]*)"`))?.[1];
    return {
      target: attr("data-embed"),
      alt: attr("data-alt"),
      state: attr("data-embed-state"),
      reason: attr("data-embed-reason"),
      label: attr("aria-label"),
    };
  };
  test("a path is a pending placeholder carrying its target and alt text", () => {
    expect(spanOf("![The fox](images/fox.png?rel=sourced-from)")).toEqual({
      target: "images/fox.png?rel=sourced-from",
      alt: "The fox",
      state: "pending",
      reason: undefined,
      label: "The fox",
    });
    // Encoded as micromark encodes a link's href, so it resolves the same way.
    expect(spanOf("![x](<my fox.png>)").target).toBe("my%20fox.png");
  });
  test("a remote image is never loaded, and says so", () => {
    expect(spanOf("![Far](https://example.com/a.png)")).toMatchObject({
      state: "remote",
      reason: EMBED_REMOTE,
    });
  });
  test("an SVG is refused, as the tree refuses one", () => {
    expect(spanOf("![Logo](logo.svg)")).toMatchObject({ state: "svg", reason: EMBED_SVG });
  });
  test("a refused scheme is a placeholder, never a src", () => {
    expect(spanOf("![x](javascript:alert(1))")).toMatchObject({
      state: "blocked",
      reason: EMBED_BLOCKED,
    });
    expect(spanOf("![x](data:image/png;base64,AAAA)").state).toBe("blocked");
  });
  test("alt text cannot break out of its attribute", () => {
    const html = renderMarkdown('![a" onerror="alert(1)](x.png)');
    expect(html).not.toContain('" onerror="');
    expect(html).toContain("&quot;");
  });
  test("where nothing resolves an embed (the chat), its placeholder can say so", () => {
    expect(spanOf("![The fox](fox.png)").reason).toBeUndefined();
    const chat = renderMarkdown("![The fox](fox.png)", { embedReason: EMBED_IN_CHAT });
    expect(chat).toContain(`data-embed-reason="${EMBED_IN_CHAT}"`);
    // A remote image keeps its own reason.
    expect(renderMarkdown("![x](https://e.com/a.png)", { embedReason: EMBED_IN_CHAT })).toContain(
      EMBED_REMOTE,
    );
  });

  test("a document without embeds renders exactly as before", () => {
    expect(renderMarkdown("# A\n\n[link](b.md) and *text*\n")).toBe(
      '<h1>A</h1>\n<p><a href="b.md">link</a> and <em>text</em></p>\n',
    );
  });
});

describe("link targets", () => {
  test("http, https, mailto and relative targets are kept", () => {
    for (const href of ["https://x.dev", "http://x.dev", "mailto:a@b.c", "./other.md", "#anchor"])
      expect(safeHref(href)).toBe(href);
  });
  test("javascript: and data: are refused, however they are written", () => {
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
  test("a colon before a bare document name is a file, not a scheme, as the link check reads it", () => {
    for (const href of ["Chapter2:intro.md", "Chapter2:intro.md?rel=x", "Notes:a.txt"])
      expect(safeHref(href)).toBe(href);
    // Real schemes stay refused, even dressed as a document's name.
    for (const href of [
      "javascript:alert(1).md",
      "java\tscript:x.md",
      "data:x.md",
      "vbscript:x.md",
      "op:doc/x.md",
      "chapter2:sub/intro.md",
    ])
      expect(safeHref(href)).toBeNull();
  });
  test("such a link renders live, not struck through, with the words as written", () => {
    const html = renderMarkdown("See [the intro](Chapter2:intro.md?rel=x).\n");
    expect(html).not.toContain("data-blocked-link");
    expect(html).toContain('href="Chapter2%3Aintro.md?rel=x"');
    expect(html).toContain(">the intro</a>");
    // In code it is text, and stays exactly as written.
    expect(renderMarkdown("`[a](Chapter2:intro.md)`\n")).toContain("[a](Chapter2:intro.md)");
    // And `javascript:` dressed the same way is still refused.
    expect(renderMarkdown("[x](javascript:alert(1).md)\n")).toContain("data-blocked-link");
  });
  test("⚠ only a text with such a link pays for a second parse", () => {
    // The common case: colons, schemes and code, but no link to a colon file.
    const before = codeParses();
    renderMarkdown("Note: see [docs](https://x.dev) and `a: b`.\n\n    code: here\n");
    renderMarkdown("[a](./a.md) at 10:30, [m](mailto:a@b.c), [op](op:doc/1)\n");
    expect(codeParses()).toBe(before);
    expect(renderMarkdown("`x` [i](Chapter2:intro.md)\n")).toContain('href="Chapter2%3Aintro.md"');
    expect(codeParses()).toBe(before + 1);
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

/**
 * The chat log renders through this same function,
 * so it must fit a short FRAGMENT as well as a document: no frontmatter split
 * inside it (that is MarkdownView's step, not the renderer's), and no heading
 * anchors that would collide between messages. GFM footnotes are the one
 * thing that mints ids, and the caller scopes those (`idPrefix`, below).
 */
describe("a short fragment, as the chat sends it", () => {
  test("one line is one paragraph and nothing else", () => {
    expect(renderMarkdown("ok")).toBe("<p>ok</p>");
  });
  test("headings carry no ids to collide between messages", () => {
    expect(renderMarkdown("## Plan")).toBe("<h2>Plan</h2>");
  });
  test("the renderer does not split frontmatter itself", () => {
    const out = renderMarkdown("---\na: b\n---\nbody");
    expect(out).toContain("<p>body</p>");
    expect(out).toContain("<hr />");
  });
});

// GFM footnotes mint ids (`user-content-fn-1`, `footnote-label`) and fragment
// links to them. One rendered document has one set, but the chat log renders
// every message into the SAME page, so two messages with a `[^1]` each made two
// elements with one id. `idPrefix` scopes a render's ids to its caller's key.
describe("footnote ids, scoped by the caller", () => {
  const FN = "Text[^1].\n\n[^1]: a note\n";
  const ids = (html: string) => [...html.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
  const fragments = (html: string) => [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);

  test("with no prefix, the renderer's own ids are unchanged", () => {
    const html = renderMarkdown(FN);
    expect(html).toContain('id="user-content-fnref-1"');
    expect(html).toContain('href="#user-content-fn-1"');
  });
  test("every id carries the prefix, and every fragment link points at one of them", () => {
    const html = renderMarkdown(FN, { idPrefix: "m-ab12" });
    const all = ids(html);
    expect(all.length).toBe(3); // the ref, the footnote, the label
    for (const id of all) expect(id).toContain("m-ab12");
    const frags = fragments(html);
    expect(frags.length).toBe(2); // ref → footnote, back-ref → ref
    for (const f of frags) expect(all).toContain(f);
  });
  test("the label the ref is described by moves with its id", () => {
    const html = renderMarkdown(FN, { idPrefix: "m-ab12" });
    const described = /aria-describedby="([^"]*)"/.exec(html)?.[1];
    expect(described).toBeDefined();
    expect(ids(html)).toContain(described);
  });
  test("two renders with different prefixes share no id", () => {
    const a = ids(renderMarkdown(FN, { idPrefix: "m-a1b2" }));
    const b = ids(renderMarkdown(FN, { idPrefix: "m-c3d4" }));
    for (const id of a) expect(b).not.toContain(id);
  });
  test("a prefix cannot break out of the attribute it is written into", () => {
    const html = renderMarkdown(FN, { idPrefix: 'x" onmouseover="alert(1)' });
    expect(html).not.toContain("onmouseover=");
    expect(html).not.toContain('x"');
  });
});
