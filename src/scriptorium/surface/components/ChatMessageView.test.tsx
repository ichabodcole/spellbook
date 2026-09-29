// One line of the conversation, rendered to static markup and read as cells.
// Agents answer in markdown, so the log renders it (item chat-renders-markdown,
// rendered only — Cole's ruling) through the ONE renderer the surface allows,
// `state/markdown.ts`. Its refusals therefore apply unchanged, and the cells
// below hold that they still do once the text is in the chat.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "../../backend/protocol";
import { ChatMessageView } from "./ChatMessageView";

const msg = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  who: "agent",
  text,
  ts: 0,
  ...extra,
});
const html = (m: ChatMessage) => renderToStaticMarkup(<ChatMessageView message={m} />);

describe("an agent's reply renders as markdown", () => {
  test("headings, emphasis and lists", () => {
    const out = html(msg("## Plan\n\nThis is **bold**.\n\n- one\n- two\n\n1. first\n"));
    expect(out).toContain("<h2>Plan</h2>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<ul>\n<li>one</li>");
    expect(out).toContain("<ol>");
    expect(out).not.toContain("**");
  });
  test("inline code and fenced code blocks", () => {
    const out = html(msg("Run `bun test`.\n\n```ts\nconst a = 1;\n```\n"));
    expect(out).toContain("<code>bun test</code>");
    expect(out).toContain('<pre><code class="language-ts">const a = 1;');
  });
  test("links keep their target", () => {
    const out = html(msg("See [the docs](https://x.dev/docs) and [a note](./notes.md)."));
    expect(out).toContain('<a href="https://x.dev/docs">the docs</a>');
    expect(out).toContain('<a href="./notes.md">a note</a>');
  });
  test("GFM tables", () => {
    const out = html(msg("| a | b |\n| - | - |\n| 1 | 2 |\n"));
    expect(out).toContain("<table>");
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<td>2</td>");
  });
  test("it is styled as prose, in the compact chat variant", () => {
    const out = html(msg("hi"));
    expect(out).toMatch(/class="[^"]*\bmd-prose\b[^"]*\bmd-chat\b/);
  });
});

describe("the renderer's refusals still hold in chat", () => {
  test("a dangerous link keeps its words and loses its link", () => {
    const out = html(msg("[click](javascript:alert(1))"));
    expect(out).not.toContain("javascript:");
    expect(out).toContain("data-blocked-link");
    expect(out).toContain("click");
  });
  test("raw HTML is text, never markup", () => {
    const out = html(msg('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">'));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("the human's messages", () => {
  test("render as markdown too", () => {
    const out = html(msg("make this **louder**", { who: "human" }));
    expect(out).toContain("<strong>louder</strong>");
  });
  test("plain text with stray * and _ still reads as the human wrote it", () => {
    const text = "rename snake_case_name, and 2 * 3 * 4 is 24; *maybe";
    const out = html(msg(text, { who: "human" }));
    expect(out).toContain(`<p>${text}</p>`);
  });
});

describe("a system line", () => {
  test("stays plain text — the daemon wrote it, it is not markdown", () => {
    const out = html(msg("Agent moved **notes_v2**.md", { who: "system" }));
    expect(out).toContain("Agent moved **notes_v2**.md");
    expect(out).not.toContain("<strong>");
    expect(out).not.toContain("md-prose");
  });
});

describe("the passage a message carried (E48)", () => {
  test("still shows beside the rendered text", () => {
    const out = html(
      msg("can you answer **this** one?", {
        who: "human",
        selection: {
          doc: "plan",
          version: 3,
          path: "docs/plan.md",
          fromLine: 4,
          toLine: 6,
          text: "the   passage\nitself",
        },
      }),
    );
    expect(out).toContain("<strong>this</strong>");
    expect(out).toContain("plan · v3 · lines 4–6");
    expect(out).toContain("the passage itself");
  });
});

// Every message is rendered into the same page, so a footnote's ids have to be
// the MESSAGE's, or two replies with a `[^1]` each put two elements under one
// id and a jump from the second can land in the first.
describe("footnotes in chat", () => {
  const FN = "Text[^1].\n\n[^1]: a note\n";
  const ids = (out: string) => [...out.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
  test("two messages with footnotes share no id", () => {
    const a = ids(html(msg(FN, { id: "m-a1b2" })));
    const b = ids(html(msg(FN, { id: "m-c3d4" })));
    expect(a.length).toBeGreaterThan(0);
    for (const id of a) expect(b).not.toContain(id);
  });
  test("each message's fragment links point inside that message", () => {
    const out = html(msg(FN, { id: "m-c3d4" }));
    const own = ids(out);
    const frags = [...out.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
    expect(frags.length).toBe(2);
    for (const f of frags) expect(own).toContain(f);
  });
});
