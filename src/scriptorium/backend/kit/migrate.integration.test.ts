// The conversion dry run (`SCRIPTORIUM_KIT_MIGRATE=1`), driven through
// Scriptorium's own LAUNCHERS (build first): a session the shipped Scriptorium
// wrote is restored by the kit path, converted as it is read. Everything runs
// under a temp SCRIPTORIUM_HOME and TMPDIR, with the preload's scratch HOME;
// every daemon this file starts, it stops by its own session id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
import { PRE_MIGRATE_FILE } from "../../../kit/workspace/manifestMigrate";
import type { PublicState } from "../../../kit/workspace/protocol";
import { scriptoriumApp } from "./app";

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  KIT_DIR,
  "..",
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "scriptorium",
  "scripts",
  "cli.ts",
);

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-migrate-")));
const home = join(root, "home");
const base = {
  ...process.env,
  SCRIPTORIUM_HOME: home,
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
};
delete (base as Record<string, string | undefined>).SCRIPTORIUM_KIT;
delete (base as Record<string, string | undefined>).SCRIPTORIUM_KIT_MIGRATE;
const shippedEnv = base;
const migrateEnv = { ...base, SCRIPTORIUM_KIT: "1", SCRIPTORIUM_KIT_MIGRATE: "1" };
mkdirSync(join(root, "tmp"), { recursive: true });
const docs = join(root, "docs");
mkdirSync(docs, { recursive: true });
writeFileSync(join(docs, "solo.md"), "# Solo\n");

type Run = { code: number; out: string; err: string };
async function run(env: Record<string, string | undefined>, ...args: string[]): Promise<Run> {
  const p = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
    cwd: docs,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}
const json = <T = Record<string, unknown>>(r: Run): T => {
  if (r.out.trim() === "")
    throw new Error(`the CLI printed nothing (exit ${r.code}); stderr: ${r.err || "(empty)"}`);
  return JSON.parse(r.out) as T;
};
const envelope = (r: Run) =>
  (JSON.parse(r.err) as { error: { kind: string; message: string; hint?: string } }).error;
const kitPointer = (id: string) => join(root, "tmp", `scriptorium.${id}.json`);
const shippedPointer = (id: string) => join(root, "tmp", `scriptorium-${id}.json`);

async function closeById(env: Record<string, string | undefined>, id: string, pointer: string) {
  const pid = pointerPid(pointer);
  if (pid === null) return;
  await run(env, "close", "--session", id);
  await waitForExit(pid);
}

let id = "";
const dir = () => join(home, "sessions", id);
const manifestText = () => readFileSync(join(dir(), "manifest.json"), "utf8");

beforeAll(async () => {
  // A session the shipped Scriptorium's own writer made, used, and closed.
  const s = await run(shippedEnv, "open", "--no-open", join(docs, "solo.md"));
  expect(s.code).toBe(0);
  id = json<{ session_id: string }>(s).session_id;
  expect((await run(shippedEnv, "say", "--session", id, "hello from the shipped one")).code).toBe(
    0,
  );
  await closeById(shippedEnv, id, shippedPointer(id));
}, 60_000);

afterAll(async () => {
  await closeById(migrateEnv, id, kitPointer(id));
  await closeById(shippedEnv, id, shippedPointer(id));
  rmSync(root, { recursive: true, force: true });
});

describe("the conversion dry run is off for real use", () => {
  test("refused without SCRIPTORIUM_HOME, and on the default ~/.scriptorium, before anything runs", async () => {
    const before = manifestText();
    const unset: Record<string, string | undefined> = { ...migrateEnv };
    delete unset.SCRIPTORIUM_HOME;
    for (const env of [
      unset,
      { ...migrateEnv, SCRIPTORIUM_HOME: join(String(process.env.HOME), ".scriptorium") },
    ]) {
      const r = await run(env, "open", "--no-open", "--restore", id);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      const e = envelope(r);
      expect(e.kind).toBe("usage");
      expect(e.message).toContain("SCRIPTORIUM_KIT_MIGRATE=1");
      expect(e.hint).toContain("scratch copy");
    }
    expect(manifestText()).toBe(before);
    expect(existsSync(join(String(process.env.HOME), ".scriptorium"))).toBe(false);
  });

  test("without SCRIPTORIUM_KIT the flag means nothing: the shipped Scriptorium restores its own session as ever", async () => {
    const r = await run(
      { ...shippedEnv, SCRIPTORIUM_KIT_MIGRATE: "1" },
      "open",
      "--no-open",
      "--restore",
      id,
    );
    expect(r.code).toBe(0);
    await closeById(shippedEnv, id, shippedPointer(id));
    const m = JSON.parse(manifestText()) as Record<string, unknown>;
    expect(typeof m.createdAt).toBe("number");
    expect("appName" in m).toBe(false);
    expect(readdirSync(dir())).not.toContain(PRE_MIGRATE_FILE);
  }, 30_000);
});

describe("the kit path, with the dry-run flag, restores a shipped session converted", () => {
  let original = "";
  let versionFiles: string[] = [];

  beforeAll(async () => {
    original = manifestText();
    versionFiles = readdirSync(join(dir(), "docs"), { recursive: true }).map(String).sort();
    const r = await run(migrateEnv, "open", "--no-open", "--restore", id);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  }, 60_000);

  test("the chat says it was converted, and the shipped messages read as the kit's", async () => {
    const st = json<PublicState>(await run(migrateEnv, "state", "--session", id));
    const texts = st.chat.map((m) => [m.from, m.type, m.text]);
    expect(texts).toContainEqual(["agent", "message", "hello from the shipped one"]);
    const said = st.chat.find((m) => m.text.includes("converted from the shipped Scriptorium"));
    expect(said?.from).toBe("system");
    expect(said?.text).toContain(join(dir(), PRE_MIGRATE_FILE));
    // The folder the shipped session opened in is now an ordinary added folder.
    expect(st.context.map((e) => [e.root, e.membership])).toContainEqual([docs, "mirrored"]);
  });

  test("one line says it was converted, and no second line says the slot was brought forward", async () => {
    // The converter writes the slot at the app's current version, so the same
    // restore has no slot migrate to run, and nothing to announce for it.
    const st = json<PublicState>(await run(migrateEnv, "state", "--session", id));
    const system = st.chat.filter((m) => m.from === "system").map((m) => m.text);
    expect(system.filter((t) => t.includes("converted from the shipped Scriptorium"))).toHaveLength(
      1,
    );
    expect(system.filter((t) => t.includes("brought forward from version"))).toEqual([]);
    expect((JSON.parse(manifestText()) as { app: unknown }).app).toMatchObject({
      version: scriptoriumApp.slot.version,
    });
  });

  test("the manifest is the kit's, the original is kept, and no version file moved", () => {
    const m = JSON.parse(manifestText()) as Record<string, unknown>;
    expect(m.appName).toBe("scriptorium");
    expect(typeof m.createdAt).toBe("string");
    expect(readFileSync(join(dir(), PRE_MIGRATE_FILE), "utf8")).toBe(original);
    expect(readdirSync(join(dir(), "docs"), { recursive: true }).map(String).sort()).toEqual(
      versionFiles,
    );
  });

  test("once converted, the shipped Scriptorium refuses it: why the dry run runs only on a copy", async () => {
    await closeById(migrateEnv, id, kitPointer(id));
    const r = await run(shippedEnv, "open", "--no-open", "--restore", id);
    expect(r.code).toBe(6);
    expect(envelope(r).message).toContain("SCRIPTORIUM_KIT=1");
  }, 30_000);
});
