// The kit page's row marks: the shipped tree's status dot (draft, stale,
// deprecated, unreadable) on the kit sidebar's rows, from the flagged daemon's
// `appState.docMeta`. The marks are the shipped `statusMark`'s, for the same
// documents: checked on a table of summaries, then end to end against a REAL
// flagged daemon (`kitDaemon`, in this process, under a scratch SCRIPTORIUM_HOME).

import "../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { Daemon } from "../../kit/context/daemonClient";
import { useDaemon } from "../../kit/context/useDaemon";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../../kit/lib/testDom";
import type { WorkspaceDaemon } from "../../kit/workspace/server";
import { tempRoot } from "../../kit/workspace/testing";
import type { DocSummary } from "../backend/kit/frontmatter";
import { kitDaemon } from "../backend/kit/server";
import { Frame, scriptoriumRowMarker } from "./Frame";
import { statusMark } from "./statusMark";

const summary = (over: Partial<DocSummary>): DocSummary => ({
  status: "stable",
  tags: [],
  trust: "unverified",
  stale: false,
  ...over,
});

describe("scriptoriumRowMarker", () => {
  const cases: Record<string, DocSummary | undefined> = {
    "/d/none.md": undefined,
    "/d/stable.md": summary({}),
    "/d/draft.md": summary({ status: "draft" }),
    "/d/deprecated.md": summary({ status: "deprecated" }),
    "/d/stale.md": summary({ status: "draft", stale: true }),
    "/d/broken.md": summary({ status: "deprecated", stale: true, error: "bad YAML" }),
    "/d/archived.md": summary({ lifecycle: "archived" }),
  };
  const meta = Object.fromEntries(
    Object.entries(cases).filter((e): e is [string, DocSummary] => e[1] !== undefined),
  );
  const marker = scriptoriumRowMarker(meta);

  test("marks exactly what the shipped statusMark marks, with its tone and reason", () => {
    const tones: Record<string, string | null> = {};
    for (const path of Object.keys(cases)) {
      const want = statusMark(meta[path]);
      const drawn = marker(path);
      if (!want) {
        expect(drawn).toBeNull();
        tones[path] = null;
        continue;
      }
      const html = renderToStaticMarkup(drawn);
      expect(html).toContain(`data-tone="${want.tone}"`);
      expect(html).toContain(`title="${want.title}"`);
      tones[path] = want.tone;
    }
    // The four marks, and nothing on what the shipped tree leaves bare.
    expect(tones).toEqual({
      "/d/none.md": null,
      "/d/stable.md": null,
      "/d/draft.md": "draft",
      "/d/deprecated.md": "deprecated",
      "/d/stale.md": "stale",
      "/d/broken.md": "unreadable",
      "/d/archived.md": null,
    });
  });

  test("each tone's dot carries the shipped StatusDot's colour for it", () => {
    // The shipped tree's colour per tone, captured from `StatusDot` in the
    // shipped `components/context/EntryTree.tsx` at cycle/shell 401beb8d. This
    // test read that file until scriptorium-kit-keepers; the kit path no
    // longer reads the shipped code, so the table is the record.
    const colour: Record<string, string> = {
      draft: "data-[tone=draft]:bg-attention",
      stale: "data-[tone=stale]:bg-attention/70",
      deprecated: "data-[tone=deprecated]:bg-danger",
      unreadable: "data-[tone=unreadable]:bg-ink-faint",
    };
    const seen: string[] = [];
    for (const path of Object.keys(cases)) {
      const drawn = marker(path);
      if (!drawn) continue;
      const html = renderToStaticMarkup(drawn);
      const tone = html.match(/data-tone="([a-z]+)"/)?.[1] as string;
      const classes = html.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [];
      expect(classes).toContain(colour[tone] as string);
      seen.push(tone);
    }
    expect(seen.sort()).toEqual(["deprecated", "draft", "stale", "unreadable"]);
  });

  test("a path the metadata does not hold has no mark", () => {
    expect(marker("/d/elsewhere.md")).toBeNull();
  });
});

const root = tempRoot("scriptorium-frame-marks");
const set = join(root, "docs", "marks");
const lone = join(root, "docs", "lone", "alone.md");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;

const FILES: Record<string, string> = {
  "draft.md": "---\nstatus: draft\n---\n# Draft\n",
  "gone.md": "---\nstatus: deprecated\n---\n# Gone\n",
  "old.md": "---\nstatus: draft\nstale_after: 2000-01-01\n---\n# Old\n",
  "broken.md": "---\nstatus: [draft\n---\n# Broken\n",
  "fine.md": "---\nstatus: stable\n---\n# Fine\n",
  "plain.md": "# Plain\n",
};

describe("the frame's tree on a real kit daemon", () => {
  beforeAll(async () => {
    installDom();
    process.env.SCRIPTORIUM_HOME = join(root, "home");
    mkdirSync(join(root, "tmp"), { recursive: true });
    mkdirSync(set, { recursive: true });
    mkdirSync(join(root, "docs", "lone"), { recursive: true });
    for (const [name, text] of Object.entries(FILES)) writeFileSync(join(set, name), text);
    writeFileSync(lone, "---\nstatus: draft\n---\n# Alone\n");
    daemon = kitDaemon({
      tmp: join(root, "tmp"),
      drainGraceMs: 10,
      trash: async () => {
        throw new Error("no Trash in this test");
      },
    });
    await daemon.start();
  });
  afterEach(cleanup);
  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await removeDom();
    if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
    else process.env.SCRIPTORIUM_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  function Host() {
    const d = useDaemon({
      url: `${daemon.url}/ws`,
      WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
      minDelayMs: 20,
      maxDelayMs: 60,
    });
    client = d;
    return (
      <div style={{ width: 1200, height: 700 }}>
        <Frame daemon={d} />
      </div>
    );
  }
  const docMeta = () =>
    (client?.state?.appState as { docMeta?: Record<string, DocSummary> } | null)?.docMeta ?? {};
  const toneIn = (el: Element | null | undefined) =>
    el?.querySelector("[data-tone]")?.getAttribute("data-tone") ?? null;
  const listButton = (name: string) =>
    [...document.querySelectorAll('[aria-label="Context"] button')].find((b) =>
      (b.textContent ?? "").trim().startsWith(name),
    );
  const treeRow = (name: string) =>
    [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
      (e.textContent ?? "").trim().startsWith(name),
    );

  test("each row carries the shipped tree's mark for its document, and only those rows", async () => {
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open" && client.state !== null, "the hello");
    for (const path of [set, lone]) {
      const n = client?.state?.context.length ?? 0;
      client?.send({ op: "context.add", path });
      await waitFor(() => (client?.state?.context.length ?? 0) > n, `${path} in the context`);
    }
    // Every document with frontmatter; plain.md has none, so no entry.
    await waitFor(() => Object.keys(docMeta()).length === 6, "every document's frontmatter");
    // The list: a document listed on its own is marked; a set's row is not.
    await waitFor(() => listButton("alone.md") !== undefined, "the list");
    expect(toneIn(listButton("alone.md"))).toBe(statusMark(docMeta()[lone])?.tone ?? null);
    expect(toneIn(listButton("alone.md"))).toBe("draft");
    expect(toneIn(listButton("marks"))).toBeNull();
    // The set's tree: every row as the shipped statusMark has it, on the same docMeta.
    const button = listButton("marks");
    await settle(() => {
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => treeRow("plain.md") !== undefined, "the set's tree");
    const drawn: Record<string, string | null> = {};
    for (const name of Object.keys(FILES)) {
      drawn[name] = toneIn(treeRow(name));
      expect(drawn[name]).toBe(statusMark(docMeta()[join(set, name)])?.tone ?? null);
    }
    expect(drawn).toEqual({
      "draft.md": "draft",
      "gone.md": "deprecated",
      "old.md": "stale",
      "broken.md": "unreadable",
      "fine.md": null,
      "plain.md": null,
    });
    await m.unmount();
  });
});
