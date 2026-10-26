// The conversion, driven through Scriptorium's own LAUNCHERS (build first): a
// session the earlier Scriptorium wrote is restored, converted as it is read.
// The session is the one its own writer left on disk, captured before that
// writer was deleted at the cutover (`fixtures/shipped-today/`, the same
// capture `./convert.test.ts` reads), planted under a temp SCRIPTORIUM_HOME.
// Everything runs under that home and a temp TMPDIR, with the preload's
// scratch HOME; every daemon this file starts, it stops by its own session id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
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
const migrateEnv = {
  ...process.env,
  SCRIPTORIUM_HOME: home,
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
};
mkdirSync(join(root, "tmp"), { recursive: true });
// The folders the captured session names, under this file's root.
const docs = join(root, "docs");
mkdirSync(join(docs, "set"), { recursive: true });
mkdirSync(join(root, "ws"), { recursive: true });
writeFileSync(join(docs, "set", "a.md"), "# A\n");
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
const kitPointer = (id: string) => join(root, "tmp", `scriptorium.${id}.json`);

async function closeById(id: string) {
  const pid = pointerPid(kitPointer(id));
  if (pid === null) return;
  await run(migrateEnv, "close", "--session", id);
  await waitForExit(pid);
}

/** Place the captured session at `<home>/sessions/<id>`, its `@ROOT@` made this file's root. */
function plantShipped(id: string): void {
  const from = join(KIT_DIR, "fixtures", "shipped-today");
  const place = (rel: string) => {
    for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) place(r);
      else {
        const to = join(home, "sessions", id, r);
        mkdirSync(dirname(to), { recursive: true });
        const text = readFileSync(join(from, r), "utf8").replaceAll("@ROOT@", root);
        writeFileSync(
          to,
          r === "manifest.json" ? text.replace('"today"', JSON.stringify(id)) : text,
        );
      }
    }
  };
  place("");
}

let id = "";
const dir = () => join(home, "sessions", id);
const manifestText = () => readFileSync(join(dir(), "manifest.json"), "utf8");

beforeAll(() => {
  id = "shipped1";
  plantShipped(id);
  // The earlier Scriptorium's shape, as its writer left it.
  const m = JSON.parse(manifestText()) as Record<string, unknown>;
  expect(typeof m.createdAt).toBe("number");
  expect("appName" in m).toBe(false);
  expect(readdirSync(dir())).not.toContain(PRE_MIGRATE_FILE);
});

afterAll(async () => {
  await closeById(id);
  rmSync(root, { recursive: true, force: true });
});

describe("Scriptorium restores an earlier session converted", () => {
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
    expect(texts).toContainEqual(["agent", "message", "read the set"]);
    expect(texts).toContainEqual(["human", "message", "about this"]);
    const said = st.chat.find((m) => m.text.includes("converted from the shipped Scriptorium"));
    expect(said?.from).toBe("system");
    expect(said?.text).toContain(join(dir(), PRE_MIGRATE_FILE));
    // The shipped session's workspace is now an ordinary added folder.
    expect(st.context.map((e) => [e.root, e.membership])).toContainEqual([
      join(root, "ws"),
      "mirrored",
    ]);
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
});
