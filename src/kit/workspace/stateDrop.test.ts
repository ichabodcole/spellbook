// A state frame Bun drops (`send` answers 0, its backpressure limit) must not
// leave that connection marked as holding a view it never got: the daemon
// tracks what each connection was sent (`viewSent` in server.ts), and a drop
// clears it, so the next frame carries the view whole. Bun's ServerWebSocket
// `send` is patched to drop one chosen frame; it is its own file because the
// patch is process-wide.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDaemonClient, type DaemonClient } from "../context/daemonClient";
import { fixtureDaemon } from "./fixtures/app";
import { FakeSurface, waitUntil } from "./fixtures/harness";
import { CONTEXT_CHANGED_SETTLE_MS, type WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

// Bun's ServerWebSocket prototype, from a throwaway server.
type Send = (this: unknown, data: unknown, ...rest: unknown[]) => number;
const proto = await new Promise<{ send: Send }>((resolve) => {
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, s) {
      return s.upgrade(req) ? undefined : new Response("x");
    },
    websocket: {
      open(ws) {
        resolve(Object.getPrototypeOf(ws));
        ws.close();
        setTimeout(() => srv.stop(true), 10);
      },
      message() {},
    },
  });
  new WebSocket(`ws://127.0.0.1:${srv.port}`);
});
const realSend = proto.send;
/** The next frame this matches is dropped (`send` answers 0), once. */
let dropNext: ((text: string) => boolean) | null = null;
proto.send = function (this: unknown, data: unknown, ...rest: unknown[]) {
  if (dropNext && typeof data === "string" && dropNext(data)) {
    dropNext = null;
    return 0;
  }
  return realSend.call(this, data, ...rest);
};

let root: string;
let daemon: WorkspaceDaemon | null;
let client: DaemonClient | null;
let surface: FakeSurface | null;

beforeEach(() => {
  root = tempRoot("state-drop");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  seedDocs(root);
  daemon = null;
  client = null;
  surface = null;
  dropNext = null;
});
afterEach(async () => {
  dropNext = null;
  client?.close();
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function boot(appState: () => unknown): Promise<WorkspaceDaemon> {
  const d = fixtureDaemon({
    tmp: join(root, "tmp"),
    workspace: join(root, "ws"),
    platform: "darwin",
    reveal: () => {},
    attentionMs: 60_000,
    appState,
  });
  await d.start();
  daemon = d;
  return d;
}

const viewOf = (s: unknown) => (s as { view?: string } | null | undefined)?.view;

describe("a dropped state frame", () => {
  test("a dropped whole frame: the next broadcast carries the view whole to that connection, and both clients converge", async () => {
    let view = "v1";
    const d = await boot(() => ({ view }));
    const c = createDaemonClient({ url: `${d.url}/ws`, minDelayMs: 5 });
    client = c;
    c.connect();
    const s = new FakeSurface();
    surface = s;
    await s.connect(d.port);
    await waitUntil("the client's hello", () => c.getSnapshot().state?.appState);
    await s.waitFor((m) => m.op === "state");

    // One copy of the frame carrying v2 is dropped: one connection misses it.
    view = "v2";
    dropNext = (t) => t.includes('"view":"v2"');
    d.context.broadcast();
    await waitUntil("the other connection's copy", () =>
      [viewOf(c.getSnapshot().state?.appState), viewOf(s.state.appState)].includes("v2"),
    );
    await Bun.sleep(50);
    const held = [viewOf(c.getSnapshot().state?.appState), viewOf(s.state.appState)];
    expect(held).toContain("v1"); // one of them really missed it
    expect(dropNext).toBeNull();

    // The view has not changed since: a daemon that counted the drop as sent
    // would mark it, and the connection that missed it would keep v1.
    d.context.broadcast();
    await waitUntil(
      "both converge",
      () => viewOf(c.getSnapshot().state?.appState) === "v2" && viewOf(s.state.appState) === "v2",
      3000,
    );
  });

  test("the watcher's refresh sends the view to the one connection that missed it, though the other holds it already", async () => {
    // The view reads a file in the context the session does not hold.
    const b = join(root, "docs", "set", "part", "b.md");
    const d = await boot(() => ({ view: readFileSync(b, "utf8").split("\n")[0] }));
    const s1 = new FakeSurface();
    const s2 = new FakeSurface();
    surface = s1;
    try {
      await s1.connect(d.port);
      await s2.connect(d.port);
      s1.send({ op: "context.add", path: join(root, "docs") });
      await waitUntil("the set listed", () => s2.state?.context.length > 0);
      await Bun.sleep(CONTEXT_CHANGED_SETTLE_MS + 300);
      // One copy of the refresh's frame is dropped: one connection is stale.
      dropNext = (t) => t.includes('"view":"# v2"');
      writeFileSync(b, "# v2\n");
      await waitUntil("the drop", () => dropNext === null, 3000);
      await waitUntil("the other copy", () =>
        [viewOf(s1.state.appState), viewOf(s2.state.appState)].includes("# v2"),
      );
      await Bun.sleep(50);
      expect([viewOf(s1.state.appState), viewOf(s2.state.appState)]).toContain("# B");
      // Another file changes; the view does not. The one that missed it is
      // stale, so the refresh must still send to it.
      writeFileSync(join(root, "docs", "set", "a.md"), "# A\n\nchanged\n");
      await waitUntil(
        "both converge",
        () => viewOf(s1.state.appState) === "# v2" && viewOf(s2.state.appState) === "# v2",
        3000,
      );
    } finally {
      s2.close();
    }
  });

  test("a dropped marked frame changes nothing the connection holds, and the next frame is whole", async () => {
    const d = await boot(() => ({ view: "same" }));
    const s = new FakeSurface();
    surface = s;
    await s.connect(d.port);
    await s.waitFor((m) => m.op === "state");
    const states = () => s.frames.filter((f) => f.op === "state").map((f) => f.state);
    dropNext = (t) => t.includes("appStateUnchanged");
    d.context.broadcast();
    await waitUntil("the drop", () => dropNext === null);
    d.context.broadcast();
    await waitUntil("a second frame", () => states().length >= 2);
    expect(states().at(-1)).toMatchObject({ appState: { view: "same" } });
    expect(viewOf(s.state.appState)).toBe("same");
  });
});
