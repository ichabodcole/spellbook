// The workspace CLI's process contract, observed rather than inferred. The
// contract is what the launcher's process writes and exits with, so every test
// spawns `fixtures/cli.ts`: a drift check binding `schema` and `help` to the
// table that dispatches, and a subprocess failure table (stdout empty on failure,
// exactly one JSON envelope on stderr, its exit_code equal to the process's,
// `choices` wherever the valid set is in hand).

import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync as mkdtempRaw,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_EXTENSIONS } from "../lib/docFormat.ts";
import { homeDir } from "../lib/home.ts";
import { cli } from "./fixtures/cli";
import { DOC_EXTENSIONS } from "./tree";
import {
  defaultWorkspace,
  docArg,
  KIT_OPTIONS,
  parseCount,
  parseSide,
  parseTailSince,
  parseVersion,
} from "./verbs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli.ts");
const VERBS = cli.verbs;
const flagsFor = (verb: string) => cli.flagsFor(verb);

// Every temp dir a test makes is removed after the file: the contract tests
// must not litter the machine's temp directory with pointer stubs.
const made: string[] = [];
const mkdtempSync = (prefix: string): string => {
  const d = realpathSync(mkdtempRaw(prefix));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

// An empty TMPDIR (no session pointer) and an empty home: no test here can
// reach a live workspace on this machine.
const EMPTY_TMP = mkdtempSync(join(tmpdir(), "workspace-contract-"));
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "workspace-contract-home-"));

// A home holding one saved session, s1: the newest, which a verb with no
// --session reads the pointer of (`kit-fixture.s1.json`).
const S1_HOME = mkdtempSync(join(tmpdir(), "workspace-contract-s1-"));
mkdirSync(join(S1_HOME, "sessions", "s1"), { recursive: true });
writeFileSync(join(S1_HOME, "sessions", "s1", "manifest.json"), '{"sessionId":"s1"}');

function run(
  args: string[],
  tmp = EMPTY_TMP,
  home = EMPTY_HOME,
): { code: number; stdout: string; stderr: string } {
  // Bun strips a bare `--` placed right after the script path; the added `--` is
  // the one it consumes, so the CLI receives exactly `args`.
  const p = Bun.spawnSync(["bun", CLI, "--", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new Uint8Array(0),
    env: { ...process.env, TMPDIR: tmp, KIT_FIXTURE_HOME: home },
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

// ── 1. the drift check ──────────────────────────────────────────────

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
  expect(r.stdout).toContain("SPELLBOOK_TAIL_WINDOW_MS");
});

test("the kit's verb roster is the resolution's, and an app adds its own to the same table", () => {
  const kit = [
    "open",
    "add",
    "import",
    "state",
    "tail",
    "say",
    "working",
    "version-new",
    "activate",
    "diff",
    "merge",
    "show",
    "version-delete",
    "note",
    "notes",
    "note-edit",
    "note-resolve",
    "task",
    "task-status",
    "task-done",
    "task-cancel",
    "new-doc",
    "new-folder",
    "rename",
    "move",
    "describe-image",
    "image-settings",
    "reveal",
    "search",
    "backlinks",
    "link-check",
    "graph",
    "profiles",
    "profile",
    "profile-check",
    "relations",
    "relink",
    "workspace",
    "close",
    "doctor",
  ];
  const auto = ["help", "schema", "version"];
  const app = ["demo", "ping"];
  expect([...VERBS].sort()).toEqual([...kit, ...auto, ...app].sort());
  // None of the wiki layer's verbs came along but `backlinks`, which
  // kit-link-relations-backlinks admitted by name. Following a link is the
  // surface's `link.open`, not a verb. kit-link-check admitted `link-check`,
  // one verb whose sections are dangling links, unsupported-scheme links and
  // shared file names: the source's `dangling` would name only the first, so it
  // stays out under that name. kit-link-graph admitted `graph`, the graph as
  // data; `map`, which draws it, is an app's (Atlas's) and stays out of the kit.
  // kit-document-profiles admitted `profiles`, `profile` and `profile-check`:
  // reading a world's profile files and the warnings they give, never writing.
  // kit-picker-relation-meanings admitted `relations`: the world's relation
  // vocabulary and how the links use it, never writing.
  // kit-image-import-settings admitted `image-settings`: the app's image
  // import settings, read, or set when the user asks. kit-per-note-waiting
  // (here kit-workspace-e65-daemon) admitted `note-edit`: the agent rewriting a note is one of the three acts
  // that answer it. Removing a note stays the human's.
  for (const gone of [
    "find",
    "map",
    "dangling",
    "meta",
    "meta-init",
    "meta-set",
    "hide",
    "unhide",
    "make-set",
    "forget",
    "info",
    "note-remove",
    "task-remove",
    "tasks-clear",
    // Delete is the human's alone (kit-delete-to-trash): a move to the Trash
    // from the sidebar, behind a dialog. The agent asks the human instead.
    "delete",
    "trash",
    "rm",
    "remove",
  ])
    expect(VERBS, gone).not.toContain(gone);
});

test("an app's own verbs take --session like the kit's, and reject a flag they do not list", () => {
  expect(flagsFor("demo")).toEqual(["--session"]);
  expect(flagsFor("ping")).toEqual(["--session"]);
  const r = run(["demo", "--doc", "x"]);
  expect(r.code).toBe(2);
  expect((JSON.parse(r.stderr) as Envelope).error.choices).toEqual(["--session"]);
});

// ── 2. the failure contract, end to end ─────────────────────────────

test.each([
  ["bare invocation", [] as string[], 2, "usage"],
  ["unknown verb", ["frobnicate"], 2, "usage"],
  ["unknown flag", ["state", "--not-a-flag"], 2, "usage"],
  ["a flag on help", ["help", "--not-a-flag"], 2, "usage"],
  ["missing operand", ["activate"], 2, "usage"],
  ["missing add path", ["add"], 2, "usage"],
  ["not a version", ["activate", "banana"], 2, "usage"],
  ["say with no message", ["say"], 2, "usage"],
  ["say with two message sources", ["say", "hi", "--stdin"], 2, "usage"],
  ["task with no text", ["task"], 2, "usage"],
  ["search with no query", ["search"], 2, "usage"],
  ["search with a blank query", ["search", "  "], 2, "usage"],
  ["search with a bad limit", ["search", "x", "--limit", "many"], 2, "usage"],
  ["search with a zero limit", ["search", "x", "--limit", "0"], 2, "usage"],
  ["no session for search", ["search", "x"], 5, "not_found"],
  ["note with no quote", ["note", "a body"], 2, "usage"],
  ["diff against nothing sensible", ["diff", "banana"], 2, "usage"],
  ["working with a bad duration", ["working", "--for", "soon"], 2, "usage"],
  ["a session id that is a path", ["state", "--session", "../x"], 2, "usage"],
  ["restore a session id that is a path", ["open", "--no-open", "--restore", "../x"], 2, "usage"],
  ["no session to act on", ["state"], 5, "not_found"],
  ["no session for version-new", ["version-new"], 5, "not_found"],
  ["no session for reveal", ["reveal", "/tmp"], 5, "not_found"],
  ["no session for the app's own verb", ["ping"], 5, "not_found"],
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

test("the unknown-flag rejection names the set at that path", () => {
  const atSay = JSON.parse(run(["say", "hi", "--not-a-flag"]).stderr) as Envelope;
  expect(atSay.error.choices).toEqual(flagsFor("say"));
  expect(atSay.meta.command).toBe("say");
  const atRoot = JSON.parse(run(["--not-a-flag"]).stderr) as Envelope;
  // Long spellings first (the registry's order).
  expect(atRoot.error.choices).toEqual(["--help", "--version", "-h", "-V"]);
  expect(atRoot.meta.command).toBeNull();
});

test("the message-source disjunction is choices, not prose", () => {
  for (const verb of ["say", "task"]) {
    const doc = JSON.parse(run([verb]).stderr) as Envelope;
    expect(doc.error.choices).toEqual(["--stdin", "--body-file"]);
  }
});

test("restoring an unknown session names the saved sessions as choices: empty, and said", () => {
  const doc = JSON.parse(run(["open", "--no-open", "--restore", "nope"]).stderr) as Envelope;
  expect(doc.error.choices).toEqual([]);
  expect(doc.error.hint).toContain("no saved sessions");
});

test("a recognized flag at the wrong verb is misplaced, and lists the verb's own flags", () => {
  const doc = JSON.parse(run(["state", "--doc", "x"]).stderr) as Envelope;
  expect(doc.error.message).toContain("is not accepted by `state`");
  expect(doc.error.choices).toEqual(flagsFor("state"));
  const help = JSON.parse(run(["help", "--session", "abc"]).stderr) as Envelope;
  expect(help.error.hint).toBe("help takes no flags");
  expect(help.error.choices).toEqual([]);
});

test("`--` at the root ends flag parsing", () => {
  const r = run(["--", "--probe-value"]);
  expect(r.code).toBe(2);
  expect((JSON.parse(r.stderr) as Envelope).error.message).toContain(
    'unknown command "--probe-value"',
  );
});

test("--version is a data path, not a failure", () => {
  for (const args of [["--version"], ["-V"], ["version"]]) {
    const r = run(args);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ name: "kit-fixture", version: expect.any(String) });
  }
});

test("every verb's rows and every registry flag agree: each flag belongs to some verb", () => {
  const owned = new Set(cli.rows.flatMap((row) => [...row.accepted]));
  const kitFlags = Object.keys(KIT_OPTIONS);
  expect(kitFlags.filter((f) => !owned.has(f))).toEqual([]);
  expect(cli.recognizedFlags).toEqual(kitFlags.map((f) => `--${f}`));
});

test("the verb is found the way the parser consumes tokens (a string flag eats its value)", () => {
  const doc = JSON.parse(run(["--session", "abc", "say", "hi", "--bogus"]).stderr) as Envelope;
  expect(doc.meta.command).toBe("say");
  expect(doc.error.choices).toEqual(flagsFor("say"));
});

test("a bad --body-file is the caller's (usage), not an internal fault", () => {
  const r = run(["say", "--body-file", "/definitely/not/here.txt"]);
  expect(r.code).toBe(2);
  expect((JSON.parse(r.stderr) as Envelope).error.kind).toBe("usage");
});

test("the in-process census: every path's unknown-flag rejection names exactly what schema declares", () => {
  const decl = JSON.parse(run(["schema"]).stdout) as {
    commands: { path: string[]; args: { name: string }[] }[];
  };
  const mismatches: string[] = [];
  for (const c of decl.commands) {
    const doc = JSON.parse(run([...c.path, "--not-a-flag"]).stderr) as Envelope;
    const accepted = [...(doc.error.choices ?? [])].sort();
    const declared = c.args.map((a) => a.name).sort();
    if (JSON.stringify(accepted) !== JSON.stringify(declared))
      mismatches.push(`${c.path.join(" ") || "(root)"}: ${accepted} vs ${declared}`);
  }
  expect(mismatches).toEqual([]);
  // One run per verb: it passes in under 2 s alone, but under a full
  // parallel gate it has run past the 5 s default.
}, 30_000);

// ── 3. parsers ──────────────────────────────────────────────────────

test("show names one target, and --against only with a change, before any daemon call", () => {
  for (const args of [
    ["show"],
    ["show", "--hunk", "1", "--quote", "the lantern"],
    ["show", "--quote", "the lantern", "--against", "v2"],
    ["show", "--hunk", "two"],
    ["show", "--hunk", "1", "--against", "latest"],
  ]) {
    const r = run(args);
    expect(r.code, args.join(" ")).toBe(2);
    expect(r.stdout).toBe("");
    expect((JSON.parse(r.stderr) as Envelope).error.kind).toBe("usage");
  }
});

test("parseVersion accepts v2 and 2, and nothing else", () => {
  expect(parseVersion("v2", "t")).toBe(2);
  expect(parseVersion("3", "t")).toBe(3);
  expect(() => parseVersion("v0", "t")).toThrow();
  expect(() => parseVersion("two", "t")).toThrow();
});

test("parseSide reads the file of record by any of its three names, and a version otherwise", () => {
  for (const word of ["original", "file", "saved", "SAVED"])
    expect(parseSide(word, "t")).toBe("original");
  expect(parseSide("v4", "t")).toBe(4);
  expect(() => parseSide("v0", "t")).toThrow();
});

test("parseCount takes whole numbers and refuses the rest", () => {
  expect(parseCount("0", "t")).toBe(0);
  expect(parseCount("30", "t")).toBe(30);
  for (const bad of ["-1", "1.5", "soon", ""]) expect(() => parseCount(bad, "t")).toThrow();
});

test("tail --since is a bookmark: an integer, with an optional epoch; anything else is usage", () => {
  const r = run(["tail", "--since", "abc"]);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  expect((JSON.parse(r.stderr) as Envelope).error.kind).toBe("usage");
  expect(parseTailSince("12")).toEqual({ since: 12 });
  expect(parseTailSince("-1")).toEqual({ since: -1 });
  expect(parseTailSince("4@e-1")).toEqual({ since: 4, epoch: "e-1" });
  expect(() => parseTailSince("1.5")).toThrow();
  expect(() => parseTailSince("4@")).toThrow();
});

test("--doc paths resolve against the CLI's own cwd; slugs and bare names pass through", () => {
  expect(docArg("sub/ch3.md")).toBe(resolve("sub/ch3.md"));
  expect(docArg("./x.md")).toBe(resolve("x.md"));
  expect(docArg("opening")).toBe("opening");
});

test("a new session's workspace holds the one folder open was given, else is where open ran, never a set's folder", () => {
  const base = realpathSync(mkdtempRaw(join(tmpdir(), "workspace-default-")));
  const world = join(base, "world");
  mkdirSync(join(world, "deep"), { recursive: true });
  writeFileSync(join(base, "solo.md"), "# solo\n");
  try {
    // The one folder becomes a set, so the workspace is the folder holding it.
    expect(defaultWorkspace([world], "/cwd")).toBe(base);
    expect(defaultWorkspace([join(base, "solo.md")], "/cwd")).toBe("/cwd");
    expect(defaultWorkspace([world, join(base, "solo.md")], "/cwd")).toBe("/cwd");
    expect(defaultWorkspace([world, base], "/cwd")).toBe("/cwd");
    expect(defaultWorkspace([], "/cwd")).toBe("/cwd");
    // `open .` and `open . other` from inside a set: stepped out above the set.
    expect(defaultWorkspace([world, join(base, "solo.md")], join(world, "deep"))).toBe(base);
    expect(defaultWorkspace([world, base], world)).toBe(dirname(base));
    // A step out that reaches the top of the disk (or the home folder): none,
    // so the session's own imported/.
    expect(defaultWorkspace(["/"], "/cwd")).toBeUndefined();
    // `open ~`: the folder above home is no workspace either.
    expect(defaultWorkspace([homeDir()], "/cwd")).toBeUndefined();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 4. daemon refusals, and absence versus failure ──────────────────

test.each([
  [400, "usage", 2],
  [404, "not_found", 5],
  [409, "conflict", 6],
  [500, "internal", 1],
])("a daemon refusal with HTTP %i maps to %s / exit %i; body under server, its set lifted into choices", async (status, kind, code) => {
  const body = {
    ok: false,
    error: "stubbed",
    choices: ["notes", "solo"],
    hint: "try the other one",
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json(body, { status }),
  });
  const dir = mkdtempSync(join(tmpdir(), "workspace-stub-"));
  writeFileSync(
    join(dir, "kit-fixture.s1.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${server.port}`,
      port: server.port,
      session_id: "s1",
      dir: "/x",
      // This process: alive and ours (a `latest` is read only while its pid lives).
      pid: process.pid,
    }),
  );
  try {
    for (const args of [["state"], ["version-new", "--doc", "x"], ["ping"]]) {
      const run = async () => {
        const p = Bun.spawn(["bun", CLI, ...args], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: { ...process.env, TMPDIR: dir, KIT_FIXTURE_HOME: S1_HOME },
        });
        const [out, err, exit] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        return { out, err, exit };
      };
      // Once, in a full run under load, a refusal printed "null\n" on stdout
      // (HTTP 404, this file); it never reproduced alone or in 14 reruns, and no
      // code path prints null on a refusal. One retry keeps the gate honest
      // about a real regression, which would print on both runs.
      let { out, err, exit } = await run();
      if (out !== "") ({ out, err, exit } = await run());
      expect(out).toBe("");
      expect(exit).toBe(code);
      const doc = JSON.parse(err) as Envelope;
      expect(doc.error.kind).toBe(kind);
      expect(doc.error.server).toEqual(body);
      expect(doc.error.choices).toEqual(["notes", "solo"]);
      expect(doc.error.hint).toBe("try the other one");
    }
  } finally {
    server.stop(true);
  }
});

test("a session pointer that cannot be read is internal/1, not not_found/5", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-unreadable-"));
  mkdirSync(join(dir, "kit-fixture.s1.json"));
  const r = run(["state"], dir, S1_HOME);
  expect(r.code).toBe(1);
  expect((JSON.parse(r.stderr) as Envelope).error.kind).toBe("internal");
});

test("a corrupt session pointer is internal/1", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-corrupt-"));
  writeFileSync(join(dir, "kit-fixture.s1.json"), '{"url":');
  const r = run(["state"], dir, S1_HOME);
  expect(r.code).toBe(1);
  expect((JSON.parse(r.stderr) as Envelope).error.message).toContain("not valid JSON");
});

test("close against a dead port is a transport failure, not a success", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-dead-"));
  writeFileSync(
    join(dir, "kit-fixture.s1.json"),
    JSON.stringify({
      url: "http://127.0.0.1:1",
      port: 1,
      session_id: "s1",
      dir: "/x",
      pid: process.pid,
    }),
  );
  const r = run(["close"], dir, S1_HOME);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(1);
  expect((JSON.parse(r.stderr) as Envelope).error.kind).toBe("internal");
});

test("another app's pointer is not found: discovery is per app", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-other-"));
  writeFileSync(
    join(dir, "other-app.latest.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", port: 1, session_id: "s1", dir: "/x", pid: 1 }),
  );
  const r = run(["state"], dir);
  expect(r.code).toBe(5);
});

// ── after the end: the refusal names the session asked about ─────────

/** A home holding saved sessions, each manifest as given (`ended` or not); the last is the newest. */
function homeWith(sessions: { id: string; ended?: { by: string; at: string } }[]): string {
  const home = mkdtempSync(join(tmpdir(), "workspace-ended-home-"));
  for (const [i, s] of sessions.entries()) {
    mkdirSync(join(home, "sessions", s.id), { recursive: true });
    const path = join(home, "sessions", s.id, "manifest.json");
    writeFileSync(
      path,
      JSON.stringify({ sessionId: s.id, ...(s.ended ? { ended: s.ended } : {}) }),
    );
    const t = new Date(Date.now() - (sessions.length - i) * 60_000);
    utimesSync(path, t, t);
  }
  return home;
}

test("a session the HUMAN ended: every verb says so, names it, and does not invite a reopen", () => {
  // The newest saved session is another one: the hint must not name it.
  const home = homeWith([
    { id: "aaaa1111", ended: { by: "human", at: "2026-10-19T00:00:00.000Z" } },
    { id: "bbbb2222", ended: { by: "agent", at: "2026-10-19T00:00:01.000Z" } },
  ]);
  for (const args of [
    ["state", "--session", "aaaa1111"],
    ["say", "hello", "--session", "aaaa1111"],
    ["close", "--session", "aaaa1111"],
  ]) {
    const r = run(args, EMPTY_TMP, home);
    expect(r.code).toBe(5);
    expect(r.stdout).toBe("");
    const doc = JSON.parse(r.stderr) as Envelope;
    expect(doc.ok).toBe(false);
    expect(doc.error.kind).toBe("not_found");
    expect(doc.error.message).toBe("the human ended session aaaa1111");
    expect(doc.error.hint).toBe(
      "the human ended this session on purpose; do not reopen it unless they ask. If they ask: `open --restore aaaa1111`",
    );
    expect(doc.error.choices).toBeUndefined();
  }
});

test("no --session: the newest saved session is the one asked about, and a human end routes the same way", () => {
  const home = homeWith([{ id: "aaaa1111" }, { id: "bbbb2222", ended: { by: "human", at: "x" } }]);
  const doc = JSON.parse(run(["state"], EMPTY_TMP, home).stderr) as Envelope;
  expect(doc.error.message).toBe("the human ended session bbbb2222");
});

// ── no --session: the newest session, live or not, and never an older one ──

/** A pid that is certainly dead: a child this test started, which has exited and been reaped. */
function deadPid(): number {
  const p = Bun.spawnSync(["true"], { env: process.env });
  return p.pid;
}

/** A pointer for `id` in `tmp`; port 1 refuses, so a verb that reaches it fails as transport (exit 1). */
function pointerIn(tmp: string, id: string, pid: number): void {
  writeFileSync(
    join(tmp, `kit-fixture.${id}.json`),
    JSON.stringify({ url: "http://127.0.0.1:1", port: 1, session_id: id, dir: "/x", pid }),
  );
}

/** A then B, B the one `open` last started; A's manifest written last (A is the busy one). */
function siblings(b: { ended?: { by: string; at: string } } = {}): { home: string; tmp: string } {
  const home = homeWith([{ id: "bbbb2222", ...b }, { id: "aaaa1111" }]);
  writeFileSync(join(home, "last-opened.json"), JSON.stringify({ session_id: "bbbb2222" }));
  const tmp = mkdtempSync(join(tmpdir(), "workspace-siblings-"));
  // A is live (this process's own pid), and a verb that reached it would fail on its port.
  pointerIn(tmp, "aaaa1111", process.pid);
  return { home, tmp };
}

test("no --session, the newest crashed while an older one is live: refused, naming the newest, never reaching the older", () => {
  const { home, tmp } = siblings();
  pointerIn(tmp, "bbbb2222", deadPid());
  for (const args of [["state"], ["say", "hello"], ["close"]]) {
    const r = run(args, tmp, home);
    expect(r.code).toBe(5);
    const doc = JSON.parse(r.stderr) as Envelope;
    expect(doc.error.message).toBe("no running kit-fixture session bbbb2222");
    expect(doc.error.hint).toContain("`open --restore bbbb2222`");
  }
  // With nothing live at all, the same: B's manifest is the older one, B is still the newest.
  rmSync(join(tmp, "kit-fixture.aaaa1111.json"));
  const doc = JSON.parse(run(["state"], tmp, home).stderr) as Envelope;
  expect(doc.error.message).toBe("no running kit-fixture session bbbb2222");
});

test("no --session, the human ended the newest while an older one is live: the shipped refusal, never the older", () => {
  const { home, tmp } = siblings({ ended: { by: "human", at: "2026-10-19T00:00:00.000Z" } });
  for (const args of [["state"], ["say", "hello"], ["close"]]) {
    const r = run(args, tmp, home);
    expect(r.code).toBe(5);
    const doc = JSON.parse(r.stderr) as Envelope;
    expect(doc.error.message).toBe("the human ended session bbbb2222");
    expect(doc.error.choices).toBeUndefined();
  }
});

test("no --session, a record naming a session no longer saved, or a corrupt one: refused, never a sibling", () => {
  for (const body of ['{"session_id":"cccc3333"}', "{not json"]) {
    const { home, tmp } = siblings();
    writeFileSync(join(home, "last-opened.json"), body);
    for (const args of [["state"], ["say", "hello"], ["close"], ["tail", "--once"]]) {
      const r = run(args, tmp, home);
      expect(r.code).toBe(5);
      expect(r.stdout).toBe("");
      const doc = JSON.parse(r.stderr) as Envelope;
      expect(doc.error.message).toContain("the newest kit-fixture session is unknown");
      expect(doc.error.message).toContain(
        body.startsWith("{not") ? "it is not valid JSON" : "it names session cccc3333",
      );
      expect(doc.error.hint).toContain("--session");
      expect(doc.error.choices).toEqual(["aaaa1111", "bbbb2222"]);
    }
    // A named session is not the record's business.
    const named = run(["state", "--session", "aaaa1111"], tmp, home);
    expect(named.code).toBe(1); // A's pointer: port 1, a transport failure, so it was reached
  }
});

test("no --session, the newest crashed: tail grounds on it, then says tail.lost, never the older live one", async () => {
  const { home, tmp } = siblings();
  pointerIn(tmp, "bbbb2222", deadPid());
  const p = Bun.spawn(["bun", CLI, "--", "tail"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, TMPDIR: tmp, KIT_FIXTURE_HOME: home },
  });
  const timer = setTimeout(() => p.kill(), 30_000);
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  clearTimeout(timer);
  const lines = out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { type: string; session_id?: string; command?: string });
  expect(lines[0]).toMatchObject({ type: "grounding", session_id: "bbbb2222" });
  expect(lines.at(-1)?.type).toBe("tail.lost");
  expect(lines.at(-1)?.command).toContain("bbbb2222");
  expect(out).not.toContain("aaaa1111");
}, 40_000);

// ── 5. admission before any daemon exists ───────────────────────────

test("open with a path that is no document or image fails before a daemon exists: no pointer, usage, the extensions as choices", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-badopen-"));
  const tmp = mkdtempSync(join(tmpdir(), "workspace-badopen-tmp-"));
  writeFileSync(join(dir, "d.md"), "hi\n");
  writeFileSync(join(dir, "notes.zip"), "x");
  writeFileSync(join(dir, "logo.svg"), "<svg/>");
  const r = run(["open", "--no-open", join(dir, "d.md"), join(dir, "notes.zip")], tmp);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as Envelope;
  expect(doc.error.kind).toBe("usage");
  expect(doc.error.choices).toEqual([...DOC_EXTENSIONS, ...IMAGE_EXTENSIONS]);
  expect(readdirSync(tmp)).toEqual([]); // no session pointer: no daemon was spawned
  // `add` refuses the same way before it looks for a session; an SVG says why.
  expect(run(["add", join(dir, "notes.zip")], tmp).code).toBe(2);
  const svg = run(["add", join(dir, "logo.svg")], tmp);
  expect(svg.code).toBe(2);
  expect((JSON.parse(svg.stderr) as Envelope).error.message).toContain("SVG");
  writeFileSync(join(dir, "IMG_0001.HEIC"), "x");
  const heic = run(["add", join(dir, "IMG_0001.HEIC")], tmp);
  expect(heic.code).toBe(2);
  expect((JSON.parse(heic.stderr) as Envelope).error.message).toContain(
    "drop it on the context list, which converts it to JPEG",
  );
});

test("import of a folder, a missing file and a non-document are each refused before any daemon call", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-import-"));
  writeFileSync(join(dir, "pic.png"), "x");
  const folder = run(["import", dir]);
  expect(folder.code).toBe(2);
  expect((JSON.parse(folder.stderr) as Envelope).error.hint).toContain("add <folder>");
  expect(run(["import", join(dir, "nope.md")]).code).toBe(5);
  const png = run(["import", join(dir, "pic.png")]);
  expect(png.code).toBe(2);
  expect((JSON.parse(png.stderr) as Envelope).error.choices).toEqual([...DOC_EXTENSIONS]);
});
