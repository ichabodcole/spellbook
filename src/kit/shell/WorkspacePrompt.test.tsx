// The workspace is set on purpose (kit-workspace-set): a session without one opens
// on a prompt for it, over a REAL daemon, and changing it later asks first.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { useDaemon } from "../context/useDaemon.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../lib/testDom.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { FakeSurface, testWorkspace } from "../workspace/fixtures/harness";
import type { PublicState } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

let root: string;
let project: string;
let daemon: WorkspaceDaemon;
/** What the stand-in OS picker hands back. */
let picked: string[];

beforeEach(() => {
  root = tempRoot("workspace-prompt");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  project = join(root, "project");
  mkdirSync(join(project, "chapters"), { recursive: true });
  writeFileSync(join(project, "chapters", "one.md"), "# One\n");
  writeFileSync(join(project, "outline.md"), "# Outline\n");
  picked = [];
  localStorage.clear();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

async function start(workspace: string | undefined): Promise<void> {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    workspace,
    pick: async () => ({ paths: picked, cancelled: picked.length === 0 }),
  });
  await daemon.start();
}

type Ask = NonNullable<PublicState["workspaceAsk"]>;
/** Puts an agent's ask into the snapshot the shell sees, as a race past the daemon would. */
let injectAsk: (ask: Ask | null) => void = () => {};

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  const [ask, setAsk] = useState<Ask | null>(null);
  injectAsk = setAsk;
  const seen = ask && d.state ? { ...d, state: { ...d.state, workspaceAsk: ask } } : d;
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={seen} centre={<p>the centre</p>} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const prompt = () => q('[data-slot="workspace-prompt"]');
const box = () => q('input[aria-label="Workspace folder"]') as HTMLInputElement;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const enter = (el: HTMLInputElement) =>
  settle(() => {
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === text) ?? null;

describe("a session with no workspace", () => {
  test("opens on the prompt, and a folder typed there becomes the workspace and the tree", async () => {
    await start(undefined);
    const m = await mount(<Host />);
    await waitFor(() => !!prompt(), "the prompt");
    expect(prompt()?.textContent).toContain("Choose a workspace");
    expect(daemon.session.workspace).toBeNull();
    await typeInto(box(), project);
    await enter(box());
    await waitFor(() => !prompt(), "the prompt to go");
    expect(daemon.session.workspace).toBe(project);
    await waitFor(
      () => !!q('[data-pane="context"]')?.textContent?.includes("outline.md"),
      "the tree to show the workspace",
    );
    expect(q('[data-pane="context"]')?.textContent).toContain("chapters");
    await m.unmount();
  });

  test("a folder the daemon refuses is said in the prompt, which stays", async () => {
    await start(undefined);
    const m = await mount(<Host />);
    await waitFor(() => !!prompt(), "the prompt");
    // The daemon's stand-in home (the fixture never knows the real one).
    await typeInto(box(), daemon.session.home);
    await enter(box());
    await waitFor(() => !!prompt()?.querySelector('[role="alert"]'), "the refusal");
    expect(prompt()?.textContent).toContain("home folder");
    expect(daemon.session.workspace).toBeNull();
    await m.unmount();
  });

  test("the folder button opens the OS picker, and what it chooses is set", async () => {
    await start(undefined);
    picked = [project];
    const m = await mount(<Host />);
    await waitFor(() => !!prompt(), "the prompt");
    await click(
      prompt()?.querySelector('[aria-label="Choose a folder with the file picker"]') ?? null,
    );
    await waitFor(() => !prompt(), "the prompt to go");
    expect(daemon.session.workspace).toBe(project);
    await m.unmount();
  });
});

describe("changing the workspace", () => {
  test("asks first; Cancel keeps it, and confirming shows only the new folder's files", async () => {
    const before = testWorkspace(root, "before");
    writeFileSync(join(before, "old.md"), "# Old\n");
    await start(before);
    const m = await mount(<Host />);
    await waitFor(
      () => !!q('[data-pane="context"]')?.textContent?.includes("old.md"),
      "the first workspace",
    );
    expect(prompt()).toBeNull();
    const change = async () => {
      await click(q('[aria-label="Change the workspace folder"]'));
      await typeInto(box(), project);
      await enter(box());
      await waitFor(() => !!q('[data-slot="confirm-dialog"]'), "the question");
    };
    await change();
    expect(q('[data-slot="confirm-dialog"]')?.textContent).toContain("none of what it shows now");
    await click(button("Cancel"));
    await waitFor(() => !q('[data-slot="confirm-dialog"]'), "the question to go");
    expect(daemon.session.workspace).toBe(before);

    await change();
    await click(button("Change workspace"));
    await waitFor(
      () => !!q('[data-pane="context"]')?.textContent?.includes("outline.md"),
      "the new workspace",
    );
    expect(daemon.session.workspace).toBe(project);
    expect(q('[data-pane="context"]')?.textContent).not.toContain("old.md");
    await m.unmount();
  });

  test("the agent's change asks the human the same question, naming the agent, and waits for it", async () => {
    const before = testWorkspace(root, "before");
    writeFileSync(join(before, "old.md"), "# Old\n");
    await start(before);
    const m = await mount(<Host />);
    await waitFor(
      () => !!q('[data-pane="context"]')?.textContent?.includes("old.md"),
      "the first workspace",
    );
    const post = (path: string) =>
      fetch(`${daemon.url}/cmd`, {
        method: "POST",
        body: JSON.stringify({ op: "workspace.set", path }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(await post(project)).toMatchObject({ waiting: true });
    await waitFor(() => !!q('[data-slot="confirm-dialog"]'), "the question");
    expect(q('[data-slot="confirm-dialog"]')?.textContent).toContain("The agent asks");
    expect(daemon.session.workspace).toBe(before);
    // Declined: nothing changes.
    await click(button("Cancel"));
    await waitFor(() => !q('[data-slot="confirm-dialog"]'), "the question to go");
    await settle();
    expect(daemon.session.workspace).toBe(before);
    // Asked again and confirmed: changed.
    await post(project);
    await waitFor(() => !!q('[data-slot="confirm-dialog"]'), "the question again");
    await click(button("Change workspace"));
    await waitFor(() => daemon.session.workspace === project, "the change");
    await m.unmount();
  });

  test("an agent's ask while the human's own question is open is refused; the human's question stays", async () => {
    const before = testWorkspace(root, "before");
    writeFileSync(join(before, "old.md"), "# Old\n");
    await start(before);
    const m = await mount(<Host />);
    await waitFor(
      () => !!q('[data-pane="context"]')?.textContent?.includes("old.md"),
      "the first workspace",
    );
    await click(q('[aria-label="Change the workspace folder"]'));
    await typeInto(box(), project);
    await enter(box());
    await waitFor(() => !!q('[data-slot="confirm-dialog"]'), "the human's question");
    // The page tells the daemon its question is open as it opens; give that
    // frame a moment to arrive, then the agent asks once.
    await new Promise<void>((done) => setTimeout(done, 150));
    const r = await fetch(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "workspace.set", path: join(root, "tmp") }),
    });
    expect(r.status).toBe(409);
    expect(String(((await r.json()) as { error?: string }).error)).toContain("choosing");
    // The human's question is still theirs, unanswered, and their yes still counts.
    expect(q('[data-slot="confirm-dialog"]')?.textContent).toContain("Change the workspace?");
    expect(daemon.session.workspace).toBe(before);
    await click(button("Change workspace"));
    await waitFor(() => daemon.session.workspace === project, "the human's change");
    await m.unmount();
  });

  test("an ask that raced the human's own question is held behind it, never put over it", async () => {
    const before = testWorkspace(root, "before");
    writeFileSync(join(before, "old.md"), "# Old\n");
    await start(before);
    const m = await mount(<Host />);
    await waitFor(
      () => !!q('[data-pane="context"]')?.textContent?.includes("old.md"),
      "the first workspace",
    );
    await click(q('[aria-label="Change the workspace folder"]'));
    await typeInto(box(), project);
    await enter(box());
    await waitFor(() => !!q('[data-slot="confirm-dialog"]'), "the human's question");
    // The agent's ask reaches the page anyway (sent before the daemon heard).
    await settle(() => injectAsk({ id: "raced", path: join(root, "tmp"), from: before }));
    await settle();
    expect(q('[data-slot="confirm-dialog"]')?.textContent).toContain("Change the workspace?");
    expect(q('[data-slot="confirm-dialog"]')?.textContent).not.toContain("The agent asks");
    // Their answer is still theirs, and only then is the agent's shown.
    await click(button("Cancel"));
    await waitFor(
      () => !!q('[data-slot="confirm-dialog"]')?.textContent?.includes("The agent asks"),
      "the agent's question, after",
    );
    expect(daemon.session.workspace).toBe(before);
    await m.unmount();
  });
});

describe("an ask and the human's answer", () => {
  async function onBefore() {
    const before = testWorkspace(root, "before");
    writeFileSync(join(before, "old.md"), "# Old\n");
    await start(before);
    const m = await mount(<Host />);
    await waitFor(
      () => !!q('[data-pane="context"]')?.textContent?.includes("old.md"),
      "the first workspace",
    );
    return { before, m };
  }

  test("the human's yes settles a held ask: its question never shows after", async () => {
    const { before, m } = await onBefore();
    await click(q('[aria-label="Change the workspace folder"]'));
    await typeInto(box(), project);
    await enter(box());
    await waitFor(() => !!q('[data-slot="confirm-dialog"]'), "the human's question");
    await settle(() => injectAsk({ id: "held", path: join(root, "tmp"), from: before }));
    await click(button("Change workspace"));
    await waitFor(() => daemon.session.workspace === project, "the human's change");
    await new Promise<void>((done) => setTimeout(done, 400));
    expect(q('[data-slot="confirm-dialog"]')).toBeNull();
    await m.unmount();
  });

  test("an ask the daemon drops takes its question off the screen", async () => {
    const { m } = await onBefore();
    const r = await fetch(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "workspace.set", path: project }),
    });
    expect(r.status).toBe(200);
    await waitFor(
      () => !!q('[data-slot="confirm-dialog"]')?.textContent?.includes("The agent asks"),
      "the agent's question",
    );
    // Another page of the session sets the workspace: the daemon drops the ask.
    const other = new FakeSurface();
    await other.connect(daemon.port);
    other.send({ op: "workspace.set", path: join(root, "tmp") });
    await waitFor(() => daemon.session.workspace === join(root, "tmp"), "the other page's change");
    await waitFor(() => !q('[data-slot="confirm-dialog"]'), "the question to go");
    other.close();
    await m.unmount();
  });
});

describe("the first prompt counts as choosing", () => {
  test("while it is open the agent's set is refused, and the prompt stays", async () => {
    await start(undefined);
    const m = await mount(<Host />);
    await waitFor(() => !!prompt(), "the prompt");
    await new Promise<void>((done) => setTimeout(done, 150));
    const r = await fetch(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "workspace.set", path: project }),
    });
    expect(r.status).toBe(409);
    expect(String(((await r.json()) as { error?: string }).error)).toContain(
      "choosing a workspace",
    );
    expect(prompt()).not.toBeNull();
    expect(daemon.session.workspace).toBeNull();
    // The human's own choice goes through.
    await typeInto(box(), project);
    await enter(box());
    await waitFor(() => !prompt(), "the prompt to go");
    expect(daemon.session.workspace).toBe(project);
    await m.unmount();
  });
});
