import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type Cli,
  type CommandSpec,
  defineCli,
  type Invocation,
  type OptionsTable,
  type RowView,
} from "../src/kit/cli/registry.ts";
import {
  allowsPositionals,
  argParsingEntryPoints,
  BACKEND_SRC_DIR,
  backendSources,
  isCallerFacing,
  readEntryPoint,
  SHARED_PARSERS,
} from "./lib/entry-points";

// ROW 2 of the sprint-05 conformance table: "free text never promoted to a flag
// name", and its inverse. It is a SIBLING ward of `flag-invariant.test.ts`
// because that ward is keyed on flag NAMES and a bare `--` is never an options
// key, so it cannot see the terminator.
//
// ── THE TWO DIRECTIONS, and what is true of each today ──────────────────────
//
//  PROMOTION  free text -> flag name.  `bounty add write the --draft section`
//             truncated the title to "write the" at exit 0.
//             SOLVED by `strict: true`: the kit registry parses every row
//             strict, and node:util throws on the unknown flag.
//
//  DEMOTION   flag -> free text.  `bounty add -- hello --session-key K1`
//             After `--`, node:util moves every token into `positionals`, so a
//             real, accepted flag becomes text. That is what `--` is for, so it
//             is NOT refused. Since `dccd2cb7` (sprint 06 phase 1, card c1) it is
//             no longer SILENT: the kit registry's `warnDemoted` prints ONE
//             `# warning:` line on stderr naming the token and the recovery
//             (move it before `--`); stdout and the exit code are unchanged.
//
// ── WHAT THIS WARD ASSERTS ──────────────────────────────────────────────────
// Over EVERY adopter of the kit CLI registry, for EVERY row that takes
// positionals, for EVERY flag that row accepts (its own and the globals): the
// argv `<row> <fillers> -- --<flag>` exits with the row's code, prints the row's
// stdout, and puts exactly one `# warning:` line naming `--<flag>` on stderr;
// the same argv with plain text in that slot prints nothing on stderr.
//
// ── WHY THE POPULATION IS "EVERY BACKEND SOURCE THAT CALLS defineCli" ───────
// The warning lives in ONE parser (`src/kit/cli/registry.ts`), so the question
// "which spells get it?" is "which spells hand their table to that parser?".
// That is answered by behaviour, from the files: every non-test `.ts` under
// `src/<spell>/backend/` whose source calls `defineCli({` (the anchor
// `entry-points.ts` requirement 3b already uses). Not a hand list and not a
// filename glob: digestify's adopter is `review.ts`, not `cli.ts`, and a glob of
// `cli.ts` would drop it silently. Each such file must export exactly one `Cli`
// (the value `defineCli` returned); a file that calls `defineCli` and exports
// none is a RED cell (the instrument could not read it), never a skip.
//
// ── WHY IN-PROCESS, AND WHY A REBUILT TABLE ─────────────────────────────────
// Driving each spell's launcher would run each row's real `run` (daemons,
// boards, files) for hundreds of cases. The registry has no side effects at
// import or in `defineCli`, so each adopter's exported `cli` is imported and its
// published table (`cli.rows`, `cli.declaration()`, `cli.recognizedFlags`) is
// handed back to the REAL `defineCli` with a stub `run` that echoes its
// invocation. A cell asserts the rebuilt table's declaration equals the
// adopter's own, so the rebuild is the adopter's table, not a guess at it.
//
// ⛔ WHAT THIS WARD CANNOT SEE (say so before trusting a green):
//  - Anything a spell's own `main`/`run()` does to argv before `dispatch`. The
//    rebuilt table is dispatched directly. bounty's c1 case is pinned end to end
//    by `src/bounty/backend/server.test.ts` and the CLI golden (`warned: true`).
//  - A row's `check` hook (flag-dependent arity). It runs before the warning and
//    is spell logic, so the rebuild omits it; a `check` that refused every
//    demoted argv would hide the warning in the real CLI and not here.
//  - Short aliases (`-s`). The published declaration does not carry them; the
//    short spelling is pinned by `src/kit/cli/registry.test.ts`.
//  - A row's `allowPositionals: false`. `RowView` does not publish it; the
//    rebuild uses the default (true).
//  - The ROOT-level `--` (`bounty -- --x`): Bun strips it before any parser.
//  - Parsers OUTSIDE the registry. The last cell pins that the only
//    caller-facing positional-accepting parser is the registry, so a new one
//    arriving is red here rather than unwarned.

const REGISTRY_CALL = /\bdefineCli\s*\(\s*\{/;

/** Every backend source that hands a table to the kit registry, by behaviour. */
const adopterFiles = backendSources()
  .filter((rel) => REGISTRY_CALL.test(readEntryPoint(rel)))
  .sort();

const isCli = (v: unknown): v is Cli =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Cli).dispatch === "function" &&
  Array.isArray((v as Cli).rows) &&
  typeof (v as Cli).declaration === "function";

type Adopter = { file: string; cli: Cli | null };

/**
 * The rows a Cli publishes, its verbless root included. `cli.rows` omits the
 * root (digestify's one row); `usageOf("")` is non-empty only when a root
 * exists, and the declaration's `path: []` entry then carries its accepted
 * flags (after the interceptors) and its positionals.
 */
function rowsOf(cli: Cli): RowView[] {
  if (cli.usageOf("") === "") return [...cli.rows];
  const decl = cli.declaration().commands.find((c) => c.path.length === 0);
  const root: RowView = {
    name: "",
    aliases: [],
    flags: [],
    accepted: (decl?.args ?? [])
      .map((a) => a.name)
      .filter((n) => n.startsWith("--") && n !== "--help" && n !== "--version")
      .map((n) => n.slice(2)),
    positionals: decl?.positionals ?? [],
    describe: "",
    auto: false,
  };
  return [root, ...cli.rows];
}

const adopters: Adopter[] = [];
for (const file of adopterFiles) {
  const mod = (await import(join(BACKEND_SRC_DIR, file))) as Record<string, unknown>;
  const clis = Object.values(mod).filter(isCli);
  adopters.push({ file, cli: clis.length === 1 ? (clis[0] as Cli) : null });
}

const STUB_EXIT = 7;
const FILLER = "ward-filler";
const PLAIN = "ward-plain-text";

/** The adopter's published table, handed back to the real `defineCli`. */
function rebuild(real: Cli): Cli {
  const decl = real.declaration();
  const types = new Map<string, "string" | "boolean">();
  for (const c of decl.commands)
    for (const a of c.args) if (a.name.startsWith("--")) types.set(a.name.slice(2), a.type);
  const options: Record<string, { type: "string" | "boolean" }> = {};
  for (const f of real.recognizedFlags) {
    const k = f.slice(2);
    options[k] = { type: types.get(k) ?? "boolean" };
  }
  const run = (inv: Invocation) => {
    process.stdout.write(`${JSON.stringify({ path: inv.path, pos: inv.pos, flags: inv.flags })}\n`);
    return STUB_EXIT;
  };
  // An auto row (help/version/schema the module added) has no flags of its
  // own, so what it accepts IS the spell's `globalFlags`.
  const globals = real.rows.find((r) => r.auto)?.accepted ?? [];
  const own = (r: RowView) => r.accepted.filter((k) => !globals.includes(k));
  const toSpec = (r: RowView): CommandSpec => ({
    name: r.name,
    aliases: r.aliases,
    flags: own(r),
    positionals: r.positionals,
    describe: r.describe,
    run,
  });
  const root = rowsOf(real).find((r) => r.name === "");
  const rootDecl = decl.commands.find((c) => c.path.length === 0);
  return defineCli({
    name: real.name,
    options: options as OptionsTable,
    globalFlags: globals,
    commands: real.rows.filter((r) => r.name !== "" && !r.auto).map(toSpec),
    ...(root
      ? {
          root: {
            flags: own(root),
            positionals: root.positionals,
            describe: root.describe,
            run,
          },
        }
      : {}),
    verbPositional: root ? undefined : rootDecl?.positionals[0]?.name,
    version: () => ({ name: real.name, version: "0.0.0" }),
  });
}

/** Run `fn` with stdout and stderr captured, always restoring them. */
async function capture(fn: () => Promise<number>) {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  (process.stdout as unknown as { write: unknown }).write = (s: string) => {
    out += s;
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (s: string) => {
    err += s;
    return true;
  };
  try {
    let code: number;
    try {
      code = await fn();
    } catch (x) {
      code = -1;
      err += `THREW: ${x instanceof Error ? x.message : String(x)}\n`;
    }
    return { code, out, err };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = o;
    (process.stderr as unknown as { write: unknown }).write = e;
  }
}

type Case = { adopter: string; row: string; flag: string; argv: string[]; control: string[] };

function casesFor(file: string, cli: Cli): Case[] {
  const out: Case[] = [];
  for (const r of rowsOf(cli)) {
    if (r.auto || r.positionals.length === 0) continue;
    // n positionals in all: n-1 fillers before `--`, the demoted token last.
    const head = [...(r.name === "" ? [] : r.name.split(" "))];
    const fillers = Array(r.positionals.length - 1).fill(FILLER);
    for (const k of r.accepted) {
      out.push({
        adopter: file,
        row: r.name,
        flag: `--${k}`,
        argv: [...head, ...fillers, "--", `--${k}`],
        control: [...head, ...fillers, "--", PLAIN],
      });
    }
  }
  return out;
}

const withCli = adopters.filter((a): a is { file: string; cli: Cli } => a.cli !== null);
const rowsWithPositionals = withCli.flatMap(({ file, cli }) =>
  rowsOf(cli)
    .filter((r) => !r.auto && r.positionals.length > 0)
    .map((r) => `${file}:${r.name}`),
);
const cases = withCli.flatMap(({ file, cli }) => casesFor(file, cli));

describe("ward — a flag demoted by `--` is warned about, on every registry adopter", () => {
  test("the sweep actually ran (zero-denominator guards)", () => {
    // A dead sweep and a clean sweep are indistinguishable without these.
    expect(adopterFiles.length).toBeGreaterThanOrEqual(9);
    expect(rowsWithPositionals.length).toBeGreaterThan(0);
    expect(cases.length).toBeGreaterThan(0);
  });

  test("every file that calls defineCli exports exactly one Cli (null is red, not 0)", () => {
    const unreadable = adopters.filter((a) => a.cli === null).map((a) => a.file);
    expect(unreadable).toEqual([]);
  });

  test("the rebuilt table IS the adopter's table (declarations equal)", () => {
    const drift = withCli
      .filter(({ cli }) => !Bun.deepEquals(rebuild(cli).declaration(), cli.declaration()))
      .map((a) => a.file);
    expect(drift).toEqual([]);
  });

  test("an accepted flag after `--` warns once; stdout and exit unchanged", async () => {
    const failures: string[] = [];
    const rebuilt = new Map(withCli.map(({ file, cli }) => [file, rebuild(cli)]));
    for (const c of cases) {
      const cli = rebuilt.get(c.adopter) as Cli;
      const demoted = await capture(() => cli.dispatch(c.argv));
      const control = await capture(() => cli.dispatch(c.control));
      const at = `${c.adopter} [${c.row || "(root)"}] ${c.flag}`;
      const lines = demoted.err.split("\n").filter((l) => l !== "");
      const expectOut = (tail: string, out: string) => {
        const parsed = JSON.parse(out) as { pos: string[] };
        return parsed.pos[parsed.pos.length - 1] === tail;
      };
      if (demoted.code !== STUB_EXIT) failures.push(`${at}: exit ${demoted.code}`);
      else if (control.code !== STUB_EXIT) failures.push(`${at}: control exit ${control.code}`);
      else if (control.err !== "") failures.push(`${at}: control stderr ${control.err}`);
      else if (!expectOut(c.flag, demoted.out) || !expectOut(PLAIN, control.out))
        failures.push(`${at}: the token did not arrive as the last positional`);
      else if (demoted.out.replace(c.flag, PLAIN) !== control.out)
        failures.push(`${at}: stdout differs from the plain-text control`);
      else if (
        lines.length !== 1 ||
        !lines[0]?.startsWith("# warning: ") ||
        !lines[0].includes(`${c.flag} after \`--\``)
      )
        failures.push(`${at}: stderr ${JSON.stringify(demoted.err)}`);
    }
    expect(failures).toEqual([]);
  });

  test("the pin prints its units — adopters, rows, cases", () => {
    // Re-measure and update when an adopter or a row arrives or leaves; the
    // number is only here so a change is loud, not as a claim about coverage.
    expect({
      adopters: adopterFiles.length,
      rowsWithPositionals: rowsWithPositionals.length,
      cases: cases.length,
      perAdopter: Object.fromEntries(
        adopterFiles.map((f) => [
          f,
          rowsWithPositionals.filter((r) => r.startsWith(`${f}:`)).length,
        ]),
      ),
    }).toEqual({
      adopters: 9,
      // Every row with ANY positional (required, optional or variadic), not
      // only c1's 43 variadic + 6 one-optional rows: a demoted token can fill
      // any positional slot. Measured 2026-09-27 on 41065365.
      rowsWithPositionals: 114,
      // One case per (row, accepted flag), globals included.
      cases: 311,
      perAdopter: {
        "astrolabe/backend/cli.ts": 6,
        "bounty/backend/cli.ts": 7,
        // digestify's one row is a verbless root that takes flags only.
        "digestify/backend/review.ts": 0,
        "glamour/backend/cli.ts": 10,
        "grapevine/backend/cli.ts": 19,
        "imago/backend/cli.ts": 11,
        "magpie/backend/cli.ts": 6,
        "mind-mapper/backend/cli.ts": 26,
        "scriptorium/backend/cli.ts": 29,
      },
    });
  });

  test("THE MECHANISM — node:util demotes silently; the registry is what warns", () => {
    // The premise, executable: node's parser itself says nothing. If this ever
    // changes, the header's account of why the registry must warn is false.
    const options = { "session-key": { type: "string" } } as const;
    const shared = { options, strict: true, allowPositionals: true } as const;
    const after = parseArgs({ args: ["update", "t1", "--", "--session-key", "K"], ...shared });
    expect({ values: after.values, positionals: after.positionals }).toEqual({
      values: {},
      positionals: ["update", "t1", "--session-key", "K"],
    });
    // Promotion stays solved by strict parsing.
    expect(() =>
      parseArgs({ args: ["add", "write", "the", "--draft", "section"], ...shared }),
    ).toThrow();
  });

  test("the registry is the ONLY caller-facing parser that takes positionals", () => {
    // A caller-facing parser outside the registry would not get the warning.
    // magpie's discover.ts takes positionals but is spawned only by magpie
    // (internal argv), so it is outside this question.
    const outside = [...argParsingEntryPoints(), ...SHARED_PARSERS]
      .filter((p) => allowsPositionals(readEntryPoint(p)))
      .filter(isCallerFacing)
      .sort();
    expect(outside).toEqual([...SHARED_PARSERS]);
  });
});
