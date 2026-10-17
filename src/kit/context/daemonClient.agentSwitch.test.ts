// The agent switching a document's version while the human's edit waits out its
// pause (`kit-agent-activate-pending-edit`). The agent's `activate` does not go
// through the human's client, so the client cannot send the edit first as it
// does before its own switch. Two orders can follow, and both are held here
// against a real daemon:
//
// - the state frame showing the new version reaches the client before the
//   write fires: the client sends the write anyway, naming the version it was
//   typed in, and reads a lazy buffer before the editor is swapped;
// - the write was sent before the client saw the switch: it reaches the daemon
//   after the switch.
//
// Either way the daemon takes the edit into the version it was typed in (or
// keeps it as a version of its own when that one changed or went since), and
// tells the human in the chat. The agent hears nothing new.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { cmd, collectEvents, waitUntil } from "../workspace/fixtures/harness";
import type { WorkspaceDaemon } from "../workspace/server";
import { LATE_EDIT_MS } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { createDaemonClient, type DaemonClient, EDIT_DEBOUNCE_MS, textKey } from "./daemonClient";
import { heldSocket } from "./heldSocket.fixture";

let root: string;
let ws: string;
let docs: string;
let daemon: WorkspaceDaemon;
let client: DaemonClient | null;

beforeEach(async () => {
  root = tempRoot("agent-switch");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // Story Studio's testWorkspace (a8776ab, its explicit-workspace model) is not
  // in this kit's harness: the folder it made, made here.
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  docs = seedDocs(ws);
  client = null;
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  // A test that failed while holding must not leave the next one's frames held.
  held.release();
  client?.close();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

const held = heldSocket();

async function connect(): Promise<DaemonClient> {
  const c = createDaemonClient({
    url: `${daemon.url}/ws`,
    minDelayMs: 20,
    maxDelayMs: 60,
    WebSocket: held.WebSocket,
  });
  client = c;
  c.connect();
  await waitUntil("the hello", () => c.getSnapshot().state);
  return c;
}

const docOf = (c: DaemonClient, slug: string) =>
  c.getSnapshot().state?.docs.find((d) => d.slug === slug);
const chat = (c: DaemonClient) => (c.getSnapshot().state?.chat ?? []).map((m) => m.text);
const fileOf = (c: DaemonClient, slug: string, n: number) =>
  docOf(c, slug)?.versions.find((v) => v.n === n)?.path as string;

/**
 * Open solo.md and give it a second version made by the agent, with a text of
 * its own, so an edit written into the wrong version shows. v1 stays active.
 */
async function soloWithTwo(c: DaemonClient) {
  c.getSnapshot().send({ op: "context.add", path: docs });
  await waitUntil("context", () => c.getSnapshot().state?.context.length);
  const frame = await c.getSnapshot().request({ op: "open", path: join(docs, "solo.md") });
  const slug = (frame as unknown as { doc: string }).doc;
  await cmd(daemon.url, { op: "version.new", doc: slug, body: "# Version two\n" });
  const doc = await waitUntil("v2", () => {
    const d = docOf(c, slug);
    return d && d.versions.length === 2 ? d : undefined;
  });
  expect(doc.active).toBe(1);
  return { slug, doc, v1: fileOf(c, slug, 1), v2: fileOf(c, slug, 2) };
}

/** One round trip: anything the daemon sent in answer to earlier frames has come back. */
const roundTrip = (c: DaemonClient, slug: string) =>
  c.getSnapshot().request({ op: "read", doc: slug, version: 1 });

describe("the agent activates another version while an edit waits", () => {
  test("the state frame first: the edit is saved to the version it was typed in, and the human is told", async () => {
    const c = await connect();
    const { slug, doc, v1, v2 } = await soloWithTwo(c);
    const tail = collectEvents(daemon.url, -1, { agent: true });
    const before = await waitUntil("the tail's backlog", () =>
      tail.events.length > 0 ? tail.events.length : undefined,
    );
    // The editor reads its buffer only when the write goes: the buffer is
    // swapped to v2's text once the client has seen v2 active, so a write read
    // after that would put v2's text into v1.
    let buffer = "# Typed in v1\n";
    expect(c.getSnapshot().writeText(doc, 1, () => buffer)).toBe(true);
    const r = await cmd(daemon.url, { op: "activate", doc: slug, version: 2 });
    expect(r.status).toBe(200);
    await waitUntil("v2 active here", () => docOf(c, slug)?.active === 2);
    buffer = "# Version two\n";
    await waitUntil("the edit in v1", () => readFileSync(v1, "utf8") === "# Typed in v1\n");
    await roundTrip(c, slug);
    expect(readFileSync(v2, "utf8")).toBe("# Version two\n");
    expect(docOf(c, slug)?.active).toBe(2);
    expect(c.getSnapshot().lastError).toBeNull();
    expect(c.getSnapshot().texts.get(textKey(slug, 1))).toBe("# Typed in v1\n");
    await waitUntil("the chat line", () =>
      chat(c).find(
        (t) => t === `Your last edit was saved to v1 of ${slug}; the agent made v2 active.`,
      ),
    );
    // Past the pause: nothing more is sent, and the agent heard only its switch.
    await Bun.sleep(EDIT_DEBOUNCE_MS + 100);
    expect(readFileSync(v1, "utf8")).toBe("# Typed in v1\n");
    const types = tail.events.slice(before).map((e) => e.type);
    await tail.stop();
    expect(types).toEqual(["activated"]);
  });

  test("the write first: an edit sent before the client saw the switch is saved, not refused", async () => {
    const c = await connect();
    const { slug, doc, v1, v2 } = await soloWithTwo(c);
    held.hold();
    expect(c.getSnapshot().writeText(doc, 1, "# Typed in v1\n")).toBe(true);
    await cmd(daemon.url, { op: "activate", doc: slug, version: 2 });
    // The client has not seen the switch: it sends the edit for v1 as it would
    // at the end of its pause, and the daemon gets it after the switch.
    expect(docOf(c, slug)?.active).toBe(1);
    c.getSnapshot().flushText(slug);
    held.release();
    await roundTrip(c, slug);
    expect(readFileSync(v1, "utf8")).toBe("# Typed in v1\n");
    expect(readFileSync(v2, "utf8")).toBe("# Version two\n");
    expect(c.getSnapshot().lastError).toBeNull();
    await waitUntil("v2 active here", () => docOf(c, slug)?.active === 2);
    await waitUntil("the chat line", () =>
      chat(c).find(
        (t) => t === `Your last edit was saved to v1 of ${slug}; the agent made v2 active.`,
      ),
    );
  });

  test("with nothing typed, the switch is as it was: no line about an edit, no file touched", async () => {
    const c = await connect();
    const { slug, v1 } = await soloWithTwo(c);
    const r = await cmd(daemon.url, { op: "activate", doc: slug, version: 2 });
    expect(r.body).toMatchObject({ ok: true, doc: slug, version: 2, previous: 1 });
    await waitUntil("v2 active here", () => docOf(c, slug)?.active === 2);
    await waitUntil("v2's text", () => c.getSnapshot().texts.get(textKey(slug, 2)));
    await Bun.sleep(EDIT_DEBOUNCE_MS + 100);
    await roundTrip(c, slug);
    expect(readFileSync(v1, "utf8")).toBe("# Solo\n");
    expect(chat(c).filter((t) => t.includes("last edit"))).toEqual([]);
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("the human's own switch still sends the edit first: no line about a late edit", async () => {
    const c = await connect();
    const { slug, doc, v1 } = await soloWithTwo(c);
    c.getSnapshot().writeText(doc, 1, "# Typed in v1\n");
    c.getSnapshot().send({ op: "activate", doc: slug, version: 2 });
    await roundTrip(c, slug);
    expect(readFileSync(v1, "utf8")).toBe("# Typed in v1\n");
    await waitUntil("v2 active here", () => docOf(c, slug)?.active === 2);
    expect(chat(c).filter((t) => t.includes("last edit"))).toEqual([]);
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("two switches in the window: the edit still lands in the version it was typed in", async () => {
    const c = await connect();
    const { slug, doc, v1 } = await soloWithTwo(c);
    await cmd(daemon.url, { op: "version.new", doc: slug, from: 1, body: "# Version three\n" });
    held.hold();
    c.getSnapshot().writeText(doc, 1, "# Typed in v1\n");
    await cmd(daemon.url, { op: "activate", doc: slug, version: 2 });
    await cmd(daemon.url, { op: "activate", doc: slug, version: 3 });
    held.release();
    await waitUntil("v3 active here", () => docOf(c, slug)?.active === 3);
    await waitUntil("the edit in v1", () => readFileSync(v1, "utf8") === "# Typed in v1\n");
    await roundTrip(c, slug);
    expect(readFileSync(fileOf(c, slug, 3), "utf8")).toBe("# Version three\n");
    expect(c.getSnapshot().lastError).toBeNull();
  });

  test("the version it was typed in changed after the switch: the edit is kept as a version of its own", async () => {
    const c = await connect();
    const { slug, doc, v1 } = await soloWithTwo(c);
    held.hold();
    c.getSnapshot().writeText(doc, 1, "# Typed in v1\n");
    await cmd(daemon.url, { op: "activate", doc: slug, version: 2 });
    // The agent rewrites v1's file with its own tools, as it may once v1 is not active.
    writeFileSync(v1, "# The agent's v1\n");
    c.getSnapshot().flushText(slug);
    held.release();
    await roundTrip(c, slug);
    const kept = await waitUntil("a third version", () => {
      const d = docOf(c, slug);
      return d && d.versions.length === 3 ? d.versions.find((v) => v.n === 3) : undefined;
    });
    expect(readFileSync(v1, "utf8")).toBe("# The agent's v1\n");
    expect(readFileSync(kept.path, "utf8")).toBe("# Typed in v1\n");
    expect(kept).toMatchObject({ by: "human", fromVersion: 1 });
    expect(docOf(c, slug)?.active).toBe(2);
    expect(c.getSnapshot().lastError).toBeNull();
    await waitUntil("the chat line", () =>
      chat(c).find(
        (t) =>
          t ===
          `Your last edit to v1 of ${slug} was kept as v3, because v1 changed after the switch; the agent made v2 active.`,
      ),
    );
  });

  test("the version it was typed in was deleted after the switch: the edit is kept as a version of its own", async () => {
    const c = await connect();
    const { slug, doc } = await soloWithTwo(c);
    held.hold();
    c.getSnapshot().writeText(doc, 1, "# Typed in v1\n");
    await cmd(daemon.url, { op: "activate", doc: slug, version: 2 });
    const del = await cmd(daemon.url, { op: "version.delete", doc: slug, version: 1 });
    expect(del.status).toBe(200);
    c.getSnapshot().flushText(slug);
    held.release();
    await roundTrip(c, slug).catch(() => {});
    const kept = await waitUntil("a version for the edit", () =>
      docOf(c, slug)?.versions.find((v) => v.n === 3),
    );
    expect(readFileSync(kept.path, "utf8")).toBe("# Typed in v1\n");
    expect(kept).toMatchObject({ by: "human", fromVersion: 2 });
    expect(c.getSnapshot().lastError).toBeNull();
    await waitUntil("the chat line", () =>
      chat(c).find(
        (t) =>
          t ===
          `Your last edit to v1 of ${slug} was kept as v3, because v1 was deleted after the switch; the agent made v2 active.`,
      ),
    );
  });
});

describe("the agent's other acts in the same window", () => {
  test("a version the agent makes copies the active text without the edit, and the edit still lands", async () => {
    const c = await connect();
    const { slug, doc, v1 } = await soloWithTwo(c);
    c.getSnapshot().writeText(doc, 1, "# Typed in v1\n");
    const r = await cmd(daemon.url, { op: "version.new", doc: slug });
    expect(r.status).toBe(200);
    await waitUntil("the edit in v1", () => readFileSync(v1, "utf8") === "# Typed in v1\n");
    await roundTrip(c, slug);
    expect(docOf(c, slug)?.active).toBe(1);
    expect(c.getSnapshot().lastError).toBeNull();
    expect(chat(c).filter((t) => t.includes("last edit"))).toEqual([]);
  });

  test("a merge into the active version: the edit typed over it still lands, with no error", async () => {
    const c = await connect();
    const { slug, doc, v1 } = await soloWithTwo(c);
    c.getSnapshot().writeText(doc, 1, "# Typed in v1\n");
    const r = await cmd(daemon.url, { op: "merge", doc: slug, against: 2, hunks: [1] });
    expect(r.status).toBe(200);
    await waitUntil("the edit in v1", () => readFileSync(v1, "utf8") === "# Typed in v1\n");
    await roundTrip(c, slug);
    expect(docOf(c, slug)?.active).toBe(1);
    expect(c.getSnapshot().lastError).toBeNull();
  });
});

describe("only an edit a switch just overtook is taken late", () => {
  /** An edit as any socket client may send one, past the client's own checks. */
  const rawEdit = (c: DaemonClient, slug: string, version: number, text: string) =>
    c.getSnapshot().send({ op: "edit", doc: slug, version, text });

  test("a version that was never active is refused, its file untouched", async () => {
    const c = await connect();
    const { slug, v2 } = await soloWithTwo(c);
    rawEdit(c, slug, 2, "# Over v2\n");
    await roundTrip(c, slug);
    await waitUntil("the refusal", () => c.getSnapshot().lastError);
    expect(readFileSync(v2, "utf8")).toBe("# Version two\n");
    expect(docOf(c, slug)?.versions.length).toBe(2);
  });

  test("a version that does not exist is refused, and none is made", async () => {
    const c = await connect();
    const { slug } = await soloWithTwo(c);
    rawEdit(c, slug, 99, "# Made up\n");
    await roundTrip(c, slug);
    await waitUntil("the refusal", () => c.getSnapshot().lastError);
    expect(docOf(c, slug)?.versions.length).toBe(2);
  });

  test("an edit arriving after the window is refused, and said, not saved", async () => {
    const c = await connect();
    const { slug, doc, v1 } = await soloWithTwo(c);
    held.hold();
    await cmd(daemon.url, { op: "activate", doc: slug, version: 2 });
    await Bun.sleep(LATE_EDIT_MS + 200);
    // The client has still not seen the switch, and sends an edit to v1 only now.
    c.getSnapshot().writeText(doc, 1, "# Typed in v1\n");
    c.getSnapshot().flushText(slug);
    held.release();
    await roundTrip(c, slug);
    await waitUntil("the refusal", () => c.getSnapshot().lastError);
    expect(readFileSync(v1, "utf8")).toBe("# Solo\n");
    expect(docOf(c, slug)?.versions.length).toBe(2);
  }, 15_000);

  test("after a daemon restart there is no record of the switch: a late edit is refused", async () => {
    const c = await connect();
    const { slug, v1 } = await soloWithTwo(c);
    await cmd(daemon.url, { op: "activate", doc: slug, version: 2 });
    await waitUntil("v2 active here", () => docOf(c, slug)?.active === 2);
    const { port, sessionId } = daemon;
    await daemon.stop();
    await waitUntil("closed", () => c.getSnapshot().connection !== "open");
    daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws, port, restore: sessionId });
    await daemon.start();
    await waitUntil("reconnected", () => c.getSnapshot().connection === "open");
    await waitUntil("the state", () => docOf(c, slug));
    rawEdit(c, slug, 1, "# Typed in v1\n");
    await roundTrip(c, slug);
    await waitUntil("the refusal", () => c.getSnapshot().lastError);
    expect(readFileSync(v1, "utf8")).toBe("# Solo\n");
    expect(docOf(c, slug)?.versions.length).toBe(2);
  });

  test("typed after the user's own click, before the switch is seen: saved, and said as theirs", async () => {
    const c = await connect();
    const { slug, doc, v1 } = await soloWithTwo(c);
    held.hold();
    // Nothing waits when the click sends the switch; the key comes just after.
    c.getSnapshot().send({ op: "activate", doc: slug, version: 2 });
    c.getSnapshot().writeText(doc, 1, "# Typed in v1\n");
    held.release();
    await waitUntil("v2 active here", () => docOf(c, slug)?.active === 2);
    await waitUntil("the edit in v1", () => readFileSync(v1, "utf8") === "# Typed in v1\n");
    await roundTrip(c, slug);
    expect(c.getSnapshot().lastError).toBeNull();
    await waitUntil("the chat line", () =>
      chat(c).find(
        (t) => t === `Your last edit was saved to v1 of ${slug} before you switched to v2.`,
      ),
    );
  });
});
