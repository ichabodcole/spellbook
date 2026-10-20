// The link check grouped by set (kit-broken-links-visible), in the real shell
// over a real daemon with an app's edges: a broken body link, a broken
// frontmatter `related:` and links leaving their set. The mark says exactly
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
  LinkCheckList,
  linkCheckGroups,
  linkCheckLabel,
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
  "related: [./ghost.md, ../lore/myth.md]",
  "---",
  "# Notes",
  "",
  "See [the cave](./cave.md) and [the myth](../lore/myth.md).",
  "",
].join("\n");
const MYTH = "# The Myth\n\nBack to [A](../set/a.md).\n";
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
      () => (mark()?.getAttribute("aria-label") ?? "").includes("leaving"),
      "the mark",
      SETTLE,
    );

    // What the agent's `link-check` verb posts, for the same session.
    const asked = await cmd(daemon.url, { op: "link.check" });
    expect(asked.status).toBe(200);
    const { ok: _ok, ...verb } = asked.body as unknown as LinkCheckData & { ok: true };
    expect(verb.dangling.count).toBe(1);
    expect(verb.edges?.count).toBe(1);
    expect(verb.leaving?.count).toBe(3);
    expect(verb.count).toBe(2);

    expect(mark()?.getAttribute("aria-label")).toBe(`Link check: ${linkCheckLabel(verb)}`);
    expect(linkCheckLabel(verb)).toBe(
      "1 broken link, 1 broken frontmatter reference, 3 leaving the set",
    );
    expect(q('[data-slot="link-check-total"]')?.textContent).toBe(String(linkCheckTotal(verb)));
    expect(linkCheckTotal(verb)).toBe(5);

    // The list: grouped by set, in the context's order, adding up to the mark.
    await click(mark() as HTMLElement);
    await waitFor(() => qa('[data-slot="link-check-set"]').length === 2, "two sets");
    const sets = qa('[data-slot="link-check-set"]');
    expect(sets.map((x) => x.getAttribute("aria-label"))).toEqual(["In set", "In lore"]);
    const totals = sets.map((x) => Number(x.querySelector('[data-slot="set-total"]')?.textContent));
    expect(totals).toEqual([4, 1]);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(linkCheckTotal(verb));
    const sections = (x: HTMLElement) =>
      [...x.querySelectorAll('[data-slot="link-check-section"]')].map((s) =>
        s.getAttribute("aria-label"),
      );
    expect(sections(sets[0] as HTMLElement)).toEqual([
      "Broken links",
      "Broken frontmatter references",
      "Leaving the set",
    ]);
    expect(sections(sets[1] as HTMLElement)).toEqual(["Leaving the set"]);
    expect(sets[1]?.textContent).toContain("lands in set: a.md");

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
    await waitFor(() => qa("[data-leaving]").length === 3, "the list again");
    const out = qa("[data-leaving]").find(
      (e) => e.getAttribute("data-source") === join(docs, "lore", "myth.md"),
    ) as HTMLElement;
    await click(out);
    await waitFor(
      () => probe().open === join(docs, "lore", "myth.md") && probe().reveal !== null,
      "myth.md open at the link",
    );
    expect(MYTH.slice(probe().reveal.from, probe().reveal.to)).toBe("[A](../set/a.md)");
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
    expect(linkCheckGroups(d).map((g) => [g.label, linkCheckTotal(g.data)])).toEqual([
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
    expect(order).toEqual(["Shared file names", "In A"]);
    await m.unmount();
  });

  test("a group cut short says how much of it shows: N of M", async () => {
    const d: LinkCheckData = {
      ...base,
      leaving: { count: 9, links: [leaving("/a/x.md", "a"), leaving("/a/y.md", "a")] },
      sets: [{ id: "a", label: "A", total: 9 }],
      truncated: true,
    };
    const m = await mount(<LinkCheckList data={d} onOpen={() => {}} />);
    expect(q('[data-slot="set-total"]')?.textContent).toBe("2 of 9");
    await m.unmount();
  });

  test("without the app's word, the kit says folder, never set", async () => {
    const d: LinkCheckData = {
      ...base,
      leaving: { count: 2, links: [leaving("/a/x.md", "a"), leaving("/z/x.md")] },
      sets: [{ id: "a", label: "A", total: 1 }],
    };
    expect(linkCheckLabel(d)).toBe("2 leaving the folder");
    const m = await mount(<LinkCheckList data={d} onOpen={() => {}} />);
    const text = q('[data-slot="link-check-list"]')?.textContent ?? "";
    expect(text).not.toMatch(/\bset\b/);
    expect(text).toContain("Leaving the folder");
    expect(text).toContain("Elsewhere");
    await m.unmount();
    expect(linkCheckLabel({ ...d, noun: "set" })).toBe("2 leaving the set");
  });
});
