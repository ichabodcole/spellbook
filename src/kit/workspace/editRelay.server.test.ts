// An edit typed in one surface reaches every other surface on the session
// (`kit-second-tab-misses-edits`), driven through the daemon in process with two
// sockets. The typing surface is not sent its own text back. Each relayed frame
// carries `editSeen`: the newest edit the daemon had taken from the surface it
// goes to, so a surface whose own edit is still on its way can keep its text.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import type { ServerOp } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
const surfaces: FakeSurface[] = [];

beforeEach(() => {
  root = tempRoot("edit-relay");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  mkdirSync(join(root, "tmp"), { recursive: true });
  daemon = null;
});
afterEach(async () => {
  for (const s of surfaces.splice(0)) s.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function surface(port: number): Promise<FakeSurface> {
  const s = new FakeSurface();
  await s.connect(port);
  surfaces.push(s);
  return s;
}

type TextFrame = Extract<ServerOp, { op: "version.text" }>;
const textsOf = (s: FakeSurface, text: string) =>
  s.frames.filter((f): f is TextFrame => f.op === "version.text" && f.text === text);
const chat = (s: FakeSurface) => s.state.chat.map((m) => m.text);

/** A plain say, waited for on every surface: each frame sent before it has been handled. */
async function settle(from: FakeSurface, all: FakeSurface[], text: string) {
  from.send({ op: "say", text, withSelection: false });
  for (const s of all) await waitUntil(`"${text}"`, () => chat(s).includes(text));
}

/** Two surfaces on one session, with solo.md open in both. */
async function twoOnSolo() {
  daemon = fixtureDaemon({ tmp: join(root, "tmp") });
  await daemon.start();
  const a = await surface(daemon.port);
  const b = await surface(daemon.port);
  a.send({ op: "context.add", path: docs });
  a.send({ op: "open", path: join(docs, "solo.md") });
  await waitUntil("solo open in b", () => b.state.docs.find((d) => d.slug === "solo"));
  const doc = a.state.docs.find((d) => d.slug === "solo");
  const path = doc?.versions.find((v) => v.n === doc.active)?.path as string;
  return { a, b, version: doc?.active as number, path };
}

describe("an edit reaches the other surfaces", () => {
  test("the other surface is sent the text; the typing one is not sent it back", async () => {
    const { a, b, version, path } = await twoOnSolo();
    a.send({ op: "edit", doc: "solo", version, text: "# typed in a\n", rid: 7 });
    const got = (await waitUntil("b gets it", () => textsOf(b, "# typed in a\n")[0])) as TextFrame;
    expect(got).toMatchObject({ doc: "solo", version, origin: "remote", editSeen: null });
    expect(got).not.toHaveProperty("requestId");
    expect(got).not.toHaveProperty("rev");
    await settle(a, [a, b], "after the edit");
    expect(textsOf(a, "# typed in a\n")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("# typed in a\n");
  });

  test("each frame carries the newest edit the daemon took from the surface it goes to", async () => {
    const { a, b, version } = await twoOnSolo();
    b.send({ op: "edit", doc: "solo", version, text: "# b first\n", rid: 3 });
    b.send({ op: "edit", doc: "solo", version, text: "# b second\n", rid: 5 });
    await waitUntil("a gets b's", () => textsOf(a, "# b second\n")[0]);
    // a has sent no edit: nothing taken from it.
    expect(textsOf(a, "# b first\n")[0]?.editSeen).toBeNull();
    expect(textsOf(a, "# b second\n")[0]?.editSeen).toBeNull();
    a.send({ op: "edit", doc: "solo", version, text: "# a over\n", rid: 9 });
    const got = (await waitUntil("b gets a's", () => textsOf(b, "# a over\n")[0])) as TextFrame;
    expect(got.editSeen).toBe(5);
    a.send({ op: "edit", doc: "solo", version, text: "# a again\n", rid: 11 });
    b.send({ op: "edit", doc: "solo", version, text: "# b last\n", rid: 6 });
    const back = (await waitUntil(
      "a gets b's last",
      () => textsOf(a, "# b last\n")[0],
    )) as TextFrame;
    expect(back.editSeen).toBe(11);
  });

  test("a third surface gets it too, and a surface that joins later starts with no edit taken", async () => {
    const { a, b, version } = await twoOnSolo();
    const c = await surface((daemon as WorkspaceDaemon).port);
    b.send({ op: "edit", doc: "solo", version, text: "# from b\n", rid: 2 });
    await waitUntil("a", () => textsOf(a, "# from b\n")[0]);
    const got = (await waitUntil("c", () => textsOf(c, "# from b\n")[0])) as TextFrame;
    expect(got.editSeen).toBeNull();
    await settle(b, [a, b, c], "settled");
    expect(textsOf(b, "# from b\n")).toEqual([]);
  });
});

describe("a refused edit", () => {
  test("still stamps what its surface is sent next: the surface waits on nothing", async () => {
    let refuse = true;
    daemon = fixtureDaemon({
      tmp: join(root, "tmp"),
      hooks: {
        beforeKitAct: (op) => {
          if (op === "edit" && refuse) throw new Error("not now");
        },
      },
    });
    await daemon.start();
    const a = await surface(daemon.port);
    const b = await surface(daemon.port);
    a.send({ op: "context.add", path: docs });
    a.send({ op: "open", path: join(docs, "solo.md") });
    await waitUntil("solo open in b", () => b.state.docs.find((d) => d.slug === "solo"));
    const version = a.state.docs.find((d) => d.slug === "solo")?.active as number;
    a.send({ op: "edit", doc: "solo", version, text: "# refused\n", rid: 8 });
    await waitUntil("the refusal", () =>
      a.frames.find((f) => f.op === "error" && (f as { requestId?: unknown }).requestId === 8),
    );
    refuse = false;
    b.send({ op: "edit", doc: "solo", version, text: "# from b\n", rid: 3 });
    const got = (await waitUntil("a gets b's", () => textsOf(a, "# from b\n")[0])) as TextFrame;
    expect(got.editSeen).toBe(8);
  });
});

describe("an edit rebased onto a link rewrite (`rev`)", () => {
  test("the typing surface is sent the rebased text too, stamped with that very edit; the other gets it with `rev`", async () => {
    const set = join(root, "world");
    mkdirSync(join(set, "places"), { recursive: true });
    writeFileSync(join(set, "places", "glade.md"), "# The Glade\n");
    writeFileSync(join(set, "keeper.md"), "# Keeper\n\nLives by [the Glade](./places/glade.md).\n");
    daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: root, platform: "darwin" });
    await daemon.start();
    const a = await surface(daemon.port);
    const b = await surface(daemon.port);
    a.send({ op: "context.add", path: set });
    a.send({ op: "open", path: join(set, "keeper.md") });
    const loaded = (await waitUntil("a's text", () =>
      a.frames.find((f) => f.op === "version.text" && f.origin === "load"),
    )) as TextFrame;
    await waitUntil("keeper in b", () => b.state.docs.find((d) => d.slug === loaded.doc));
    const r = await cmd(daemon.url, {
      op: "rename",
      path: join(set, "places", "glade.md"),
      name: "the-glade.md",
      updateLinks: true,
    });
    expect(r.status).toBe(200);
    // a's late write, typed over the text from before the rewrite (no `base`).
    a.send({
      op: "edit",
      doc: loaded.doc,
      version: loaded.version,
      text: `${loaded.text}Late line.\n`,
      rid: 42,
    });
    const rebased = "# Keeper\n\nLives by [the Glade](./places/the-glade.md).\nLate line.\n";
    const mine = (await waitUntil("a gets the rebased text", () =>
      textsOf(a, rebased).find((f) => f.editSeen !== undefined),
    )) as TextFrame;
    expect(mine.rev).toBeNumber();
    // Stamped with the edit it answers: a's client takes it, never passes it over.
    expect(mine.editSeen).toBe(42);
    const theirs = (await waitUntil("b gets it", () =>
      textsOf(b, rebased).find((f) => f.editSeen !== undefined),
    )) as TextFrame;
    expect(theirs.rev).toBe(mine.rev);
    expect(theirs.editSeen).toBeNull();
  });
});
