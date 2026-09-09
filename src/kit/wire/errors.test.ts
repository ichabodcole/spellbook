import { describe, expect, test } from "bun:test";
import { CliError, errorEnvelope, reportCliError, setCurrentCommand } from "./errors.ts";

// ⚠ THIS FILE ARRIVED IN PHASE 2, WITH THE `server` FIELD, AND ITS ABSENCE
// UNTIL THEN IS ITSELF WORTH NAMING: `errors.ts` is the module that decides what
// every spell's failures look like on the wire, and it had no cells of its own —
// it was covered only transitively, by each adopting spell's contract suite. A
// contract with no direct test is a contract whose changes are checked by
// whoever happens to adopt it next.

describe("the failure envelope", () => {
  test("⛔ `server` rides the envelope VERBATIM, and last", () => {
    // The field is the upstream daemon's own body. glamour is the first spell to
    // keep it (astrolabe's and magpie's copies discard what the daemon said and
    // report only the status number), and its cli-contract suite asserts the
    // round trip for HTTP 400 / 404 / 409. This cell is the module-side half.
    setCurrentCommand("state");
    const body = { ok: false, applied: false, error: "unrecognised command type" };
    const line = errorEnvelope("conflict", "cmd failed (HTTP 409)", {
      hint: "try again",
      choices: ["--session"],
      server: body,
    });
    const doc = JSON.parse(line) as {
      ok: boolean;
      error: { kind: string; exit_code: number; server: unknown };
      meta: { command: string };
    };
    expect(doc.ok).toBe(false);
    expect(doc.error.kind).toBe("conflict");
    expect(doc.error.exit_code).toBe(6);
    expect(doc.error.server).toEqual(body);
    expect(doc.meta.command).toBe("state");
    // ⛔ KEY ORDER IS PART OF THE CONTRACT for a spell that already shipped this
    // envelope: a byte-diffed golden in a spell's suite must not move because the
    // kit inserted a key in the middle.
    expect(Object.keys(doc.error)).toEqual([
      "kind",
      "exit_code",
      "retryable",
      "message",
      "hint",
      "choices",
      "server",
    ]);
  });

  test("an ABSENT `server` emits no key at all — absence is not `null`", () => {
    setCurrentCommand(null);
    const doc = JSON.parse(errorEnvelope("usage", "no verb given")) as {
      error: Record<string, unknown>;
    };
    expect("server" in doc.error).toBe(false);
    expect(Object.keys(doc.error)).toEqual(["kind", "exit_code", "retryable", "message"]);
  });

  test("`reportCliError` carries `server` through and returns the taxonomy code", () => {
    const out: string[] = [];
    const code = reportCliError(
      new CliError("not_found", "no such item", { server: { id: "x" } }),
      {
        write: (c: string) => out.push(c),
      },
    );
    expect(code).toBe(5);
    expect(JSON.parse(out.join("")).error.server).toEqual({ id: "x" });
  });

  test("a NON-CliError returns null so the caller rethrows rather than mislabelling it", () => {
    const out: string[] = [];
    expect(reportCliError(new TypeError("boom"), { write: (c: string) => out.push(c) })).toBeNull();
    expect(out).toEqual([]);
  });
});
