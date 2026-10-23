// The shipped frame's native-picker acts, against REAL kit daemons in this
// process (scratch SCRIPTORIUM_HOME): where the system has no picker (the
// daemon answers for Windows) neither "Choose a folder…" nor "Add the
// original file…" is offered; where it has one (the OS dialog stubbed through
// the daemon's `pick` seam) both are, a folder chosen is highlighted, and a
// refused "Add it as a set" (`/`) says the daemon's reason in the dialog.

import "../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { type LaidOut, laidOut } from "../../kit/lib/testLayout";
import type { WorkspaceDaemon } from "../../kit/workspace/server";
import { tempRoot } from "../../kit/workspace/testing";
import { kitDaemon } from "../backend/kit/server";
import { Frame } from "./Frame";
import { reseedPrefs, seedPrefs } from "./testPrefs";

const root = tempRoot("scriptorium-frame-picker");
const set = join(root, "docs", "set");
const savedHome = process.env.SCRIPTORIUM_HOME;
let windows: WorkspaceDaemon;
let mac: WorkspaceDaemon;
let client: Daemon | null = null;
let layout: LaidOut | null = null;
/** The stubbed OS dialog: each call takes the next queued answer. */
const queue: string[][] = [];

beforeAll(async () => {
  installDom();
  layout = laidOut(1400);
  process.env.SCRIPTORIUM_HOME = join(root, "home");
  seedPrefs(join(root, "home"), { "doc:view": "raw" });
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "a.md"), "# A\n");
  windows = kitDaemon({ tmp: join(root, "tmp"), drainGraceMs: 10, platform: "win32" });
  mac = kitDaemon({
    tmp: join(root, "tmp"),
    drainGraceMs: 10,
    platform: "darwin",
    pick: async () => {
      const paths = queue.shift() ?? [];
      return { paths, cancelled: paths.length === 0 };
    },
  });
  await windows.start();
  await mac.start();
});
afterEach(cleanup);
afterEach(() => reseedPrefs(join(root, "home"), { "doc:view": "raw" }));
afterAll(async () => {
  layout?.undo();
  await windows?.stop().catch(() => {});
  await mac?.stop().catch(() => {});
  await removeDom();
  if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
  else process.env.SCRIPTORIUM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

function Host({ url }: { url: string }) {
  const d = useDaemon({
    url: `${url}/ws`,
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

const byLabel = (l: string) => document.querySelector(`[aria-label="${l}"]`);
const where = () => document.querySelector<HTMLElement>('[data-slot="location-dialog"]');
const button = (text: string) =>
  [...document.querySelectorAll('[data-slot="location-dialog"] button')].find((b) =>
    (b.textContent ?? "").includes(text),
  ) ?? null;
const chosen = () =>
  [
    ...document.querySelectorAll(
      '[data-slot="location-dialog"] [role="option"][aria-selected="true"]',
    ),
  ].map((e) => (e.textContent ?? "").trim());
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const pressEscape = () =>
  settle(() => {
    document.activeElement?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
async function dropOnList(files: File[]) {
  const ul = document.querySelector('ul[aria-label="Context"]');
  const target = ul?.parentElement as Element;
  await settle(() => {
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
      value: {
        types: ["Files"],
        files,
        items: files.map(() => ({ webkitGetAsEntry: () => ({ isDirectory: false }) })),
        getData: () => "",
      },
    });
    target.dispatchEvent(ev);
  });
}

async function open(d: WorkspaceDaemon) {
  const m = await mount(<Host url={d.url} />);
  await waitFor(() => client?.connection === "open" && client.state !== null, "the hello");
  if (!client?.state?.context.some((e) => e.root === set)) {
    client?.send({ op: "context.add", path: set });
    await waitFor(() => (client?.state?.context.length ?? 0) > 0, "the set");
  }
  return m;
}

describe("the frame's native-picker acts", () => {
  test("with no picker on the system, neither the folder button nor the original-file act is offered", async () => {
    const m = await open(windows);
    expect(client?.state?.picker).toBe(false);
    await click(byLabel("New document…"));
    await waitFor(() => where() !== null, "the location dialog");
    expect(button("Choose a folder")).toBeNull();
    await pressEscape();
    await waitFor(() => where() === null, "closed");
    await dropOnList([new File(["# X\n"], "x.md")]);
    await waitFor(() => where() !== null, "the drop dialog");
    expect(where()?.textContent).toContain("Where should x.md be copied?");
    expect(button("Add the original")).toBeNull();
    expect(button("Choose a folder")).toBeNull();
    await m.unmount();
  });

  test("with a picker both are offered; a folder chosen is highlighted, and a refused add says why", async () => {
    const m = await open(mac);
    expect(client?.state?.picker).toBe(true);
    await dropOnList([new File(["# X\n"], "x.md")]);
    await waitFor(() => where() !== null, "the drop dialog");
    expect(button("Add the original file")).not.toBeNull();
    await pressEscape();
    await waitFor(() => where() === null, "closed");
    await click(byLabel("New document…"));
    await waitFor(() => where() !== null, "the location dialog");
    queue.push([join(set, "part")]);
    await click(button("Choose a folder"));
    await waitFor(() => chosen().length === 1, "the highlight");
    expect(chosen()).toEqual(["set/part"]);
    // The root of the disk cannot be a set: the daemon's reason, in the dialog.
    queue.push(["/"]);
    await click(button("Choose a folder"));
    await waitFor(() => button("Add it as a set") !== null, "the offer");
    await click(button("Add it as a set"));
    await waitFor(
      () => (where()?.textContent ?? "").includes("is the top of the disk"),
      "the refusal",
      5000,
    );
    expect(where()?.textContent).not.toContain("Adding");
    expect(client?.state?.context.some((e) => e.root === "/")).toBe(false);
    await m.unmount();
  });
});
