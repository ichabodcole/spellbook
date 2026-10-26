// `testDom.waitFor` under a runner stall: the process is blocked past the
// wait's deadline while the awaited change arrives, and its callback is still
// queued when the helper wakes. The helper must look once more after that
// callback has run instead of failing. Each stall is a busy-wait, so these hold
// on an idle machine as well as a loaded one.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installDom, nativeGlobal, removeDom, waitFor } from "./testDom.ts";

beforeAll(() => {
  installDom();
});
afterAll(async () => {
  await removeDom();
});

/** Block the event loop, as a stalled runner does. */
const stall = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
};

let server: ReturnType<typeof Bun.serve> | null = null;
let client: WebSocket | null = null;
afterEach(() => {
  client?.close();
  client = null;
  server?.stop(true);
  server = null;
});

describe("waitFor after a stall", () => {
  test("a callback that came due during the stall still counts", async () => {
    let seen = false;
    // Due during the stall, and after the helper's own sleep: the helper wakes
    // first, past its deadline, with the change still queued behind it.
    setTimeout(() => {
      seen = true;
    }, 40);
    setTimeout(() => stall(300), 5);
    await expect(waitFor(() => seen, "the change", 50)).resolves.toBeUndefined();
  });

  test("a socket message sent during the stall still counts", async () => {
    let peer: { send(m: string): unknown } | null = null;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) =>
        srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 }),
      websocket: {
        open(ws) {
          peer = ws;
        },
        message() {},
      },
    });
    const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`ws://127.0.0.1:${server.port}/`);
    client = ws;
    await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
    await waitFor(() => peer !== null, "the server's side");
    let seen = false;
    ws.onmessage = () => {
      seen = true;
    };
    // The daemon's frame goes out, and the process stalls before it reads it:
    // between the helper's look and its reading of the clock.
    let stalled = false;
    const check = () => {
      if (!stalled) {
        stalled = true;
        peer?.send("ended");
        stall(300);
      }
      return seen;
    };
    await expect(waitFor(check, "the message", 50)).resolves.toBeUndefined();
  });
});
