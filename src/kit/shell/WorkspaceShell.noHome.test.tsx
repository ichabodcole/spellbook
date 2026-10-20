// The shell never asks for, or heads its context with, a single workspace. An
// app that declares no home workspace (`homeWorkspace: false`) has none to show;
// a snapshot that says there is none (`workspace: null`) is not a cue to block
// the session on choosing one; and even a daemon that does keep a home workspace
// gets no workspace row or heading from the shell, which never hands the sidebar
// a workspace. Over a REAL workspace daemon, and looked at again after an agent
// message and after a file dropped on the context pane, so a later pick from
// upstream that brings back a prompt, a dialog, a workspace heading, a pencil
// to change the folder, or the sidebar's workspace row turns this red, whatever
// words or element it uses.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../context/daemonClient.ts";
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
import { fixtureApp, fixtureDaemon } from "../workspace/fixtures/app";
import { cmd } from "../workspace/fixtures/harness";
import type { PublicState } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null = null;
let seen: Daemon | null = null;

beforeEach(() => {
  root = tempRoot("shell-no-home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  seen = null;
});
afterEach(async () => {
  await daemon?.stop().catch(() => {});
  daemon = null;
  rmSync(root, { recursive: true, force: true });
});

/** A daemon for an app with no home workspace, or (`home`) one whose workspace is `docs`. */
async function start(home = false) {
  daemon = home
    ? fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs })
    : fixtureDaemon({ tmp: join(root, "tmp"), app: { ...fixtureApp, homeWorkspace: false } });
  await daemon.start();
  return daemon;
}

/**
 * The shell over the daemon. `noWorkspace` hands the shell a snapshot that says
 * `workspace: null`, as a daemon with a workspace still to be chosen would.
 */
function Host({ noWorkspace = false }: { noWorkspace?: boolean }) {
  const d = useDaemon({
    url: `${(daemon as WorkspaceDaemon).url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  seen = d;
  const shown: Daemon =
    noWorkspace && d.state
      ? { ...d, state: { ...d.state, workspace: null } as unknown as PublicState }
      : d;
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={shown} centre={<div data-testid="centre" />} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const contextPane = () => q('[data-pane="context"]');

/**
 * What a single-workspace UX says, in any words: the workspace by name, a
 * request to choose a folder to start in or copy into, or a folder to change.
 * Not "copy them in" alone: the sidebar's own empty state says that of a drop.
 * Nor the picker's "Choose a folder with the file picker", which adds one to
 * the context where it lives.
 */
const WORKSPACE_UX =
  /workspace|choose (a|the|your|one) (folder|directory|place)(?! with the file picker)|change (the |this )?(folder|directory)/i;

/** Every word the context pane shows or says to a screen reader. */
function paneWords(): string {
  const pane = contextPane();
  if (!pane) return "";
  const said = [...pane.querySelectorAll("*")].flatMap((el) =>
    ["aria-label", "title", "placeholder", "aria-description"]
      .map((a) => el.getAttribute(a))
      .filter((v): v is string => !!v),
  );
  return [pane.textContent ?? "", ...said].join("\n");
}

/** Everything a single-workspace UX would put on screen, none of which may be there. */
function expectNoWorkspaceUx() {
  expect(q('[data-slot="workspace-prompt"]')).toBeNull();
  expect(q('[data-slot="workspace-title"]')).toBeNull();
  // No dialog of any kind is up: nothing blocks the session or asks.
  expect(q('[role="dialog"], [role="alertdialog"], dialog[open]')).toBeNull();
  // Nothing anywhere asks for a workspace or a folder to start in.
  expect(document.body.textContent ?? "").not.toMatch(WORKSPACE_UX);
  // The context pane names no workspace, in its text or its labels.
  expect(paneWords()).not.toMatch(WORKSPACE_UX);
  // It is headed by what it holds: the context, never a folder.
  expect(contextPane()?.textContent).toContain("Context");
}

async function shellUp() {
  await waitFor(() => seen?.connection === "open" && !!seen.state, "the snapshot");
  await waitFor(() => !!contextPane(), "the shell");
}

/** The agent says something: a heading or a prompt keyed on the chat would show now. */
async function agentSays() {
  const before = seen?.state?.chat.length ?? 0;
  await cmd((daemon as WorkspaceDaemon).url, { op: "say", text: "Here is a thought." });
  await waitFor(() => (seen?.state?.chat.length ?? 0) > before, "the agent's message");
  await settle(() => new Promise<void>((r) => setTimeout(r, 50)));
}

/** A file dragged over and dropped on the context pane, as from the Finder. */
async function dropOnContext() {
  const pane = contextPane();
  if (!pane) throw new Error("no context pane");
  const DT = (window as unknown as { DataTransfer?: new () => DataTransfer }).DataTransfer;
  const data = DT ? new DT() : null;
  try {
    data?.items.add(new window.File(["# Dropped\n"], "dropped.md", { type: "text/markdown" }));
  } catch {}
  const fire = (type: string) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: data });
    pane.dispatchEvent(ev);
  };
  await settle(() => {
    fire("dragenter");
    fire("dragover");
    fire("drop");
  });
  await settle(() => new Promise<void>((r) => setTimeout(r, 50)));
}

/** The whole check, at the start, after an agent message, and after a drop. */
async function holdsThroughout() {
  expectNoWorkspaceUx();
  await agentSays();
  expectNoWorkspaceUx();
  await dropOnContext();
  expectNoWorkspaceUx();
}

describe("the shell shows no single workspace", () => {
  test("an app with no home workspace: no prompt, no heading, no dialog, through a message and a drop", async () => {
    await start();
    const m = await mount(<Host />);
    await shellUp();
    expect(seen?.state?.workspace).toBeUndefined();
    await holdsThroughout();
    // Adding a set where it lives changes none of that.
    await settle(() => {
      seen?.send({ op: "context.add", path: join(docs, "set") });
    });
    await waitFor(() => (seen?.state?.context.length ?? 0) > 0, "the set in the context");
    expectNoWorkspaceUx();
    await m.unmount();
  });

  test("a snapshot that says `workspace: null` does not block the session on choosing one", async () => {
    await start();
    const m = await mount(<Host noWorkspace />);
    await shellUp();
    // Long enough for a prompt keyed on the snapshot to have mounted.
    await settle(() => new Promise<void>((r) => setTimeout(r, 50)));
    await holdsThroughout();
    await m.unmount();
  });

  test("a daemon that keeps a home workspace still gets no workspace row or heading from the shell", async () => {
    await start(true);
    const m = await mount(<Host />);
    await shellUp();
    // The daemon has one; the shell never hands it to the sidebar.
    expect(seen?.state?.workspace).toBe(docs);
    await holdsThroughout();
    await m.unmount();
  });
});
