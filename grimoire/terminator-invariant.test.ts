import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
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
  isCallerFacing,
  readEntryPoint,
  SHARED_PARSERS,
} from "./lib/entry-points";

// enforces: none in house-style — sprint-05 conformance table, row 2
//
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
// positionals, called by EVERY spelling (its name and each alias), for EVERY
// flag that row accepts (its own and the globals), in THREE forms:
//   direct      `<row> <fillers> -- --<flag>`
//   after-text  `<row> -- <text…> --<flag>`   (the flag is NOT the first token
//               after `--`; a registry that inspected only that token — c1's
//               own shape — passed every direct case. Skipped only for a row
//               with one non-variadic positional, which has no room for text.)
//   =value      `<row> <fillers> -- --<flag>=ward-value`
// each exits with the row's code, prints the row's stdout, and puts exactly one
// `# warning:` line naming the token as written on stderr; the same argv with
// plain text in that slot prints nothing on stderr. And per (row, spelling), a
// flag-SHAPED token no row accepts (`--ward-not-a-flag`) after `--` is text and
// prints nothing on stderr.
//
// ── WHY THE POPULATION IS "EVERY SOURCE THAT IMPORTS THE REGISTRY" ──────────
// The warning lives in ONE parser (`src/kit/cli/registry.ts`), so the question
// "which spells get it?" is "which sources hand their table to that parser?".
// Answered from the files, by IMPORT, not by a spelling of the call: every
// non-test source anywhere under `src/` (except `src/kit/cli/` itself) with a
// value import — static, `import()` or `require` — whose RELATIVE specifier
// resolves to the registry module, whatever local name it binds. An earlier
// version matched the literal `defineCli({` under `src/*/backend/` and was
// blind to an aliased import, a table built before the call, and an adopter
// outside `backend/`. Not a hand list and not a filename glob: digestify's
// adopter is `review.ts`, not `cli.ts`. Each such file must export exactly one
// `Cli`; a file that imports the registry and exports none is a RED cell (the
// instrument could not read it), never a skip. (`import type` is erased and
// hands nothing to the parser, so it does not make an adopter.)
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
// ── IMPORTING AN ADOPTER RUNS ITS MODULE (A5) ───────────────────────────────
// Each adopter's top level runs at import. Guarded cheaply: while the adopters
// are imported, `Bun.spawn`, `Bun.spawnSync`, `Bun.write`, `Bun.serve`,
// `Bun.$` and `process.exit` are replaced by recorders, and a cell asserts
// none was called. The recorders do not call through, so a violation cannot do
// its damage here.
//
// ⛔ WHAT THIS WARD CANNOT SEE (say so before trusting a green):
//  - Import-time side effects the recorders do not cover: `node:fs` writes,
//    `node:child_process`, `fetch`, timers. A module doing those at import
//    would do them in this test process, silently.
//  - An import of the registry through a NON-relative specifier (a bare
//    package name or a path alias). tsconfig.json declares no `paths` today;
//    one arriving would make such an adopter invisible here.
//  - Anything a spell's own `main`/`run()` does to argv before `dispatch`. The
//    rebuilt table is dispatched directly. bounty's c1 case is pinned end to end
//    by `src/bounty/backend/server.test.ts` and the CLI golden (`warned: true`).
//  - A row's `check` hook (flag-dependent arity). It runs before the warning and
//    is spell logic, so the rebuild omits it; a `check` that refused every
//    demoted argv would hide the warning in the real CLI and not here.
//  - Short flag aliases (`-s`). The published declaration does not carry
//    them; the short spelling is pinned by `src/kit/cli/registry.test.ts`.
//    (VERB aliases — grapevine `up`/`prune`, mind-mapper `message` — ARE
//    driven: `RowView.aliases` publishes them.)
//  - A row's `allowPositionals: false`. `RowView` does not publish it; the
//    rebuild uses the default (true).
//  - The ROOT-level `--` (`bounty -- --x`): Bun strips it before any parser.
//  - Parsers OUTSIDE the registry. The last cell requires every `parseArgs(`
//    call in a caller-facing entry point to be PROVABLY positional-free — a
//    literal object with literal `strict: true` and `allowPositionals: false`
//    and no spread — so a new one arriving is red here rather than unwarned.
//    A non-literal argument or value is a finding, not a pass.

const REGISTRY = join(BACKEND_SRC_DIR, "kit", "cli", "registry");
const REGISTRY_DIR = join(BACKEND_SRC_DIR, "kit", "cli");
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/i;
// `import … from`, `export … from`, `import("…")`, `require("…")`, and a bare
// `import "…"`. Group 1 is `type ` on a type-only import.
const IMPORT_SPEC =
  /\b(?:(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;

/** Every non-test source under `src/`, keyed relative to it. */
function srcSources(dir = BACKEND_SRC_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) {
      if (abs !== REGISTRY_DIR) out.push(...srcSources(abs));
    } else if (SOURCE.test(e) && !TEST_FILE.test(e) && !e.endsWith(".d.ts"))
      out.push(abs.slice(BACKEND_SRC_DIR.length + 1));
  }
  return out;
}

/** Does this source value-import `target` (an absolute path without its extension), under any local name? */
function importsModule(abs: string, src: string, target: string): boolean {
  for (const m of src.matchAll(IMPORT_SPEC)) {
    const spec = m[2] as string;
    if (m[1] !== undefined || !spec.startsWith(".")) continue;
    if (resolve(dirname(abs), spec).replace(/\.[cm]?[jt]sx?$/, "") === target) return true;
  }
  return false;
}

/** Does this source value-import the registry module, under any local name? */
const importsRegistry = (abs: string, src: string): boolean => importsModule(abs, src, REGISTRY);

/** Every source that hands a table to the kit registry: found by its import. */
const registryImporters = srcSources()
  .filter((rel) => {
    const abs = join(BACKEND_SRC_DIR, rel);
    return importsRegistry(abs, readFileSync(abs, "utf8"));
  })
  .sort();

/**
 * ── A FACTORY IS READ THROUGH WHAT IT BUILDS (added 2026-10-14) ─────────────
 * The kit's workspace CLI (`src/kit/workspace/verbs.ts`) imports the registry
 * but exports no `Cli`: it exports `createWorkspaceCli`, and each caller builds
 * its own. Such a file is read through its FOLLOWERS, each driven here as an
 * adopter in its place.
 *
 * A follower is a source that EXPORTS THE RESULT OF CALLING something it
 * imported from the factory (`export const cli = createWorkspaceCli(…)`, read
 * from the syntax tree by `builtExports`). Importing the factory is not enough:
 * a barrel that re-exports it builds nothing, and a file that imports it and
 * re-exports some other `Cli` would otherwise pass for one (the verification's
 * orphan.ts + follower.ts plant). A follower must then export exactly one
 * `Cli`, and that `Cli` must be the value of one of those built exports; any
 * follower that fails is a RED cell, even when another follower passes.
 *
 * A file that imports the registry, exports no `Cli` and has no follower stays
 * RED, as before: the instrument still could not read it. Today the one
 * follower is the kit's own fixture CLI (`src/kit/workspace/fixtures/cli.ts`);
 * a spell built on the factory joins by the same call. A follower that exports
 * a BUILDER instead (Scriptorium's) is driven through `BUILDER_ARGS`, below.
 */
function followersOf(factory: string): { file: string; built: string[]; builders: string[] }[] {
  const target = join(BACKEND_SRC_DIR, factory).replace(/\.[cm]?[jt]sx?$/, "");
  const out: { file: string; built: string[]; builders: string[] }[] = [];
  for (const rel of srcSources().sort()) {
    if (rel === factory) continue;
    const abs = join(BACKEND_SRC_DIR, rel);
    const src = readFileSync(abs, "utf8");
    if (!importsModule(abs, src, target)) continue;
    const fromFactory = (spec: string) =>
      spec.startsWith(".")
        ? resolve(dirname(abs), spec).replace(/\.[cm]?[jt]sx?$/, "") === target
        : false;
    const built = builtExports(src, fromFactory);
    const builders = builderExports(src, fromFactory);
    if (built.length > 0 || builders.length > 0) out.push({ file: rel, built, builders });
  }
  return out;
}

/**
 * ── A BUILDER IS DRIVEN WITH STUB DEPS (added 2026-10-22) ───────────────────
 * Scriptorium's CLI is not a built export: `src/scriptorium/backend/kit/cli.ts`
 * exports `scriptoriumKitCli(deps)`, a function that RETURNS the factory's
 * call, because its caller computes the daemon's path (in the bundle). The
 * deletion's verifier found every one of Scriptorium's own rows (`hide`,
 * `unhide`, `meta-set`, …) unswept: a planted extra positional on `unhide`
 * survived. Such a function is a BUILDER: it is called once here with the stub
 * arguments `BUILDER_ARGS` names for it, and the `Cli` it returns is driven as
 * an adopter of its own (`<file>#<name>`).
 *
 * A builder with no entry in `BUILDER_ARGS`, or whose call throws or returns
 * no `Cli`, is a RED cell: the instrument could not read it. The stubs only
 * have to let the table be BUILT. No row's `run` is reached: the sweep
 * dispatches a rebuild of the published table.
 */
const BUILDER_ARGS: Readonly<Record<string, readonly unknown[]>> = {
  "scriptorium/backend/kit/cli.ts#scriptoriumKitCli": [
    {
      serverScript: "/ward/stub/scripts/server.ts",
      daemonCwd: () => "/ward/stub",
      version: () => ({ name: "scriptorium", version: "0.0.0" }),
    },
  ],
};

/**
 * The names of a module's exported functions that RETURN a call to something
 * it imported from a module `fromFactory` accepts: `export function f(…) { …
 * return make(…) }`, and `export const f = (…) => make(…)` (concise or block
 * body). Only a `return` at the top of the function's own body counts, read
 * from the syntax tree. A function that uses the result (`make(…).run(argv)`)
 * returns nothing an adopter could be read from.
 */
function builderExports(src: string, fromFactory: (spec: string) => boolean): string[] {
  const sf = ts.createSourceFile("m.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fns = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const clause = s.importClause;
    if (!clause || clause.isTypeOnly || !fromFactory(s.moduleSpecifier.text)) continue;
    if (clause.name) fns.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb))
      for (const el of nb.elements) if (!el.isTypeOnly) fns.add(el.name.text);
  }
  const isFactoryCall = (e: ts.Expression | undefined): boolean => {
    while (e && (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
    return (
      !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && fns.has(e.expression.text)
    );
  };
  const returnsFactory = (body: ts.ConciseBody | undefined): boolean => {
    if (!body) return false;
    if (!ts.isBlock(body)) return isFactoryCall(body);
    return body.statements.some((st) => ts.isReturnStatement(st) && isFactoryCall(st.expression));
  };
  const exported = (s: ts.Statement) =>
    ts.canHaveModifiers(s) &&
    (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const out = new Set<string>();
  for (const s of sf.statements) {
    if (!exported(s)) continue;
    if (ts.isFunctionDeclaration(s) && s.name && returnsFactory(s.body)) out.add(s.name.text);
    if (ts.isVariableStatement(s))
      for (const d of s.declarationList.declarations) {
        const init = d.initializer;
        if (
          ts.isIdentifier(d.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          returnsFactory(init.body)
        )
          out.add(d.name.text);
      }
  }
  return [...out].sort();
}

/** A builder's `Cli`, built with its stub arguments, or null (red). */
function builderCli(mod: Record<string, unknown>, key: string, name: string): Cli | null {
  const args = BUILDER_ARGS[key];
  const fn = mod[name];
  if (args === undefined || typeof fn !== "function") return null;
  try {
    const cli: unknown = fn(...args);
    return isCli(cli) ? cli : null;
  } catch {
    return null;
  }
}

/**
 * The names a module exports whose value is a call to something it imported
 * from a module `fromFactory` accepts: `export const x = f(…)`,
 * `const x = f(…); export { x as y }`, and `export default f(…)` (as
 * `default`). `f` may be a named or default import, or a member of a namespace
 * import (`ns.f(…)`). Read from the syntax tree; anything else builds nothing.
 */
function builtExports(src: string, fromFactory: (spec: string) => boolean): string[] {
  const sf = ts.createSourceFile("m.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fns = new Set<string>();
  const namespaces = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const clause = s.importClause;
    if (!clause || clause.isTypeOnly || !fromFactory(s.moduleSpecifier.text)) continue;
    if (clause.name) fns.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
    if (nb && ts.isNamedImports(nb))
      for (const el of nb.elements) if (!el.isTypeOnly) fns.add(el.name.text);
  }
  const callsFactory = (e: ts.Expression | undefined): boolean => {
    while (e && (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
    if (!e || !ts.isCallExpression(e)) return false;
    const c = e.expression;
    if (ts.isIdentifier(c)) return fns.has(c.text);
    return (
      ts.isPropertyAccessExpression(c) &&
      ts.isIdentifier(c.expression) &&
      namespaces.has(c.expression.text)
    );
  };
  const exported = (s: ts.Statement) =>
    ts.canHaveModifiers(s) &&
    (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const built = new Set<string>();
  /** Local names bound to a factory call, for `export { x }`. */
  const local = new Set<string>();
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s))
      for (const d of s.declarationList.declarations)
        if (ts.isIdentifier(d.name) && callsFactory(d.initializer)) {
          local.add(d.name.text);
          if (exported(s)) built.add(d.name.text);
        }
    if (ts.isExportAssignment(s) && !s.isExportEquals && callsFactory(s.expression))
      built.add("default");
  }
  for (const s of sf.statements)
    if (
      ts.isExportDeclaration(s) &&
      !s.moduleSpecifier &&
      s.exportClause &&
      ts.isNamedExports(s.exportClause)
    )
      for (const el of s.exportClause.elements)
        if (local.has((el.propertyName ?? el.name).text)) built.add(el.name.text);
  return [...built].sort();
}

/**
 * A follower's `Cli`, or null (red): it must export exactly one `Cli`, and that
 * `Cli` must be the value of one of its built exports.
 */
function builtCli(mod: Record<string, unknown>, built: readonly string[]): Cli | null {
  const clis = Object.values(mod).filter(isCli);
  if (clis.length !== 1) return null;
  const cli = clis[0] as Cli;
  return built.some((name) => mod[name] === cli) ? cli : null;
}

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
/** Side effects recorded while the adopters were imported (A5); must be []. */
const importEffects: string[] = [];
{
  const bun = Bun as unknown as Record<string, unknown>;
  const guarded = ["spawn", "spawnSync", "write", "serve", "$"] as const;
  const saved = guarded.map((k) => bun[k]);
  const savedExit = process.exit;
  let importing = "";
  for (const k of guarded)
    bun[k] = () => {
      importEffects.push(`${importing}: Bun.${k}`);
      return {
        quiet: () => ({ text: () => undefined }),
        text: () => undefined,
      };
    };
  (process as unknown as { exit: unknown }).exit = () => {
    importEffects.push(`${importing}: process.exit`);
  };
  const moduleOf = async (file: string): Promise<Record<string, unknown>> => {
    importing = file;
    return (await import(join(BACKEND_SRC_DIR, file))) as Record<string, unknown>;
  };
  try {
    for (const file of registryImporters) {
      const clis = Object.values(await moduleOf(file)).filter(isCli);
      if (clis.length === 0) {
        // A factory: read through its followers (see `followersOf`). Every
        // follower is a cell of its own; one that fails is red, never dropped
        // because another follower passed.
        const followers = followersOf(file);
        if (followers.length > 0) {
          for (const { file: f, built, builders } of followers) {
            const mod = await moduleOf(f);
            if (built.length > 0) adopters.push({ file: f, cli: builtCli(mod, built) });
            for (const name of builders) {
              const key = `${f}#${name}`;
              adopters.push({ file: key, cli: builderCli(mod, key, name) });
            }
          }
          continue;
        }
      }
      adopters.push({ file, cli: clis.length === 1 ? (clis[0] as Cli) : null });
    }
  } finally {
    guarded.forEach((k, i) => {
      bun[k] = saved[i];
    });
    process.exit = savedExit;
  }
}
/** The files whose `Cli` this ward drives: each registry importer, or a factory's followers. */
const adopterFiles = adopters.map((a) => a.file).sort();

const STUB_EXIT = 7;
const FILLER = "ward-filler";
const PLAIN = "ward-plain-text";
const NOT_A_FLAG = "--ward-not-a-flag";

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

type Form = "direct" | "after-text" | "=value";
type Case = {
  adopter: string;
  row: string;
  /** The spelling dispatched: the row's name, or one of its aliases. */
  via: string;
  form: Form;
  /** The demoted token, exactly as written. */
  flag: string;
  argv: string[];
  control: string[];
};
type QuietCase = { adopter: string; row: string; via: string; argv: string[] };

function spellingsOf(r: RowView): string[] {
  return [r.name, ...r.aliases];
}

function casesFor(file: string, cli: Cli): { cases: Case[]; quiet: QuietCase[] } {
  const cases: Case[] = [];
  const quiet: QuietCase[] = [];
  for (const r of rowsOf(cli)) {
    if (r.auto || r.positionals.length === 0) continue;
    const n = r.positionals.length;
    const variadic = r.positionals.some((p) => p.variadic);
    // n positionals in all: n-1 fillers before `--`, the demoted token last.
    const fillers: string[] = Array(n - 1).fill(FILLER);
    // After-text: text AFTER `--` and before the token. Needs a second slot.
    const text = n >= 2 ? fillers : variadic ? [FILLER] : null;
    for (const via of spellingsOf(r)) {
      const head = via === "" ? [] : via.split(" ");
      const at = { adopter: file, row: r.name, via };
      quiet.push({ ...at, argv: [...head, ...fillers, "--", NOT_A_FLAG] });
      for (const k of r.accepted) {
        const direct = `--${k}`;
        const eq = `--${k}=ward-value`;
        cases.push({
          ...at,
          form: "direct",
          flag: direct,
          argv: [...head, ...fillers, "--", direct],
          control: [...head, ...fillers, "--", PLAIN],
        });
        if (text !== null)
          cases.push({
            ...at,
            form: "after-text",
            flag: direct,
            argv: [...head, "--", ...text, direct],
            control: [...head, "--", ...text, PLAIN],
          });
        cases.push({
          ...at,
          form: "=value",
          flag: eq,
          argv: [...head, ...fillers, "--", eq],
          control: [...head, ...fillers, "--", PLAIN],
        });
      }
    }
  }
  return { cases, quiet };
}

const withCli = adopters.filter((a): a is { file: string; cli: Cli } => a.cli !== null);
const rowsWithPositionals = withCli.flatMap(({ file, cli }) =>
  rowsOf(cli)
    .filter((r) => !r.auto && r.positionals.length > 0)
    .map((r) => `${file}:${r.name}`),
);
const swept = withCli.map(({ file, cli }) => casesFor(file, cli));
const cases = swept.flatMap((s) => s.cases);
const quietCases = swept.flatMap((s) => s.quiet);
const aliasRows = withCli.flatMap(({ file, cli }) =>
  rowsOf(cli)
    .filter((r) => !r.auto && r.positionals.length > 0 && r.aliases.length > 0)
    .flatMap((r) => r.aliases.map((a) => `${file}:${r.name}<-${a}`)),
);
const rebuiltOf = new Map(withCli.map(({ file, cli }) => [file, rebuild(cli)]));

/**
 * Every `parseArgs(` call in `src` that is NOT provably positional-free: the
 * argument must be a literal object carrying literal `strict: true` and literal
 * `allowPositionals: false`, and no spread (which could override either). A
 * non-literal argument or value is a finding, not a pass.
 */
function positionalParseFindings(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:nodeParseArgs|parseArgs)\s*\(/g)) {
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const rest = src.slice(m.index + m[0].length);
    if (!/^\s*\{/.test(rest)) {
      out.push(`L${line}: argument is not a literal object`);
      continue;
    }
    const open = m.index + m[0].length + rest.indexOf("{");
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}" && --depth === 0) break;
    }
    const block = src.slice(open, end + 1);
    const why = [
      /\.\.\./.test(block) ? "a spread" : "",
      /\bstrict\s*:\s*true\b/.test(block) ? "" : "no literal `strict: true`",
      /\ballowPositionals\s*:\s*false\b/.test(block) ? "" : "no literal `allowPositionals: false`",
    ].filter((w) => w !== "");
    if (why.length > 0) out.push(`L${line}: ${why.join(", ")}`);
  }
  return out;
}

describe("ward — a flag demoted by `--` is warned about, on every registry adopter", () => {
  test("the sweep actually ran (zero-denominator guards)", () => {
    // A dead sweep and a clean sweep are indistinguishable without these.
    expect(adopterFiles.length).toBeGreaterThanOrEqual(9);
    expect(rowsWithPositionals.length).toBeGreaterThan(0);
    expect(cases.length).toBeGreaterThan(0);
    expect(quietCases.length).toBeGreaterThan(0);
    // Each form and the alias spelling each reached at least one case.
    for (const f of ["direct", "after-text", "=value"])
      expect(cases.filter((c) => c.form === f).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.via !== c.row).length).toBeGreaterThan(0);
  });

  test("importing the adopters spawned, wrote, served and exited nothing (A5)", () => {
    expect(importEffects).toEqual([]);
  });

  test("every file that imports the registry exports exactly one Cli, or is a factory read through its followers (null is red, not 0)", () => {
    const unreadable = adopters.filter((a) => a.cli === null).map((a) => a.file);
    expect(unreadable).toEqual([]);
  });

  test("CALIBRATION: a follower is what CALLS the factory into an export, and its Cli must be that export", () => {
    const fromF = (spec: string) => spec === "./f";
    // Built: a named, default or namespace import called into an export.
    expect(
      builtExports('import { make } from "./f";\nexport const cli = make({});', fromF),
    ).toEqual(["cli"]);
    expect(builtExports('import make from "./f";\nexport default make();', fromF)).toEqual([
      "default",
    ]);
    expect(
      builtExports('import * as f from "./f";\nconst c = f.make();\nexport { c as cli };', fromF),
    ).toEqual(["cli"]);
    // Not built: importing, re-exporting, a type import, or a call kept private.
    expect(
      builtExports(
        'import { make } from "./f";\nmake;\nexport { cli } from "../bounty/backend/cli";',
        fromF,
      ),
    ).toEqual([]);
    expect(builtExports('export { make } from "./f";', fromF)).toEqual([]);
    expect(
      builtExports('import type { make } from "./f";\nexport const cli = make();', fromF),
    ).toEqual([]);
    expect(builtExports('import { make } from "./f";\nconst c = make();', fromF)).toEqual([]);
    expect(builtExports('import { make } from "./g";\nexport const cli = make();', fromF)).toEqual(
      [],
    );

    const fake = (): Cli =>
      ({ dispatch: async () => 0, rows: [], declaration: () => ({}) }) as unknown as Cli;
    const a = fake();
    const b = fake();
    expect(builtCli({ cli: a }, ["cli"])).toBe(a);
    // An unrelated Cli beside a built non-Cli: red.
    expect(builtCli({ cli: a, built: {} }, ["built"])).toBeNull();
    // Two Clis: red, even when one of them is the built one.
    expect(builtCli({ cli: a, other: b }, ["cli"])).toBeNull();
    // None: red.
    expect(builtCli({ built: {} }, ["built"])).toBeNull();
  });

  test("CALIBRATION: a builder is an exported function that RETURNS the factory's call, and one without stub deps is red", () => {
    const fromF = (spec: string) => spec === "./f";
    // Builders: a function declaration or an arrow, block or concise body.
    expect(
      builderExports(
        'import { make } from "./f";\nexport function build(d) { const x = 1; return make({ x, d }); }',
        fromF,
      ),
    ).toEqual(["build"]);
    expect(
      builderExports('import { make } from "./f";\nexport const b = (d) => make(d);', fromF),
    ).toEqual(["b"]);
    // Not builders: using the result, a private function, a call to something
    // else, a type import, or a nested return.
    expect(
      builderExports(
        'import { make } from "./f";\nexport async function run(a, d) { return await make(d).run(a); }',
        fromF,
      ),
    ).toEqual([]);
    expect(
      builderExports('import { make } from "./f";\nfunction b() { return make(); }', fromF),
    ).toEqual([]);
    expect(
      builderExports('import { make } from "./g";\nexport function b() { return make(); }', fromF),
    ).toEqual([]);
    expect(
      builderExports(
        'import type { make } from "./f";\nexport function b() { return make(); }',
        fromF,
      ),
    ).toEqual([]);
    expect(
      builderExports(
        'import { make } from "./f";\nexport function b() { return () => make(); }',
        fromF,
      ),
    ).toEqual([]);

    // The real one is found, and is driven.
    expect(adopterFiles).toContain("scriptorium/backend/kit/cli.ts#scriptoriumKitCli");
    // No stub deps, a throw, or a non-Cli: red.
    const fake = { dispatch: async () => 0, rows: [], declaration: () => ({}) };
    expect(builderCli({ b: () => fake }, "nowhere.ts#b", "b")).toBeNull();
    expect(
      builderCli(
        {
          scriptoriumKitCli: () => {
            throw new Error("x");
          },
        },
        "scriptorium/backend/kit/cli.ts#scriptoriumKitCli",
        "scriptoriumKitCli",
      ),
    ).toBeNull();
    expect(
      builderCli(
        { scriptoriumKitCli: () => ({}) },
        "scriptorium/backend/kit/cli.ts#scriptoriumKitCli",
        "scriptoriumKitCli",
      ),
    ).toBeNull();
  });

  test("the rebuilt table IS the adopter's table (declarations equal)", () => {
    const drift = withCli
      .filter(({ cli }) => !Bun.deepEquals(rebuild(cli).declaration(), cli.declaration()))
      .map((a) => a.file);
    expect(drift).toEqual([]);
  });

  test("an accepted flag after `--` warns once, in every form and spelling; stdout and exit unchanged", async () => {
    const failures: string[] = [];
    for (const c of cases) {
      const cli = rebuiltOf.get(c.adopter) as Cli;
      const demoted = await capture(() => cli.dispatch(c.argv));
      const control = await capture(() => cli.dispatch(c.control));
      const at = `${c.adopter} [${c.via || "(root)"}${c.via === c.row ? "" : ` -> ${c.row}`}] ${c.form} ${c.flag}`;
      const lines = demoted.err.split("\n").filter((l) => l !== "");
      // The token arrived as the LAST positional, on the row the spelling names.
      const expectOut = (tail: string, out: string) => {
        const parsed = JSON.parse(out) as { path: string; pos: string[] };
        return parsed.path === c.row && parsed.pos[parsed.pos.length - 1] === tail;
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

  test("a flag-shaped token no row accepts, after `--`, is text: no warning", async () => {
    const failures: string[] = [];
    for (const c of quietCases) {
      const cli = rebuiltOf.get(c.adopter) as Cli;
      const r = await capture(() => cli.dispatch(c.argv));
      const at = `${c.adopter} [${c.via || "(root)"}]`;
      const pos = r.code === STUB_EXIT ? (JSON.parse(r.out) as { pos: string[] }).pos : [];
      if (r.code !== STUB_EXIT) failures.push(`${at}: exit ${r.code} ${r.err}`);
      else if (r.err !== "") failures.push(`${at}: stderr ${JSON.stringify(r.err)}`);
      else if (pos[pos.length - 1] !== NOT_A_FLAG)
        failures.push(`${at}: token not last positional`);
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
      byForm: {
        direct: cases.filter((c) => c.form === "direct").length,
        "after-text": cases.filter((c) => c.form === "after-text").length,
        "=value": cases.filter((c) => c.form === "=value").length,
      },
      viaAlias: cases.filter((c) => c.via !== c.row).length,
      aliasRows,
      quietCases: quietCases.length,
      perAdopter: Object.fromEntries(
        adopterFiles.map((f) => [
          f,
          rowsWithPositionals.filter((r) => r.startsWith(`${f}:`)).length,
        ]),
      ),
    }).toEqual({
      // 10 since 2026-10-14: the kit workspace CLI joined, read through its
      // fixture (see `followersOf`), with 23 rows that take positionals (24
      // since `note-edit`, kit-workspace-e65-daemon).
      // 10 -> 9 at the cutover (scriptorium-delete-shipped): the shipped
      // Scriptorium's `defineCli` table (`scriptorium/backend/cli.ts`, 29 rows
      // with positionals) was deleted, and that file now only hands the
      // command line to the kit. Scriptorium's CLI is built by the kit's
      // factory, which this ward reads through the fixture follower; its own
      // builder (`scriptoriumKitCli(deps)` in `backend/kit/cli.ts`) exports a
      // function, not a built `Cli`, so it is not a follower (`followersOf`).
      // Every count below fell by the deleted table's share: rows 138 -> 109,
      // cases 902 -> 761 (direct 367 -> 310, after-text 168 -> 141, =value
      // 367 -> 310), quiet cases 139 -> 110.
      // 9 -> 10 (scriptorium-ward-blind-spots-after-deletion): builders are
      // now driven with stub deps (`BUILDER_ARGS`), so `scriptoriumKitCli`
      // joined with 32 rows that take positionals: 22 of the kit's (the
      // fixture's 24 less `workspace`, which an app with no home workspace
      // does not get, and the fixture's own `demo`) plus Scriptorium's own 10
      // (`add-folder`, `make-set`, `move-plan`, `note-remove`, `task-remove`,
      // `meta`, `meta-init`, `meta-set`, `hide`, `unhide`). Rows 109 -> 141, cases 761 -> 928 (direct
      // 310 -> 377, after-text 141 -> 174, =value 310 -> 377), quiet cases
      // 110 -> 142.
      adopters: 10,
      // Every row with ANY positional (required, optional or variadic), not
      // only c1's 43 variadic + 6 one-optional rows: a demoted token can fill
      // any positional slot. Measured 2026-09-27 on 41065365.
      rowsWithPositionals: 141,
      // Per (row, spelling, accepted flag), globals included: one direct and
      // one =value case, plus one after-text case wherever the row has room.
      // Measured 2026-09-27: 311 direct cases before the alias spelling joined.
      // 902 since the kit's `say` took `--via` (kit-port-via-refs): one more
      // case in each form.
      cases: 928,
      byForm: { direct: 377, "after-text": 174, "=value": 377 },
      // mind-mapper `message` -> `read`: direct and =value. `read` has one
      // non-variadic positional, so no after-text case.
      viaAlias: 2,
      // Rows with positionals that carry a verb alias. grapevine's `up` and
      // `prune` alias rows with no positionals, so they have no case here.
      aliasRows: ["mind-mapper/backend/cli.ts:read<-message"],
      // One per (row, spelling).
      quietCases: 142,
      perAdopter: {
        "astrolabe/backend/cli.ts": 6,
        "bounty/backend/cli.ts": 7,
        // digestify's one row is a verbless root that takes flags only.
        "digestify/backend/review.ts": 0,
        "glamour/backend/cli.ts": 10,
        "grapevine/backend/cli.ts": 19,
        "imago/backend/cli.ts": 11,
        "kit/workspace/fixtures/cli.ts": 24,
        "magpie/backend/cli.ts": 6,
        "mind-mapper/backend/cli.ts": 26,
        // Built with stub deps: 22 kit rows plus Scriptorium's own 10.
        "scriptorium/backend/kit/cli.ts#scriptoriumKitCli": 32,
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
    // (internal argv), so it is outside this question — as is every daemon in
    // INTERNAL_ENTRY_POINTS. Today's legitimate exceptions: none.
    const EXCEPTIONS: readonly string[] = [];
    const findings = argParsingEntryPoints()
      .filter(isCallerFacing)
      .flatMap((p) => positionalParseFindings(readEntryPoint(p)).map((f) => `${p}: ${f}`))
      .filter((f) => !EXCEPTIONS.some((e) => f.startsWith(`${e}:`)));
    expect(findings).toEqual([]);
    // And the registry itself is the one that does take them.
    expect(SHARED_PARSERS.filter((p) => allowsPositionals(readEntryPoint(p)))).toEqual([
      ...SHARED_PARSERS,
    ]);
  });

  test("the positional-free predicate reds anything it cannot prove (planted)", () => {
    const ok =
      "parseArgs({ args, options: { a: { type: 'string' } }, strict: true, allowPositionals: false })";
    expect(positionalParseFindings(ok)).toEqual([]);
    for (const bad of [
      "parseArgs({ args, options: {}, strict: true, allowPositionals: true })",
      "parseArgs({ args, options: {}, strict: true, allowPositionals: POS })",
      "parseArgs({ args, options: {}, allowPositionals: false })",
      "parseArgs({ args, options: {}, strict: STRICT, allowPositionals: false })",
      "parseArgs({ ...shared, strict: true, allowPositionals: false })",
      "parseArgs(config)",
      "nodeParseArgs({ args, options: {}, strict: true })",
    ])
      expect(positionalParseFindings(bad).length).toBe(1);
    // A declaration is not a call.
    expect(positionalParseFindings("function parseArgs(argv: string[]) {}")).toEqual([]);
  });
});
