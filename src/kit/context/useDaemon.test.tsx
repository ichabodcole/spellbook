// The hook over a REAL workspace daemon, mounted in a DOM: it connects on mount,
// renders the daemon's state, follows a change, and closes on unmount.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, nativeGlobal, removeDom, waitFor } from "../lib/testDom.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import type { Daemon } from "./daemonClient";
import { useDaemon } from "./useDaemon";

beforeAll(installDom);
afterAll(removeDom);

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;

beforeEach(() => {
  root = tempRoot("use-daemon");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  daemon = null;
});
afterEach(async () => {
  await daemon?.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Probe({ url, onDaemon }: { url: string; onDaemon: (d: Daemon) => void }) {
  const daemon = useDaemon({
    url,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  onDaemon(daemon);
  return (
    <p data-connection={daemon.connection}>
      {daemon.state ? `${daemon.state.app}:${daemon.state.context.length}` : "waiting"}
    </p>
  );
}

describe("useDaemon", () => {
  test("connects on mount, renders the state, and follows a change", async () => {
    daemon = fixtureDaemon({ tmp: join(root, "tmp") });
    await daemon.start();
    let latest: Daemon | null = null;
    const m = await mount(<Probe url={`${daemon.url}/ws`} onDaemon={(d) => (latest = d)} />);
    await waitFor(() => m.container.textContent === "kit-fixture:0", "the hello");
    expect(m.container.querySelector("p")?.getAttribute("data-connection")).toBe("open");
    (latest as Daemon | null)?.send({ op: "context.add", path: docs });
    await waitFor(() => m.container.textContent === "kit-fixture:1", "the context change");
    await m.unmount();
  });

  test("a request through the hook's own daemon resolves with its reply", async () => {
    daemon = fixtureDaemon({ tmp: join(root, "tmp") });
    await daemon.start();
    let latest: Daemon | null = null;
    const m = await mount(<Probe url={`${daemon.url}/ws`} onDaemon={(d) => (latest = d)} />);
    await waitFor(() => m.container.textContent === "kit-fixture:0", "the hello");
    const listing = await (latest as Daemon | null)?.listDir(docs);
    expect(listing?.entries.map((e) => e.name)).toContain("solo.md");
    await m.unmount();
  });

  test("unmounting closes the socket, and nothing reconnects afterwards", async () => {
    daemon = fixtureDaemon({ tmp: join(root, "tmp") });
    await daemon.start();
    const Native = nativeGlobal<typeof WebSocket>("WebSocket");
    const made: WebSocket[] = [];
    class Counting extends Native {
      constructor(url: string | URL) {
        super(url);
        made.push(this);
      }
    }
    function Counted() {
      const d = useDaemon({
        url: `${daemon?.url}/ws`,
        WebSocket: Counting,
        minDelayMs: 20,
        maxDelayMs: 60,
      });
      return <p>{d.state ? "hello" : "waiting"}</p>;
    }
    const m = await mount(<Counted />);
    await waitFor(() => m.container.textContent === "hello", "the hello");
    expect(made).toHaveLength(1);
    await m.unmount();
    await Bun.sleep(200);
    expect(made).toHaveLength(1);
    expect(made[0]?.readyState).toBeGreaterThanOrEqual(2);
  });

  test("send, request and importImage stay the same functions across snapshots and a reconnect", async () => {
    // The shell keys effects on these (a made document's open on `[done, send]`,
    // compare mode's `diff` on `send`): a fresh one per snapshot re-runs them on
    // every snapshot, and page and daemon volley `open` and `state` until unmount.
    daemon = fixtureDaemon({ tmp: join(root, "tmp") });
    await daemon.start();
    const port = daemon.port;
    const sessionId = daemon.sessionId;
    const seen: Daemon[] = [];
    const m = await mount(
      <Probe
        url={`${daemon.url}/ws`}
        onDaemon={(d) => {
          if (seen.at(-1) !== d) seen.push(d);
        }}
      />,
    );
    await waitFor(() => m.container.textContent === "kit-fixture:0", "the hello");
    seen.at(-1)?.send({ op: "context.add", path: docs });
    await waitFor(() => m.container.textContent === "kit-fixture:1", "the context change");
    await daemon.stop();
    await waitFor(
      () => m.container.querySelector("p")?.getAttribute("data-connection") === "closed",
      "closed",
    );
    daemon = fixtureDaemon({ tmp: join(root, "tmp"), port, restore: sessionId });
    await daemon.start();
    await waitFor(
      () => m.container.querySelector("p")?.getAttribute("data-connection") === "open",
      "open again",
      5000,
    );
    // Several snapshots, across the hello, a change, the close and the reopen.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const first = seen[0] as Daemon;
    for (const d of seen) {
      expect(d.send).toBe(first.send);
      expect(d.request).toBe(first.request);
      expect(d.importImage).toBe(first.importImage);
    }
    await m.unmount();
  });

  test("reconnects on its own when the daemon goes away and comes back", async () => {
    daemon = fixtureDaemon({ tmp: join(root, "tmp") });
    await daemon.start();
    const port = daemon.port;
    const sessionId = daemon.sessionId;
    const m = await mount(<Probe url={`${daemon.url}/ws`} onDaemon={() => {}} />);
    await waitFor(() => m.container.textContent === "kit-fixture:0", "the hello");
    await daemon.stop();
    await waitFor(
      () => m.container.querySelector("p")?.getAttribute("data-connection") === "closed",
      "closed",
    );
    daemon = fixtureDaemon({ tmp: join(root, "tmp"), port, restore: sessionId });
    await daemon.start();
    await waitFor(
      () => m.container.querySelector("p")?.getAttribute("data-connection") === "open",
      "open again",
      5000,
    );
    await m.unmount();
  });
});
