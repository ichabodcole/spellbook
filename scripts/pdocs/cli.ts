#!/usr/bin/env bun
// `pdocs` — the documentation gate and the graph behind it.
//
//   bun scripts/pdocs/cli.ts check     lint the tree; 9 if it is dirty
//   bun scripts/pdocs/cli.ts report    what is missing, grouped by field
//   bun scripts/pdocs/cli.ts graph     the knowledge graph, both tiers
//   bun scripts/pdocs/cli.ts find      query by type, lifecycle, status, tag, date
//   bun scripts/pdocs/cli.ts backlinks what cites a document
//   bun scripts/pdocs/cli.ts orphans   library pages the catalog cannot reach
//   bun scripts/pdocs/cli.ts new       create a document of a declared type
//   bun scripts/pdocs/cli.ts schema    this CLI's own surface, as a declaration
//
// Hand-rolled dispatch, and ZERO DEPENDENCIES on purpose. The recipe for this
// shape of CLI prescribes `citty`; this declines it. The lint's whole value is
// that the payload can be dropped into a repository and just run — a framework
// drags an install into every scaffolded project, and the surface here is a
// table, four interceptors and an argument loop. `project-antfarm` hand-rolls
// the same job in 408 lines.
//
// The output contract — format resolution, the envelope, the exit codes — is
// `envelope.ts`. This file is only about getting to the right command with the
// right arguments, and about turning a thrown `CliError` into a status.

import { existsSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { isatty } from "node:tty";
import { type Ctx, context } from "./lint/rules.ts";
import {
  CliError,
  ExitCode,
  FORMATS,
  type Format,
  NotFoundError,
  UsageError,
  outOfSet,
  readFlag,
  printDiagnostic,
  printEnvelope,
  resolveFormat,
} from "./envelope.ts";
import { backlinks } from "./commands/backlinks.ts";
import { check } from "./commands/check.ts";
import { find } from "./commands/find.ts";
import { graph } from "./commands/graph.ts";
import { newCommand } from "./commands/new.ts";
import { orphans } from "./commands/orphans.ts";
import { report } from "./commands/report.ts";

/** One flag, as help and as the parser's rule for it. A `metavar` means the
 *  flag takes the next token as its value; an `alias` is a second spelling the
 *  parser accepts for the same flag, declared here so the accepted set and the
 *  set a rejection enumerates are one list. */
export interface Option {
  flag: string;
  alias?: string;
  metavar?: string;
  summary: string;
  /** The closed set the flag's value is CHECKED against, when there is one.
   *  Only for a set the parser actually enforces — a filter that happens to be
   *  usually spelled one of a few ways has no set, and declaring one would
   *  publish a constraint nothing applies. */
  values?: readonly string[];
}

/** One positional a verb takes. `required` is here rather than inferred from a
 *  `<name>` / `[name]` spelling, because the spelling is prose and the fact is
 *  a fact: `pdocs new <type>` is always required and its `<name>` is not (a
 *  `proposal` takes its filename from the registry, not from the caller). */
export interface Positional {
  name: string;
  required: boolean;
}

/** What a command is handed. The tree is already resolved and already proven to
 *  exist — a command never re-derives a root, because a root derived in the
 *  wrong place is silent: the walk finds nothing and the lint reports clean. */
export interface Invocation {
  ctx: Ctx;
  format: Format;
  /** Parsed command-specific flags, keyed by flag with the leading `--`. */
  flags: Record<string, string | true>;
  /** Positional arguments, in order. */
  positionals: string[];
}

/**
 * A VERB'S SURFACE — everything that describes what the caller may type after
 * `pdocs <name>`, and nothing about who answers it.
 *
 * The parser, the dispatcher, the help text, the machine manifest, the set a
 * rejection enumerates and the emitted declaration all read this one row. That
 * is the whole design: a flag this table does not carry cannot be accepted,
 * listed, enumerated or declared, so those five cannot disagree with each other.
 *
 * SEPARATE FROM `Command` because two verbs — `help` and `schema` — are
 * answered by an interceptor before dispatch and take no `Invocation` at all:
 * they describe the tool rather than the tree, so they have no handler to hold
 * and needing a `.project-docs.json` to print them would be absurd. They still
 * have a surface, and a verb with a surface and no handler is exactly what this
 * type is. Before it existed `help` was a bare name and its flags were nobody's:
 * `pdocs help --acc-not-a-flag` exited 0 and printed help.
 */
export interface Verb {
  name: string;
  summary: string;
  usage: string;
  /** Beyond the globals every verb accepts. */
  options: Option[];
  /** The positionals this verb takes, for the manifest, for arity and for the
   *  declaration. */
  positionals?: Positional[];
}

export interface Command extends Verb {
  run(invocation: Invocation): number;
}

const COMMANDS: Command[] = [
  check,
  report,
  graph,
  find,
  backlinks,
  orphans,
  newCommand,
];

const GLOBAL_OPTIONS: Option[] = [
  {
    flag: "--root",
    metavar: "<path>",
    summary: "The repository to work on. Defaults to this CLI's own.",
  },
  {
    flag: "--format",
    metavar: "<text|json>",
    summary: "Output format. Defaults to text on a TTY, json otherwise.",
    // The one closed set this CLI enforces on a flag VALUE, and `resolveFormat`
    // is what enforces it. Read from there rather than re-listed here.
    values: FORMATS,
  },
  { flag: "--json", summary: "Shorthand for `--format json`." },
  {
    flag: "--help",
    alias: "-h",
    summary: "Help for the command, or for pdocs. Also -h.",
  },
  {
    flag: "--version",
    alias: "-V",
    summary: "Print the version and exit. Also -V.",
  },
];

/**
 * `help` is a verb the caller may type and is deliberately NOT a `Command` row:
 * it needs no tree, takes no `Invocation`, and is answered by an interceptor
 * before dispatch. It carries a row anyway, so that its flags and its positional
 * are declared in the same place every other verb's are — see `Verb`.
 */
const HELP: Verb = {
  name: "help",
  summary: "This help, or one verb's. `pdocs help --json` for the manifest.",
  usage: "pdocs help [<verb>] [--json]",
  options: [],
  positionals: [{ name: "verb", required: false }],
};

/**
 * `schema` emits `acc` declaration format v0, describing this CLI.
 *
 * Answered before dispatch for the same reason `help` is: it describes the
 * TOOL, and a tool that could not say what its own interface is until it found
 * a `.project-docs.json` would be useless to the caller most in need of the
 * answer. See `buildDeclaration`.
 */
const SCHEMA: Verb = {
  name: "schema",
  summary: "This CLI's own surface, as an acc declaration. Always JSON.",
  usage: "pdocs schema",
  options: [],
  positionals: [],
};

/**
 * EVERY VERB `pdocs` ANSWERS TO, in help order — the dispatched ones and the
 * two the root answers itself.
 *
 * THIS IS THE SET A REJECTION ENUMERATES, the set help lists, the set the
 * manifest carries and the set the declaration publishes. Never a list beside
 * them: a hand-maintained enumeration in an error message is a second source of
 * truth for the surface, and the drift is silent — the message stays confident
 * while the table underneath it moves.
 *
 * A verb answered before the table is consulted is the one a walk over "the
 * commands" walks straight past, so `help` and `schema` are appended HERE, once,
 * rather than each consumer remembering them.
 */
const VERBS: Verb[] = [...COMMANDS, SCHEMA, HELP];

export function commandNames(): string[] {
  return VERBS.map((v) => v.name);
}

/**
 * Whether `argv` carries a global flag, in ANY spelling the table declares.
 *
 * The short forms used to be literals here — `argv.includes("-V")` — which made
 * the option table and the interceptors two places that had to agree about the
 * same flag. They read from one now.
 */
function asks(argv: string[], flag: string): boolean {
  const option = GLOBAL_OPTIONS.find((o) => o.flag === flag);
  return (
    argv.includes(flag) ||
    (option?.alias !== undefined && argv.includes(option.alias))
  );
}

/**
 * Every spelling of every flag in `options`, aliases included, in help order —
 * as the DECLARATION's own argument shape.
 *
 * ONE FUNCTION, TWO CONSUMERS, and that is the point. `spellings` below maps it
 * to names for the rejection's `choices`; `buildDeclaration` publishes it whole.
 * The set the parser accepts, the set a rejection enumerates and the set the
 * declaration names are therefore not three facts that agree today — they are
 * one array from one call.
 */
function declaredArgs(options: Option[]): DeclaredArg[] {
  const out: DeclaredArg[] = [];
  for (const o of options) {
    // `status` is "valid" throughout, and that is a claim rather than a
    // formality: pdocs has no flag it REGISTERS AND REFUSES. The day one
    // appears, it needs a `status: "refused"` here and a field on `Option` to
    // carry it — declaring it valid would be the exact defect `status` exists
    // to prevent.
    out.push({
      name: o.flag,
      type: o.metavar === undefined ? "boolean" : "string",
      status: "valid",
      ...(o.values ? { values: [...o.values] } : {}),
    });
    // An alias never carries the value slot — `parseArgs` registers it that way
    // — so it is a boolean row of its own. v0 has no alias field, so every
    // spelling is a first-class row or the declaration is short by one.
    if (o.alias)
      out.push({ name: o.alias, type: "boolean", status: "valid" });
  }
  return out;
}

/** Every spelling of a flag, aliases included, in help order. */
function spellings(options: Option[]): string[] {
  return declaredArgs(options).map((a) => a.name);
}

/** The flags accepted before a command has been named. */
export function globalFlagNames(): string[] {
  return spellings(GLOBAL_OPTIONS);
}

/** The flags accepted after one has — its own, then the globals. */
export function commandFlagNames(verb: Verb): string[] {
  return spellings([...verb.options, ...GLOBAL_OPTIONS]);
}

const EXIT_CODE_TABLE: Array<[number, string]> = [
  [0, "clean — or dirty under `lint.adopting: true`"],
  [1, "an unexpected fault inside pdocs itself"],
  [2, "bad invocation: unknown command, unknown flag, missing value"],
  [5, "no docs root, or no .project-docs.json"],
  [6, "the document already exists"],
  [9, "outcome: it ran fine, and the documents are dirty"],
];

// ---------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------

/**
 * The tree to work on. Without `--root` that is this file's own repository, as
 * the lint always did; `--root <path>` points it at another one, resolved
 * against the working directory.
 *
 * A `--root` that cannot be used exits 2 rather than falling back to the
 * default, because the failure mode of falling back is a `clean` reported for a
 * repository nobody actually checked.
 */
export function repoRootFrom(argv: string[]): string {
  const { found, value } = readFlag(argv, "--root");
  if (!found) return resolve(import.meta.dir, "..", "..");

  if (value === undefined)
    throw new UsageError("--root needs a path — `--root /path/to/repo`.");

  const root = resolve(process.cwd(), value);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new UsageError(`--root is not a directory: ${root}`);

  return root;
}

/**
 * Read the tree's configuration, and refuse to work on something that is not
 * one.
 *
 * `loadConfig` deliberately falls back to defaults when `.project-docs.json` is
 * absent, so that a project mid-adoption can run the lint before it has written
 * one. That is right for a library function and wrong for a CLI: an agent that
 * points `pdocs` at the wrong directory would otherwise get a confident answer
 * about a `docs/` folder that was never there. Missing config or missing docs
 * root is `NotFound`, not a silent default.
 */
export function treeContext(root: string): Ctx {
  if (!existsSync(join(root, ".project-docs.json")))
    throw new NotFoundError(
      `no .project-docs.json in ${root} — not a project-docs tree.`
    );

  const ctx = context(root);
  if (!existsSync(ctx.docsRoot) || !statSync(ctx.docsRoot).isDirectory())
    throw new NotFoundError(
      `no docs root at ${ctx.docsRoot} — \`docsRoot\` in .project-docs.json points nowhere.`
    );

  return ctx;
}

// ---------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------

/**
 * Everything after the command name.
 *
 * An unknown flag is an error and NAMES THE TOKEN. A CLI that shrugs at
 * `--formt json` and renders text has silently done something other than what
 * was asked, and the caller most likely to make that typo is the one least able
 * to notice — an agent reading stdout, not a person reading a terminal.
 */
export function parseArgs(
  verb: Verb,
  argv: string[]
): { flags: Record<string, string | true>; positionals: string[] } {
  const takesValue = new Map<string, boolean>();
  for (const o of [...GLOBAL_OPTIONS, ...verb.options]) {
    takesValue.set(o.flag, o.metavar !== undefined);
    // An alias never carries the value slot — `-h` and `-V` are answered by the
    // interceptors above and never reach here — but it is an accepted spelling,
    // so a parser that rejected it would contradict the set it enumerates.
    if (o.alias) takesValue.set(o.alias, false);
  }

  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    // `--flag=value` IS `--flag value`, split here and nowhere else in this
    // loop, so every branch below reasons about a flag name and an optional
    // value rather than about how the caller spelled them. `readFlag` does the
    // same split for the two scanners that run before this one.
    //
    // The flag NAME is what a rejection names, because the name is the part
    // that is unknown — `unknown flag \`--formt=json\`` invites the reader to
    // wonder whether the value was the problem. The whole token is kept in
    // `details.token` for a caller reconstructing what was typed.
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const attached = eq === -1 ? undefined : token.slice(eq + 1);

    if (!takesValue.has(name)) {
      const valid = commandFlagNames(verb);
      throw new UsageError(
        `unknown flag \`${name}\` for \`pdocs ${verb.name}\`. Valid flags: ${valid.join(", ")}.`,
        {
          token,
          choices: valid,
          hint: `\`pdocs ${verb.name} --help\` describes each one.`,
        }
      );
    }

    if (!takesValue.get(name)) {
      // A BOOLEAN FLAG HANDED A VALUE IS REFUSED, not silently stripped.
      // `--json=false` means the opposite of what it does, and a parser that
      // reads it as `--json` has performed the inversion quietly.
      if (attached !== undefined)
        throw new UsageError(
          `\`${name}\` takes no value — write \`${name}\`, not \`${token}\`.`,
          { token, hint: `\`pdocs ${verb.name} --help\` describes each one.` }
        );
      flags[name] = true;
      continue;
    }

    if (attached !== undefined) {
      if (attached === "") throw new UsageError(`${name} needs a value.`);
      flags[name] = attached;
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-"))
      throw new UsageError(`${name} needs a value.`);
    flags[name] = value;
    i++;
  }

  const expected = verb.positionals ?? [];
  if (positionals.length > expected.length)
    throw new UsageError(
      `unexpected argument \`${positionals[expected.length]}\` — \`${verb.usage}\`.`
    );

  return { flags, positionals };
}

// ---------------------------------------------------------------------------------------
// Help and version
// ---------------------------------------------------------------------------------------

/**
 * The version this CLI ships as.
 *
 * Embedded rather than read from a neighbouring `package.json`, because the
 * CLI does not reliably have one. `hooks/post_gen_project.py` deliberately
 * does NOT move `package.json` when installing into an existing project — the
 * host has its own — so reading the nearest one answers with the HOST
 * project's version, which is not this tool's version and is worse than
 * useless for a caller trying to tell two `pdocs` apart.
 *
 * release-please rewrites the literal below via the marker comment, the same
 * way anthill's CLI carries its own.
 */
const VERSION = "8.1.0"; // x-release-please-version

export function version(): string {
  return VERSION;
}

function optionLines(options: Option[]): string[] {
  const left = options.map((o) =>
    o.metavar ? `${o.flag} ${o.metavar}` : o.flag
  );
  const width = Math.max(...left.map((s) => s.length));
  return options.map(
    (o, i) => `  ${(left[i] as string).padEnd(width)}  ${o.summary}`
  );
}

export function helpText(verb?: Verb): string {
  if (verb) {
    const lines = [
      `pdocs ${verb.name} — ${verb.summary}`,
      "",
      "Usage",
      `  ${verb.usage}`,
      "",
      "Options",
      ...optionLines([...verb.options, ...GLOBAL_OPTIONS]),
    ];
    return `${lines.join("\n")}\n`;
  }

  const width = Math.max(...VERBS.map((v) => v.name.length));
  return `${[
    "pdocs — the documentation gate, and the graph behind it.",
    "",
    "Usage",
    "  pdocs <command> [options]",
    "",
    "Commands",
    ...VERBS.map((v) => `  ${v.name.padEnd(width)}  ${v.summary}`),
    "",
    "Options",
    ...optionLines(GLOBAL_OPTIONS),
    "",
    "Exit codes",
    ...EXIT_CODE_TABLE.map(([code, meaning]) => `  ${code}  ${meaning}`),
  ].join("\n")}\n`;
}

/** The machine manifest: the same information `helpText` renders, as data. */
export function helpManifest(): Record<string, unknown> {
  return {
    name: "pdocs",
    version: version(),
    summary: "the documentation gate, and the graph behind it",
    commands: VERBS.map((v) => ({
      name: v.name,
      summary: v.summary,
      usage: v.usage,
      options: [...v.options, ...GLOBAL_OPTIONS].map((o) => ({
        flag: o.flag,
        metavar: o.metavar ?? null,
        summary: o.summary,
        values: o.values ? [...o.values] : null,
      })),
      positionals: v.positionals ?? [],
    })),
    exitCodes: Object.fromEntries(EXIT_CODE_TABLE),
  };
}

/**
 * Help is prose unless asked for data.
 *
 * The only place the TTY heuristic does NOT apply, and deliberately: the
 * grammar is `pdocs help [--json]`, so a piped `pdocs --help` — a human running
 * it through `less` — stays readable. Every command that produces an ANSWER
 * follows the heuristic; help produces documentation.
 */
function helpFormat(argv: string[]): Format {
  return resolveFormat(argv, true);
}

// ---------------------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------------------

/**
 * `acc` declaration format v0, as the types that format defines.
 *
 * Held here rather than imported: `agent-cli-conformance` is a dev tool of the
 * REPOSITORY, and this CLI is copied whole into projects that have never heard
 * of it. Zero dependencies is the payload's whole proposition; a declaration
 * that only emits where a dev dependency is installed emits nowhere that
 * matters. The cost is named: `formatVersion` below is a literal duplicating
 * that kit's constant, and nothing links them at compile time.
 */
interface DeclaredArg {
  name: string;
  type: "string" | "boolean";
  status: "valid" | "refused";
  values?: string[];
}

interface DeclaredCommand {
  path: string[];
  args: DeclaredArg[];
  positionals: Positional[];
}

interface Declaration {
  formatVersion: "0";
  provenance: "emitted";
  selfDescription: { args: string[] } | null;
  commands: DeclaredCommand[];
}

/**
 * WHAT THIS CLI SAYS ITS OWN INTERFACE IS — by walking the same tables the
 * parser and the dispatcher walk, at answer time.
 *
 * `provenance: "emitted"` is the strongest claim the format has and it is true
 * here because nothing was transcribed: every row below comes out of `VERBS`,
 * `GLOBAL_OPTIONS` and each verb's own `options`, and `declaredArgs` is the
 * same call `commandFlagNames` makes for the set a rejection enumerates. There
 * is no second document to keep in step, which is the only reason the claim is
 * safe to make.
 *
 * THE ROOT IS A ROW, and it is the row a walk over "the commands" leaves out.
 * `--help`, `-h`, `--version`, `-V`, `--root`, `--format` and `--json` are
 * flags the root answers before any verb; they are not commands and they are
 * not any command's own flags, so without `path: []` every one of them would
 * come back `accepted-not-declared` against the kit's own probe of the root.
 *
 * WHAT IT DOES NOT CARRY, and the format is what decides:
 *
 * - **The creatable document types**, which `pdocs new <type>` enforces from
 *   `buildRegistry`. They are POSITIONAL values, and `DeclaredPositional` in v0
 *   holds `name`, `required` and `variadic` and refuses every other key — there
 *   is no `values` slot on a positional the way there is on an argument. So the
 *   closed set stays where a caller can already reach it: the rejection's
 *   `choices`, and `pdocs help --json`.
 * - **Per-type value sets** — `--lifecycle` and `--variant` are checked against
 *   a set that depends on the type named in the positional, so no single set is
 *   true of the flag. `values` is absent rather than wrong.
 */
export function buildDeclaration(): Declaration {
  return {
    formatVersion: "0",
    provenance: "emitted",
    // Derived from the verb's own row rather than written as a literal: rename
    // the verb and this follows it, instead of going stale and reporting
    // `self-description-not-declared` on the next census.
    selfDescription: { args: [SCHEMA.name] },
    commands: [
      {
        path: [],
        args: declaredArgs(GLOBAL_OPTIONS),
        // The root's own arity, which dispatch enforces: a bare invocation is a
        // usage error, and the first token has to name a verb.
        positionals: [{ name: "command", required: true }],
      },
      ...VERBS.map((v) => ({
        path: [v.name],
        args: declaredArgs([...v.options, ...GLOBAL_OPTIONS]),
        positionals: v.positionals ?? [],
      })),
    ],
  };
}

// ---------------------------------------------------------------------------------------
// Writing to the terminal that may not be one
// ---------------------------------------------------------------------------------------

/**
 * Is stdout a terminal — asked WITHOUT materializing a stream over fd 1.
 *
 * `process.stdout.isTTY` is the obvious spelling and it silently truncates this
 * CLI's output. Reading any property of Node's stdout object materializes Bun's
 * `WriteStream` over the descriptor, and from that moment `console.log` routes
 * through it — an ASYNCHRONOUS writer whose queued tail is dropped when the
 * process ends. Left alone, `console.log` writes straight to the descriptor and
 * everything arrives.
 *
 * The loss is invisible until the output is big and stdout is a pipe, because a
 * pipe stops accepting writes once its 64 KiB buffer is full and a terminal
 * does not. Measured: `graph --format json` over this repository is 77757 bytes
 * redirected to a file, and was exactly 65536 through a pipe — cut mid-string,
 * `JSON.parse` refusing it, exit status 0.
 *
 * That is the DECLARED PRIMARY PATH, not an edge case. `resolveFormat` renders
 * JSON precisely BECAUSE stdout is not a terminal, so the caller this CLI is
 * built for — an agent capturing stdout — was the only one ever handed a
 * truncated answer, and was handed it silently.
 *
 * `node:tty`'s `isatty(1)` answers the same question against the raw descriptor
 * and materializes nothing. THE RULE THIS FILE KEEPS: pdocs never reaches for
 * Node's stdout or stderr objects. Prose goes out through `writeTo` below;
 * everything else goes through `console.log` / `console.error`. `cli.test.ts`'s
 * "stdout survives a real pipe" fails if this is undone.
 */
export function stdoutIsTerminal(): boolean {
  return isatty(1);
}

/** Write to a descriptor directly. Used for the help text, which is the one
 *  output that is not a line-oriented render and must not gain a newline. */
function writeTo(fd: 1 | 2, text: string): void {
  writeSync(fd, text);
}

// ---------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------

function run(argv: string[]): number {
  // Interceptors, before dispatch: these four answer without a tree — they
  // describe the TOOL rather than the tree — and `--help` has to work on a
  // command whose arguments are otherwise wrong.
  if (asks(argv, "--version")) {
    // A BARE STRING IN TEXT MODE, A FIELD IN MACHINE MODE. A shell running
    // `pdocs --version` in a terminal should not start receiving JSON; a caller
    // that is piping asked for structured output and should not have to regex a
    // version out of it. `--version` is intercepted here, ahead of every other
    // token, so the answer goes through the same envelope as every command
    // rather than short-circuiting past it.
    if (resolveFormat(argv, stdoutIsTerminal()) === "json")
      printEnvelope("version", { name: "pdocs", version: version() });
    else console.log(version());
    return ExitCode.Success;
  }

  const first = argv[0];

  if (first === undefined) {
    // A bare invocation is a usage error, not a request for help — but the help
    // is what a HUMAN needs to see, so on a terminal it goes to stderr and
    // stdout stays empty for whatever was going to parse it.
    //
    // Off a terminal, machine mode is in force and machine mode holds on EVERY
    // outcome, this one included: a caller that pipes `pdocs` and reads stderr
    // gets one JSON document rather than a help screen it has no parser for.
    // Rendering prose here would be the same defect `resolveFormat` exists to
    // prevent one line further down the dispatch.
    if (resolveFormat(argv, stdoutIsTerminal()) === "text") {
      writeTo(2, helpText());
      return ExitCode.Usage;
    }
    throw new UsageError("pdocs takes a command — none was given.", {
      choices: commandNames(),
      hint: "`pdocs help` prints the command list and the exit-code table.",
    });
  }

  if (first === HELP.name || asks(argv, "--help")) {
    // `pdocs help ...` IS PARSED; `--help` on a broken invocation is not, and
    // the asymmetry is the point. `--help` has to answer a command whose
    // arguments are otherwise wrong — that is what it is for. `help` typed as a
    // verb is an invocation of its own, and it used to accept anything at all:
    // `pdocs help --acc-not-a-flag` exited 0 and printed help, which is the
    // silent-accept this CLI rejects everywhere else. It reads `HELP`'s row, so
    // the flags it takes are the flags it declares.
    if (first === HELP.name) parseArgs(HELP, argv.slice(1));
    const named = VERBS.find(
      (v) => v.name === (first === HELP.name ? argv[1] : first)
    );
    if (helpFormat(argv) === "json") {
      printEnvelope("help", helpManifest());
      return ExitCode.Success;
    }
    writeTo(1, helpText(named));
    return ExitCode.Success;
  }

  if (first === SCHEMA.name) {
    // THE DECLARATION IS NOT ENVELOPED, and this is the one command where that
    // is right. `acc check --declaration` reads the document at the top level
    // and REFUSES unknown keys, so `{ ok, data, meta }` around it is not a
    // wrapper — it is a file that tool cannot read. The answer is a document in
    // a format this CLI does not own, so there is nothing for `--format` to
    // choose between and both modes emit the same bytes.
    parseArgs(SCHEMA, argv.slice(1));
    writeTo(1, `${JSON.stringify(buildDeclaration(), null, 2)}\n`);
    return ExitCode.Success;
  }

  // A FLAG WHERE A COMMAND BELONGS — and the two ways that happens are not the
  // same error.
  //
  // A flag this CLI HAS is not unknown, it is MISPLACED, and the rejection used
  // to say `unknown flag \`--root\`. Valid flags: --root, ...` — a sentence that
  // contradicts itself inside its own punctuation, enumerates a set the caller
  // just picked from, and withholds the single fact that would fix the
  // invocation. What belongs in that position is a command, so a command list
  // is what this rejection enumerates.
  //
  // ITS VALUE IS CHECKED FIRST where the flag declares a closed set. A value
  // outside the set is wrong wherever the flag sits, so `pdocs --format yaml
  // check` reports the value and not the placement: the caller has two things
  // to fix and only one of them is legible from the usage line. A7's `how to
  // comply` asks a verb-first tool for exactly this, and until it was done the
  // detached spelling of that probe drew a placement message that never
  // revealed whether the value had been read at all.
  //
  // BOTH REJECTIONS ENUMERATE, and both read their set from the table the
  // parser itself uses. A caller that guessed wrong is the caller most in need
  // of the list, and it costs nothing on the path where the guess was right.
  if (first.startsWith("-")) {
    const eq = first.indexOf("=");
    const spelled = eq === -1 ? first : first.slice(0, eq);
    const misplaced = GLOBAL_OPTIONS.find(
      (o) => o.flag === spelled || o.alias === spelled
    );
    if (misplaced) {
      const value = eq === -1 ? argv[1] : first.slice(eq + 1);
      if (
        misplaced.values !== undefined &&
        value !== undefined &&
        !value.startsWith("-") &&
        !misplaced.values.includes(value)
      )
        throw outOfSet(misplaced.flag, value, misplaced.values);

      const verbs = commandNames();
      const slot = misplaced.metavar === undefined ? "" : ` ${misplaced.metavar}`;
      throw new UsageError(
        `\`${spelled}\` must follow a command — \`pdocs <command> ${spelled}${slot}\`. ` +
          `Commands: ${verbs.join(", ")}.`,
        {
          token: first,
          choices: verbs,
          hint: "`pdocs help` prints the command list and the exit-code table.",
        }
      );
    }

    const valid = globalFlagNames();
    throw new UsageError(
      `unknown flag \`${first}\` — pdocs takes a command first. Valid flags: ${valid.join(", ")}.`,
      { token: first, choices: valid, hint: "`pdocs help` lists the commands." }
    );
  }

  const command = COMMANDS.find((c) => c.name === first);
  if (!command) {
    const verbs = commandNames();
    throw new UsageError(
      `unknown command \`${first}\` — expected one of: ${verbs.join(", ")}.`,
      {
        token: first,
        choices: verbs,
        hint: "`pdocs help` prints the command list and the exit-code table.",
      }
    );
  }

  const rest = argv.slice(1);
  // `--root` is validated FIRST so its own diagnostic wins over the parser's
  // generic "needs a value". Pointing the gate at the wrong tree is the failure
  // this CLI most needs to be legible about.
  const root = repoRootFrom(rest);
  const { flags, positionals } = parseArgs(command, rest);
  const format = resolveFormat(rest, stdoutIsTerminal());
  const ctx = treeContext(root);

  return command.run({ ctx, format, flags, positionals });
}

function main(): void {
  const argv = process.argv.slice(2);
  // Resolved before anything can throw, so a diagnostic is never rendered in
  // the wrong format because the failure happened during format resolution.
  //
  // WHEN RESOLUTION ITSELF FAILS — `--format yaml` — the fallback is the format
  // the caller would have got had they passed no `--format` at all, which off a
  // terminal is JSON. It used to be text unconditionally, and that is exactly
  // the defect B5 is named for: a caller who is piping gets prose on the one
  // path where the parser stopped early, so `pdocs check --format yaml | jq`
  // failed to parse for a reason that had nothing to do with jq.
  let format: Format = stdoutIsTerminal() ? "text" : "json";
  try {
    format = resolveFormat(argv, stdoutIsTerminal());
  } catch {
    /* the bad --format is itself reported below, in the fallback format */
  }

  // `process.exitCode`, never `process.exit()`. Exiting explicitly abandons
  // whatever output has not left the process yet; setting the status and
  // returning lets the runtime finish the writes and exit with it. Nothing here
  // holds the event loop open — every command is synchronous filesystem work —
  // so returning costs nothing. See `stdoutIsTerminal` for the failure this is
  // half of, and `cli.test.ts`'s "stdout survives a real pipe" for the guard.
  try {
    process.exitCode = run(argv);
  } catch (e) {
    // A READER THAT LEFT IS NOT A FAULT, and `1` would say it was — this CLI
    // documents that code as "an unexpected fault inside pdocs itself".
    //
    // `schema` and `help` are the two commands that write through `writeTo`,
    // whose `writeSync` throws EPIPE synchronously when the far end of the
    // pipe is already gone. Every other command writes through `console.log`,
    // which swallows exactly this and exits 0 — so before this branch, one
    // pipeline (`pdocs schema | true`) reported an internal fault on two verbs
    // and nothing at all on the other five. The caller asked to stop reading.
    // Say nothing and exit 0, the way the majority of this CLI already did.
    if ((e as NodeJS.ErrnoException)?.code === "EPIPE") return;

    const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "pdocs";
    const error =
      e instanceof CliError
        ? e
        : new CliError(
            e instanceof Error ? e.message : String(e),
            "internal",
            ExitCode.Internal
          );
    printDiagnostic(command, error, format);
    process.exitCode = error.exitCode;
  }
}

if (import.meta.main) main();
