// Round 3 (Claim C1) — `send` adopts grapevine's body-resolution chain
// (behavior, not parser): --body-file > --stdin > inline positional >
// piped-stdin default. Trailing newline strips; an EMPTY resolved body is a
// usage error (exit 2) — the measured sharp edge is that the piped default
// hangs forever under agent shells (isTTY null, no EOF), so a fast loud
// failure on every resolvable-but-empty path is what the CLI can honestly
// give. Leak refusal is narrowed to the send verb; --force overrides.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const CLI_SCRIPT = join(SCRIPT_DIR, "cli.ts");
let home: string;
let scratch: string;

async function runCli(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, ...args], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    // stdin undefined → inherit would expose the test runner's tty-less
    // stdin; pass an explicit (possibly empty) pipe so the piped-stdin
    // default resolves instead of hanging.
    stdin: new Response(stdin ?? "").body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function lastMessage(): Promise<string> {
  const { stdout } = await runCli(["state"]);
  const state = JSON.parse(stdout) as { conversation: Array<{ text: string }> };
  return state.conversation[state.conversation.length - 1]?.text ?? "";
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "mind-mapper-send-body-test-"));
  scratch = mkdtempSync(join(tmpdir(), "mind-mapper-send-body-scratch-"));
  const open = await runCli(["open", "--no-open"]);
  expect(open.code).toBe(0);
  const created = await runCli(["projects", "--create", "Default"]);
  expect(created.code).toBe(0);
});

afterAll(async () => {
  try {
    const { readFileSync } = await import("node:fs");
    const pid = Number.parseInt(readFileSync(join(home, "daemon.pid"), "utf8").trim(), 10);
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

test("--body-file wins over --stdin and piped stdin (top of the chain)", async () => {
  const bodyPath = join(scratch, "body-precedence.txt");
  writeFileSync(bodyPath, "from the file\n");
  const r = await runCli(["send", "--body-file", bodyPath, "--stdin"], "from the pipe");
  expect(r.code).toBe(0);
  expect(await lastMessage()).toBe("from the file");
});

test("--stdin wins over inline positional text", async () => {
  const r = await runCli(["send", "--stdin", "inline", "loser"], "explicit stdin body\n");
  expect(r.code).toBe(0);
  expect(await lastMessage()).toBe("explicit stdin body");
});

test("inline positional wins over piped stdin when both are present", async () => {
  const r = await runCli(["send", "inline", "winner"], "piped loser");
  expect(r.code).toBe(0);
  expect(await lastMessage()).toBe("inline winner");
});

test("piped stdin is the default body when no inline text is given", async () => {
  const r = await runCli(["send"], "the piped default\n");
  expect(r.code).toBe(0);
  expect(await lastMessage()).toBe("the piped default");
});

test("a two-paragraph body round-trips byte-exact to /state.conversation (one trailing newline stripped)", async () => {
  const body =
    "First paragraph, with `backticks` and $(subshell) intact.\n\nSecond paragraph:\n  indented line\n";
  const bodyPath = join(scratch, "body-two-para.txt");
  writeFileSync(bodyPath, body);
  const r = await runCli(["send", "--body-file", bodyPath]);
  expect(r.code).toBe(0);
  expect(await lastMessage()).toBe(body.replace(/\n$/, ""));
});

test("--body-file that does not exist is a clean exit 2", async () => {
  const r = await runCli(["send", "--body-file", join(scratch, "never-was.txt")]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--body-file not found");
});

test("a leaked cli invocation body is refused (exit 2, nothing posted); --force sends it", async () => {
  const before = await lastMessage();
  const leaked = `bun ${CLI_SCRIPT} send here is what I meant to say`;
  const refused = await runCli(["send", "--stdin"], leaked);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("leaked");
  expect(await lastMessage()).toBe(before); // nothing posted

  const forced = await runCli(["send", "--stdin", "--force"], leaked);
  expect(forced.code).toBe(0);
  expect(await lastMessage()).toBe(leaked);
});

test("an inline body with shell metacharacters sends, with a stderr warning", async () => {
  const r = await runCli(["send", "risky", "`title`", "body"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("shell metacharacters");
  expect(await lastMessage()).toBe("risky `title` body");
});

test("an EMPTY resolved body is a usage error exit 2 on every path", async () => {
  // Piped default resolving empty (the agent-shell fumble shape).
  const piped = await runCli(["send"], "");
  expect(piped.code).toBe(2);
  expect(piped.stderr).toContain("empty body");

  // --stdin resolving empty.
  const viaStdin = await runCli(["send", "--stdin"], "\n");
  expect(viaStdin.code).toBe(2);

  // --body-file resolving empty.
  const emptyPath = join(scratch, "empty.txt");
  writeFileSync(emptyPath, "\n");
  const viaFile = await runCli(["send", "--body-file", emptyPath]);
  expect(viaFile.code).toBe(2);
});

// Round 4 gate rework — the round's one silent-loss edge: parseArgs'
// single-value --ground kept only the LAST repeat (exit 0, refs dropped).
// --ground is `multiple` now: repeats ACCUMULATE, and each value still
// splits on commas — both forms, mixed, land every ref.
test("repeated --ground flags accumulate (and commas still split) — no silent last-wins loss", async () => {
  const sent = await runCli([
    "send",
    "grounded body",
    "--ground",
    "node-a,node-b",
    "--ground",
    "doc:ramble-01",
  ]);
  expect(sent.code).toBe(0);
  const { stdout } = await runCli(["state"]);
  const state = JSON.parse(stdout) as { conversation: Array<{ ground: string[] | null }> };
  expect(state.conversation.at(-1)?.ground).toEqual(["node-a", "node-b", "doc:ramble-01"]);
});

test("--ground tolerates stray commas/blank fragments without minting empty refs", async () => {
  const sent = await runCli(["send", "tidy ground", "--ground", "node-a,", "--ground", ""]);
  expect(sent.code).toBe(0);
  const { stdout } = await runCli(["state"]);
  const state = JSON.parse(stdout) as { conversation: Array<{ ground: string[] | null }> };
  expect(state.conversation.at(-1)?.ground).toEqual(["node-a"]);
});
