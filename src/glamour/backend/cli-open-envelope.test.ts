// The consumer's path to a boot failure is `cli.ts open`, not `bun run server.ts`.
// At an install that has NO dist/index.html and NO src/glamour/ (a surface-free
// destination whose artifact went missing), daemonCwd() resolves to a directory
// that does not exist, and node's spawn reports a MISSING CWD as a MISSING
// BINARY: "ENOENT … posix_spawn 'bun'" — while bun is the very thing running the
// CLI. A cold agent reads that envelope and reinstalls bun (comms #1265, #1268).
//
// This cell asserts the envelope on the CONSUMER path names the DIRECTORY.
// It is RED before cli.ts guards the cwd and GREEN after (authored by cassandra
// as the non-author of that guard; calibrated by a seat other than cassandra).
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ⛔ AN EXPLICIT SKILL ROOT, NOT A `..` COUNT. This file moved out of the skill's
// own `tests/`; the count that was right there is wrong here, and adjusting it is
// the repair that rots on the next relocation.
const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_SRC = join(BACKEND_DIR, "..", "..", "..", "plugins", "spellbook", "skills", "glamour");
const shipping = (dir: string) =>
  readdirSync(join(SKILL_SRC, dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

test("cli open at a destination with no dist/index.html and no src/glamour/ dies naming the missing DIRECTORY, not `bun`", async () => {
  // A copied tree: scripts/ + shared/ only. No dist/ at all, no surface/, and
  // — because the copy sits under tmpdir — no src/glamour/ four levels up.
  const root = mkdtempSync(join(tmpdir(), "glamour-cli-open-envelope-"));
  const tmp = mkdtempSync(join(tmpdir(), "glamour-cli-open-envelope-tmp-"));
  const home = mkdtempSync(join(tmpdir(), "glamour-cli-open-envelope-home-"));
  try {
    // ⛔ THE COPY IS THE LAUNCHER PLUS ITS BUNDLE, NOT A GLOB OF `scripts/`.
    // After the relocation `scripts/` holds two launchers and nothing else, and
    // each imports `../dist/<name>.js` — so a tree with `scripts/` and no `dist/`
    // fails at module resolution and never reaches the guard this cell is about.
    // `dist/cli.js` is copied (it is what `scripts/cli.ts` imports) and
    // `dist/index.html` deliberately is NOT: its absence is the whole premise.
    mkdirSync(join(root, "shared"), { recursive: true });
    for (const f of shipping("shared"))
      cpSync(join(SKILL_SRC, "shared", f), join(root, "shared", f));
    mkdirSync(join(root, "scripts"), { recursive: true });
    for (const f of ["cli.ts", "server.ts"])
      cpSync(join(SKILL_SRC, "scripts", f), join(root, "scripts", f));
    mkdirSync(join(root, "dist"), { recursive: true });
    for (const f of ["cli.js", "server.js"])
      cpSync(join(SKILL_SRC, "dist", f), join(root, "dist", f));
    // PRECONDITIONS, asserted so a fixture that accidentally has what it must
    // lack cannot pass the cell vacuously.
    expect(existsSync(join(root, "dist", "index.html"))).toBe(false);
    const surfaceCwd = join(root, "..", "..", "..", "..", "src", "glamour");
    expect(existsSync(surfaceCwd)).toBe(false);

    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        join(root, "scripts", "cli.ts"),
        "open",
        "--no-open",
        "--title",
        "x",
        "--intent",
        "logos",
      ],
      {
        cwd: root,
        // ⛔ THE MODE OVERRIDE IS EXPLICITLY CLEARED. This cell's whole premise is
        // that mode is AUTO-DETECTED — no `dist/index.html`, therefore dev,
        // therefore a cwd that does not exist, therefore the guard. An inherited
        // `SPELLBOOK_SURFACE_MODE` from the runner (or from a sibling suite in
        // the same `bun test` process) short-circuits the detection and this cell
        // silently tests nothing.
        env: {
          ...process.env,
          SPELLBOOK_SURFACE_MODE: undefined,
          GLAMOUR_HOME: home,
          TMPDIR: tmp,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(4000).then(() => "still-running" as const),
    ]);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).not.toBe("still-running");
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe(""); // no handshake — nothing downstream can read a URL off this
    const envelope = JSON.parse(stderr.trim().split("\n").at(-1) ?? "{}") as {
      ok?: boolean;
      error?: { kind?: string; message?: string };
    };
    expect(envelope.ok).toBe(false);
    const message = envelope.error?.message ?? "";
    // THE ASSERTION: the envelope names what is actually missing…
    expect(message).toContain("src/glamour");
    // …and does not blame the binary that just ran this CLI.
    expect(message).not.toContain("posix_spawn 'bun'");
    // And the failed open left no discovery pointer behind.
    expect(readdirSync(tmp).filter((f) => f.startsWith("glamour-"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
