// Embeds in the rendered document (the kit-image-embeds item), in a DOM against
// a REAL workspace daemon: `![alt](x.png)` is drawn through the guarded file
// route (its 1024 px thumbnail) with its alt text, resolved as a link from the
// document is; a click opens the viewer and Close brings the document back; a
// missing, remote or SVG embed, or one that is not really an image, is a quiet
// placeholder that says why; and a document without embeds asks nothing and changes nothing.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { EMBED_REMOTE, EMBED_SVG } from "../lib/markdown.ts";
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
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let docs: string;
let set: string;
let daemon: WorkspaceDaemon;
/** Every frame the page sent. */
let sent: { op?: string; [k: string]: unknown }[];
let client: Daemon | null = null;

const A = [
  "# A",
  "",
  "![The fox before the archway](./images/fox.png?rel=sourced-from)",
  "",
  "![A missing picture](images/nowhere.png)",
  "",
  "![Far away](https://example.com/far.png)",
  "",
  "![A drawing](images/logo.svg)",
  "",
  "![A page in disguise](images/fake.png)",
  "",
  "![](part/)",
  "",
  "[![The fox, linked](images/fox.png)](part/b.md)",
  "",
].join("\n");

beforeEach(async () => {
  root = tempRoot("pane-embeds");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  set = join(docs, "set");
  mkdirSync(join(set, "images"), { recursive: true });
  writeFileSync(join(set, "images", "fox.png"), pngBytes(40, 30));
  writeFileSync(join(set, "images", "fake.png"), "<html><script>alert(1)</script></html>");
  writeFileSync(join(set, "images", "logo.svg"), "<svg/>");
  writeFileSync(join(set, "a.md"), A);
  localStorage.clear();
  sent = [];
  client = null;
  // The seeded folder is the session's workspace folder; the set inside it is added below.
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
  daemon.session.addContext(set);
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** The real WebSocket, with what it sends recorded. */
function Recording(url: string, protocols?: string | string[]) {
  const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(url, protocols);
  const send = ws.send.bind(ws);
  ws.send = (data) => {
    try {
      sent.push(JSON.parse(String(data)));
    } catch {
      /* not a frame */
    }
    send(data);
  };
  return ws;
}

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: Recording as unknown as typeof WebSocket,
    minDelayMs: 20,
    maxDelayMs: 60,
  });
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
    toasts,
    announce: () => 0,
    theme: "dark",
    setTheme: () => {},
    focusPane: () => {},
    columns: { collapsed: { context: false, chat: false }, collapse: () => {}, expand: () => {} },
    setQuiet: () => {},
  };
  // The shell swaps in the viewer while an image is open; the pane stands aside.
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" style={{ width: 900, height: 700 }}>
        {state.openImage ? <p data-testid="viewer" /> : <DocumentPane mode="rendered" />}
      </main>
    </WorkspaceContext.Provider>
  );
}

const embed = (alt: string) =>
  ([...document.querySelectorAll<HTMLElement>(".md-prose .md-embed")].find(
    (e) => e.getAttribute("data-alt") === alt,
  ) ?? null) as HTMLElement | null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

async function open(name: string) {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(set, name) });
  });
  await waitFor(() => document.querySelector(".md-prose h1") !== null, "the rendered document");
  return m;
}

describe("an embed in the rendered view", () => {
  test("is drawn through the thumbnail route with its alt text, lazily", async () => {
    const m = await open("a.md");
    const fox = () => embed("The fox before the archway")?.querySelector("img") ?? null;
    await waitFor(() => fox() !== null, "the image");
    const img = fox() as HTMLImageElement;
    const src = new URL(img.getAttribute("src") ?? "");
    expect(src.pathname).toBe("/fs/thumb");
    // Resolved against the document, `?rel=` stripped.
    expect(src.searchParams.get("path")).toBe(join(set, "images", "fox.png"));
    expect(src.searchParams.get("w")).toBe("1024");
    expect(img.getAttribute("alt")).toBe("The fox before the archway");
    expect(img.getAttribute("loading")).toBe("lazy");
    // Its size from the header, set before a byte of it loads: the space is
    // held, so lazy loading fetches only what is near and nothing shifts.
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["40", "30"]);
    expect(embed("The fox before the archway")?.getAttribute("data-embed-state")).toBe("shown");
    // What the view asks for, the route serves.
    const res = await fetch(src);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    // Asked once for every distinct target, as written.
    const ask = sent.find((f) => f.op === "link.embeds");
    expect(ask?.targets).toContain("./images/fox.png?rel=sourced-from");
    expect(ask?.targets).not.toContain("https://example.com/far.png");
    await m.unmount();
  });

  test("a click opens the viewer, and Close brings the document back", async () => {
    const m = await open("a.md");
    const button = () =>
      embed("The fox before the archway")?.querySelector('[data-slot="embed-open"]') ?? null;
    await waitFor(() => button() !== null, "the image");
    await click(button());
    await waitFor(() => document.querySelector('[data-testid="viewer"]') !== null, "the viewer");
    expect(client?.state?.openImage?.path).toBe(join(set, "images", "fox.png"));
    expect(client?.state?.openDoc).toBeNull();
    await settle(() => {
      client?.send({ op: "image.close" });
    });
    await waitFor(() => button() !== null, "the document, and its image, again");
    expect(client?.state?.openDoc).toBe("a");
    await m.unmount();
  });

  test("a linked image follows its link, not the viewer", async () => {
    const m = await open("a.md");
    const button = () =>
      embed("The fox, linked")?.querySelector('[data-slot="embed-open"]') ?? null;
    await waitFor(() => button() !== null, "the linked image");
    await click(button());
    await waitFor(() => client?.state?.openDoc === "b", "the link's document");
    expect(client?.state?.openImage ?? null).toBeNull();
    await m.unmount();
  });

  test("missing, remote, SVG, a page named .png and a folder are placeholders that say why", async () => {
    const m = await open("a.md");
    await waitFor(
      () => embed("A missing picture")?.getAttribute("data-embed-state") === "not-shown",
      "the answers",
    );
    const said = (alt: string) => ({
      state: embed(alt)?.getAttribute("data-embed-state"),
      reason: embed(alt)?.getAttribute("data-embed-reason"),
      img: embed(alt)?.querySelector("img") ?? null,
      label: embed(alt)?.getAttribute("aria-label"),
    });
    expect(said("A missing picture")).toMatchObject({ state: "not-shown", img: null });
    expect(said("A missing picture").reason).toContain("Image not found: nothing at");
    expect(said("A missing picture").reason).toContain("nowhere.png");
    expect(said("A missing picture").label).toStartWith("A missing picture: Image not found");
    // Never asked about, never fetched.
    expect(said("Far away")).toMatchObject({ state: "remote", reason: EMBED_REMOTE, img: null });
    expect(said("A drawing")).toMatchObject({ state: "svg", reason: EMBED_SVG, img: null });
    expect(said("A page in disguise")).toMatchObject({ state: "not-shown", img: null });
    expect(said("A page in disguise").reason).toContain("is not a PNG, JPEG, WebP, GIF or AVIF");
    expect(said("")).toMatchObject({ state: "not-shown", img: null });
    expect(said("").reason).toContain("is a folder, not an image");
    // No `<img>` anywhere points at the page's own origin or another site.
    for (const img of document.querySelectorAll(".md-prose img"))
      expect(new URL(img.getAttribute("src") ?? "").pathname).toBe("/fs/thumb");
    await m.unmount();
  });
});

describe("a document without embeds", () => {
  test("renders as before and asks the daemon nothing about embeds", async () => {
    const m = await open("part/b.md");
    await settle(() => {});
    expect(document.querySelector(".md-prose .md-embed")).toBeNull();
    expect(document.querySelector(".md-prose")?.innerHTML).toBe("<h1>B</h1>\n");
    expect(sent.some((f) => f.op === "link.embeds")).toBe(false);
    await m.unmount();
  });
});
