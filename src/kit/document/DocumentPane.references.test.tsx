// "Linked from" and an app's edges (kit-link-edges-slot), in a DOM against a
// REAL workspace daemon. With an edge slot registered, a document that refers
// to the open one only from its frontmatter is listed under "Linked from",
// said as a reference and not a link in the text, and opens its source. With
// no slot, "Linked from" is exactly what it was: the same markup, and a
// document referred to only from frontmatter shows no section at all.
//
// The slot here is the test's own, not any app's: each entry under `refs:` is
// an edge of kind `frontmatter`, keyed `refs[i]`.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { AppEdge, LinkSlot } from "../workspace/linkEdges";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

/** The test's slot: each entry under `refs:` is a `frontmatter` edge. */
const refsSlot: LinkSlot = {
  edges: ({ frontmatter }) => {
    const list = frontmatter?.refs;
    return Array.isArray(list)
      ? list.map((t, i): AppEdge => ({ kind: "frontmatter", target: String(t), key: `refs[${i}]` }))
      : [];
  },
};

let root: string;
let docs: string;
let set: string;
let daemon: WorkspaceDaemon | null = null;
let client: Daemon | null = null;
let opened: string[];

beforeEach(() => {
  root = tempRoot("pane-references");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  set = join(docs, "set");
  // b.md: two body links (a.md, c.md) and, from r.md, one frontmatter reference.
  writeFileSync(join(set, "a.md"), "# A\n\nHer [sister](./part/b.md?rel=sister-of) lives here.\n");
  writeFileSync(join(set, "part", "b.md"), "# B\n\nPlain.\n");
  writeFileSync(join(set, "c.md"), "# C\n\nSee [b](part/b.md).\n");
  writeFileSync(join(set, "r.md"), "---\ntitle: R\nrefs: [./part/b.md, ./only.md]\n---\n# R\n");
  // c.md: one body link, from d.md, and no reference.
  writeFileSync(join(set, "d.md"), "# D\n\n[to c](./c.md?rel=extends)\n");
  // only.md: nothing links to it in a body; r.md refers to it from frontmatter.
  writeFileSync(join(set, "only.md"), "# Only\n\nNo links here.\n");
  localStorage.clear();
  client = null;
  opened = [];
});
afterEach(async () => {
  await daemon?.stop().catch(() => {});
  daemon = null;
  rmSync(root, { recursive: true, force: true });
});

async function start(links?: LinkSlot) {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    workspace: docs,
    ...(links ? { links } : {}),
  });
  await daemon.start();
  daemon.session.addContext(set);
}

function Host() {
  const d = useDaemon({ url: `${daemon?.url}/ws`, minDelayMs: 20, maxDelayMs: 60 });
  client = d;
  const toasts = useMemo(() => createToastStore(), []);
  const state = d.state;
  if (!state) return null;
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc: state.docs.find((doc) => doc.slug === state.openDoc) ?? null,
    selection: null,
    reportSelection: () => {},
    dropSelection: () => {},
    clearSeq: 0,
    reveal: null,
    requestReveal: () => {},
    revealApplied: () => {},
    openAt: (path) => {
      opened.push(path);
      d.send({ op: "open", path });
    },
    toasts,
    announce: () => 0,
    theme: "dark",
    setTheme: () => {},
    focusPane: () => {},
    columns: { collapsed: { context: false, chat: false }, collapse: () => {}, expand: () => {} },
    setQuiet: () => {},
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" style={{ width: 900, height: 700 }}>
        <DocumentPane mode="rendered" />
      </main>
    </WorkspaceContext.Provider>
  );
}

const section = () => document.querySelector('[data-slot="backlinks"]');
const openName = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.name;
const prose = (word: string) => () =>
  document.querySelector(".md-prose")?.textContent?.includes(word) === true;

async function open(path: string, ready: () => boolean) {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path });
  });
  await waitFor(ready, "the document");
  return m;
}

/** The section's markup, with React's per-mount ids taken out so two mounts compare. */
const markup = () => (section()?.outerHTML ?? "").replace(/ (id|aria-describedby)="[^"]*"/g, "");

/** Wait out the pause before the pane asks for backlinks, and its answer. */
const quiet = () => settle(() => new Promise((r) => setTimeout(r, 400)));

describe("with an edge slot", () => {
  beforeEach(() => start(refsSlot));

  test("a frontmatter reference is listed under Linked from, said as a reference", async () => {
    const m = await open(join(set, "part", "b.md"), () =>
      Boolean(section()?.querySelector('[data-slot="backlink-reference"]')),
    );
    expect(section()?.querySelector("h2")?.textContent).toBe("Linked from2 links, 1 reference");
    // The body links are as they were, grouped by relation.
    expect(
      [...document.querySelectorAll('[data-slot="backlink"]')].map((b) =>
        b.getAttribute("data-source"),
      ),
    ).toEqual([join(set, "a.md"), join(set, "c.md")]);
    const group = section()?.querySelector('[data-slot="backlink-references"]');
    expect(group?.getAttribute("data-edge")).toBe("frontmatter");
    expect(group?.querySelector("h3")?.textContent).toBe(
      "frontmatterreferences, not links in the text1",
    );
    const entry = group?.querySelector('[data-slot="backlink-reference"]');
    expect(entry?.getAttribute("data-source")).toBe(join(set, "r.md"));
    expect(entry?.getAttribute("data-key")).toBe("refs[0]");
    expect(entry?.getAttribute("aria-label")).toBe(
      "r: reference (frontmatter), not a link in its text",
    );
    expect(entry?.querySelector('[data-slot="reference-line"]')?.textContent).toBe(
      "refs[0]: ./part/b.md",
    );
    // A reference is not a body link: it has no quoted line to mark.
    expect(entry?.querySelector("mark")).toBeNull();
    await m.unmount();
  });

  test("a document referred to only from frontmatter still has a Linked from", async () => {
    const m = await open(join(set, "only.md"), () => section() !== null);
    expect(section()?.querySelector("h2")?.textContent).toBe("Linked from1 reference");
    expect(section()?.querySelectorAll('[data-slot="backlink"]')).toHaveLength(0);
    const entry = section()?.querySelector('[data-slot="backlink-reference"]');
    expect(entry?.getAttribute("data-source")).toBe(join(set, "r.md"));
    expect(entry?.getAttribute("data-key")).toBe("refs[1]");
    await m.unmount();
  });

  test("a reference opens its source", async () => {
    const m = await open(join(set, "only.md"), () => section() !== null);
    const entry = section()?.querySelector('[data-slot="backlink-reference"]');
    await settle(() => {
      entry?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(opened).toEqual([join(set, "r.md")]);
    await waitFor(() => openName() === "r.md", "r.md open");
    await m.unmount();
  });

  test("where no reference lands, the section is the one drawn without a slot", async () => {
    // c.md is linked from d.md's body, and referred to from no frontmatter.
    const m = await open(join(set, "c.md"), () => section() !== null);
    await quiet();
    const withSlot = markup();
    expect(withSlot).not.toContain("backlink-reference");
    await m.unmount();
    await daemon?.stop();
    client = null;
    await start();
    const n = await open(join(set, "c.md"), () => section() !== null);
    await quiet();
    expect(markup()).toBe(withSlot);
    await n.unmount();
  });
});

describe("with no edge slot, Linked from is unchanged", () => {
  beforeEach(() => start());

  test("the daemon sends no edges, and the section is body links only", async () => {
    const m = await open(join(set, "part", "b.md"), () => section() !== null);
    await quiet();
    expect(section()?.querySelector("h2")?.textContent).toBe("Linked from2 links");
    expect(section()?.querySelector('[data-slot="backlink-references"]')).toBeNull();
    expect(section()?.querySelector('[data-slot="backlink-reference"]')).toBeNull();
    const answer = (await client?.request({ op: "link.backlinks", doc: client?.state?.openDoc })) as
      | Record<string, unknown>
      | undefined;
    expect(answer && "edges" in answer).toBe(false);
    expect(answer && "edgeCount" in answer).toBe(false);
    await m.unmount();
  });

  test("a document referred to only from frontmatter shows no section", async () => {
    const m = await open(join(set, "only.md"), prose("No links here."));
    await quiet();
    expect(section()).toBeNull();
    await m.unmount();
  });
});
