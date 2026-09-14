// scriptorium CLI's PROCESS contract, observed rather than inferred — glamour's
// cli-contract cell set, ported. The contract is what the LAUNCHER's process
// writes and exits with, so every cell spawns `scripts/cli.ts` (→ the BUILT
// `dist/cli.js`; build before running — T23).
//
// Two instruments: a DRIFT WARD binding `schema` and `help` to the COMMANDS
// table that dispatches, and a SUBPROCESS failure table — stdout empty on
// failure, exactly one JSON envelope on stderr, its exit_code equal to the
// process's, `choices` wherever the valid set is in hand (register A1).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync as mkdtempRaw, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  docArg,
  flagsFor,
  parseSince,
  parseVersion,
  RECOGNIZED_FLAGS,
  VERB_SPEC,
  VERBS,
  verbToken,
} from "./cli";
import { DOC_EXTENSIONS } from "./tree";

const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(
  BACKEND_DIR,
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "scriptorium",
);
const CLI = join(SKILL_ROOT, "scripts", "cli.ts");

// Every temp dir a cell makes is removed after the file — the contract cells
// must not litter the machine's temp directory with pointer stubs.
const made: string[] = [];
const mkdtempSync = (prefix: string): string => {
  const d = mkdtempRaw(prefix);
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

// An empty TMPDIR (no session pointer) and an empty home: no cell here can
// reach a live scriptorium on this machine.
const EMPTY_TMP = mkdtempSync(join(tmpdir(), "scriptorium-contract-"));
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "scriptorium-contract-home-"));

function run(args: string[], tmp = EMPTY_TMP): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Uint8Array(0),
    env: { ...process.env, TMPDIR: tmp, SCRIPTORIUM_HOME: EMPTY_HOME },
  });
  return {
    code: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

type Envelope = {
  ok: boolean;
  error: {
    kind: string;
    exit_code: number;
    retryable: boolean;
    message: string;
    hint?: string;
    choices?: string[];
    server?: unknown;
  };
  meta: { command: string | null };
};

// ── 1. the drift ward ───────────────────────────────────────────────

test("the emitted declaration walks the same table dispatch does: one row per verb, plus the root", () => {
  const r = run(["schema"]);
  expect(r.code).toBe(0);
  const decl = JSON.parse(r.stdout) as { commands: { path: string[]; args: { name: string }[] }[] };
  expect(decl.commands.map((c) => c.path.join(" ")).sort()).toEqual(["", ...VERBS].sort());
  expect(decl.commands.find((c) => c.path.length === 0)?.args.map((a) => a.name)).toEqual([
    "--help",
    "-h",
    "--version",
    "-V",
  ]);
});

test("the help surface advertises every verb on its own line", () => {
  const r = run(["help"]);
  expect(r.code).toBe(0);
  const missing = VERBS.filter((v) => !new RegExp(`^\\s*${v}(\\s|$)`, "m").test(r.stdout));
  expect(missing).toEqual([]);
  expect(run(["--help"]).stdout).toBe(r.stdout);
  expect(run(["-h"]).stdout).toBe(r.stdout);
});

test("the brief's verb roster is exactly the table's", () => {
  expect([...VERBS].sort()).toEqual(
    [
      "activate",
      "add",
      "close",
      "dangling",
      "diff",
      "help",
      "info",
      "open",
      "say",
      "schema",
      "state",
      "tail",
      "version-new",
      "version-delete",
      "task",
      "task-status",
      "task-done",
      "task-remove",
      "tasks-clear",
      "note",
      "notes",
      "note-edit",
      "note-resolve",
      "note-remove",
      "new-doc",
      "new-folder",
      "move",
      "rename",
      "hide",
      "unhide",
      "make-set",
      "merge",
      "import",
      "working",
      "workspace",
      "meta",
      "find",
      "graph",
      "backlinks",
      "meta-init",
      "meta-set",
    ].sort(),
  );
});

// ── 2. the failure contract, end to end ─────────────────────────────

test.each([
  ["bare invocation", [] as string[], 2, "usage"],
  ["unknown verb", ["frobnicate"], 2, "usage"],
  ["unknown flag", ["state", "--acc-not-a-flag"], 2, "usage"],
  ["a flag on help", ["help", "--acc-not-a-flag"], 2, "usage"],
  ["missing operand", ["activate"], 2, "usage"],
  ["missing add path", ["add"], 2, "usage"],
  ["not a version", ["activate", "banana"], 2, "usage"],
  ["say with no message", ["say"], 2, "usage"],
  ["say with two message sources", ["say", "hi", "--stdin"], 2, "usage"],
  ["no session to act on", ["state"], 5, "not_found"],
  ["no session for info", ["info"], 5, "not_found"],
  ["no session for version-new", ["version-new"], 5, "not_found"],
  [
    "open a path that does not exist",
    ["open", "--no-open", "/definitely/not/here.md"],
    5,
    "not_found",
  ],
  [
    "restore a session that was never saved",
    ["open", "--no-open", "--restore", "nope"],
    5,
    "not_found",
  ],
])("failure contract: %s", (_label, args, expectedCode, expectedKind) => {
  const r = run(args);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(expectedCode);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.ok).toBe(false);
  expect(doc.error.kind).toBe(expectedKind);
  expect(doc.error.exit_code).toBe(r.code);
  expect(doc.error.retryable).toBe(false);
});

test("the bare and unknown-verb rejections name the whole roster as choices", () => {
  for (const args of [[], ["frobnicate"]]) {
    const doc = JSON.parse(run(args).stderr) as Envelope;
    expect(doc.error.choices).toEqual([...VERBS]);
  }
  expect((JSON.parse(run(["frobnicate"]).stderr) as Envelope).meta.command).toBe("frobnicate");
});

test("the unknown-flag rejection names the set AT THAT PATH", () => {
  const atSay = JSON.parse(run(["say", "hi", "--acc-not-a-flag"]).stderr) as Envelope;
  expect(atSay.error.choices).toEqual(flagsFor("say"));
  expect(atSay.meta.command).toBe("say");
  const atRoot = JSON.parse(run(["--acc-not-a-flag"]).stderr) as Envelope;
  expect(atRoot.error.choices).toEqual(["--help", "-h", "--version", "-V"]);
  expect(atRoot.meta.command).toBeNull();
});

test("say's message-source disjunction is choices, not prose (A1)", () => {
  const doc = JSON.parse(run(["say"]).stderr) as Envelope;
  expect(doc.error.choices).toEqual(["--stdin", "--body-file"]);
});

test("restoring an unknown session names the saved sessions as choices — empty, and said", () => {
  const doc = JSON.parse(run(["open", "--no-open", "--restore", "nope"]).stderr) as Envelope;
  expect(doc.error.choices).toEqual([]);
  expect(doc.error.hint).toContain("no saved sessions");
});

test("a recognized flag at the wrong verb is MISPLACED, and lists the verb's own flags", () => {
  const doc = JSON.parse(run(["state", "--doc", "x"]).stderr) as Envelope;
  expect(doc.error.message).toContain("is not accepted by `state`");
  expect(doc.error.choices).toEqual(flagsFor("state"));
  const help = JSON.parse(run(["help", "--session", "abc"]).stderr) as Envelope;
  expect(help.error.hint).toBe("help takes no flags");
  expect(help.error.choices).toBeUndefined();
});

test("`--` at the root ends flag parsing", () => {
  const r = run(["--", "--", "--acc-probe-value"]);
  expect(r.code).toBe(2);
  expect((JSON.parse(r.stderr) as Envelope).error.message).toContain(
    'unknown verb "--acc-probe-value"',
  );
});

test("--version is a data path, not a failure", () => {
  for (const args of [["--version"], ["-V"], ["version"]]) {
    const r = run(args);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ name: "scriptorium", version: expect.any(String) });
  }
});

test("VERB_SPEC and VERBS agree, and every registry flag belongs to some verb", () => {
  expect(Object.keys(VERB_SPEC).sort()).toEqual([...VERBS].sort());
  const owned: ReadonlySet<string> = new Set(Object.values(VERB_SPEC).flatMap((row) => [...row]));
  expect(RECOGNIZED_FLAGS.filter((f) => !owned.has(f.slice(2)))).toEqual([]);
});

test("verbToken finds the verb the way the parser consumes tokens", () => {
  expect(verbToken(["--session", "abc", "say", "--bogus"])).toBe("say");
  expect(verbToken(["--session=abc", "say"])).toBe("say");
  expect(verbToken(["--full", "state"])).toBe("state");
  expect(verbToken(["--", "--x"])).toBe("--x");
});

test("parseVersion accepts v2 and 2, and nothing else", () => {
  expect(parseVersion("v2", "t")).toBe(2);
  expect(parseVersion("3", "t")).toBe(3);
  expect(() => parseVersion("v0", "t")).toThrow();
  expect(() => parseVersion("two", "t")).toThrow();
});

// ── 3. the round trip: acc against the emitted declaration ───────────

test("acc check against the emitted declaration finds zero disagreements", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptorium-schema-"));
  const declPath = join(dir, "declaration.json");
  writeFileSync(declPath, run(["schema"]).stdout);
  const p = Bun.spawnSync(
    ["bunx", "acc", "check", CLI, "--declaration", declPath, "--config-dir", SKILL_ROOT],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Uint8Array(0),
      env: { ...process.env, TMPDIR: EMPTY_TMP, SCRIPTORIUM_HOME: EMPTY_HOME },
    },
  );
  const report = JSON.parse(new TextDecoder().decode(p.stdout)) as {
    data: {
      conformant: boolean;
      declaration: { status: string; findings: unknown[]; declaredCommands: number };
    };
  };
  expect(p.exitCode).toBe(0);
  expect(report.data.conformant).toBe(true);
  expect(report.data.declaration.status).toBe("checked");
  expect(report.data.declaration.declaredCommands).toBe(VERBS.length + 1);
  expect(report.data.declaration.findings).toEqual([]);
}, 60_000);

test("the in-process census: every path's unknown-flag rejection names exactly what schema declares", () => {
  const decl = JSON.parse(run(["schema"]).stdout) as {
    commands: { path: string[]; args: { name: string }[] }[];
  };
  const mismatches: string[] = [];
  for (const c of decl.commands) {
    const doc = JSON.parse(run([...c.path, "--acc-not-a-flag"]).stderr) as Envelope;
    const accepted = [...(doc.error.choices ?? [])].sort();
    const declared = c.args.map((a) => a.name).sort();
    if (JSON.stringify(accepted) !== JSON.stringify(declared))
      mismatches.push(`${c.path.join(" ") || "(root)"}: ${accepted} vs ${declared}`);
  }
  expect(mismatches).toEqual([]);
});

// ── 4. daemon refusals, and absence vs failure ───────────────────────

test.each([
  [400, "usage", 2],
  [404, "not_found", 5],
  [409, "conflict", 6],
  [500, "internal", 1],
])("a daemon refusal with HTTP %i maps to %s / exit %i; body under server, its set lifted into choices", async (status, kind, code) => {
  const body = { ok: false, error: "stubbed", choices: ["notes", "solo"] };
  const server = Bun.serve({ port: 0, fetch: () => Response.json(body, { status }) });
  const dir = mkdtempSync(join(tmpdir(), "scriptorium-stub-"));
  writeFileSync(
    join(dir, "scriptorium-latest.json"),
    JSON.stringify({ url: `http://127.0.0.1:${server.port}`, port: server.port, session_id: "s1" }),
  );
  try {
    for (const args of [["state"], ["version-new", "--doc", "x"]]) {
      const p = Bun.spawn(["bun", CLI, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env, TMPDIR: dir },
      });
      const [out, err, exit] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(out).toBe("");
      expect(exit).toBe(code);
      const doc = JSON.parse(err) as Envelope;
      expect(doc.error.kind).toBe(kind);
      expect(doc.error.server).toEqual(body);
      expect(doc.error.choices).toEqual(["notes", "solo"]);
    }
  } finally {
    server.stop(true);
  }
});

test("a session pointer that cannot be READ is internal/1, not not_found/5", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptorium-unreadable-"));
  mkdirSync(join(dir, "scriptorium-latest.json"));
  const r = run(["state"], dir);
  expect(r.code).toBe(1);
  expect((JSON.parse(r.stderr) as Envelope).error.message).toContain("EISDIR");
});

test("a corrupt session pointer is internal/1", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptorium-corrupt-"));
  writeFileSync(join(dir, "scriptorium-latest.json"), '{"url":');
  const r = run(["state"], dir);
  expect(r.code).toBe(1);
  expect((JSON.parse(r.stderr) as Envelope).error.message).toContain("not valid JSON");
});

test("close against a dead port is a transport failure, not a success", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptorium-dead-"));
  writeFileSync(
    join(dir, "scriptorium-latest.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", port: 1, session_id: "s1" }),
  );
  const r = run(["close"], dir);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(1);
  expect((JSON.parse(r.stderr) as Envelope).error.kind).toBe("internal");
});

// ── verify-pass fixes 5, 8 and 9 ─────────────────────────────────────

test("fix 5 — open with a non-document path fails BEFORE a daemon exists: no pointer, usage, the extensions as choices", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptorium-badopen-"));
  const tmp = mkdtempSync(join(tmpdir(), "scriptorium-badopen-tmp-"));
  writeFileSync(join(dir, "d.md"), "hi\n");
  writeFileSync(join(dir, "pic.png"), "x");
  const r = run(["open", "--no-open", join(dir, "d.md"), join(dir, "pic.png")], tmp);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.error.kind).toBe("usage");
  expect(doc.error.choices).toEqual([...DOC_EXTENSIONS]);
  expect(readdirSync(tmp)).toEqual([]); // no session pointer: no daemon was spawned
  // `add` refuses the same way before it looks for a session.
  expect(run(["add", join(dir, "pic.png")], tmp).code).toBe(2);
});

test("fix 9 — tail --since that is not an integer is a usage error, not a full replay", () => {
  const r = run(["tail", "--since", "abc"]);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  expect((JSON.parse(r.stderr) as Envelope).error.kind).toBe("usage");
  expect(parseSince("12")).toBe(12);
  expect(parseSince("-1")).toBe(-1);
  expect(() => parseSince("1.5")).toThrow();
});

test("fix 8 — --doc paths resolve against the CLI's own cwd; slugs and bare names pass through", () => {
  expect(docArg("sub/ch3.md")).toBe(resolve("sub/ch3.md"));
  expect(docArg("./x.md")).toBe(resolve("x.md"));
  expect(docArg("opening")).toBe("opening");
});
