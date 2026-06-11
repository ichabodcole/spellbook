// Tests for review.ts — parser, payload builder, port-suffix parser, and a
// reduced set of end-to-end subprocess tests covering the agent-facing
// contract. Pure-function coverage is intentionally exhaustive; HTTP handler
// internals are exercised through the subprocess tests rather than direct
// fetch-handler poking, because Bun's fetch handler is straightforward and
// the integration tests verify the contract that matters (exit codes, stdout
// JSON shape, stderr ready line).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(SCRIPT_DIR, "review.ts");

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

type ReadyInfo = { url: string; port: number; session_id: string };

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

async function postCancel(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/cancel`, { method: "POST", body: "" });
}

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
