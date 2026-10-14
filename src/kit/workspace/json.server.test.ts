// The agent's path to a JSON document through the daemon (the kit-json-documents
// item): a version it writes that does not parse is said on the log, with
// where and why, and its activate and merge of one are refused with the same
// words; the human's Save is refused too, and the file is untouched.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, writeUntilSeen } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

const VALID = '{\n  "kind": "location"\n}\n';
const BROKEN = '{\n  "kind": "location",\n}\n';

let root: string;
let world: string;
let profile: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

beforeEach(() => {
  root = tempRoot("workspace-json-server");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  mkdirSync(join(world, "_meta", "profiles"), { recursive: true });
  profile = join(world, "_meta", "profiles", "location.json");
  writeFileSync(profile, VALID);
  daemon = null;
  surface = null;
  tail = null;
});
afterEach(async () => {
  surface?.close();
  await tail?.stop();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: join(root, "ws") });
  await daemon.start();
  tail = collectEvents(daemon.url);
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  await cmd(daemon.url, { op: "context.add", paths: [world] });
  return { base: daemon.url, s: surface, t: tail };
}

describe("the agent's version of a JSON document", () => {
  test("a version written that does not parse is said on the log; activate and merge refuse it", async () => {
    const { base, t } = await start();
    const made = await cmd(base, { op: "version.new", doc: profile, label: "try" });
    expect(made.status).toBe(200);
    const path = made.body.path as string;
    expect(path.endsWith(".json")).toBe(true);
    // version.new made the docs folder, whose watch is armed just now.
    const said = await writeUntilSeen(
      "json.invalid",
      () => writeFileSync(path, BROKEN),
      () => t.events.find((e) => e.type === "system" && e.fact === "json.invalid"),
    );
    expect(said).toMatchObject({ doc: "location", version: 2, path, line: 2, column: 21 });
    expect(String(said.text)).toContain(
      "v2 of location.json is not valid JSON (line 2, column 21:",
    );
    expect(String(said.text)).toContain(
      "Save, and your activate and merge, refuse it until it parses",
    );

    const act = await cmd(base, { op: "activate", doc: "location", version: 2 });
    expect(act.status).toBe(409);
    expect(JSON.stringify(act.body)).toContain(
      "v2 of location.json is not valid JSON, so it was not activated: line 2, column 21",
    );
    expect(daemon?.session.doc("location").active).toBe(1);

    const merge = await cmd(base, { op: "merge", doc: "location", against: 2, hunks: [1] });
    expect(merge.status).toBe(409);
    expect(JSON.stringify(merge.body)).toContain(
      "taking change 1 from v2 into v1 of location.json would leave invalid JSON (line 2, column 21",
    );
    expect(JSON.stringify(merge.body)).toContain("fix v2, or take fewer changes");
    expect(daemon?.session.readVersion("location", 1).text).toBe(VALID);

    // Fixed, it activates.
    writeFileSync(path, VALID.replace("location", "place"));
    const ok = await cmd(base, { op: "activate", doc: "location", version: 2 });
    expect(ok.status).toBe(200);
  });

  test("the human's Save of text that does not parse is refused; the file is unchanged", async () => {
    const { s } = await start();
    s.send({ op: "open", path: profile });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "edit", doc: "location", version: 1, text: BROKEN });
    await s.waitFor(() => s.state.docs[0]?.dirty === true);
    s.send({ op: "save", doc: "location" });
    const err = await s.waitFor((m) => m.op === "error");
    expect(String((err as { message?: unknown }).message)).toContain(
      "not valid JSON, so it was not saved: line 2, column 21",
    );
    expect(readFileSync(profile, "utf8")).toBe(VALID);
  });
});

describe("JSON outside the agent's own version", () => {
  test("an outside write of invalid JSON to the active version is kept, and said as json.invalid", async () => {
    const { s, t } = await start();
    s.send({ op: "open", path: profile });
    await s.waitFor((m) => m.op === "version.text");
    const active = s.state.docs[0]?.versions[0]?.path ?? "";
    // Open made the docs folder, whose watch is armed just now. The active
    // version is written back each time, so a repeat is kept as one more version.
    const kept = await writeUntilSeen(
      "active.outside",
      () => writeFileSync(active, BROKEN),
      () => t.events.find((e) => e.type === "system" && e.fact === "active.outside"),
    );
    const said = await t.waitFor((e) => e.type === "system" && e.fact === "json.invalid");
    expect(said).toMatchObject({ doc: "location", version: kept.preservedAs, line: 2, column: 21 });
  });

  test("renaming an open, empty document to .json gives it {} on disk and in the editor", async () => {
    const { s } = await start();
    const untitled = join(world, "Untitled.md");
    s.send({ op: "doc.create", dir: world });
    await s.waitFor(() => existsSync(untitled));
    s.send({ op: "open", path: untitled });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "rename", path: untitled, name: "fresh.json" });
    const pushed = await s.waitFor(
      (m) => m.op === "version.text" && (m as { text?: string }).text === "{}\n",
    );
    expect(pushed).toMatchObject({ version: 1 });
    expect(readFileSync(join(world, "fresh.json"), "utf8")).toBe("{}\n");
  });
});
