// Tests for review.ts — parser, payload builder, port-suffix parser, and a
// reduced set of end-to-end subprocess tests covering the agent-facing
// contract. Pure-function coverage is intentionally exhaustive; HTTP handler
// internals are exercised through the subprocess tests rather than direct
// fetch-handler poking, because Bun's fetch handler is straightforward and
// the integration tests verify the contract that matters (exit codes, stdout
// JSON shape, stderr ready line).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPayload,
  htmlEscape,
  isoZNoMillis,
  parsePortFromSessionId,
  parseQuestions,
} from "./review.ts";

/**
 * ⛔ THE PROCESS SPAWNED IS THE LAUNCHER, NOT THIS DIRECTORY'S SOURCE (playbook
 * Phase B, B6.1). The contract these end-to-end cells assert is what the
 * PROCESS writes and exits with, and the process a caller runs is
 * `<skill>/scripts/review.ts` → `<skill>/dist/review.js`. Spawning
 * `src/digestify/backend/review.ts` would run a module whose whole path
 * arithmetic is anchored at an address it does not ship at — see `run()`'s
 * block in the source, and D57 for what that failure looks like when it is
 * driven (a confident exit 2 blaming the operator's cwd).
 *
 * ⚠ AND THE SKILL ROOT IS DERIVED FROM A MARKER, NOT COUNTED. `..` counted by
 * hand is the repair that rots, and a test whose spawn path is wrong fails as
 * "the daemon never answered".
 *
 * ⚠ ONE CONSTANT, ONE JOB. bounty's port recorded the trap: a single constant
 * used both to SPAWN a process and to READ the source with `Bun.file(...).text()`
 * silently re-points the source scans when it is moved to the launcher, and the
 * cells then fail as broken regexes rather than as a wrong file. Checked here —
 * `SCRIPT` is only ever spawned; nothing in this file reads it as text, and the
 * pure-function cells import from `./review.ts` directly.
 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function repoRoot(from: string): string {
  let d = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".anthill", "config.json"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`repo root marker (.anthill/config.json) not found above ${from}`);
}
const SKILL_ROOT = join(repoRoot(SCRIPT_DIR), "plugins", "spellbook", "skills", "digestify");
const SCRIPT = join(SKILL_ROOT, "scripts", "review.ts");

describe("parseQuestions", () => {
  test("single question block extracted", () => {
    const md = "Intro paragraph.\n\n::: question id=scope\nShould we split it?\n:::\n\nOutro.";
    const { transformed, questions } = parseQuestions(md);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({ id: "scope", prompt: "Should we split it?" });
    expect(transformed).toContain('data-qblock="scope"');
    expect(transformed).not.toContain(":::");
  });

  test("multiple question blocks preserve order", () => {
    const md =
      "::: question id=first\nFirst?\n:::\n\n" +
      "Middle.\n\n" +
      "::: question id=second\nSecond?\n:::\n";
    const { questions } = parseQuestions(md);
    expect(questions.map((q) => q.id)).toEqual(["first", "second"]);
  });

  test("question body can contain markdown", () => {
    const md = "::: question id=naming\nPick: `Foo`, `Bar`, or `Baz`?\n:::";
    const { questions } = parseQuestions(md);
    expect(questions[0].prompt).toBe("Pick: `Foo`, `Bar`, or `Baz`?");
  });

  test("no questions returns empty list (read-only mode is valid)", () => {
    const { transformed, questions } = parseQuestions("Just prose, no questions.");
    expect(questions).toEqual([]);
    expect(transformed).toBe("Just prose, no questions.");
  });

  test("duplicate id throws", () => {
    const md = "::: question id=x\nA?\n:::\n\n::: question id=x\nB?\n:::";
    expect(() => parseQuestions(md)).toThrow(/duplicate/i);
  });

  test("missing id throws", () => {
    expect(() => parseQuestions("::: question\nWhat?\n:::")).toThrow();
  });

  test("empty id throws", () => {
    expect(() => parseQuestions("::: question id=\nWhat?\n:::")).toThrow();
  });

  test("empty body throws", () => {
    expect(() => parseQuestions("::: question id=foo\n\n:::")).toThrow(/empty/i);
  });

  test("id accepts alphanumeric, hyphen, underscore", () => {
    const md = "::: question id=naming-v2\nQ?\n:::\n\n" + "::: question id=scope_a\nQ?\n:::";
    const { questions } = parseQuestions(md);
    expect(questions.map((q) => q.id)).toEqual(["naming-v2", "scope_a"]);
  });
});

describe("buildPayload", () => {
  test("contains title, markdown, and questions", () => {
    const p = buildPayload("Intro.\n\n::: question id=q1\nWhy?\n:::", {
      title: "Test Title",
      theme: "digestify",
      sessionId: "s",
      timeout: 1800,
    });
    expect(p.title).toBe("Test Title");
    expect(p.theme).toBe("digestify");
    expect(p.markdown).toContain('data-qblock="q1"');
    expect(p.questions).toEqual([{ id: "q1", prompt: "Why?" }]);
  });

  test("accepts theme variants", () => {
    for (const theme of ["digestify", "classic", "cthulhu"] as const) {
      const p = buildPayload("::: question id=q1\nQ?\n:::", {
        title: "T",
        theme,
        sessionId: "s",
        timeout: 1,
      });
      expect(p.theme).toBe(theme);
    }
  });

  test("is JSON serialisable", () => {
    const p = buildPayload("::: question id=q1\nQ?\n:::", {
      title: "T",
      theme: "digestify",
      sessionId: "s",
      timeout: 1,
    });
    expect(() => JSON.stringify(p)).not.toThrow();
  });

  test("includes session_id and timeout_seconds", () => {
    const p = buildPayload("::: question id=q1\nQ?\n:::", {
      title: "T",
      theme: "digestify",
      sessionId: "my-slug",
      timeout: 900,
    });
    expect(p.session_id).toBe("my-slug");
    expect(p.timeout_seconds).toBe(900);
  });
});

describe("parsePortFromSessionId", () => {
  test("extracts trailing -p<port>", () => {
    expect(parsePortFromSessionId("digestify-abc123-p61432")).toBe(61432);
  });
  test("returns null when no port marker", () => {
    expect(parsePortFromSessionId("digestify-abc123")).toBeNull();
  });
  test("returns null for empty id", () => {
    expect(parsePortFromSessionId("")).toBeNull();
  });
  test("rejects out-of-range port", () => {
    expect(parsePortFromSessionId("digestify-abc-p99999")).toBeNull();
  });
  test("only matches trailing marker", () => {
    expect(parsePortFromSessionId("digestify-p1234-suffix")).toBeNull();
  });
});

describe("htmlEscape", () => {
  test("escapes the five interesting chars", () => {
    expect(htmlEscape(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#x27;");
  });
  test("ampersand is escaped before the others so &lt; doesn't become &amp;lt;", () => {
    expect(htmlEscape("<&>")).toBe("&lt;&amp;&gt;");
  });
});

describe("isoZNoMillis", () => {
  test("strips milliseconds and ends in Z", () => {
    const s = isoZNoMillis(new Date("2026-05-21T23:01:59.123Z"));
    expect(s).toBe("2026-05-21T23:01:59Z");
  });
});

// ── End-to-end subprocess tests ─────────────────────────────────────────────

type ReadyInfo = { url: string; port: number; session_id: string; mode: "dev" | "release" };

async function spawnAndWaitForReady(
  args: string[],
  stdinText?: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; ready: ReadyInfo }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SCRIPT, "--no-open", ...args],
    stdin: stdinText !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdinText !== undefined) {
    proc.stdin.write(new TextEncoder().encode(stdinText));
    proc.stdin.end();
  }
  // Read stderr until we see the ready JSON line.
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("{") && line.includes('"port"') && line.includes('"url"')) {
        reader.releaseLock();
        return { proc, ready: JSON.parse(line) };
      }
      nl = buf.indexOf("\n");
    }
    if (done) break;
  }
  reader.releaseLock();
  throw new Error("subprocess didn't print ready line within 5s");
}

async function readStdout(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  return new Response(proc.stdout).text();
}

async function postSubmit(
  port: number,
  body: { answers: Record<string, unknown>; comments: unknown[] },
): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postCancel(port: number, sessionId?: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/cancel`, {
    method: "POST",
    body: sessionId === undefined ? "" : JSON.stringify({ sessionId }),
  });
}

// ── /cancel ends THIS session, not whoever holds the port ────────────────────
//
// Recovery re-binds the port encoded in the session id so a relaunched review
// lands on the same origin and inherits its localStorage draft. That leaves the
// user's OLD tab pointed at the same origin: closing it beaconed /cancel into
// the daemon that REPLACED it, and the restored review died with exit 130 the
// moment the user tidied up the tab it was restored from. Filed 2026-09-07 off
// the port's browser drive, fixed 2026-09-08.
describe("a departing tab can only cancel its own session", () => {
  test("a /cancel naming a DIFFERENT session is ignored — the daemon lives on", async () => {
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "3"],
      "::: question id=q1\nWhy?\n:::",
    );
    const res = await postCancel(ready.port, "digestify-deadbeef-p1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "stale-session" });
    // The proof is the EXIT CODE, not the response: 130 is "closed without
    // submitting" and 124 is the timeout failsafe. Before the fix this was 130.
    expect(await proc.exited).toBe(124);
  }, 10000);

  test("a /cancel naming the CURRENT session still ends it with 130", async () => {
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "10"],
      "::: question id=q1\nWhy?\n:::",
    );
    const res = await postCancel(ready.port, ready.session_id);
    expect(await res.json()).toEqual({ ok: true });
    expect(await proc.exited).toBe(130);
  }, 15000);

  test("a /cancel naming NOTHING is still honoured — the route stays hand-callable", async () => {
    // Deliberate: an id-less beacon can only come from a tab older than this
    // fix, and refusing it would break every direct caller of the route.
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "10"],
      "::: question id=q1\nWhy?\n:::",
    );
    await postCancel(ready.port);
    expect(await proc.exited).toBe(130);
  }, 15000);
});

describe("end-to-end via subprocess", () => {
  test("submit prints response JSON and exits 0", async () => {
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "5"],
      "::: question id=q1\nWhy?\n:::",
    );
    await postSubmit(ready.port, { answers: { q1: "because" }, comments: [] });
    const stdout = await readStdout(proc);
    const code = await proc.exited;
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.answers).toEqual({ q1: "because" });
    expect(payload.comments).toEqual([]);
    expect(payload.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }, 15000);

  test("cancel exits 130", async () => {
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "5"],
      "::: question id=q1\nQ?\n:::",
    );
    await postCancel(ready.port);
    const code = await proc.exited;
    expect(code).toBe(130);
  }, 15000);

  test("timeout exits 124", async () => {
    const { proc } = await spawnAndWaitForReady(
      ["--timeout", "0.3"],
      "::: question id=q1\nQ?\n:::",
    );
    const code = await proc.exited;
    expect(code).toBe(124);
  }, 15000);

  test("no input exits 2", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", SCRIPT, "--no-open"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    const code = await proc.exited;
    expect(code).toBe(2);
  }, 5000);

  test("missing --reference path exits 2", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        SCRIPT,
        "--no-open",
        "--reference",
        "/tmp/does-not-exist-digestify-test.md",
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(2);
  }, 5000);

  test("--file input works without stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digestify-test-"));
    const path = join(dir, "input.md");
    writeFileSync(path, "::: question id=q1\nWhy?\n:::");
    try {
      const { proc, ready } = await spawnAndWaitForReady(["--file", path, "--timeout", "5"]);
      await postSubmit(ready.port, { answers: { q1: "ok" }, comments: [] });
      const stdout = await readStdout(proc);
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(JSON.parse(stdout).answers).toEqual({ q1: "ok" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("--reference + stdin combines reference body first then agent content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digestify-test-"));
    const refPath = join(dir, "reference.md");
    writeFileSync(refPath, "# Reference doc\n\nSome content.\n");
    try {
      const { proc, ready } = await spawnAndWaitForReady(
        ["--reference", refPath, "--timeout", "5"],
        "::: question id=q1\nReactions?\n:::\n",
      );
      await postSubmit(ready.port, { answers: { q1: "looks good" }, comments: [] });
      const stdout = await readStdout(proc);
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(JSON.parse(stdout).answers).toEqual({ q1: "looks good" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("zero-question prose-only input is valid", async () => {
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "5"],
      "Just prose, no questions.\n",
    );
    await postSubmit(ready.port, { answers: {}, comments: [] });
    const stdout = await readStdout(proc);
    const code = await proc.exited;
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.answers).toEqual({});
    expect(payload.comments).toEqual([]);
  }, 15000);

  test("session id is auto-generated in digestify-<hex>-p<port> form", async () => {
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "1"],
      "::: question id=q1\nQ?\n:::",
    );
    expect(ready.session_id).toMatch(/^digestify-[0-9a-f]{8}-p\d+$/);
    expect(ready.session_id).toContain(`-p${ready.port}`);
    await proc.exited; // let timeout fire
  }, 15000);
});

// ── P0 — a >64KiB submission survives a PIPE (#78 family) ────────────────
// Bun's stdout is ASYNCHRONOUS on a pipe and synchronous on a TTY or file, so
// `process.exit(code)` discards whatever has not drained — measured at exactly
// 65,536 bytes.
//
// digestify is the asymmetry-of-harm case rather than the size case: the payload
// is the human's ONE submission, written once and never retryable, so a
// truncation eats work that cannot be regenerated. That is why it was ruled IN
// despite rarely reaching 64KiB in practice.
//
// ⚠ THE READER IS PART OF THE EXPERIMENT. `spawnAndWaitForReady` above uses
// Bun.spawn's own pipe, which does NOT reproduce this defect (measured on
// bounty: shell pipe 65536, Bun.spawn pipe 114042, same payload). So this gate
// puts review.ts's stdout on a REAL SHELL PIPE via `sh -c … | cat` and reads the
// outer hop, where nothing is at stake. stderr stays a direct pipe so the ready
// line is still readable.
describe("P0 — a >64KiB submission survives a PIPE", () => {
  test("the submitted answers come back whole through a shell pipe", async () => {
    const proc = Bun.spawn({
      cmd: ["sh", "-c", `${process.execPath} run ${SCRIPT} --no-open --timeout 20 | cat`],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(new TextEncoder().encode("::: question id=q1\nWhy?\n:::"));
    proc.stdin.end();

    // Same ready-line discipline as the helper above, on stderr.
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ready: { port: number } | null = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !ready) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("{") && line.includes('"port"')) ready = JSON.parse(line);
        nl = buf.indexOf("\n");
      }
      if (done) break;
    }
    reader.releaseLock();
    if (!ready) throw new Error("subprocess didn't print ready line");

    // ~120KB of answer: over the buffer by a wide margin so ordinary drift
    // cannot silently walk the fixture back under the threshold.
    const answer = "z".repeat(120_000);
    await fetch(`http://127.0.0.1:${ready.port}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: { q1: answer }, comments: [] }),
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // ── THE VACUITY GUARD, asserted BEFORE the parse ────────────────────
    // A sub-64KiB fixture passes in BOTH worlds and stays green forever,
    // including on the day it breaks.
    const bytes = Buffer.byteLength(stdout);
    expect({ overBuffer: bytes > 65_536, bytes }).toEqual({ overBuffer: true, bytes });
    expect(bytes).not.toBe(65_536);

    const payload = JSON.parse(stdout) as { answers: Record<string, string> };
    expect(payload.answers.q1).toHaveLength(120_000);
  }, 40000);
});

describe("b4 — a departure is observable through a pipe", () => {
  const MD = "::: question id=q1\nWhy?\n:::";

  // circe's matched arms (b4s, fbfe1d3) measured these two as BYTE-IDENTICAL on
  // stdout and exit code. That is the defect: "a human read it and declined" and
  // "nobody ever opened it" were one observable. They must now differ.
  test("read-then-left and never-opened are DISTINGUISHABLE on stdout", async () => {
    // ARM A — the page is served, then the human leaves without engaging.
    const a = await spawnAndWaitForReady(["--timeout", "1"], MD);
    await fetch(`http://127.0.0.1:${a.ready.port}/`);
    await fetch(`http://127.0.0.1:${a.ready.port}/left`, {
      method: "POST",
      body: JSON.stringify({ engaged: false, elapsedMs: 32775, answered: 0, commented: 0 }),
    });
    const aOut = await readStdout(a.proc);
    const aCode = await a.proc.exited;

    // ARM B — nobody ever opens it.
    const b = await spawnAndWaitForReady(["--timeout", "1"], MD);
    const bOut = await readStdout(b.proc);
    const bCode = await b.proc.exited;

    // RED PRE-FIX: both were 0 bytes and both exit 124 — diff was empty.
    expect(aCode).toBe(124);
    expect(bCode).toBe(124);
    expect(aOut).not.toBe(bOut);

    const a1 = JSON.parse(aOut);
    const b1 = JSON.parse(bOut);
    expect(a1.observed).toBe("read-then-left");
    expect(a1.pageServed).toBe(true);
    expect(a1.departure.elapsedMs).toBe(32775);
    expect(b1.observed).toBe("never-opened");
    expect(b1.pageServed).toBe(false);
    expect(b1.departure).toBeNull();
    // both are honest that nothing was submitted
    expect(a1.submitted).toBe(false);
    expect(b1.submitted).toBe(false);
  }, 20000);

  test("opened-then-silent is its OWN observable, not folded into never-opened", async () => {
    // The page was served and no beacon arrived — a crashed tab or a machine
    // that slept. Deliberately NOT merged with never-opened: they are different
    // facts and the payload says so rather than guessing between them.
    const { proc, ready } = await spawnAndWaitForReady(["--timeout", "1"], MD);
    await fetch(`http://127.0.0.1:${ready.port}/`);
    const out = await readStdout(proc);
    expect(await proc.exited).toBe(124);
    const p = JSON.parse(out);
    expect(p.observed).toBe("opened-then-silent");
    expect(p.pageServed).toBe(true);
    expect(p.departure).toBeNull();
  }, 20000);

  test("GUARD — /left is RECORD-ONLY: it must never end the session", async () => {
    // The whole safety of the seam. If /left resolved, a refresh would kill a
    // live review — which is why it is a separate route and not a flag on
    // /cancel. Passes in BOTH worlds by design; it guards the clause, not the fix.
    const { proc, ready } = await spawnAndWaitForReady(["--timeout", "10"], MD);
    await fetch(`http://127.0.0.1:${ready.port}/`);
    await fetch(`http://127.0.0.1:${ready.port}/left`, {
      method: "POST",
      body: JSON.stringify({ engaged: false, elapsedMs: 10, answered: 0, commented: 0 }),
    });
    // still alive after the beacon — a submit must still be accepted
    await postSubmit(ready.port, { answers: { q1: "still here" }, comments: [] });
    const out = await readStdout(proc);
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out).answers).toEqual({ q1: "still here" });
  }, 20000);
});

// ── the served page ─────────────────────────────────────────────────────────
// ⚠ THIS BLOCK REPLACED TWO CELLS THAT NO LONGER HAVE A SUBJECT, and the reason
// they existed is worth keeping. `template.html` was invisible to
// `bun run check` — biome's files.includes is an allow-list of ts/tsx/json/jsonc
// — so a syntax error in 1,500 lines of inline vanilla JS shipped silently, and
// these were the only mechanical guard that file had:
//
//   • "served surface beacons /left on departure, and keeps /cancel" — a text
//     search of the served <script> block. Its successor is
//     `src/digestify/reaches-the-agent.test.ts`, which reads the surface source
//     beside its subject. It CANNOT live here: a test under plugins/ reaching
//     into src/ is the relative escape out of the artifact boundary the
//     import-boundary wards forbid (playbook Gotcha 6).
//   • "served app script parses" — a Bun.Transpiler parse of the same block.
//     Now VACUOUS by construction: the surface is .tsx that `bun run check`
//     lints and `tsc` type-checks, and `bun run build` fails outright on a
//     syntax error. Deleted rather than kept as a cell that cannot fail.
//
// What is left here is the half that is still this file's: the daemon's
// substitution pass, asserted against the page it actually serves.
describe("the served page", () => {
  test("carries the substituted title and a parseable payload island", async () => {
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "5", "--title", "Served & Checked"],
      "::: question id=q1\nQ?\n:::",
    );
    const html = await (await fetch(`http://127.0.0.1:${ready.port}/`)).text();

    // Neither placeholder survives, and the title is HTML-escaped.
    expect(html).not.toContain("__TITLE__");
    expect(html).not.toContain("__PAYLOAD__");
    expect(html).toContain("Served &amp; Checked");

    const island = /<script id="payload" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(island?.[1]).toBeTruthy();
    const payload = JSON.parse(island?.[1] ?? "");
    expect(payload.title).toBe("Served & Checked");
    expect(payload.session_id).toBe(ready.session_id);
    expect(payload.questions).toEqual([{ id: "q1", prompt: "Q?" }]);
    expect(payload.timeout_seconds).toBe(5);

    await postCancel(ready.port);
    await proc.exited;
  }, 15000);

  test("a document containing `</script>` does not break out of the payload island", async () => {
    // The one thing that could turn a document's own text into markup at this
    // seam. `JSON.stringify(...).replace(/<\//g, "<\\/")` is what stops it, and
    // this cell is what stops that line being tidied away.
    const { proc, ready } = await spawnAndWaitForReady(
      ["--timeout", "5"],
      "before </script><script>globalThis.PWNED=1</script> after\n\n::: question id=q1\nQ?\n:::",
    );
    const html = await (await fetch(`http://127.0.0.1:${ready.port}/`)).text();
    const island = /<script id="payload" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    const payload = JSON.parse(island?.[1] ?? "");
    // The whole document survived INSIDE the island — the tag never closed early.
    expect(payload.markdown).toContain("globalThis.PWNED=1");
    expect(html).not.toContain("<script>globalThis.PWNED=1</script>");

    await postCancel(ready.port);
    await proc.exited;
  }, 15000);

  test("the ready line names the mode", async () => {
    // The daemon's ONLY mode transport (Contract 1). In this repo dist/ is
    // committed, so an unforced boot is release.
    const { proc, ready } = await spawnAndWaitForReady(["--timeout", "5"], "hello");
    expect(ready.mode).toBe("release");
    await postCancel(ready.port);
    await proc.exited;
  }, 15000);
});
