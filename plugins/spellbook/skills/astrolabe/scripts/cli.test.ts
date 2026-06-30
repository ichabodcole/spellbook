import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fallbackAvatar } from "./state.ts";

// cli↔daemon integration (front-loads part of t8). Runs the cli as a subprocess
// against an auto-spawned daemon on an isolated $ASTROLABE_HOME, asserting both
// the stdout payload and the exit-code contract.

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

async function runCli(home: string, args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ASTROLABE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

describe("cli ↔ daemon", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "astrolabe-cli-"));
  });
  afterAll(async () => {
    await runCli(home, ["close"]);
    await Bun.sleep(300); // let the daemon finish teardown before we remove HOME
    rmSync(home, { recursive: true, force: true });
  });

  test("info on a cold machine reports not-running without spawning", async () => {
    const r = await runCli(home, ["info"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).running).toBe(false);
  });

  test("add registers a project, echoes the derived id, and auto-seeds the avatar", async () => {
    const r = await runCli(home, ["add", "Imago Layers", "--path", "~/imago", "--as", "kepler"]);
    expect(r.code).toBe(0);
    const resp = JSON.parse(r.out);
    expect(resp.applied).toBe(true);
    expect(resp.id).toBe("imago-layers"); // the derived id is echoed so join/status can use it

    const s = await runCli(home, ["state"]);
    const card = JSON.parse(s.out).state.projects[0];
    expect(card.id).toBe("imago-layers");
    expect(card.avatar).toBe(fallbackAvatar("Imago Layers"));
    expect(card.zone).toBe("quiet");
  });

  test("a duplicate registration is rejected on stderr with exit 2", async () => {
    const r = await runCli(home, ["add", "Imago Layers", "--path", "~/other"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe(""); // nothing on stdout
    expect(r.err).toMatch(/already registered|duplicate/);
  });

  test("status replaces the summary and surfaces it", async () => {
    expect((await runCli(home, ["status", "imago-layers", "phase 3", "--phase", "3/5"])).code).toBe(
      0,
    );
    const card = JSON.parse((await runCli(home, ["state"])).out).state.projects[0];
    expect(card.status.summary).toBe("phase 3");
    expect(card.status.phase).toBe("3/5");
  });

  test("attention raises the zone; clear lowers it", async () => {
    await runCli(home, ["attention", "imago-layers", "--question", "flatten?"]);
    let card = JSON.parse((await runCli(home, ["state"])).out).state.projects[0];
    expect(card.zone).toBe("attention");
    expect(card.question).toBe("flatten?");

    await runCli(home, ["attention", "imago-layers", "--clear"]);
    card = JSON.parse((await runCli(home, ["state"])).out).state.projects[0];
    expect(card.needsAttention).toBe(false);
  });

  test("poke is accepted for a known project, rejected (exit 2) for an unknown one", async () => {
    expect((await runCli(home, ["poke", "imago-layers"])).code).toBe(0);
    const ghost = await runCli(home, ["poke", "ghost"]);
    expect(ghost.code).toBe(2);
    expect(ghost.err).toMatch(/unknown project/);
  });

  test("list summarizes the registered projects", async () => {
    const r = await runCli(home, ["list"]);
    const parsed = JSON.parse(r.out);
    expect(parsed.running).toBe(true);
    expect(parsed.projects[0].id).toBe("imago-layers");
  });

  test("remove unregisters a project; an unknown id exits 2", async () => {
    await runCli(home, ["add", "Scratch Proj", "--path", "~/scratch"]);
    expect((await runCli(home, ["remove", "scratch-proj"])).code).toBe(0);
    const ids = JSON.parse((await runCli(home, ["state"])).out).state.projects.map(
      (p: { id: string }) => p.id,
    );
    expect(ids).not.toContain("scratch-proj");
    const ghost = await runCli(home, ["remove", "nope"]);
    expect(ghost.code).toBe(2);
    expect(ghost.err).toMatch(/unknown project/);
  });

  test("an unknown verb fails with exit 2", async () => {
    const r = await runCli(home, ["bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown verb/);
  });

  test("list guards a stale port file → exits 0 with running:false (no ECONNREFUSED)", async () => {
    // A leftover daemon.port from a crashed daemon must not make `list` throw —
    // the isUp() guard should fall back to the clean running:false path.
    const staleHome = mkdtempSync(join(tmpdir(), "astrolabe-stale-"));
    await Bun.write(join(staleHome, "daemon.port"), "59999"); // nothing listening there
    const r = await runCli(staleHome, ["list"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).running).toBe(false);
    rmSync(staleHome, { recursive: true, force: true });
  });
});
