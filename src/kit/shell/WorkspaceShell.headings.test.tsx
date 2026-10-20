// Following a link to a heading from the chat, in the shell over a REAL
// workspace daemon (kit-heading-links-build): the daemon opens the document and
// says where the heading is, and the shell asks the centre to reveal it, the
// caret at the heading's start and its line to mark; a heading that is not
// there opens the document at the top, with a toast naming the heading.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { useWorkspace } from "../context/workspace.ts";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const B = "# B\n\nintro\n\n## The chakra / body-passage lens\n\nbody\n";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;

beforeEach(async () => {
  root = tempRoot("shell-headings");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "set", "part", "b.md"), B);
  localStorage.clear();
  client = null;
  daemon = fixtureDaemon({ tmp: join(root, "tmp") });
  await daemon.start();
  daemon.session.addContext(join(docs, "set"));
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** The centre: what the shell asks it to reveal, as text. */
function RevealProbe() {
  const w = useWorkspace();
  return <pre data-slot="reveal">{JSON.stringify(w.reveal)}</pre>;
}

function Host() {
  const d = useDaemon({ url: `${daemon.url}/ws`, minDelayMs: 20, maxDelayMs: 60 });
  client = d;
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<RevealProbe />} />
    </div>
  );
}

const reveal = () =>
  JSON.parse(document.querySelector('[data-slot="reveal"]')?.textContent || "null") as {
    doc: string;
    from: number;
    to: number;
    heading?: { from: number; to: number };
  } | null;
const openName = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.name;
const chatLink = (label: string) =>
  [...document.querySelectorAll('[data-pane="chat"] a')].find((a) => a.textContent === label) ??
  null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const say = async (said: string) => {
  await fetch(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify({ op: "say", text: said }),
  });
};

async function openA() {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(docs, "set", "a.md") });
  });
  await waitFor(() => openName() === "a.md", "a.md open");
  return m;
}

describe("a chat link to a heading", () => {
  test("opens the document and reveals the heading: the caret at its start, its line to mark", async () => {
    const m = await openA();
    await say("See [the lens](./part/b.md#The%20chakra%20/%20body-passage%20lens).");
    await waitFor(() => chatLink("the lens") !== null, "the chat link");
    await click(chatLink("the lens"));
    await waitFor(() => openName() === "b.md", "b.md open");
    await waitFor(() => reveal() !== null, "the reveal");
    const at = B.indexOf("## The chakra");
    expect(reveal()).toMatchObject({
      doc: "b",
      from: at,
      to: at,
      heading: { from: at, to: at + "## The chakra / body-passage lens".length },
    });
    await m.unmount();
  });

  test("a heading that is not there opens at the top and says which heading", async () => {
    const m = await openA();
    await say("See [gone](./part/b.md#The%20chakra%20lens).");
    await waitFor(() => chatLink("gone") !== null, "the chat link");
    await click(chatLink("gone"));
    await waitFor(() => openName() === "b.md", "b.md open");
    await waitFor(
      () => (document.body.textContent ?? "").includes("No heading “The chakra lens” in b.md"),
      "the toast",
    );
    await waitFor(() => reveal() !== null, "the reveal");
    expect(reveal()).toMatchObject({ doc: "b", from: 0, to: 0 });
    expect(reveal()?.heading).toBeUndefined();
    await m.unmount();
  });
});
