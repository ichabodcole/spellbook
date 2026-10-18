// The surface's connection against a REAL workspace daemon: the fixture app on
// an ephemeral port, the client in this process. Nothing here is mocked, because
// the contract worth holding is the wire's: the hello, the `requestId` the daemon
// echoes, the refusals, and the re-sync after a restart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { waitUntil } from "../workspace/fixtures/harness";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import {
  createDaemonClient,
  type DaemonClient,
  DaemonError,
  EDIT_DEBOUNCE_MS,
  textKey,
} from "./daemonClient";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
let client: DaemonClient | null;
const started: WorkspaceDaemon[] = [];

beforeEach(() => {
  root = tempRoot("daemon-client");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  daemon = null;
  client = null;
});
afterEach(async () => {
  client?.close();
  for (const d of started.splice(0)) await d.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

async function boot(overrides: Parameters<typeof fixtureDaemon>[0] = {}): Promise<WorkspaceDaemon> {
  const d = fixtureDaemon({ tmp: join(root, "tmp"), ...overrides });
  await d.start();
  started.push(d);
  return d;
}

async function connect(d: WorkspaceDaemon, opts: { minDelayMs?: number } = {}) {
  client = createDaemonClient({ url: `${d.url}/ws`, minDelayMs: 20, maxDelayMs: 60, ...opts });
  client.connect();
  await waitUntil("the hello", () => client?.getSnapshot().state);
  return client;
}

describe("the hello", () => {
  test("the first frame is the daemon's whole state, and the connection reads open", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const view = c.getSnapshot();
    expect(view.connection).toBe("open");
    expect(view.state?.app).toBe("kit-fixture");
    expect(view.state?.sessionId).toBe(daemon.sessionId);
    expect(view.state?.mode).toBe("dev");
    expect(view.state?.context).toEqual([]);
  });

  test("the snapshot is the same object until something changes, and subscribers hear of change", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const a = c.getSnapshot();
    expect(c.getSnapshot()).toBe(a);
    let heard = 0;
    c.subscribe(() => heard++);
    a.send({ op: "context.add", path: docs });
    await waitUntil("a state with context", () => c.getSnapshot().state?.context.length);
    expect(heard).toBeGreaterThan(0);
    expect(c.getSnapshot()).not.toBe(a);
  });

  test("GET /state adds the log's cursor and epoch to the same snapshot", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const snap = await c.getSnapshot().fetchSnapshot();
    expect(snap.sessionId).toBe(daemon.sessionId);
    expect(typeof snap.epoch).toBe("string");
    expect(snap.cursor).toBeGreaterThan(0);
    expect(snap.chatTotal).toBe(snap.chat.length);
  });
});

describe("requests", () => {
  test("a reply comes back on the id the request carried", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { request, send } = c.getSnapshot();
    const listing = await request({ op: "fs.list", path: docs });
    expect(listing.op).toBe("fs.list");
    const names = (listing as { entries: { name: string }[] }).entries.map((e) => e.name);
    expect(names).toContain("solo.md");
    expect(listing.requestId).toBeDefined();
    // The id a fire-and-forget send carries is echoed on its reply frame too.
    const seen: unknown[] = [];
    c.getSnapshot().onFrame((f) => {
      if (f.op === "fs.list") seen.push(f.requestId);
    });
    const id = send({ op: "fs.list", path: docs });
    expect(typeof id).toBe("number");
    await waitUntil("the echoed id", () => seen.includes(id));
  });

  test("ids are unique on a socket, in order", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { send } = c.getSnapshot();
    const ids = [send({ op: "fs.list", path: docs }), send({ op: "fs.list", path: docs })];
    expect(ids[1] as number).toBeGreaterThan(ids[0] as number);
  });

  test("an op that names a task keeps its own id as the subject, and the request id is separate", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { send, request } = c.getSnapshot();
    send({ op: "task.create", title: "outline" });
    const task = await waitUntil("the task", () => c.getSnapshot().state?.tasks[0]);
    const rid = send({ op: "task.cancel", id: task.id });
    expect(typeof rid).toBe("number");
    await waitUntil("cancelled", () => c.getSnapshot().state?.tasks[0]?.status === "cancelled");
    // A refusal comes back on the request id, never on the subject.
    const err = await request({ op: "note.edit", doc: "nope", id: "n-missing", body: "x" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DaemonError);
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("two requests about the same note at once are told apart", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { request } = c.getSnapshot();
    const op = { op: "note.edit", doc: "nope", id: "same", body: "x" } as const;
    const both = await Promise.all([request(op).catch((e) => e), request(op).catch((e) => e)]);
    expect(both.every((e) => e instanceof DaemonError)).toBe(true);
  });

  test("two requests in flight each get their own reply", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { listDir } = c.getSnapshot();
    const [a, b] = await Promise.all([listDir(docs), listDir(join(docs, "set"))]);
    expect(a.entries.map((e) => e.name)).toContain("solo.md");
    expect(b.entries.map((e) => e.name)).toContain("a.md");
    expect(b.entries.map((e) => e.name)).not.toContain("solo.md");
  });

  test("a refusal rejects the request with the daemon's words, and is not shown as a stray error", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { request } = c.getSnapshot();
    const err = await request({ op: "open", path: join(docs, "nope.md") }).catch((e) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).message.length).toBeGreaterThan(0);
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("a refusal that answers no request is the surface's lastError, until cleared", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    // A fire-and-forget op carries an id too, but nobody is waiting on it.
    c.getSnapshot().send({ op: "open", path: join(docs, "nope.md") });
    await waitUntil("lastError", () => c.getSnapshot().lastError);
    c.getSnapshot().clearError();
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("opening a document loads its text into texts, keyed by doc and version", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    c.getSnapshot().send({ op: "context.add", path: docs });
    await waitUntil("context", () => c.getSnapshot().state?.context.length);
    const frame = await c.getSnapshot().request({ op: "open", path: join(docs, "solo.md") });
    expect(frame.op).toBe("version.text");
    const f = frame as unknown as { doc: string; version: number; text: string };
    expect(c.getSnapshot().texts.get(textKey(f.doc, f.version))).toBe("# Solo\n");
    expect(c.getSnapshot().state?.openDoc).toBe(f.doc);
  });

  test("a structure op reports where it landed, to the sender and in `done`", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    c.getSnapshot().send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => c.getSnapshot().state?.context.length);
    const frame = await c.getSnapshot().request({ op: "doc.create", dir: join(docs, "set") });
    expect(frame.op).toBe("structure.done");
    const path = (frame as unknown as { path: string }).path;
    expect(path.startsWith(join(docs, "set"))).toBe(true);
    const done = c.getSnapshot().done;
    expect(done?.path).toBe(path);
    expect(done?.of).toBe("doc.create");
    expect(done?.seq).toBe(1);
  });

  test("a document made with `stay` lands with its text, and `done` never hears of it", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    c.getSnapshot().send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => c.getSnapshot().state?.context.length);
    const ask = () =>
      c.getSnapshot().request({
        op: "doc.create",
        dir: join(docs, "set"),
        name: "A seed",
        text: "A seed.\n",
        free: true,
        stay: true,
      });
    const one = (await ask()) as unknown as { op: string; path: string; stay?: boolean };
    expect(one.op).toBe("structure.done");
    expect(one.stay).toBe(true);
    expect(one.path).toBe(join(docs, "set", "A seed.md"));
    expect(readFileSync(one.path, "utf8")).toBe("A seed.\n");
    // Taken: the next free name, never a refusal or an overwrite.
    const two = (await ask()) as unknown as { path: string };
    expect(two.path).toBe(join(docs, "set", "A seed 2.md"));
    // The maker stays where it is: nothing to open or rename.
    expect(c.getSnapshot().done).toBeNull();
    expect(c.getSnapshot().state?.openDoc ?? null).toBeNull();
  });

  test("a request that nobody answers rejects at its timeout", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const err = await c
      .getSnapshot()
      .request({ op: "prefs.set", key: "k", value: "v" }, { timeoutMs: 80 })
      .catch((e) => e);
    expect((err as Error).message).toContain("no reply");
  });

  test("a request on a socket that is not open rejects at once, and send reports null", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const view = c.getSnapshot();
    c.close();
    expect(
      await view.request({ op: "fs.list", path: docs }).catch((e) => (e as Error).message),
    ).toBe("disconnected");
    expect(view.send({ op: "fs.list", path: docs })).toBeNull();
    expect(c.getSnapshot().connection).toBe("closed");
  });

  test("closing rejects a request still waiting", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const waiting = c
      .getSnapshot()
      .request({ op: "prefs.set", key: "k", value: "v" }, { timeoutMs: 5000 })
      .catch((e) => (e as Error).message);
    c.close();
    expect(await waiting).toBe("closed");
  });
});

describe("reconnecting", () => {
  test("a daemon that restarts on its port is picked up, and its state replaces the old", async () => {
    const first = await boot({ port: 0 });
    const port = first.port;
    const c = await connect(first);
    c.getSnapshot().send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => c.getSnapshot().state?.context.length);
    const sessionId = first.sessionId;

    await first.stop();
    await waitUntil("closed", () => c.getSnapshot().connection === "closed");
    // The last state stays on screen while the daemon is away.
    expect(c.getSnapshot().state?.sessionId).toBe(sessionId);

    const second = await boot({ port, restore: sessionId });
    expect(second.port).toBe(port);
    await waitUntil("open again", () => c.getSnapshot().connection === "open", 5000);
    // The hello on the new socket is the re-sync: the restored session, whole.
    await waitUntil("the restored state", () => c.getSnapshot().state?.context.length === 1);
    expect(c.getSnapshot().state?.sessionId).toBe(sessionId);
    // And the new socket works for requests.
    const listing = await c.getSnapshot().listDir(docs);
    expect(listing.entries.map((e) => e.name)).toContain("solo.md");
  });

  test("a restart into a different session does not keep the old session's texts", async () => {
    const first = await boot();
    const port = first.port;
    const c = await connect(first);
    c.getSnapshot().send({ op: "context.add", path: docs });
    await waitUntil("context", () => c.getSnapshot().state?.context.length);
    const f = await c.getSnapshot().request({ op: "open", path: join(docs, "solo.md") });
    const key = textKey((f as unknown as { doc: string }).doc, 1);
    expect(c.getSnapshot().texts.get(key)).toBe("# Solo\n");
    c.getSnapshot().noteText("solo", 1, "OLD SESSION TEXT");
    await first.stop();
    await waitUntil("closed", () => c.getSnapshot().connection === "closed");
    // The last texts stay on screen while the daemon is away.
    expect(c.getSnapshot().texts.size).toBeGreaterThan(0);
    const second = await boot({ port });
    expect(second.sessionId).not.toBe(first.sessionId);
    await waitUntil("the new session", () => c.getSnapshot().state?.sessionId === second.sessionId);
    expect(c.getSnapshot().texts.size).toBe(0);
    expect(c.getSnapshot().diff).toBeNull();
  });

  test("a reconnect to the same session also drops what was loaded, to be asked for again", async () => {
    const first = await boot();
    const port = first.port;
    const c = await connect(first);
    c.getSnapshot().noteText("solo", 1, "stale");
    await first.stop();
    await waitUntil("closed", () => c.getSnapshot().connection === "closed");
    await boot({ port, restore: first.sessionId });
    await waitUntil("open again", () => c.getSnapshot().connection === "open", 5000);
    expect(c.getSnapshot().texts.size).toBe(0);
  });

  test("requests in flight when the socket drops are rejected, not left waiting", async () => {
    const first = await boot();
    const c = await connect(first);
    const waiting = c
      .getSnapshot()
      .request({ op: "prefs.set", key: "k", value: "v" }, { timeoutMs: 5000 })
      .catch((e) => (e as Error).message);
    await first.stop();
    expect(await waiting).toBe("disconnected");
  });

  test("close is for good: nothing reconnects", async () => {
    const first = await boot();
    const c = await connect(first);
    c.close();
    await Bun.sleep(120);
    expect(c.getSnapshot().connection).toBe("closed");
  });

  test("listDir never rejects: a dropped socket answers with an error and no entries", async () => {
    const first = await boot();
    const c = await connect(first);
    const view = c.getSnapshot();
    c.close();
    expect(await view.listDir(docs)).toEqual({ entries: [], error: "disconnected" });
  });
});

describe("writeText", () => {
  /** Open solo.md and return its slug and the file its active version lives in. */
  async function openSolo(c: DaemonClient) {
    c.getSnapshot().send({ op: "context.add", path: docs });
    await waitUntil("context", () => c.getSnapshot().state?.context.length);
    const frame = await c.getSnapshot().request({ op: "open", path: join(docs, "solo.md") });
    const slug = (frame as unknown as { doc: string }).doc;
    const doc = await waitUntil("the doc", () =>
      c.getSnapshot().state?.docs.find((d) => d.slug === slug),
    );
    const path = doc.versions.find((v) => v.n === doc.active)?.path as string;
    return { slug, path };
  }
  const docOf = (c: DaemonClient, slug: string) =>
    c.getSnapshot().state?.docs.find((d) => d.slug === slug);

  test("a burst of writes is one edit: the last text, after the pause", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    for (const text of ["# S", "# So", "# Solo, edited\n"])
      expect(c.getSnapshot().writeText(doc, doc.active, text)).toBe(true);
    // Nothing has gone yet: the pause has not passed.
    expect(readFileSync(path, "utf8")).toBe("# Solo\n");
    await waitUntil("the edit", () => readFileSync(path, "utf8") === "# Solo, edited\n");
    // This viewer's own copy matches what it typed, and the doc is now unsaved.
    expect(c.getSnapshot().texts.get(textKey(slug, doc.active))).toBe("# Solo, edited\n");
    await waitUntil("dirty", () => docOf(c, slug)?.dirty);
  });

  test("the text may be a function, read only when it is sent", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    let reads = 0;
    const read = () => {
      reads++;
      return "# Lazy\n";
    };
    c.getSnapshot().writeText(doc, doc.active, read);
    c.getSnapshot().writeText(doc, doc.active, read);
    expect(reads).toBe(0);
    await waitUntil("the edit", () => readFileSync(path, "utf8") === "# Lazy\n");
    expect(reads).toBe(1);
  });

  test("after the session ends nothing is written or retried, and a human's act is answered", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    // A write is waiting out its pause when the session ends.
    expect(c.getSnapshot().writeText(doc, doc.active, "# Late\n")).toBe(true);
    c.getSnapshot().send({ op: "close" });
    await waitUntil("ended", () => c.getSnapshot().connection === "ended");
    expect(c.getSnapshot().endedBy).toBe("human");
    expect(c.getSnapshot().writeText(doc, doc.active, "# Later\n")).toBe(false);
    // Past the pause and the retry delay: still nothing written, and no new socket.
    await Bun.sleep(EDIT_DEBOUNCE_MS + 1200);
    expect(readFileSync(path, "utf8")).toBe("# Solo\n");
    expect(c.getSnapshot().connection).toBe("ended");
    // Ambient traffic is dropped quietly; a human's act says why it did nothing.
    expect(c.getSnapshot().send({ op: "select", selection: null })).toBeNull();
    expect(c.getSnapshot().lastError).toBeNull();
    expect(c.getSnapshot().send({ op: "say", text: "hi" })).toBeNull();
    expect(c.getSnapshot().lastError).toBe("The session has ended");
    await expect(c.getSnapshot().request({ op: "open", path })).rejects.toThrow("has ended");
  }, 15_000);

  test("only the active version is written: another is declined and nothing is sent", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    expect(c.getSnapshot().writeText(doc, doc.active + 1, "# Nope\n")).toBe(false);
    await Bun.sleep(EDIT_DEBOUNCE_MS + 150);
    expect(readFileSync(path, "utf8")).toBe("# Solo\n");
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("flushText sends at once, for one document or all", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    c.getSnapshot().writeText(doc, doc.active, "# Flushed\n");
    c.getSnapshot().flushText(slug);
    await waitUntil("the edit", () => readFileSync(path, "utf8") === "# Flushed\n");
    // Nothing is left pending: a second flush sends nothing new.
    c.getSnapshot().flushText();
  });

  test("a write typed on a render from before a switch goes to the version it was typed in", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    // The document as the editor last rendered it, with v1 active.
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    await fetch(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "version.new", doc: slug }),
    });
    await waitUntil("v2", () => (docOf(c, slug)?.versions.length ?? 0) === 2);
    c.getSnapshot().send({ op: "activate", doc: slug, version: 2 });
    await waitUntil("v2 active", () => docOf(c, slug)?.active === 2);
    // An editor still on that render writes v1, after the client has seen v2
    // activated (by another viewer, say: this client's own `activate` sends a
    // write queued before it first, as the next test holds). It is the human's
    // text typed in v1, so it goes at once, before the buffer is given v2's
    // text, and the daemon saves it to v1 (`daemonClient.agentSwitch.test.ts`).
    expect(c.getSnapshot().writeText(doc, doc.active, "# Late\n")).toBe(true);
    // A round trip: a refusal of the edit would have come back first.
    await c.getSnapshot().request({ op: "read", doc: slug, version: 1 });
    expect(readFileSync(path, "utf8")).toBe("# Late\n");
    expect(docOf(c, slug)?.active).toBe(2);
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("activating within the pause sends the pending write first, into the version it was typed in", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    await fetch(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "version.new", doc: slug }),
    });
    const doc = await waitUntil("v2", () => {
      const d = docOf(c, slug);
      return d && d.versions.length === 2 ? d : undefined;
    });
    expect(c.getSnapshot().writeText(doc, doc.active, "# Typed in v1\n")).toBe(true);
    // Straight after, well inside the pause: the write goes out with the
    // activate, ahead of it, so no timer and no runner's speed decides the order.
    c.getSnapshot().send({ op: "activate", doc: slug, version: 2 });
    // One round trip: a refusal of anything sent before it would have come back first.
    await c.getSnapshot().request({ op: "read", doc: slug, version: 1 });
    expect(readFileSync(path, "utf8")).toBe("# Typed in v1\n");
    expect(docOf(c, slug)?.active).toBe(2);
    expect(c.getSnapshot().lastError).toBeNull();
    expect(c.getSnapshot().texts.get(textKey(slug, 1))).toBe("# Typed in v1\n");
  });

  test("a new version made within the pause copies the pending write, and branching into it loses nothing", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    expect(c.getSnapshot().writeText(doc, doc.active, "# Before the branch\n")).toBe(true);
    c.getSnapshot().send({ op: "version.new", doc: slug, activate: true });
    await c.getSnapshot().request({ op: "read", doc: slug, version: 1 });
    const now = await waitUntil("v2 active", () => {
      const d = docOf(c, slug);
      return d?.active === 2 ? d : undefined;
    });
    expect(readFileSync(path, "utf8")).toBe("# Before the branch\n");
    const v2 = now.versions.find((v) => v.n === 2)?.path as string;
    expect(readFileSync(v2, "utf8")).toBe("# Before the branch\n");
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("deleting another version leaves the pending write to its pause: the active one is never deleted", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    await fetch(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "version.new", doc: slug }),
    });
    await waitUntil("v2", () => (docOf(c, slug)?.versions.length ?? 0) === 2);
    // v1 stays active; v2 is the one deleted.
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    expect(doc.active).toBe(1);
    expect(c.getSnapshot().writeText(doc, doc.active, "# Kept\n")).toBe(true);
    c.getSnapshot().send({ op: "version.delete", doc: slug, version: 2 });
    await waitUntil("v2 gone", () => docOf(c, slug)?.versions.length === 1);
    await waitUntil("the edit", () => readFileSync(path, "utf8") === "# Kept\n");
    await c.getSnapshot().request({ op: "read", doc: slug, version: 1 });
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("an op that would overtake a pending write sends it first, and a revert drops it", async () => {
    class FakeSocket {
      static last: FakeSocket;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {}
      deliver(frame: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    const client = createDaemonClient({
      url: "http://127.0.0.1:1/ws",
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    client.connect();
    await Bun.sleep(5);
    const sock = FakeSocket.last;
    const doc = { slug: "solo", active: 1 };
    const other = { slug: "duo", active: 1 };
    sock.deliver({ op: "state", state: { sessionId: "s", docs: [doc, other] } });
    const ops = () => sock.sent.map((s) => JSON.parse(s) as { op: string; doc?: string });
    const overtaking = [
      { op: "activate", doc: "solo", version: 2 },
      { op: "version.new", doc: "solo", activate: true },
      { op: "version.new", doc: "solo" },
      { op: "merge", doc: "solo", against: "original", hunks: [0] },
    ] as const;
    for (const op of overtaking) {
      sock.sent.length = 0;
      client.getSnapshot().writeText(doc, 1, `before ${op.op}`);
      client.getSnapshot().writeText(other, 1, "elsewhere");
      client.getSnapshot().send(op);
      // This document's write, then the op; another document's write still waits.
      expect(ops()).toMatchObject([{ op: "edit", doc: "solo" }, { op: op.op }]);
      client.getSnapshot().dropText("duo");
    }
    // Through `request` too, and a merge naming no document sends every pending write.
    sock.sent.length = 0;
    client.getSnapshot().writeText(doc, 1, "a");
    client.getSnapshot().writeText(other, 1, "b");
    void client
      .getSnapshot()
      .request({ op: "merge", against: "original", hunks: [0] })
      .catch(() => {});
    expect(ops().map((o) => o.op)).toEqual(["edit", "edit", "merge"]);
    // A revert discards unsaved work: the pending write is dropped, never sent after it.
    sock.sent.length = 0;
    client.getSnapshot().writeText(doc, 1, "discarded");
    client.getSnapshot().send({ op: "revert", doc: "solo" });
    client.getSnapshot().flushText();
    expect(ops()).toMatchObject([{ op: "revert" }]);
    client.close();
  });

  test("a write the socket could not take goes out on reconnect, before any re-read", async () => {
    daemon = await boot();
    const port = daemon.port;
    const sessionId = daemon.sessionId;
    const c = await connect(daemon);
    const { slug } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    const path = doc.versions.find((v) => v.n === doc.active)?.path as string;
    await daemon.stop();
    await waitUntil("closed", () => c.getSnapshot().connection !== "open");
    // Typed while the daemon is gone: held, and retried on a timer.
    c.getSnapshot().writeText(doc, doc.active, "# Typed offline\n");
    await Bun.sleep(EDIT_DEBOUNCE_MS + 100);
    expect(readFileSync(path, "utf8")).toBe("# Solo\n");
    const back = await boot({ port, restore: sessionId });
    await waitUntil("reconnected", () => c.getSnapshot().connection === "open");
    // What the surface does on a reconnect: ask for the text it just lost. The edit
    // went out first, so the reply carries it instead of the pre-edit text.
    const frame = await c.getSnapshot().request({ op: "read", doc: slug, version: doc.active });
    expect((frame as unknown as { text: string }).text).toBe("# Typed offline\n");
    expect(readFileSync(path, "utf8")).toBe("# Typed offline\n");
    expect(c.getSnapshot().texts.get(textKey(slug, doc.active))).toBe("# Typed offline\n");
    daemon = back;
  });

  test("an older text frame for a version with a write waiting is not taken", async () => {
    type Handler = (e: { data: string }) => void;
    class FakeSocket {
      static last: FakeSocket;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: Handler | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {}
      deliver(frame: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    const client = createDaemonClient({
      url: "http://127.0.0.1:1/ws",
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    client.connect();
    await Bun.sleep(5);
    const sock = FakeSocket.last;
    const doc = { slug: "solo", active: 1 };
    sock.deliver({ op: "state", state: { sessionId: "s", docs: [doc] } });
    client.getSnapshot().writeText(doc, 1, "newer");
    // A reply to an earlier `read` lands while the write waits: it must not replace the buffer's text.
    sock.deliver({ op: "version.text", doc: "solo", version: 1, text: "older", origin: "load" });
    expect(client.getSnapshot().texts.get(textKey("solo", 1))).toBeUndefined();
    client.getSnapshot().flushText("solo");
    expect(JSON.parse(sock.sent.at(-1) as string)).toMatchObject({ op: "edit", text: "newer" });
    expect(client.getSnapshot().texts.get(textKey("solo", 1))).toBe("newer");
    // With nothing waiting, a text frame is taken as before.
    sock.deliver({
      op: "version.text",
      doc: "solo",
      version: 1,
      text: "from disk",
      origin: "remote",
    });
    expect(client.getSnapshot().texts.get(textKey("solo", 1))).toBe("from disk");
    client.close();
  });

  // kit-read-reply-reverts-sent-edit: a text read before an edit this client has
  // already SENT (not one still waiting) used to replace the client's copy, and
  // the next keystroke sent the old text back, losing what was typed. A request
  // answered after the stale reply is the fence: one socket, in order.
  test("an edit sent in the same tick as a re-open keeps its text: the open's older reply is not taken", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    await c.getSnapshot().request({ op: "open", path: join(docs, "sibling.md") });
    // Back to solo: its text is held, so a surface shows it at once and the
    // human types; the open's reply is still on its way.
    c.getSnapshot().send({ op: "open", path: join(docs, "solo.md") });
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    expect(c.getSnapshot().writeText(doc, doc.active, "# Solo, typed\n")).toBe(true);
    c.getSnapshot().flushText(slug);
    await c.getSnapshot().listDir(docs);
    expect(readFileSync(path, "utf8")).toBe("# Solo, typed\n");
    expect(c.getSnapshot().texts.get(textKey(slug, doc.active))).toBe("# Solo, typed\n");
  });

  test("an edit sent while a `read` is in flight keeps its text: the read's older reply is not taken", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    // The pane asks for the text it does not have yet; the human types first.
    c.getSnapshot().send({ op: "read", doc: slug, version: doc.active });
    c.getSnapshot().writeText(doc, doc.active, "# Solo, typed\n");
    c.getSnapshot().flushText(slug);
    await c.getSnapshot().listDir(docs);
    expect(readFileSync(path, "utf8")).toBe("# Solo, typed\n");
    expect(c.getSnapshot().texts.get(textKey(slug, doc.active))).toBe("# Solo, typed\n");
    // A read sent after the edit is answered with the edit in it, and taken.
    await c.getSnapshot().request({ op: "read", doc: slug, version: doc.active });
    expect(c.getSnapshot().texts.get(textKey(slug, doc.active))).toBe("# Solo, typed\n");
  });

  test("only a reply to a request sent before the edit, for that version, is passed over", async () => {
    class FakeSocket {
      static last: FakeSocket;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {}
      deliver(frame: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    const client = createDaemonClient({
      url: "http://127.0.0.1:1/ws",
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    client.connect();
    await Bun.sleep(5);
    const sock = FakeSocket.last;
    const doc = { slug: "solo", active: 1 };
    sock.deliver({ op: "state", state: { sessionId: "s", docs: [doc] } });
    const text = (v = 1) => client.getSnapshot().texts.get(textKey("solo", v));
    const asked = client.getSnapshot().send({ op: "read", doc: "solo", version: 1 }) as number;
    client.getSnapshot().writeText(doc, 1, "typed");
    client.getSnapshot().flushText("solo");
    const edit = JSON.parse(sock.sent.at(-1) as string) as { op: string; rid: number };
    expect(edit.op).toBe("edit");
    expect(asked).toBeLessThan(edit.rid);
    const reply = { op: "version.text", doc: "solo", version: 1, origin: "load" };
    // Asked before the edit: read before the daemon took it. Passed over.
    sock.deliver({ ...reply, text: "older", requestId: asked });
    expect(text()).toBe("typed");
    // Another version is not the one typed in: taken.
    sock.deliver({ ...reply, version: 2, text: "v2", requestId: asked });
    expect(text(2)).toBe("v2");
    // The daemon's own news answers no request: taken.
    sock.deliver({ ...reply, text: "from disk", origin: "remote" });
    expect(text()).toBe("from disk");
    // Asked after the edit: the edit is in it. Taken.
    sock.deliver({ ...reply, text: "re-read", requestId: edit.rid + 1 });
    expect(text()).toBe("re-read");
    client.close();
  });

  test("an edit carries the newest rewritten text it took as its base, and a dropped one is not taken", async () => {
    class FakeSocket {
      static last: FakeSocket;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {}
      deliver(frame: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    const client = createDaemonClient({
      url: "http://127.0.0.1:1/ws",
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    client.connect();
    await Bun.sleep(5);
    const sock = FakeSocket.last;
    const doc = { slug: "solo", active: 1 };
    sock.deliver({ op: "state", state: { sessionId: "s", docs: [doc] } });
    const lastEdit = () => JSON.parse(sock.sent.at(-1) as string);
    // Dropped while a write waits: the edit goes out on no base.
    client.getSnapshot().writeText(doc, 1, "typed");
    sock.deliver({
      op: "version.text",
      doc: "solo",
      version: 1,
      text: "rewritten",
      origin: "remote",
      rev: 3,
    });
    client.getSnapshot().flushText("solo");
    expect(lastEdit()).toMatchObject({ op: "edit", text: "typed" });
    expect(lastEdit().base).toBeUndefined();
    // Taken with nothing waiting: the next edit says it was typed over rev 4.
    sock.deliver({
      op: "version.text",
      doc: "solo",
      version: 1,
      text: "kept",
      origin: "remote",
      rev: 4,
    });
    client.getSnapshot().writeText(doc, 1, "kept, and more");
    client.getSnapshot().flushText("solo");
    expect(lastEdit()).toMatchObject({ op: "edit", text: "kept, and more", base: 4 });
    client.close();
  });

  test("a reconnect (the daemon may have restarted, counting from 1 again) forgets the rewritten texts it took", async () => {
    class FakeSocket {
      static last: FakeSocket;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {}
      deliver(frame: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    const client = createDaemonClient({
      url: "http://127.0.0.1:1/ws",
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      minDelayMs: 1,
    });
    client.connect();
    await Bun.sleep(5);
    const first = FakeSocket.last;
    const doc = { slug: "solo", active: 1 };
    first.deliver({ op: "state", state: { sessionId: "s", docs: [doc] } });
    first.deliver({
      op: "version.text",
      doc: "solo",
      version: 1,
      text: "kept",
      origin: "remote",
      rev: 7,
    });
    // The daemon goes away and comes back.
    first.readyState = 3;
    first.onclose?.();
    await waitUntil("a new socket", () => FakeSocket.last !== first);
    await Bun.sleep(5);
    const second = FakeSocket.last;
    second.deliver({ op: "state", state: { sessionId: "s", docs: [doc] } });
    client.getSnapshot().writeText(doc, 1, "typed after the restart");
    client.getSnapshot().flushText("solo");
    const edit = JSON.parse(second.sent.at(-1) as string);
    expect(edit).toMatchObject({ op: "edit", text: "typed after the restart" });
    expect(edit.base).toBeUndefined();
    client.close();
  });

  test("close forgets what was pending", async () => {
    daemon = await boot();
    const c = await connect(daemon);
    const { slug, path } = await openSolo(c);
    const doc = docOf(c, slug) as NonNullable<ReturnType<typeof docOf>>;
    c.getSnapshot().writeText(doc, doc.active, "# Gone\n");
    c.close();
    await Bun.sleep(EDIT_DEBOUNCE_MS + 150);
    expect(readFileSync(path, "utf8")).toBe("# Solo\n");
  });
});

describe("the app's view, marked unchanged (StateFrame)", () => {
  test("against the real daemon: a broadcast that leaves the view alone keeps it, and a changed one replaces it", async () => {
    // The pair under test: this daemon marks an unchanged view, and this client
    // keeps it. A client that did not fold the mark would lose the view here.
    let view = "big".repeat(1000);
    daemon = await boot({ attentionMs: 60_000, appState: () => ({ view }) });
    const c = await connect(daemon);
    expect(c.getSnapshot().state?.appState).toEqual({ view });
    c.getSnapshot().send({ op: "context.add", path: docs });
    await waitUntil("the entry", () => (c.getSnapshot().state?.context.length ?? 0) === 1);
    expect(c.getSnapshot().state?.appState).toEqual({ view });
    view = "changed";
    daemon.context.broadcast();
    await waitUntil(
      "the changed view",
      () => (c.getSnapshot().state?.appState as { view?: string } | null)?.view === "changed",
    );
  });

  test("a marked frame keeps the view held; after a reconnect, the new hello's view is the one kept", async () => {
    class FakeSocket {
      static last: FakeSocket;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
      deliver(frame: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    const client = createDaemonClient({
      url: "http://127.0.0.1:1/ws",
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      minDelayMs: 1,
    });
    client.connect();
    await Bun.sleep(5);
    const held = () => client.getSnapshot().state;
    const first = FakeSocket.last;
    first.deliver({ op: "state", state: { sessionId: "s", docs: [], appState: { n: 1 } } });
    first.deliver({ op: "state", state: { sessionId: "s", docs: [], appStateUnchanged: true } });
    expect(held()?.appState).toEqual({ n: 1 });
    expect("appStateUnchanged" in (held() ?? {})).toBe(false);
    // An app with no view says so: null is a view, not a mark.
    first.deliver({ op: "state", state: { sessionId: "s", docs: [], appState: null } });
    expect(held()?.appState).toBeNull();
    first.deliver({ op: "state", state: { sessionId: "s", docs: [], appState: { n: 2 } } });

    // The daemon goes away and comes back: its hello is whole, and is kept.
    first.readyState = 3;
    first.onclose?.();
    await waitUntil("a new socket", () => FakeSocket.last !== first);
    await Bun.sleep(5);
    const second = FakeSocket.last;
    second.deliver({ op: "state", state: { sessionId: "s", docs: [], appState: { n: 3 } } });
    second.deliver({ op: "state", state: { sessionId: "s", docs: [], appStateUnchanged: true } });
    expect(held()?.appState).toEqual({ n: 3 });

    // A mark from another session has nothing of its own to keep: no view,
    // never the old session's.
    second.deliver({ op: "state", state: { sessionId: "t", docs: [], appStateUnchanged: true } });
    expect(held()?.appState).toBeNull();
    client.close();
  });
});
