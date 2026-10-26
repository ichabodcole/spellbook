// The link check in the real shell, over a real daemon: nothing in the status
// bar while the links are sound, a mark when they are not that follows a change
// on disk without being opened, and a list behind it whose entries open their
// source at the link. Following an edit in the editor needs the document pane
// too, which the shell may not import: Atlas's `surface/LinkCheck.test.tsx`.

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
import type { LinkCheck as LinkCheckData } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import {
  LINK_CHECK_PAUSE_MS,
  LinkCheckList,
  linkCheckLabel,
  linkCheckTotal,
} from "./LinkCheck.tsx";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;

const BROKEN = "# Notes\n\nSee [Maren](op:doc/0193-maren) and [the cave](./cave.md?rel=near).\n";
/** Long enough for an ask after a cue, with room for a loaded machine. */
const SETTLE = LINK_CHECK_PAUSE_MS + 3000;

beforeEach(async () => {
  root = tempRoot("shell-link-check");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  daemon = fixtureDaemon({ tmp: join(root, "tmp") });
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
const probe = () => JSON.parse(q('[data-testid="probe"]')?.textContent ?? "{}");
const mark = () => q('[data-slot="link-check"]') as HTMLElement | null;
/** What the mark says, in full: its accessible name, whatever the width shows. */
const said = () => mark()?.getAttribute("aria-label") ?? null;
const entries = () => [...document.querySelectorAll<HTMLElement>('[data-slot="link-check-entry"]')];

/** Add `path` (default the seeded set) to the context from a second socket, as the agent would. */
async function agentSends(frames: object[]): Promise<void> {
  const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  for (const f of frames) ws.send(JSON.stringify(f));
  await Bun.sleep(50);
  ws.close();
}

async function addContext(): Promise<void> {
  await agentSends([{ op: "context.add", path: join(docs, "set") }]);
  await waitFor(
    () => !(q('[data-pane="context"]')?.textContent ?? "No context yet").includes("No context yet"),
    "the context",
  );
}

const click = (el: HTMLElement) =>
  settle(() => {
    el.click();
  });

describe("the status bar's link check", () => {
  test("quiet while sound, a mark when not, and it follows a change on disk unopened", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    await addContext();
    // Asked, answered, and nothing to say: no mark at all.
    await Bun.sleep(LINK_CHECK_PAUSE_MS + 300);
    expect(mark()).toBeNull();

    writeFileSync(join(docs, "set", "notes.md"), BROKEN);
    await waitFor(() => mark() !== null, "the mark", SETTLE);
    expect(said()).toBe("Link check: 1 broken link, 1 unsupported link");
    // Narrow or wide, the label carries the words; the total is the short form.
    expect(q('[data-slot="link-check-total"]')?.textContent).toBe("2");
    expect(q('[data-slot="link-check-label"]')?.textContent).toBe(
      "1 broken link, 1 unsupported link",
    );

    // Fixed on disk, outside the app, in a document the session does not hold:
    // no snapshot says so, and the daemon's `context.changed` does.
    writeFileSync(join(docs, "set", "notes.md"), "# Notes\n\nNothing linked.\n");
    await waitFor(() => mark() === null, "the mark gone", SETTLE);
    await m.unmount();
  }, 20_000);

  test("each link opens its source at the link; a shared name opens the file", async () => {
    writeFileSync(join(docs, "set", "notes.md"), BROKEN);
    writeFileSync(join(docs, "set", "part", "a.md"), "# Another A\n");
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="context"]'), "the shell");
    await addContext();
    await waitFor(() => mark() !== null, "the mark", SETTLE);
    expect(said()).toBe("Link check: 1 shared file name, 1 broken link, 1 unsupported link");

    await click(mark() as HTMLElement);
    await waitFor(() => entries().length === 4, "four entries");
    // Shared names first, then broken, then unsupported.
    const sections = [...document.querySelectorAll('[data-slot="link-check-section"]')].map((s) =>
      s.getAttribute("aria-label"),
    );
    expect(sections).toEqual(["Shared file names", "Broken links", "Unsupported links"]);
    const list = q('[data-slot="link-check-list"]')?.textContent ?? "";
    expect(list).toContain("./cave.md?rel=near");
    expect(list).toContain("op:doc/0193-maren");
    expect(list).toContain("could be part-a.md");
    expect(list).toContain("could be set-a.md");
    // The scheme is said once, in the section's header.
    const notes = [...document.querySelectorAll('[data-slot="section-note"]')].map(
      (n) => n.textContent,
    );
    expect(notes).toContain("op: links do not open here.");
    expect(list.split("op: links do not open here").length).toBe(2);

    // The broken link: its document opens, and the link itself is shown.
    const broken = entries().find((e) => e.textContent?.includes("cave.md")) as HTMLElement;
    expect(broken.getAttribute("data-line")).toBe("3");
    await click(broken);
    await waitFor(
      () => probe().open === join(docs, "set", "notes.md") && probe().reveal !== null,
      "notes.md open at the link",
    );
    const { reveal } = probe();
    expect(BROKEN.slice(reveal.from, reveal.to)).toBe("[the cave](./cave.md?rel=near)");
    // Choosing closes the list.
    expect(q('[data-slot="link-check-list"]')).toBeNull();

    // A shared name: the file opens, nothing is renamed.
    await click(mark() as HTMLElement);
    await waitFor(() => entries().length === 4, "the list again");
    const shared = entries().find(
      (e) => e.getAttribute("data-source") === join(docs, "set", "part", "a.md"),
    ) as HTMLElement;
    await click(shared);
    await waitFor(() => probe().open === join(docs, "set", "part", "a.md"), "part/a.md open");
    await m.unmount();
  }, 20_000);
});

const empty: LinkCheckData = {
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

describe("the label", () => {
  test("names only the sections with something, in the list's order, singular and plural", () => {
    expect(
      linkCheckLabel({ ...empty, unsupported: { count: 12, schemes: ["op"], links: [] } }),
    ).toBe("12 unsupported links");
    expect(
      linkCheckLabel({
        ...empty,
        dangling: { count: 2, links: [] },
        duplicates: { count: 1, names: [] },
      }),
    ).toBe("1 shared file name, 2 broken links");
    expect(
      linkCheckLabel({
        ...empty,
        dangling: { count: 1, links: [] },
        unusedImages: { count: 1, images: [] },
      }),
    ).toBe("1 broken link, 1 image nothing links to or embeds");
    expect(linkCheckLabel({ ...empty, symmetry: { count: 2, hints: [] } })).toBe(
      "2 one-way symmetric links",
    );
    // kit-heading-links-build: a missing heading is a problem, a repeated one a hint.
    const headings = { ...empty, count: 1, headings: { count: 1, links: [] } };
    expect(linkCheckLabel(headings)).toBe("1 link to a missing heading");
    expect(linkCheckTotal(headings)).toBe(1);
    const repeated = { ...empty, ambiguousHeadings: { count: 2, hints: [] } };
    expect(linkCheckLabel(repeated)).toBe("2 links to a repeated heading");
    expect(linkCheckTotal(repeated)).toBe(2);
  });
});

describe("the list", () => {
  test("says when there is nothing to report", async () => {
    const m = await mount(<LinkCheckList data={empty} onOpen={() => {}} />);
    expect(q('[data-slot="link-check-list"]')?.textContent).toContain("Nothing to report");
    await m.unmount();
  });

  test("lists images nothing links to or embeds, each opening the image", async () => {
    const opened: string[] = [];
    const data: LinkCheckData = {
      ...empty,
      count: 0, // an unused image is not a link problem
      unusedImages: { count: 1, images: [{ path: "/w/images/fox.png", shown: "images/fox.png" }] },
    };
    const m = await mount(<LinkCheckList data={data} onOpen={(p) => opened.push(p)} />);
    const section = q('section[aria-label="Images nothing links to or embeds"]');
    expect(section?.textContent).toContain("images/fox.png");
    await click(q('[data-source="/w/images/fox.png"]') as HTMLElement);
    expect(opened).toEqual(["/w/images/fox.png"]);
    await m.unmount();
  });

  test("lists symmetric links written one way as hints, each opening its source at the link", async () => {
    const opened: [string, unknown][] = [];
    const data: LinkCheckData = {
      ...empty,
      count: 0, // a hint is not a link problem
      symmetry: {
        count: 1,
        hints: [
          {
            source: "/w/locations/the-ruin.md",
            name: "the-ruin.md",
            shown: "locations/the-ruin.md",
            line: 6,
            raw: "./the-glade.md?rel=contrasts-with",
            kind: "markdown",
            label: "the Glade",
            context: "[the Glade](./the-glade.md?rel=contrasts-with)",
            from: 40,
            to: 86,
            rel: "contrasts-with",
            target: "/w/locations/the-glade.md",
            targetShown: "locations/the-glade.md",
            hint: "The Ruin contrasts-with The Glade; The Glade does not link back",
          },
        ],
      },
    };
    const m = await mount(<LinkCheckList data={data} onOpen={(p, at) => opened.push([p, at])} />);
    const section = q('section[aria-label="Symmetric links written one way"]');
    expect(section?.textContent).toContain(
      "The Ruin contrasts-with The Glade; The Glade does not link back",
    );
    expect(section?.querySelector('[data-slot="section-note"]')?.textContent).toContain(
      "A hint, not a problem",
    );
    await click(q('[data-source="/w/locations/the-ruin.md"]') as HTMLElement);
    expect(opened).toEqual([["/w/locations/the-ruin.md", { from: 40, to: 86 }]]);
    await m.unmount();
  });
});
