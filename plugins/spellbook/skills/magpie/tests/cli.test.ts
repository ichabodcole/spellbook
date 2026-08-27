// Pure unit tests for cli.ts helpers that don't need a running daemon.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cutoutFilename, parseArgs, VERB_SPEC } from "../scripts/cli";

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

test("parseArgs: a verb refuses another verb's flag", () => {
  // --bbox belongs to element-add. `say` used to accept it silently.
  expect(() => parseArgs(["--bbox", "1,2,3,4"], "say")).toThrow();
  // --pad belongs to extract.
  expect(() => parseArgs(["--pad", "4"], "close")).toThrow();
  // ...and the flag is still good where it belongs.
  expect(parseArgs(["--pad", "4"], "extract").flags.pad).toBe("4");
  expect(parseArgs(["--bbox", "1,2,3,4"], "element-add").flags.bbox).toBe("1,2,3,4");
});

test("parseArgs: --session is accepted only where there is a session to target", () => {
  expect(parseArgs(["--session", "abc"], "state").flags.session).toBe("abc");
  // open CREATES a session, so it has none to target.
  expect(() => parseArgs(["--session", "abc"], "open")).toThrow();
  expect(() => parseArgs(["--session", "abc"], "sessions")).toThrow();
});

test("VERB_SPEC is the dispatch switch — neither may grow a verb alone", () => {
  // THE BINDING THIS TABLE EXISTS TO BE. VERB_SPEC drives the verb set, the
  // rejection's `choices` and each verb's parser; the switch drives what runs.
  // Nothing in the type system ties them together, so a verb added to one and
  // not the other is exactly the drift the census was built to find — magpie
  // would advertise a verb it cannot run, or run one it will not name.
  const src = readFileSync(new URL("../scripts/cli.ts", import.meta.url), "utf8");
  const dispatch = src.slice(src.indexOf("switch (verb) {"));
  const cases = new Set(
    [...dispatch.matchAll(/^\s{4}case "([a-z-]+)":/gm)].map((m) => m[1] as string),
  );
  expect([...cases].sort()).toEqual(Object.keys(VERB_SPEC).sort());
});

// ── the failure contract, end to end (#acc-B5/B1/C2) ────────────────
//
// The branch's whole point is a MACHINE-READABLE failure contract, and nothing
// gated it — every check above is a unit test of the parser, and the contract
// lives in what the PROCESS writes and exits with. Subprocess tests, so stdout
// emptiness and the exit code are observed rather than inferred.

const CLI = new URL("../scripts/cli.ts", import.meta.url).pathname;

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
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

test("failure contract: --version is a data path, not a failure", () => {
  const r = run(["--version"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toEqual({ name: "magpie", version: expect.any(String) });
});
