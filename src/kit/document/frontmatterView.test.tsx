// The rendered view with a frontmatter header, in a DOM: the header is drawn above
// the body and outside it, and a selection, a note's context menu and a note's
// highlight still resolve to the right WHOLE-TEXT offsets, in a document with a
// block and in the same document without one. Also the malformed block and the
// app's chip slot.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import type { PlacedNote } from "../workspace/protocol";
import type { SelectionReport } from "./DocumentView.tsx";
import type { FrontmatterChips } from "./FrontmatterHeader.tsx";
import { FLASH_PAINT_MS, MarkdownView } from "./MarkdownView.tsx";

/** The CSS Custom Highlight API, which happy-dom lacks: a registry the test can read. */
class FakeHighlight extends Set<Range> {
  /** Set-like, as the real one is: the kit adds ranges one at a time. */
  get ranges(): Range[] {
    return [...this];
  }
}
const highlights = new Map<string, FakeHighlight>();
let ownCss: PropertyDescriptor | undefined;

beforeAll(() => {
  installDom();
  ownCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    value: { highlights },
    configurable: true,
    writable: true,
  });
  (globalThis as Record<string, unknown>).Highlight = FakeHighlight;
});
afterEach(async () => {
  await cleanup();
  highlights.clear();
});
afterAll(async () => {
  if (ownCss) Object.defineProperty(globalThis, "CSS", ownCss);
  else delete (globalThis as Record<string, unknown>).CSS;
  delete (globalThis as Record<string, unknown>).Highlight;
  // Awaited: the next file's installDom is a no-op while the DOM is still registered.
  await removeDom();
});

const FM = [
  "---",
  "type: feature",
  "description: Where worlds are made.",
  "status: draft",
  "lifecycle: ready",
  "tags: [kit, atlas]",
  "generated: { by: an agent, at: 2026-10-01 }",
  "world_role: capital",
  "---",
  "",
].join("\n");
const BODY = "# The atlas\n\nMaren's **bakery** opens at dawn.\n\n- one\n- two three\n";

/** The text node under `root` holding `word`, and the word's offset in it. */
function find(root: Element, word: string): { node: Text; at: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const at = (n as Text).data.indexOf(word);
    if (at !== -1) return { node: n as Text, at };
  }
  throw new Error(`"${word}" is not rendered`);
}

/** Select from the start of `a` to the end of `b` in the rendered body. */
async function select(root: Element, a: string, b: string): Promise<void> {
  const s = find(root, a);
  const e = find(root, b);
  const range = document.createRange();
  range.setStart(s.node, s.at);
  range.setEnd(e.node, e.at + b.length);
  await settle(() => {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function body(container: Element): Element {
  const el = container.querySelector(".md-prose");
  if (!el) throw new Error("no rendered body");
  return el;
}

for (const [name, text] of [
  ["with a frontmatter block", FM + BODY],
  ["without one", BODY],
] as const) {
  describe(`selection and notes, ${name}`, () => {
    test("a selection reports the whole-text offsets of what was selected", async () => {
      const reports: SelectionReport[] = [];
      const m = await mount(<MarkdownView text={text} onSelect={(s) => reports.push(s)} />);
      await select(body(m.container), "bakery", "bakery");
      const last = reports.at(-1);
      expect(last?.text).toBe("bakery");
      expect(last?.from).toBe(text.indexOf("bakery"));
      expect(last?.fromLine).toBe(text.slice(0, text.indexOf("bakery")).split("\n").length);

      await select(body(m.container), "opens", "two");
      expect(reports.at(-1)?.text).toBe("opens at dawn.\n\n- one\n- two");
    });

    test("a context menu over a selection offers a note on that passage", async () => {
      const menus: { from: number; to: number }[] = [];
      const m = await mount(
        <MarkdownView
          text={text}
          onSelect={() => {}}
          onContextMenu={(at) => {
            menus.push(at);
            return true;
          }}
        />,
      );
      await select(body(m.container), "dawn", "dawn");
      await settle(() => {
        body(m.container).dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
      });
      const at = menus.at(-1);
      expect(at && text.slice(at.from, at.to)).toBe("dawn");
    });

    test("a note is painted over its own words", async () => {
      const from = text.indexOf("two three");
      const note: PlacedNote = {
        id: "n1",
        quote: "two three",
        from,
        to: from + "two three".length,
      } as PlacedNote;
      await mount(<MarkdownView text={text} notes={[note]} />);
      const hl = highlights.get("doc-note");
      expect(hl?.ranges.map((r) => r.toString())).toEqual(["two three"]);
    });
  });
}

describe("the header", () => {
  test("chips, the description, tags and the other keys, outside the rendered body", async () => {
    const m = await mount(<MarkdownView text={FM + BODY} />);
    const header = m.container.querySelector("[data-slot=frontmatter-header]");
    expect(header).not.toBeNull();
    expect(body(m.container).contains(header)).toBe(false);
    const chips = [...(header?.querySelectorAll("[data-chip], span.inline-flex") ?? [])].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["feature", "draft", "ready", "2026-10-01", "#kit", "#atlas"]);
    expect(header?.querySelector("[data-chip=status]")?.className).toContain("text-attention");
    expect(header?.querySelector("p")?.textContent).toBe("Where worlds are made.");
    const listed = [...(header?.querySelectorAll("dt") ?? [])].map((d) => d.textContent);
    expect(listed).toEqual(["generated", "world_role"]);
    // The date is a chip, so the generated row keeps only who.
    expect(header?.querySelector("dd")?.textContent).toBe("by: an agent");
    // The body starts at its heading: nothing of the block is rendered text.
    expect(body(m.container).textContent?.startsWith("The atlas")).toBe(true);
  });

  test("the trust chip shows only for a document with verified, and the option turns it off", async () => {
    const verified = FM.replace("world_role", "verified: [{ by: 'human:someone' }]\nworld_role");
    const on = await mount(<MarkdownView text={verified + BODY} />);
    const chip = on.container.querySelector("[data-chip=verified]");
    expect(chip?.textContent).toBe("human-reviewed");
    await cleanup();

    const unsaid = await mount(<MarkdownView text={FM + BODY} />);
    expect(unsaid.container.querySelector("[data-chip=verified]")).toBeNull();
    expect(unsaid.container.textContent).not.toContain("unverified");
    await cleanup();

    const off = await mount(<MarkdownView text={verified + BODY} frontmatterTrust={false} />);
    const header = off.container.querySelector("[data-slot=frontmatter-header]");
    expect(header?.querySelector("[data-chip=verified]")).toBeNull();
    // Off, the key is just another field: listed, not judged.
    const listed = [...(header?.querySelectorAll("dt") ?? [])].map((d) => d.textContent);
    expect(listed).toContain("verified");
  });

  test("a generated mapping with only its date loses its row to the date chip", async () => {
    const m = await mount(
      <MarkdownView text={"---\ngenerated: { at: 2026-10-01 }\n---\nBody.\n"} />,
    );
    const header = m.container.querySelector("[data-slot=frontmatter-header]");
    expect(header?.querySelector("dl")).toBeNull();
    expect(header?.querySelector('[data-chip="generated.at"]')?.textContent).toBe("2026-10-01");
  });

  test("prose between two rules at the top is markdown, not a header", async () => {
    const m = await mount(<MarkdownView text={"---\nOnce upon a time.\n---\n\nThe tale."} />);
    expect(m.container.querySelector("[data-slot=frontmatter-header]")).toBeNull();
    expect(body(m.container).textContent).toContain("Once upon a time.");
  });

  test("a document without a block has no header and keeps the body's own padding", async () => {
    const m = await mount(<MarkdownView text={BODY} />);
    expect(m.container.querySelector("[data-slot=frontmatter-header]")).toBeNull();
    expect(body(m.container).className).toBe(
      "md-prose md-document mx-auto max-w-[76ch] px-8 pt-7 pb-16",
    );
  });

  test("a malformed block shows as written, with a quiet warning, above the body", async () => {
    const raw = "type: [unclosed\nstatus: draft";
    const m = await mount(<MarkdownView text={`---\n${raw}\n---\n${BODY}`} />);
    const header = m.container.querySelector("[data-slot=frontmatter-header]");
    expect(header?.hasAttribute("data-invalid")).toBe(true);
    expect(header?.querySelector("pre")?.textContent).toBe(raw);
    expect(header?.textContent).toContain("could not be read");
    expect(body(m.container).textContent?.startsWith("The atlas")).toBe(true);
  });

  test("an app's chip slot adds, restyles and drops chips, and claims its keys", async () => {
    const chips: FrontmatterChips = (fields, base) => [
      ...base
        .filter((c) => c.key !== "verified")
        .map((c) => (c.key === "status" ? { ...c, tone: "none" as const, className: "mine" } : c)),
      { key: "world_role", label: `role: ${String(fields.world_role)}`, tone: "brand" },
    ];
    const m = await mount(<MarkdownView text={FM + BODY} frontmatterChips={chips} />);
    const header = m.container.querySelector("[data-slot=frontmatter-header]");
    expect(header?.querySelector("[data-chip=verified]")).toBeNull();
    expect(header?.querySelector("[data-chip=status]")?.className).toContain("mine");
    expect(header?.querySelector("[data-chip=status]")?.className).not.toContain("attention");
    expect(header?.querySelector("[data-chip=world_role]")?.textContent).toBe("role: capital");
    const listed = [...(header?.querySelectorAll("dt") ?? [])].map((d) => d.textContent);
    expect(listed).toEqual(["generated"]);
  });

  // kit-reveal-frontmatter-and-selection: a broken `related:` reference opened at
  // its place marked nothing, since the block is drawn as this header, not as text.
  test("a reveal in the block marks the field it is in, not the body", async () => {
    const DOC = FM + BODY;
    const flash = (word: string, seq: number) => ({
      from: DOC.indexOf(word),
      to: DOC.indexOf(word) + word.length,
      seq,
    });
    const marked = (c: HTMLElement) =>
      [...c.querySelectorAll('[data-flash="on"]')].map(
        (e) => `${e.tagName.toLowerCase()}:${e.textContent}`,
      );
    const m = await mount(<MarkdownView text={DOC} flash={flash("capital", 1)} />);
    expect(marked(m.container)).toEqual(["dt:world_role", "dd:capital"]);
    expect(highlights.has("doc-flash")).toBe(false);
    // A key a chip shows; a key split between a dotted chip and its row, both.
    await m.render(<MarkdownView text={DOC} flash={flash("draft", 2)} />);
    expect(marked(m.container)).toEqual(["span:draft"]);
    await m.render(<MarkdownView text={DOC} flash={flash("2026-10-01", 3)} />);
    expect(marked(m.container)).toEqual(["span:2026-10-01", "dt:generated", "dd:by: an agent"]);
    // On a delimiter, the header itself.
    await m.render(<MarkdownView text={DOC} flash={{ from: 0, to: 3, seq: 4 }} />);
    expect(m.container.querySelector('[data-flash="on"]')?.getAttribute("data-slot")).toBe(
      "frontmatter-header",
    );
    // In the body, the text is painted as before and the header is left alone.
    await m.render(<MarkdownView text={DOC} flash={flash("bakery", 5)} />);
    expect(marked(m.container)).toEqual([]);
    expect(highlights.get("doc-flash")?.ranges[0]?.toString()).toBe("bakery");
    await m.unmount();
  });

  test("the frontmatter mark goes when its moment is up", async () => {
    const DOC = FM + BODY;
    const at = DOC.indexOf("capital");
    const m = await mount(<MarkdownView text={DOC} flash={{ from: at, to: at + 7, seq: 1 }} />);
    expect(m.container.querySelectorAll('[data-flash="on"]').length).toBe(2);
    await settle(() => new Promise((r) => setTimeout(r, FLASH_PAINT_MS + 100)));
    expect(m.container.querySelectorAll("[data-flash]").length).toBe(0);
    await m.unmount();
  });
});
