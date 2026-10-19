// End session in the shell, over a REAL workspace daemon: the control confirms,
// then sends `close`, and the same dialog becomes the ended state with the
// restore command; cancelling sends nothing; closed, the dialog leaves an "Ended"
// chip in the top bar whose popover says it again; an end the agent made opens
// the ended dialog on its own; and the page does not open another socket.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../context/daemonClient.ts";
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
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let daemon: WorkspaceDaemon;
/** Every frame the page sent, and every socket it opened. */
let sent: { op?: string }[];
let sockets: number;
/** When set, a `close` frame is swallowed and the socket dropped instead, as a dying link would. */
let dropOnClose = false;
/** The page's daemon client, as the last render saw it. */
let client: Daemon | null = null;

beforeEach(async () => {
  root = tempRoot("shell-end");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  seedDocs(root);
  localStorage.clear();
  sent = [];
  sockets = 0;
  dropOnClose = false;
  client = null;
  daemon = fixtureDaemon({ tmp: join(root, "tmp") });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

const Native = () => nativeGlobal<typeof WebSocket>("WebSocket");

/** The real WebSocket, counted and with what it sends recorded. */
function Recording(url: string, protocols?: string | string[]) {
  sockets++;
  const ws = new (Native())(url, protocols);
  const send = ws.send.bind(ws);
  ws.send = (data) => {
    let frame: { op?: string } = {};
    try {
      frame = JSON.parse(String(data));
      sent.push(frame);
    } catch {
      /* not a frame */
    }
    if (dropOnClose && frame.op === "close") {
      ws.close();
      return;
    }
    send(data);
  };
  return ws;
}

/** A control that tries a write, as any sidebar or toolbar button would. */
function Probe() {
  const { daemon } = useWorkspace();
  return (
    <button
      type="button"
      data-testid="probe"
      onClick={() => daemon.send({ op: "say", text: "hi" })}
    >
      try a write
    </button>
  );
}

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: Recording as unknown as typeof WebSocket,
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<Probe />} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const control = () => q('[data-column-control="end-session"]') as HTMLButtonElement | null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const DIALOG = '[data-slot="session-end-dialog"]';
const dialog = () => q(DIALOG);
const dialogButton = (text: string) =>
  [...document.querySelectorAll(`${DIALOG} button`)].find((b) => b.textContent === text) ?? null;
const chip = () => q('[data-slot="ended-chip"]');
const closes = () => sent.filter((f) => f.op === "close").length;
const COMMAND = "bun /fixture/scripts/cli.ts open --restore";

async function askToEnd() {
  await waitFor(() => control() !== null && !control()?.disabled, "the control");
  await click(control());
  await waitFor(() => dialog() !== null, "the confirm");
}

/** Close the open dialog the way its X does. */
async function closeDialog() {
  await click(q(`${DIALOG} [data-slot="dialog-close"]`));
  await waitFor(() => dialog() === null, "the dialog gone");
}

describe("End session", () => {
  test("the control confirms, naming what happens, then sends close", async () => {
    const m = await mount(<Host />);
    await askToEnd();
    expect(dialog()?.getAttribute("data-phase")).toBe("confirm");
    expect(dialog()?.textContent ?? "").toContain(COMMAND);
    expect(closes()).toBe(0);
    await click(dialogButton("End session"));
    await waitFor(() => closes() === 1, "the close frame");
    await m.unmount();
  });

  test("cancelling sends nothing", async () => {
    const m = await mount(<Host />);
    await askToEnd();
    await click(dialogButton("Cancel"));
    await waitFor(() => dialog() === null, "the dialog gone");
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(closes()).toBe(0);
    expect(chip()).toBeNull();
    await m.unmount();
  });

  test("on confirm the same dialog becomes the ended state, with the command to copy, and nothing retries", async () => {
    const m = await mount(<Host />);
    await askToEnd();
    const asked = dialog();
    await click(dialogButton("End session"));
    await waitFor(() => dialog()?.getAttribute("data-phase") === "ended", "the ended state");
    // The same dialog, not a second one in its place.
    expect(dialog()).toBe(asked);
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Session ended");
    expect(text).toContain("You ended this session.");
    expect(q(`${DIALOG} [data-slot="restore-command"]`)?.textContent).toContain(COMMAND);
    expect(dialogButton("Copy command")).not.toBeNull();
    // No banner: the status bar says it, and the controls are what change.
    expect(q('[data-slot="session-ended"]')).toBeNull();
    expect(document.body.textContent).not.toContain("daemon unreachable");
    expect(q('[data-slot="shell-status"]')?.textContent).toContain("session ended");
    // No reconnect loop: well past several backoff periods, still one socket.
    await new Promise<void>((r) => setTimeout(r, 400));
    expect(sockets).toBe(1);
    await m.unmount();
  });

  test("closed, the dialog leaves an Ended chip where End session was; the chip's popover says it again", async () => {
    const m = await mount(<Host />);
    await askToEnd();
    await click(dialogButton("End session"));
    await waitFor(() => dialog()?.getAttribute("data-phase") === "ended", "the ended state");
    await closeDialog();
    expect(control()).toBeNull();
    // The dialog has no trigger left to return to: focus goes to the chip.
    await waitFor(() => document.activeElement === chip(), "focus on the chip");
    expect(chip()?.getAttribute("aria-label")).toBe("Session ended: how to keep working");
    expect(chip()?.closest('[data-slot="shell-top-bar"]')).not.toBeNull();
    await click(chip());
    await waitFor(() => q('[data-slot="ended-popover"]') !== null, "the popover");
    // A popover, not the dialog again.
    expect(dialog()).toBeNull();
    const pop = q('[data-slot="ended-popover"]');
    expect(pop?.textContent).toContain("You ended this session.");
    expect(pop?.querySelector('[data-slot="restore-command"]')?.textContent).toContain(COMMAND);
    await m.unmount();
  });

  test("an end the agent makes opens the ended dialog on its own, naming the agent", async () => {
    const m = await mount(<Host />);
    await waitFor(() => control() !== null && !control()?.disabled, "the control");
    await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "close" }),
    });
    await waitFor(() => dialog()?.getAttribute("data-phase") === "ended", "the ended dialog");
    expect(dialog()?.textContent).toContain("The agent ended this session.");
    expect(q(`${DIALOG} [data-slot="restore-command"]`)?.textContent).toContain(COMMAND);
    expect(chip()).not.toBeNull();
    await m.unmount();
  });

  test("after the end the composer says Session ended, and a write answers with a toast", async () => {
    const m = await mount(<Host />);
    await askToEnd();
    await click(dialogButton("End session"));
    await waitFor(() => chip() !== null, "the ended state");
    expect(q("textarea")?.getAttribute("placeholder")).toBe("Session ended");
    await closeDialog();
    await click(q('[data-testid="probe"]'));
    await waitFor(
      () => document.body.textContent?.includes("The session has ended") ?? false,
      "the toast",
    );
    await m.unmount();
  });

  test("with the daemon gone between opening and confirming, End session waits rather than hangs", async () => {
    const m = await mount(<Host />);
    await askToEnd();
    await daemon.stop();
    await waitFor(() => client?.connection === "closed", "the socket gone");
    const confirm = dialogButton("End session") as HTMLButtonElement | null;
    expect(confirm?.disabled).toBe(true);
    expect(dialog()?.getAttribute("data-phase")).toBe("confirm");
    await m.unmount();
  });

  test("a close the link drops on the way leaves the question open, saying why", async () => {
    dropOnClose = true;
    const m = await mount(<Host />);
    await askToEnd();
    await click(dialogButton("End session"));
    await waitFor(
      () => q('[data-slot="end-notice"]') !== null,
      "the dialog back on its question, with the reason",
    );
    expect(dialog()?.getAttribute("data-phase")).toBe("confirm");
    expect(q('[data-slot="end-notice"]')?.textContent).toContain("not answering");
    expect(dialogButton("Ending…")).toBeNull();
    await m.unmount();
  });

  test("a page that mounts already ended shows the chip and no dialog", async () => {
    const live = await mount(<Host />);
    await waitFor(() => client?.state != null, "a snapshot");
    const snapshot = client as Daemon;
    await live.unmount();
    const ended: Daemon = { ...snapshot, connection: "ended", endedBy: "agent" };
    const m = await mount(
      <div style={{ width: 1200, height: 700 }}>
        <WorkspaceShell daemon={ended} centre={<p>the centre</p>} />
      </div>,
    );
    await waitFor(() => chip() !== null, "the chip");
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(dialog()).toBeNull();
    expect(control()).toBeNull();
    await m.unmount();
  });

  test("Copy that the clipboard refuses selects the command and says to copy it", async () => {
    const m = await mount(<Host />);
    await askToEnd();
    await click(dialogButton("End session"));
    await waitFor(() => dialog()?.getAttribute("data-phase") === "ended", "the ended state");
    const nav = navigator as unknown as { clipboard?: unknown };
    const was = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    try {
      await click(q('[data-slot="copy-command"]'));
      await waitFor(
        () => q('[data-slot="copy-command"]')?.textContent === "Select and copy",
        "the fallback",
      );
      expect(window.getSelection()?.toString()).toContain(COMMAND);
    } finally {
      if (was) Object.defineProperty(navigator, "clipboard", was);
      else delete nav.clipboard;
    }
    // The ended description is the sentence and the command; Copy stands apart.
    const description = q(`${DIALOG} [data-slot="restore-command"]`)?.parentElement;
    expect(description?.querySelector('[data-slot="copy-command"]')).toBeNull();
    await m.unmount();
  });
});
