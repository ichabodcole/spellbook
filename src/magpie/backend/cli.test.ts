// Unit tests for cli.ts helpers that don't need a running daemon, plus the
// end-to-end failure contract driven as a subprocess.
//
// ⛔ MOVED HERE FROM `plugins/spellbook/skills/magpie/tests/` IN SLICE 2, and it
// had to move: it imports the CLI's internals, and after the backend source
// relocated to `src/magpie/backend/` that import would have been a RELATIVE
// ESCAPE out of `plugins/spellbook/` — exactly what ward 1a forbids. A test
// lives with the source it imports; what it SPAWNS is a separate question,
// answered at `CLI` below.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, cutoutFilename, VERBS } from "./cli";

test("cutoutFilename: the raw crop keeps the bare name; each model gets its own file", () => {
  // crop = the bare name (back-compat with existing slice-phase files)
  expect(cutoutFilename("icon_image", "crop")).toBe("icon_image.png");
  // every removal model is suffixed → its own file, so versions can't overwrite
  // each other and don't collide in the browser cache (same URL = stale image)
  expect(cutoutFilename("icon_image", "rembg")).toBe("icon_image.rembg.png");
  expect(cutoutFilename("icon_image", "bria")).toBe("icon_image.bria.png");
  // crop vs a model → DISTINCT files (the bug this guards against)
  expect(cutoutFilename("x", "rembg")).not.toBe(cutoutFilename("x", "crop"));
  // names stay sanitized (traversal-safe)
  expect(cutoutFilename("a/b name", "rembg")).toBe("a_b_name.rembg.png");
});

// ── per-verb flag scoping (#acc-census) ─────────────────────────────
//
// A recorded-surface census found 289 flag/path pairs magpie accepted and could
// not act on: one global registry meant every verb took every other verb's
// flags at exit 0. These guard the scoping that replaced it.

test("flagsFor: a verb does not take another verb's flag", () => {
  // --bbox belongs to element-add. `say` used to accept it silently.
  expect(cli.flagsFor("say")).not.toContain("--bbox");
  // --pad belongs to extract.
  expect(cli.flagsFor("close")).not.toContain("--pad");
  // ...and the flag is still good where it belongs.
  expect(cli.flagsFor("extract")).toContain("--pad");
  expect(cli.flagsFor("element-add")).toContain("--bbox");
});

test("flagsFor: --session is accepted only where there is a session to target", () => {
  expect(cli.flagsFor("state")).toContain("--session");
  // open CREATES a session, so it has none to target.
  expect(cli.flagsFor("open")).not.toContain("--session");
  expect(cli.flagsFor("sessions")).not.toContain("--session");
});

test("the table is the roster: every verb dispatches and schema declares it", () => {
  // ONE TABLE, so the old binding test (VERB_SPEC vs the switch) has nothing
  // left to bind: the registry derives the dispatcher, help, `choices` and the
  // declaration from the same rows. What is left to pin is the roster itself.
  expect([...VERBS].sort()).toEqual(
    [
      "ask",
      "close",
      "cmd",
      "discover",
      "element-add",
      "element-remove",
      "export",
      "extract",
      "help",
      "info",
      "open",
      "say",
      "schema",
      "sessions",
      "source",
      "state",
      "status",
      "tail",
      "version",
    ].sort(),
  );
  const declared = cli
    .declaration()
    .commands.map((c) => c.path.join(" "))
    .filter(Boolean);
  expect(declared.sort()).toEqual([...VERBS].sort());
});

// ── the failure contract, end to end (#acc-B5/B1/C2) ────────────────
//
// The branch's whole point is a MACHINE-READABLE failure contract, and nothing
// gated it — every check above is a unit test of the parser, and the contract
// lives in what the PROCESS writes and exits with. Subprocess tests, so stdout
// emptiness and the exit code are observed rather than inferred.

// ⛔ THE SUBPROCESS CELLS DRIVE THE SHIPPED LAUNCHER, NOT THIS SOURCE, AND THAT
// IS THE POINT. The failure contract is what the installed PROCESS writes and
// exits with, so after Slice 2 the honest target is the path a consumer
// actually invokes: `scripts/cli.ts` -> `dist/cli.js` -> this module, bundled.
// Pointing these at the source here would test code that never ships alone.
// (The unit cells above import this source directly — deliberately the other
// half: parser behaviour is cheaper to pin before bundling than after.)
const CLI = new URL("../../../plugins/spellbook/skills/magpie/scripts/cli.ts", import.meta.url)
  .pathname;

// A private TMPDIR and MAGPIE_HOME, so a live session on this machine (its
// pointer is `$TMPDIR/magpie-latest.json`) is never the one a cell reaches:
// `extract --pad 4` against a real session would cut real slices.
const HOME = mkdtempSync(join(tmpdir(), "magpie-cli-test-"));

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: HOME, MAGPIE_HOME: HOME },
  });
  return {
    code: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

test.each([
  ["bare invocation", [] as string[], 2, "usage"],
  ["unknown verb", ["frobnicate"], 2, "usage"],
  ["unknown flag", ["state", "--acc-not-a-flag"], 2, "usage"],
  ["another verb's flag", ["say", "--bbox", "1,2,3,4"], 2, "usage"],
  ["no session to act on", ["extract", "--pad", "4"], 5, "not_found"],
  ["a flag before the verb", ["--session", "s1", "state"], 2, "usage"],
  ["cmd with no body", ["cmd"], 2, "usage"],
])("failure contract: %s", (_label, args, expectedCode, expectedKind) => {
  const r = run(args);
  // stdout carries DATA. A failure has none — a caller parsing stdout must see
  // nothing rather than a half-answer.
  expect(r.stdout).toBe("");
  expect(r.code).toBe(expectedCode);
  // Exactly ONE JSON document on stderr.
  const doc = JSON.parse(r.stderr);
  expect(doc.ok).toBe(false);
  expect(doc.error.kind).toBe(expectedKind);
  // The envelope's own exit_code must equal the code the process exited with —
  // an envelope that disagrees with its process is two claims about one failure.
  expect(doc.error.exit_code).toBe(r.code);
  expect(doc.error.retryable).toBe(false);
});

test.each([
  ["--version"],
  ["-V"],
  ["version"],
])("failure contract: %s is a data path, not a failure", (token) => {
  const r = run([token]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toEqual({ name: "magpie", version: expect.any(String) });
});
