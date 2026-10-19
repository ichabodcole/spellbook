// An image in the shell over a REAL daemon (the kit-image-files item): a click
// on its row opens the kit's viewer in the centre, served by the guarded file
// route, with the app's centre and toolbar standing aside; its row is marked;
// Close, or a document, puts it away.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useDaemon } from "../context/useDaemon.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { cmd } from "../workspace/fixtures/harness";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

let root: string;
let world: string;
let daemon: WorkspaceDaemon;

beforeEach(async () => {
  root = tempRoot("shell-images");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  mkdirSync(world, { recursive: true });
  writeFileSync(join(world, "fox.md"), "# The fox\n");
  writeFileSync(join(world, "fox.png"), pngBytes(16, 12));
  // Where fox.png is used, and an image nothing uses.
  writeFileSync(join(world, "den.md"), "# The den\n\n![The fox](fox.png)\n\nSee [it](fox.png).\n");
  writeFileSync(join(world, "owl.png"), pngBytes(4, 4));
  daemon = fixtureDaemon({ tmp: join(root, "tmp") });
  await daemon.start();
  await cmd(daemon.url, { op: "context.add", paths: [world] });
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell
        daemon={d}
        centre={<p data-testid="app-centre">the app's centre</p>}
        toolbar={<span data-testid="app-toolbar">the app's toolbar</span>}
      />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const row = (name: string) =>
  [...document.querySelectorAll('[role="treeitem"]')].find((b) => b.textContent === name) as
    | HTMLElement
    | undefined;
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

test("an image opens in the kit's viewer; the app's centre and toolbar stand aside until it is put away", async () => {
  await mount(<Host />);
  await waitFor(() => !!q('[data-pane="context"]'), "the shell");
  await click(
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("world")),
  );
  await waitFor(() => !!row("fox.png"), "the image row");
  expect(row("fox.png")?.querySelector('[data-format="image"]')).not.toBeNull();

  await click(row("fox.md"));
  await waitFor(() => daemon.session.view().openDoc === "fox", "the document");
  await click(row("fox.png"));
  await waitFor(() => !!q('[data-slot="image-viewer"]'), "the viewer");
  expect(q('[data-testid="app-centre"]')).toBeNull();
  expect(q('[data-testid="app-toolbar"]')).toBeNull();
  const img = q('[data-slot="image"]') as HTMLImageElement;
  const src = new URL(img.getAttribute("src") ?? "");
  expect(src.pathname).toBe("/fs/file");
  expect(src.searchParams.get("path")).toBe(join(world, "fox.png"));
  // What the viewer asks for, the route serves.
  const res = await fetch(src);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(q('[data-slot="image-footer"]')?.textContent).toContain("fox.png");
  expect(row("fox.png")?.dataset.active).toBe("true");
  expect(row("fox.md")?.dataset.active).toBeUndefined();

  await click(q('button[aria-label="Close fox.png"]'));
  await waitFor(() => !q('[data-slot="image-viewer"]'), "closed");
  expect(q('[data-testid="app-centre"]')).not.toBeNull();
  expect(q('[data-testid="app-toolbar"]')).not.toBeNull();

  // A document puts it away too.
  await click(row("fox.png"));
  await waitFor(() => !!q('[data-slot="image-viewer"]'), "the viewer again");
  await click(row("fox.md"));
  await waitFor(() => !q('[data-slot="image-viewer"]'), "the document again");
  expect(daemon.session.view().openDoc).toBe("fox");
});

test("the viewer says where an image is used, and opens a document that uses it", async () => {
  await mount(<Host />);
  await waitFor(() => !!q('[data-pane="context"]'), "the shell");
  await click(
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("world")),
  );
  await waitFor(() => !!row("owl.png"), "the image rows");
  await click(row("fox.png"));
  await waitFor(() => !!q('[data-slot="image-linked-from"]'), "linked from");
  expect(q('[data-slot="image-linked-from"]')?.textContent).toContain("Linked from 2 places");
  // Opened, it lists each one; choosing one opens its document.
  // Spellbook: the footer mounts when the backlinks arrive, outside act; one
  // settle runs its effects first, or the menu trigger can miss the click
  // (about one run in two under @base-ui/react 1.6).
  await settle(() => {});
  await click(q('[data-slot="image-linked-from"]'));
  await waitFor(
    () => document.querySelectorAll('[data-slot="image-backlink"]').length === 2,
    "listed",
  );
  await click(q('[data-slot="image-backlink"]'));
  await waitFor(() => daemon.session.view().openDoc === "den", "the document that uses it");
  // An image nothing uses says nothing.
  await click(row("owl.png"));
  await waitFor(
    () => q('[data-slot="image-footer"]')?.textContent?.includes("owl.png") === true,
    "the second image",
  );
  await waitFor(() => !q('[data-slot="image-linked-from"]'), "nothing to say");
});
