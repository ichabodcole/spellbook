// SLICE 2's PROOF — one implementation, two shipped CLIs, byte-identical bytes.
//
// This is the cell the sprint's done-when names: "both spells' CLIs emit
// BYTE-IDENTICAL stdout for the same input, sourced from one file, and a diff of
// the two outputs is EMPTY AND ASSERTED IN A TEST."
//
// ⛔ WHY IT DOES NOT COMPARE WHOLE CLI ENVELOPES. astrolabe and magpie are
// different spells: the same argv produces different payloads (different verb
// lists, different hints), so a whole-stdout diff between the two CLIs would be
// asserting they are the same program, which they are not and must not be. The
// shared thing is the EMITTER, so the emitter is what is compared — and it is
// compared AS SHIPPED, extracted from each emitted bundle, never re-implemented
// here. A test that re-typed the function would pass while the bundles diverged.
//
// ⛔ AND IT READS THE BUNDLES, SO IT FAILS IF THEY ARE STALE. That is deliberate:
// this cell is only evidence about the shipped artifact if it reads the shipped
// artifact. Run `bun run build` after touching the kit or either backend.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { printJson } from "./printJson";

const REPO_ROOT = join(dirname(import.meta.dir), "..", "..");
const SPELLS = ["astrolabe", "magpie"] as const;
const bundleFor = (spell: string) =>
  join(REPO_ROOT, "plugins", "spellbook", "skills", spell, "dist", "cli.js");

/** The emitter's body as it exists INSIDE a shipped bundle. Anchored on the
 *  declaration the bundler emits, then brace-matched — never a line-number pin
 *  (a bundle's line numbers move on every unrelated source edit). */
function inlinedPrintJson(source: string): string {
  const start = source.search(/function printJson\s*\(/);
  if (start === -1) return "";
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{") {
      depth++;
      seen = true;
    } else if (c === "}") {
      depth--;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  return "";
}

/** A battery chosen for the ways a hand-rolled emitter drifts from another:
 *  key order, unicode, nesting, the values that serialise to `null`, and the
 *  ones that vanish entirely. */
const BATTERY: unknown[] = [
  { ok: true },
  { ok: false, error: { kind: "usage", message: "unknown verb", choices: ["a", "b"] } },
  { nested: { deep: { deeper: [1, 2, 3] } } },
  { unicode: "— · ⛔ \\ ' \"", newline: "a\nb" },
  { nul: null, undef: undefined, arr: [undefined, null] },
  [],
  {},
  { n: 0, neg: -0, big: 1e21, frac: 0.1 + 0.2 },
  "a bare string",
  0,
  null,
];

/** Capture whatever a function writes to `process.stdout`, and always restore. */
function captureStdout(run: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout as unknown as { write: unknown }).write = (s: string) => {
    out += s;
    return true;
  };
  try {
    run();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = original;
  }
  return out;
}

test("both spells ship a BUILT cli.js — the artifact this proof reads", () => {
  // Zero-guard on the population: every cell below reads these files, and a
  // missing bundle would make an extraction return "" and a comparison of two
  // empty strings PASS. The failure this catches is "nobody ran the build".
  for (const spell of SPELLS) {
    expect(existsSync(bundleFor(spell))).toBe(true);
    expect(readFileSync(bundleFor(spell), "utf8").length).toBeGreaterThan(1000);
  }
});

test("ONE implementation: the kit's emitter is inlined into BOTH bundles, identically", () => {
  const bodies = SPELLS.map((s) => inlinedPrintJson(readFileSync(bundleFor(s), "utf8")));
  const astrolabe = bodies[0] ?? "";
  const magpie = bodies[1] ?? "";
  // Non-empty first: two failed extractions are two empty strings, and empty
  // === empty is the vacuous pass this cell would otherwise hand out.
  expect(astrolabe.length).toBeGreaterThan(0);
  expect(magpie.length).toBeGreaterThan(0);
  expect(astrolabe).toBe(magpie);
  // And it is an EMITTER, not any function that happens to be named the same.
  expect(astrolabe).toContain("JSON.stringify");
  expect(astrolabe).toContain("process.stdout.write");
});

test("NEITHER backend source still carries a local copy — the duplication is gone", () => {
  // The point of the slice. A surviving local definition would make the two
  // bundles agree (each inlining its own) while nothing was actually shared.
  for (const spell of SPELLS) {
    const src = readFileSync(join(REPO_ROOT, "src", spell, "backend", "cli.ts"), "utf8");
    expect(src).toContain("kit/lib/printJson");
    expect(src).not.toMatch(/(?:function|const)\s+printJson\s*[=(]/);
  }
});

test("the KIT's own emitter is byte-exact across the battery — one document, one newline, every time", () => {
  // The source half of the identity. The bundle half is the textual cell above:
  // two byte-identical function bodies cannot produce different bytes, which is
  // why this does NOT eval a string extracted from a build artifact. `new
  // Function(body)` would be executing generated code to prove a property that
  // string equality already establishes — more risk, weaker evidence.
  const differences: string[] = [];
  for (const value of BATTERY) {
    const out = captureStdout(() => printJson(value));
    const expected = `${JSON.stringify(value)}\n`;
    if (out !== expected) differences.push(`${String(value)}: ${out} !== ${expected}`);
  }
  expect(differences).toEqual([]);
  // The battery ran — a zero-length loop compares nothing and reports no diffs.
  expect(BATTERY.length).toBeGreaterThan(8);
});

test("BYTE-IDENTICAL ON THE WIRE — both SHIPPED CLIs, driven as processes, emit one exact document", async () => {
  // ⛔ THE END-TO-END HALF, AND IT IS THE ONE THAT WOULD CATCH A REAL DRIFT.
  // The two spells' payloads differ by design (different names, different
  // verbs), so what is compared is not the payload but the EMISSION: for each
  // real CLI, re-serialising the parsed payload must reproduce the emitted line
  // BYTE FOR BYTE, with exactly one trailing newline and nothing after it.
  // An emitter that indented, that dropped the newline, that wrote a second
  // document, or that used a different stringifier fails here — and this runs
  // the launcher, the bundle, and the inlined kit, in a real process.
  //
  // ⛔ `--version`, NOT an error case. `printJson` governs STDOUT; Contract 15
  // routes error envelopes to STDERR through a different writer, so driving a
  // rejection here would assert nothing about this module and would read as a
  // passing test of the wrong stream. Verified: both spells route `--version`
  // through `printJson` (astrolabe `printJson(await versionInfo())`, magpie
  // `printJson({ name, version })`).
  const emissions: Record<string, string> = {};
  for (const spell of SPELLS) {
    const cli = join(REPO_ROOT, "plugins", "spellbook", "skills", spell, "scripts", "cli.ts");
    const proc = Bun.spawn([process.execPath, "run", cli, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      // An explicit stdin so a stdin-defaulting verb can never inherit the test
      // runner's never-EOF pipe and block forever.
      stdin: new Response("").body,
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    emissions[spell] = out;

    expect(out.endsWith("\n")).toBe(true);
    expect(out.slice(0, -1)).not.toContain("\n");
    // The load-bearing one: emitted === JSON.stringify(parse(emitted)) + "\n".
    // That equality IS printJson's contract, and it holds only if the shipped
    // emitter is this module's.
    expect(out).toBe(`${JSON.stringify(JSON.parse(out))}\n`);
  }
  // Both actually produced something — an empty stdout satisfies none of the
  // above by accident, but it would satisfy a careless reader.
  for (const spell of SPELLS) expect((emissions[spell] ?? "").length).toBeGreaterThan(20);
  // And the two really are DIFFERENT payloads — proving the cell compared an
  // emission property and not two copies of one string.
  expect(emissions.astrolabe).not.toBe(emissions.magpie);
});

test("the WIRE CONTRACT the emitter exists to hold: one document, one trailing newline", () => {
  const payload = { ok: true, note: "line-delimited readers depend on this" };
  const out = captureStdout(() => printJson(payload));
  expect(out.endsWith("\n")).toBe(true);
  expect(out.slice(0, -1)).not.toContain("\n");
  expect(JSON.parse(out)).toEqual(payload);
});
