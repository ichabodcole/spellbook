// One line of the conversation, rendered to static markup and read as cells.
// Agents answer in markdown, so the log renders it through the ONE renderer the
// surface allows, `lib/markdown.ts`. Its refusals therefore apply unchanged, and
// the cells below hold that they still do once the text is in the chat.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../workspace/protocol";
import { aboutLabel, ChatMessageView, linesLabel } from "./ChatMessageView.tsx";

const msg = (text: string, extra: Partial<Message> = {}): Message => ({
  id: "m1",
  from: "agent",
  type: "message",
  text,
  ts: "2026-09-30T10:00:00.000Z",
  ...extra,
});
const html = (m: Message, props: Partial<Parameters<typeof ChatMessageView>[0]> = {}) =>
  renderToStaticMarkup(<ChatMessageView message={m} {...props} />);

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
  test("it is styled as prose", () => {
    expect(html(msg("hi"))).toMatch(/class="md-prose"/);
  });
});

describe("the renderer's refusals still hold in chat", () => {
  test("a dangerous link keeps its words and loses its link", () => {
    const out = html(msg("[click](javascript:alert(1))"));
    expect(out).not.toContain("javascript:");
    expect(out).toContain("data-blocked-link");
    expect(out).toContain("click");
  });
  test("an embed is a placeholder that says images show in the document view", () => {
    const out = html(msg("Here: ![The fox](images/fox.png)"));
    expect(out).not.toContain("<img");
    expect(out).toContain('data-alt="The fox"');
    expect(out).toContain('data-embed-reason="Images show in the document view."');
  });
  test("raw HTML is text, never markup", () => {
    const out = html(msg('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">'));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("from and type drive how a line looks", () => {
  test("the human's messages render as markdown too, and read as theirs", () => {
    const out = html(msg("make this **louder**", { from: "human" }));
    expect(out).toContain("<strong>louder</strong>");
    expect(out).toContain('data-from="human"');
    expect(out).toContain("You");
  });
  test("plain text with stray * and _ still reads as the human wrote it", () => {
    const text = "rename snake_case_name, and 2 * 3 * 4 is 24; *maybe";
    expect(html(msg(text, { from: "human" }))).toContain(`<p>${text}</p>`);
  });
  test("an agent's line is labelled as the agent's", () => {
    const out = html(msg("hello"));
    expect(out).toContain('data-from="agent"');
    expect(out).toContain("Agent");
  });
  test("a system line stays plain text: the daemon wrote it, it is not markdown", () => {
    const out = html(msg("Agent moved **notes_v2**.md", { from: "system", type: "info" }));
    expect(out).toContain("Agent moved **notes_v2**.md");
    expect(out).not.toContain("<strong>");
    expect(out).not.toContain("md-prose");
    expect(out).toContain('data-from="system"');
  });
  test("an info line from anyone is plain text too", () => {
    const out = html(msg("Created v3 of *plan*", { from: "agent", type: "info" }));
    expect(out).not.toContain("<em>");
    expect(out).toContain('data-type="info"');
  });
  test("a result is the outcome of work: still markdown, and marked as one", () => {
    const out = html(msg("Rendered **4 cues**.", { type: "result" }));
    expect(out).toContain("<strong>4 cues</strong>");
    expect(out).toContain('data-type="result"');
    expect(out).toContain("result");
    expect(out).toContain("border-added");
  });
});

describe("what a message was about", () => {
  test("shows the document, the version and the lines, beside the rendered text", () => {
    const out = html(
      msg("can you answer **this** one?", {
        from: "human",
        about: {
          doc: "plan",
          version: 3,
          path: "/s/docs/plan/v3.md",
          fromLine: 4,
          toLine: 6,
          text: "the   passage\nitself",
        },
      }),
      { docName: (slug) => (slug === "plan" ? "Plan.md" : slug) },
    );
    expect(out).toContain("<strong>this</strong>");
    expect(out).toContain("Plan.md · v3 · lines 4–6");
    expect(out).toContain("the passage itself");
    expect(out).toContain('data-slot="about-chip"');
  });
  test("a message that names nothing draws no chip", () => {
    expect(html(msg("hi"))).not.toContain("about-chip");
    expect(html(msg("hi", { about: {} }))).not.toContain("about-chip");
  });
  test("labels read the way a human would say them", () => {
    const name = (s: string) => s;
    expect(linesLabel({ fromLine: 3, toLine: 3 })).toBe("line 3");
    expect(linesLabel({ fromLine: 3 })).toBe("line 3");
    expect(linesLabel({ fromLine: 3, toLine: 5 })).toBe("lines 3–5");
    expect(linesLabel({})).toBeNull();
    expect(aboutLabel({ doc: "a", version: 2 }, name)).toBe("a · v2");
    expect(aboutLabel({ doc: "a", noteId: "n1" }, name)).toBe("a · a note");
    expect(aboutLabel({}, name)).toBeNull();
  });
  test("an old message's pointed documents read as they did, though no new one carries them", () => {
    const name = (p: string) => p.split("/").pop() ?? p;
    expect(aboutLabel({ doc: "a", version: 1, docs: ["/w/b.md", "/w/c.md"] }, name)).toBe(
      "a · v1 · b, c",
    );
    const old = html(msg("these?", { from: "human", about: { docs: ["/w/b.md"] } }));
    expect(old).toContain("about-chip");
    expect(old).toContain("b");
  });
  test("refs read after the subject; a subject named by path only is named by it", () => {
    const name = (p: string) => p.split("/").pop() ?? p;
    expect(
      aboutLabel(
        { doc: "a", version: 2, refs: [{ path: "/w/b.md", label: "B" }, { path: "/w/c.md" }] },
        name,
      ),
    ).toBe("a · v2 · with B, c");
    const four = ["a", "b", "c", "d"].map((n) => ({ path: `/w/${n}.md` }));
    expect(aboutLabel({ refs: four }, name)).toBe("with 4 references");
    expect(aboutLabel({ path: "/w/fox.png", refs: [{ path: "/w/b.md" }] }, name)).toBe(
      "fox.png · with b",
    );
  });
});

// An app's own `about` parts (what its `hooks.messageAbout` added) are stored
// with the message; the chip names them only in the app's words. The fixture
// app's part is a `glance`: where the human was looking on its canvas.
describe("an app's own parts of what a message was about", () => {
  const name = (s: string) => s;
  const glance = (part: string, value: unknown) =>
    part === "glance" ? `at ${(value as { at: string }).at}` : null;
  test("are named in the app's words, after the kit's parts, in the order about holds them", () => {
    expect(
      aboutLabel(
        { doc: "a", version: 2, glance: { at: "the harbour" } } as never,
        name,
        undefined,
        glance,
      ),
    ).toBe("a · v2 · at the harbour");
    const two = (part: string) =>
      part === "zoom" ? "zoomed" : part === "glance" ? "glance" : null;
    expect(aboutLabel({ zoom: 2, glance: {} } as never, name, undefined, two)).toBe(
      "zoomed · glance",
    );
  });
  test("with no labeller, or a part the labeller declines, the chip shows the kit's parts only", () => {
    const about = { doc: "a", version: 1, glance: { at: "the harbour" }, other: 1 } as never;
    expect(aboutLabel(about, name)).toBe("a · v1");
    expect(aboutLabel(about, name, undefined, glance)).toBe("a · v1 · at the harbour");
    expect(aboutLabel({ other: 1 } as never, name, undefined, glance)).toBeNull();
    expect(html(msg("hi", { from: "human", about: { other: 1 } }))).not.toContain("about-chip");
  });
  test("a labeller is never handed a kit key, nor the retired entryIds", () => {
    const seen: string[] = [];
    const record = (part: string) => {
      seen.push(part);
      return null;
    };
    aboutLabel(
      {
        doc: "a",
        version: 1,
        path: "/p",
        fromLine: 1,
        toLine: 2,
        text: "t",
        noteId: "n",
        docs: ["/d"],
        refs: [{ path: "/r" }],
        entryIds: ["c1"],
        glance: 1,
      } as never,
      name,
      undefined,
      record,
    );
    expect(seen).toEqual(["glance"]);
  });
  test("a labeller that throws costs only its part", () => {
    const shaky = (part: string) => {
      if (part === "bad") throw new Error("no words");
      return part;
    };
    expect(aboutLabel({ bad: 1, good: 2 } as never, name, undefined, shaky)).toBe("good");
  });
  test("the message view passes aboutPart to the chip", () => {
    const out = html(
      msg("look here", { from: "human", about: { glance: { at: "the harbour" } } }),
      { aboutPart: glance },
    );
    expect(out).toContain('data-slot="about-chip"');
    expect(out).toContain("at the harbour");
  });
  test("an old message's entryIds restores without a chip of its own", () => {
    const old = msg("these?", { from: "human", about: { entryIds: ["c1", "c2"] } as never });
    expect(html(old)).not.toContain("about-chip");
    expect(html(old)).not.toContain("context item");
    expect(aboutLabel({ doc: "a", entryIds: ["c1"] } as never, name)).toBe("a");
  });
});

describe("the gesture a message came through", () => {
  test("a pressed button says so beside the speaker; the chat, and a message from before via, say nothing", () => {
    expect(html(msg("pace it", { from: "human", via: "pace" }))).toContain('data-slot="via"');
    expect(html(msg("pace it", { from: "human", via: "pace" }))).toContain("· pace");
    // An unknown value is shown as it was sent.
    expect(html(msg("x", { from: "human", via: "shiny" }))).toContain("· shiny");
    expect(html(msg("typed", { from: "human", via: "chat" }))).not.toContain('data-slot="via"');
    expect(html(msg("older", { from: "human" }))).not.toContain('data-slot="via"');
  });
});

describe("the waiting badge", () => {
  test("sits on the message it is about, pulsing only while working", () => {
    const working = html(msg("hi", { from: "human" }), { badge: "working" });
    expect(working).toContain('data-badge="working"');
    expect(working).toContain("animate-pulse");
    const stalled = html(msg("hi", { from: "human" }), { badge: "stalled" });
    expect(stalled).toContain('data-badge="stalled"');
    expect(stalled).not.toContain("animate-pulse");
    expect(stalled).toContain("may be stuck");
  });
  test("no badge, none drawn", () => {
    expect(html(msg("hi"), { badge: null })).not.toContain("data-badge");
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

describe("an app's own actions under a message", () => {
  test("what the app gives is drawn under the message, and nothing when it gives nothing", () => {
    const out = html(msg("I added two cards."), {
      actions: <button type="button">Review 2 changes</button>,
    });
    expect(out).toContain('data-slot="message-actions"');
    expect(out).toContain("Review 2 changes</button>");
    expect(out.indexOf("message-actions")).toBeGreaterThan(out.indexOf("I added two cards."));
    for (const none of [undefined, null, false])
      expect(html(msg("hi"), { actions: none })).not.toContain("message-actions");
  });
});
