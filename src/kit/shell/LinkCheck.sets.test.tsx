// The link check grouped by set (kit-broken-links-visible), in the real shell
// over a real daemon with an app's edges: a broken body link, a broken
// frontmatter `related:`, an unresolved one (not a path, so not counted), and
// links to files the session does not hold. The mark says exactly
// what the agent's `link-check` answers for the same session, the list groups
// it by set, and each entry opens its source at the link.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useDaemon } from "../context/useDaemon.ts";
import { useWorkspace } from "../context/workspace.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { cmd } from "../workspace/fixtures/harness";
import type { AppEdge, LinkSlot } from "../workspace/linkEdges";
import type { LinkCheck as LinkCheckData } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import {
  LINK_CHECK_PAUSE_MS,
  LinkCheck,
  LinkCheckList,
  linkCheckGroups,
  linkCheckLabel,
  linkCheckListed,
  linkCheckQuietLabel,
  linkCheckQuietWord,
  linkCheckTotal,
} from "./LinkCheck.tsx";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

/** `related:` names are edges of kind `frontmatter`, as Scriptorium reads them. */
const related: NonNullable<LinkSlot["edges"]> = ({ frontmatter }) => {
  const list = frontmatter?.related;
  return Array.isArray(list)
    ? list.map((t): AppEdge => ({ kind: "frontmatter", target: String(t), key: "related" }))
    : [];
};

const NOTES = [
  "---",
  "title: Notes",
  "related: [./ghost.md, ../lore/myth.md, feature/some-slug]",
  "---",
  "# Notes",
  "",
  "See [the cave](./cave.md), [the myth](../lore/myth.md) and [solo](../solo.md).",
  "",
].join("\n");
const MYTH = "# The Myth\n\nBack to [A](../set/a.md), beside [the sibling](../sibling.md).\n";
const SETTLE = LINK_CHECK_PAUSE_MS + 3000;

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;

beforeEach(async () => {
  root = tempRoot("shell-link-sets");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  mkdirSync(join(docs, "lore"), { recursive: true });
  writeFileSync(join(docs, "set", "notes.md"), NOTES);
  writeFileSync(join(docs, "lore", "myth.md"), MYTH);
  localStorage.clear();
  // As Scriptorium declares it: leaving links on, in its word.
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    links: { edges: related },
    linkCheck: { leaving: true, noun: "set" },
  });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Probe() {
  const w = useWorkspace();
  return (
    <p data-testid="probe">
      {JSON.stringify({
        open: w.openDoc?.original ?? null,
        reveal: w.reveal ? { from: w.reveal.from, to: w.reveal.to } : null,
      })}
    </p>
  );
}

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<Probe />} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const probe = () => JSON.parse(q('[data-testid="probe"]')?.textContent ?? "{}");
const mark = () => q('[data-slot="link-check"]') as HTMLElement | null;
const click = (el: HTMLElement) =>
  settle(() => {
    el.click();
  });

async function addSets(): Promise<void> {
  const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  ws.send(JSON.stringify({ op: "context.add", path: join(docs, "set") }));
  ws.send(JSON.stringify({ op: "context.add", path: join(docs, "lore") }));
  await Bun.sleep(80);
  ws.close();
}

describe("the mark against the agent's link-check", () => {
  test("says what link-check says, grouped by set, each entry opening at its line", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    await addSets();
    await waitFor(
      () => (mark()?.getAttribute("aria-label") ?? "").includes("broken frontmatter"),
      "the mark",
      SETTLE,
    );

    // What the agent's `link-check` verb posts, for the same session.
    const asked = await cmd(daemon.url, { op: "link.check" });
    expect(asked.status).toBe(200);
    const { ok: _ok, ...verb } = asked.body as unknown as LinkCheckData & { ok: true };
    expect(verb.dangling.count).toBe(1);
    expect(verb.edges?.count).toBe(1);
    expect(verb.unresolved?.links.map((e) => e.raw)).toEqual(["feature/some-slug"]);
    // Links to another set's document stay inside the session: only the two
    // to files no set holds leave.
    expect(verb.leaving?.count).toBe(2);
    expect(verb.count).toBe(2);

    expect(mark()?.getAttribute("aria-label")).toBe(`Link check: ${linkCheckLabel(verb)}`);
    // Only what is broken heads the sign: leaving is listed, never counted (Cole, 2026-10-23).
    expect(linkCheckLabel(verb)).toBe("1 broken link, 1 broken frontmatter reference");
    expect(q('[data-slot="link-check-total"]')?.textContent).toBe(String(linkCheckTotal(verb)));
    // Neither the unresolved reference nor the two leaving links are in the sign's count.
    expect(linkCheckTotal(verb)).toBe(2);
    expect(linkCheckListed(verb)).toBe(5);
    expect(mark()?.hasAttribute("data-quiet")).toBe(false);

    // The list: grouped by set, in the context's order, adding up to the mark.
    await click(mark() as HTMLElement);
    await waitFor(() => qa('[data-slot="link-check-set"]').length === 3, "the groups");
    const sets = qa('[data-slot="link-check-set"]');
    // Counted first (Cole, 2026-10-23): the set with something broken, then
    // each set's listed-not-counted part, set by set, under no number.
    expect(sets.map((x) => [x.getAttribute("aria-label"), x.dataset.part])).toEqual([
      ["In set", "counted"],
      ["In set, listed, not counted", "quiet"],
      ["In lore, listed, not counted", "quiet"],
    ]);
    const totals = sets.map((x) => x.querySelector('[data-slot="set-total"]')?.textContent ?? null);
    expect(totals).toEqual(["2", null, null]);
    // The headers add up to the sign: the unresolved reference and the leaving links are listed, not counted.
    expect(totals.reduce((a, b) => a + Number(b ?? 0), 0)).toBe(linkCheckTotal(verb));
    // Listed under their own heading, quieter than the broken ones.
    const leavingHeads = qa('[data-slot="link-check-section"][aria-label="Leaving the set"]');
    expect(leavingHeads).toHaveLength(2);
    expect(leavingHeads.every((x) => x.hasAttribute("data-quiet"))).toBe(true);
    expect(
      q('[data-slot="link-check-section"][aria-label="Broken links"]')?.hasAttribute("data-quiet"),
    ).toBe(false);
    const sections = (x: HTMLElement) =>
      [...x.querySelectorAll('[data-slot="link-check-section"]')].map((s) =>
        s.getAttribute("aria-label"),
      );
    expect(sections(sets[0] as HTMLElement)).toEqual([
      "Broken links",
      "Broken frontmatter references",
    ]);
    expect(sections(sets[1] as HTMLElement)).toEqual(["Unresolved references", "Leaving the set"]);
    expect(sections(sets[2] as HTMLElement)).toEqual(["Leaving the set"]);
    expect(sets[2]?.textContent).toContain("lands outside every set: ../sibling.md");
    // Every counted entry comes before every listed one in the list.
    const entries = qa('[data-slot="link-check-entry"]');
    const lastCounted = entries.findLastIndex(
      (e) => !e.hasAttribute("data-leaving") && !e.hasAttribute("data-unresolved"),
    );
    const firstQuiet = entries.findIndex(
      (e) => e.hasAttribute("data-leaving") || e.hasAttribute("data-unresolved"),
    );
    expect(lastCounted).toBeLessThan(firstQuiet);
    // An unresolved reference says nothing of where it looked: it was never a path.
    const unresolved = qa("[data-unresolved]");
    expect(unresolved.map((e) => e.querySelector('[data-slot="raw"]')?.textContent)).toEqual([
      "related: feature/some-slug",
    ]);
    expect(unresolved[0]?.textContent).not.toContain("nothing at");

    // The broken `related:` opens at its line, on the reference itself.
    const ref = qa('[data-edge="frontmatter"]')[0] as HTMLElement;
    expect(ref.getAttribute("data-line")).toBe("3");
    await click(ref);
    await waitFor(
      () => probe().open === join(docs, "set", "notes.md") && probe().reveal !== null,
      "notes.md open at the reference",
    );
    expect(NOTES.slice(probe().reveal.from, probe().reveal.to)).toBe("./ghost.md");

    // A link leaving the set opens at the link.
    await click(mark() as HTMLElement);
    await waitFor(() => qa("[data-leaving]").length === 2, "the list again");
    const out = qa("[data-leaving]").find(
      (e) => e.getAttribute("data-source") === join(docs, "lore", "myth.md"),
    ) as HTMLElement;
    await click(out);
    await waitFor(
      () => probe().open === join(docs, "lore", "myth.md") && probe().reveal !== null,
      "myth.md open at the link",
    );
    expect(MYTH.slice(probe().reveal.from, probe().reveal.to)).toBe("[the sibling](../sibling.md)");
    await m.unmount();
  }, 25_000);
});

describe("grouping, alone", () => {
  const base: LinkCheckData = {
    count: 0,
    dangling: { count: 0, links: [] },
    unsupported: { count: 0, schemes: [], links: [] },
    duplicates: { count: 0, names: [] },
    unusedImages: { count: 0, images: [] },
    symmetry: { count: 0, hints: [] },
    headings: { count: 0, links: [] },
    ambiguousHeadings: { count: 0, hints: [] },
    references: { count: 0, links: [] },
  };
  const leaving = (source: string, set?: string) => ({
    source,
    name: "x.md",
    shown: "x.md",
    raw: "../y.md",
    target: "/y.md",
    targetShown: "../y.md",
    ...(set ? { set } : {}),
  });

  test("an entry in no named set comes last, under no set's name; empty sets are dropped", () => {
    const d: LinkCheckData = {
      ...base,
      leaving: {
        count: 3,
        links: [leaving("/a/x.md", "a"), leaving("/z/x.md"), leaving("/q/x.md", "unknown")],
      },
      sets: [
        { id: "b", label: "B", total: 0 },
        { id: "a", label: "A", total: 1 },
      ],
    };
    // No set's entry, and one in a set the answer does not name, both land last.
    expect(linkCheckGroups(d).map((g) => [g.label, linkCheckListed(g.data)])).toEqual([
      ["A", 1],
      [null, 2],
    ]);
  });

  test("shared names stay one session-wide section above the sets", async () => {
    const d: LinkCheckData = {
      ...base,
      count: 1,
      duplicates: {
        count: 1,
        names: [
          {
            name: "x.md",
            files: [
              { path: "/a/x.md", shown: "x.md", suggest: "a-x.md", set: "a" },
              { path: "/b/x.md", shown: "x.md", suggest: "b-x.md", set: "b" },
            ],
          },
        ],
      },
      leaving: { count: 1, links: [leaving("/a/x.md", "a")] },
      sets: [{ id: "a", label: "A", total: 1 }],
    };
    const m = await mount(<LinkCheckList data={d} onOpen={() => {}} />);
    const list = q('[data-slot="link-check-list"]') as HTMLElement;
    const order = [...list.children].map(
      (c) => c.getAttribute("aria-label") ?? c.getAttribute("data-slot"),
    );
    expect(order).toEqual(["Shared file names", "In A, listed, not counted"]);
    await m.unmount();
  });

  test("a group cut short says how much of it shows: N of M", async () => {
    const broken = (source: string) => ({
      source,
      name: "x.md",
      shown: "x.md",
      line: 1,
      raw: "./gone.md",
      kind: "markdown" as const,
      label: "gone",
      context: "[gone](./gone.md)",
      from: 0,
      to: 17,
      set: "a",
      tried: ["/a/gone.md"],
    });
    const d: LinkCheckData = {
      ...base,
      count: 9,
      dangling: { count: 9, links: [broken("/a/x.md"), broken("/a/y.md")] },
      sets: [{ id: "a", label: "A", total: 9 }],
      truncated: true,
    };
    const m = await mount(<LinkCheckList data={d} onOpen={() => {}} />);
    expect(q('[data-slot="set-total"]')?.textContent).toBe("2 of 9");
    await m.unmount();
  });

  test("a link broken in a proposed version is counted, and opens its document", async () => {
    const link = {
      source: "/a/keeper.md",
      name: "keeper.md",
      shown: "keeper.md",
      line: 3,
      raw: "./places/glade.md",
      kind: "markdown" as const,
      label: "the Glade",
      context: "Lives by [the Glade](./places/glade.md).",
      from: 10,
      to: 40,
      set: "a",
      doc: "keeper",
      version: 2,
      tried: ["/a/places/glade.md"],
      suggest: "./wilds/glade.md",
      act: "…",
    };
    const d: LinkCheckData = {
      ...base,
      count: 1,
      proposed: { count: 1, links: [link] },
      sets: [{ id: "a", label: "A", total: 1 }],
    };
    expect(linkCheckTotal(d)).toBe(1);
    expect(linkCheckLabel(d)).toBe("1 broken link in a proposed version");
    expect(linkCheckGroups(d).map((g) => [g.label, linkCheckTotal(g.data)])).toEqual([["A", 1]]);
    const opened: unknown[][] = [];
    const m = await mount(<LinkCheckList data={d} onOpen={(...a) => opened.push(a)} />);
    const text = q('[data-slot="link-check-list"]')?.textContent ?? "";
    expect(text).toContain("Broken in a proposed version");
    expect(text).toContain("in v2; its target moved to ./wilds/glade.md");
    await click(q('[data-slot="link-check-entry"]') as HTMLElement);
    // Its offsets are in v2's text, not the active one's: the document opens, at no place.
    expect(opened).toEqual([["/a/keeper.md"]]);
    await m.unmount();
  });

  test("unresolved references are listed, never counted in the sign", async () => {
    const ref = {
      source: "/a/x.md",
      name: "x.md",
      shown: "x.md",
      edge: "frontmatter",
      raw: "feature/some-slug",
      key: "parent",
      line: 2,
      tried: ["/a/feature/some-slug.md"],
      set: "a",
    };
    const d: LinkCheckData = {
      ...base,
      edges: { count: 0, kinds: [], links: [] },
      unresolved: { count: 1, kinds: ["frontmatter"], links: [ref] },
      sets: [{ id: "a", label: "A", total: 0 }],
    };
    expect(linkCheckTotal(d)).toBe(0);
    expect(linkCheckLabel(d)).toBe("");
    expect(linkCheckGroups(d).map((g) => g.label)).toEqual(["A"]);
    const m = await mount(<LinkCheckList data={d} onOpen={() => {}} />);
    const text = q('[data-slot="link-check-list"]')?.textContent ?? "";
    expect(text).toContain("Unresolved references");
    expect(text).toContain("parent: feature/some-slug");
    expect(text).not.toContain("nothing at");
    // Listed, not counted: the group says no number.
    expect(q('[data-slot="set-total"]')).toBeNull();
    await m.unmount();
  });

  test("without the app's word, the kit says folder, never set", async () => {
    const d: LinkCheckData = {
      ...base,
      leaving: { count: 2, links: [leaving("/a/x.md", "a"), leaving("/z/x.md")] },
      sets: [{ id: "a", label: "A", total: 1 }],
    };
    // Leaving is never in the headline; the quiet mark names it without a number.
    expect(linkCheckLabel(d)).toBe("");
    expect(linkCheckQuietLabel(d)).toBe("nothing broken; listed: links leaving the folder");
    const m = await mount(<LinkCheckList data={d} onOpen={() => {}} />);
    const text = q('[data-slot="link-check-list"]')?.textContent ?? "";
    expect(text).not.toMatch(/\bset\b/);
    expect(text).toContain("Leaving the folder");
    expect(text).toContain("Elsewhere");
    await m.unmount();
    expect(linkCheckQuietLabel({ ...d, noun: "set" })).toBe(
      "nothing broken; listed: links leaving the set",
    );
  });
});

describe("the sign counts only what is broken (Cole, 2026-10-23)", () => {
  const base: LinkCheckData = {
    count: 0,
    dangling: { count: 0, links: [] },
    unsupported: { count: 0, schemes: [], links: [] },
    duplicates: { count: 0, names: [] },
    unusedImages: { count: 0, images: [] },
    symmetry: { count: 0, hints: [] },
    headings: { count: 0, links: [] },
    ambiguousHeadings: { count: 0, hints: [] },
    references: { count: 0, links: [] },
    noun: "set",
  };
  const out = (i: number) => ({
    source: "/a/x.md",
    name: "x.md",
    shown: "x.md",
    line: i + 1,
    raw: `../y${i}.md`,
    target: `/y${i}.md`,
    targetShown: `../y${i}.md`,
    from: i * 10,
    to: i * 10 + 8,
    set: "a",
  });
  const gone = {
    source: "/a/x.md",
    name: "x.md",
    shown: "x.md",
    line: 9,
    raw: "./gone.md",
    kind: "markdown" as const,
    label: "gone",
    context: "[gone](./gone.md)",
    from: 90,
    to: 107,
    set: "a",
    tried: ["/a/gone.md"],
  };
  const leavingOnly: LinkCheckData = {
    ...base,
    leaving: { count: 11, links: Array.from({ length: 11 }, (_, i) => out(i)) },
    sets: [{ id: "a", label: "A", total: 0 }],
  };

  /** Which lucide icon the mark draws: the plain link, or the broken one. */
  const icon = () => {
    const c = mark()?.querySelector("svg")?.getAttribute("class") ?? "";
    return { plain: /\blucide-link-2\b(?!-off)/.test(c), off: /\blucide-link-2-off\b/.test(c) };
  };

  /** The sign alone, over a daemon that answers `data`. */
  async function sign(data: LinkCheckData) {
    return mount(
      <LinkCheck
        request={async () => ({ op: "link.check", ...data }) as never}
        onFrame={() => () => {}}
        connected
        snapshot={0}
        edits={0}
        onOpen={() => {}}
      />,
    );
  }

  test("with something broken, the number and the words leave the leaving links out", async () => {
    const d: LinkCheckData = {
      ...leavingOnly,
      count: 1,
      dangling: { count: 1, links: [gone] },
      sets: [{ id: "a", label: "A", total: 1 }],
    };
    const m = await sign(d);
    await waitFor(() => mark() !== null, "the mark");
    expect(mark()?.getAttribute("aria-label")).toBe("Link check: 1 broken link");
    expect(q('[data-slot="link-check-total"]')?.textContent).toBe("1");
    expect(mark()?.hasAttribute("data-quiet")).toBe(false);
    // The broken-link icon, at the sign's usual weight.
    expect(icon()).toEqual({ plain: false, off: true });
    expect(mark()?.classList.contains("text-ink-dim")).toBe(true);
    expect(mark()?.classList.contains("text-ink-faint")).toBe(false);
    // Still in the list, under their own heading.
    await click(mark() as HTMLElement);
    await waitFor(() => qa("[data-leaving]").length === 11, "the leaving links listed");
    await m.unmount();
  });

  test("with only leaving links, a quiet mark: no number, no problem, and it opens the list", async () => {
    expect(linkCheckTotal(leavingOnly)).toBe(0);
    const m = await sign(leavingOnly);
    await waitFor(() => mark() !== null, "the quiet mark");
    expect(mark()?.hasAttribute("data-quiet")).toBe(true);
    expect(mark()?.getAttribute("aria-label")).toBe(
      "Link check: nothing broken; listed: links leaving the set",
    );
    // No number anywhere on it, and not the broken-link icon's words.
    expect(q('[data-slot="link-check-total"]')).toBeNull();
    expect(q('[data-slot="link-check-label"]')).toBeNull();
    // A small faint word says what it lists (Cole, 2026-10-23); narrow, the number alone, as the sign does.
    expect(linkCheckQuietWord(leavingOnly)).toBe("11 leaving");
    const word = q('[data-slot="link-check-quiet-word"]');
    expect(word?.textContent).toBe("11 leaving");
    expect(word?.classList.contains("text-[11px]")).toBe(true);
    expect(word?.classList.contains("sm:inline")).toBe(true);
    const narrow = q('[data-slot="link-check-quiet-total"]');
    expect(narrow?.textContent).toBe("11");
    expect(narrow?.classList.contains("sm:hidden")).toBe(true);
    // A plain link, not the broken one, and faint.
    expect(icon()).toEqual({ plain: true, off: false });
    expect(mark()?.classList.contains("text-ink-faint")).toBe(true);
    expect(mark()?.classList.contains("text-ink-dim")).toBe(false);
    await click(mark() as HTMLElement);
    await waitFor(() => qa("[data-leaving]").length === 11, "the leaving links listed");
    expect(q('[data-slot="set-total"]')).toBeNull();
    await m.unmount();
  });

  test("with only unresolved references, the same quiet mark, saying so; their section is quiet", async () => {
    const ref = {
      source: "/a/x.md",
      name: "x.md",
      shown: "x.md",
      edge: "frontmatter",
      raw: "feature/some-slug",
      key: "parent",
      line: 2,
      tried: ["/a/feature/some-slug.md"],
      set: "a",
    };
    const d: LinkCheckData = {
      ...base,
      edges: { count: 0, kinds: [], links: [] },
      unresolved: { count: 1, kinds: ["frontmatter"], links: [ref] },
      sets: [{ id: "a", label: "A", total: 0 }],
    };
    expect(linkCheckQuietLabel(d)).toBe("nothing broken; listed: unresolved references");
    const m = await sign(d);
    await waitFor(() => mark() !== null, "the quiet mark");
    expect(mark()?.hasAttribute("data-quiet")).toBe(true);
    expect(mark()?.getAttribute("aria-label")).toBe(
      "Link check: nothing broken; listed: unresolved references",
    );
    expect(q('[data-slot="link-check-quiet-word"]')?.textContent).toBe("1 unresolved");
    expect(linkCheckQuietWord({ ...d, leaving: leavingOnly.leaving })).toBe(
      "11 leaving, 1 unresolved",
    );
    expect(icon()).toEqual({ plain: true, off: false });
    await click(mark() as HTMLElement);
    await waitFor(() => qa("[data-unresolved]").length === 1, "the unresolved reference listed");
    const section = q('[data-slot="link-check-section"][aria-label="Unresolved references"]');
    expect(section?.hasAttribute("data-quiet")).toBe(true);
    await m.unmount();
  });

  test("from a daemon that names no sets, the counted sections still come first", async () => {
    const d: LinkCheckData = {
      ...base,
      count: 1,
      dangling: { count: 1, links: [gone] },
      unusedImages: { count: 1, images: [{ path: "/a/images/x.png", shown: "x.png" }] },
      leaving: { count: 1, links: [out(0)] },
      // No `sets`: one list, not grouped.
    };
    const m = await mount(<LinkCheckList data={d} onOpen={() => {}} />);
    expect(qa('[data-slot="link-check-section"]').map((x) => x.getAttribute("aria-label"))).toEqual(
      ["Broken links", "Images nothing links to or embeds", "Leaving the set"],
    );
    await m.unmount();
  });

  test("a clean session still shows nothing", async () => {
    const m = await sign({ ...base, sets: [] });
    await Bun.sleep(50);
    expect(mark()).toBeNull();
    await m.unmount();
  });
});
