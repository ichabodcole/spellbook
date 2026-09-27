/**
 * The house's ONE CLI registry: one table drives the parser, the dispatcher,
 * help, the rejections' `choices`, `--version` and the acc declaration
 * (`schema`, format v0).
 *
 * Generalised from the three hand-built registries (grapevine, glamour,
 * scriptorium) per `docs/items/shared-cli-registry-in-the-kit/write-up.md`, as
 * amended by its cold read (`…/artifacts/cold-read.md`). Where they disagreed,
 * the cold read won.
 *
 * ⛔ THE KIT IS A LEAF. This module imports only `node:util` and other kit
 * modules (`../wire/errors`, `../lib/printJson`).
 *
 * ⛔ NO SIDE EFFECTS AT IMPORT, AND NONE IN `defineCli`. Building the table only
 * validates and indexes it; nothing is parsed, printed or read until `main` or
 * `dispatch` is called. A grimoire ward can import a spell's table and read
 * `recognizedFlags`, `flagsFor`, `verbs` and `declaration()` without running it.
 *
 * ── THE CONTRACT A SPELL CANNOT CHANGE ─────────────────────────────────────
 *
 * 1. `--help`/`-h` and `--version`/`-V` as `argv[0]` run the `help` or
 *    `version` row and PASS THE REMAINING ARGUMENTS ON to it, so that row's own
 *    flag check applies: `--version --human` works where `version` accepts
 *    `--human`, and `--version --junk` is exit 2 where it does not.
 * 2. Empty argv is a usage error (acc C2/D2: one envelope on stderr, exit 2,
 *    `choices` = the verbs) — unless the CLI has a verbless `root` row that
 *    accepts an empty argv (no required positionals; flags defaulted).
 * 3. The verb is found per the grammar:
 *    - `verb-first` (default): `argv[0]`. A dash-led `argv[0]` that is not an
 *      interceptor is an unknown ROOT flag (`choices` = the interceptors, long
 *      first). Flags before the verb are refused, including global ones.
 *    - `flags-anywhere`: the first token that is neither a flag nor a string
 *      flag's value (`glamour --session x info` runs `info`). The
 *      unknown-root-flag rule does NOT apply; an argv with no verb in it is
 *      parsed whole, so an unknown flag there is refused with the root's set.
 *    In both, a bare `--` before the verb makes the NEXT token the verb
 *    candidate and everything after it positional (acc A6): `cli -- --x` is
 *    `unknown command "--x"`, never an option.
 * 4. Nesting is one level: a row named `"node edit"`. The sub-verb of a group
 *    is found by the group's `subVerbAt` (see `GroupSpec`). A group with no row
 *    of its own rejects a missing or unknown sub-verb with its sub-verbs as
 *    `choices`; a group WITH its own row (`doc <id>`) runs that row instead.
 * 5. The row's args are parsed strict against the WHOLE options table (with
 *    `default`s stripped), so a flag the spell knows but this row does not take
 *    is refused as MISPLACED (`--x is not accepted by \`verb\``), and one the
 *    spell does not know as UNKNOWN. Both carry `choices` = this row's accepted
 *    set (its own flags plus `globalFlags`; a verbless root's adds the
 *    interceptors, as its declared row does). After a `--` everything is a
 *    positional (node's parser honours it). A post-`--` token that spells a
 *    flag this row accepts is still a positional, but it earns one
 *    `# warning:` line on stderr naming the recovery (`warnDemoted`); stdout
 *    and the exit code are unchanged.
 * 6. Defaults are applied AFTER the per-row check, and only for flags the row
 *    accepts — so a defaulted flag never trips the misplaced-flag check, and a
 *    row never sees another row's default.
 * 7. Arity is enforced from `positionals`; the rejection names the missing
 *    `<positional>` or the extra token. A row's `check` may then refuse a
 *    combination the declaration cannot express (flag-dependent arity).
 * 8. The row runs; a number it returns is the exit code, anything else is 0.
 *
 * The module adds `help`, `version` and `schema` rows unless the spell defines
 * a row of that name (grapevine's `version --human`). They are ordinary rows:
 * declared, strict, and given `globalFlags` like every other row.
 */

import { parseArgs } from "node:util";
import { printJson } from "../lib/printJson";
import { CliError, die, reportCliError, setCurrentCommand } from "../wire/errors";

// ── types ─────────────────────────────────────────────────────────────────

export type FlagType = "string" | "boolean";

/** One `parseArgs` option, plus the `default` node's parser also takes. */
export type OptionSpec = {
  type: FlagType;
  multiple?: boolean;
  short?: string;
  default?: string | boolean | readonly string[] | readonly boolean[];
};

export type OptionsTable = Readonly<Record<string, OptionSpec>>;

export type PositionalSpec = { name: string; required: boolean; variadic?: boolean };

export type FlagValue = string | boolean | (string | boolean)[];

export type Invocation<F extends string = string> = {
  /** The resolved row name: `"open"`, `"node edit"`, or `""` for a verbless root. */
  path: string;
  /** The spelling the caller used — an alias, when one was used. */
  token: string;
  /** Positionals after the path. */
  pos: string[];
  /** Flags given, plus the defaults of the flags this row accepts. */
  flags: Partial<Record<F, FlagValue>>;
};

export type CommandSpec<F extends string = string> = {
  /** `"open"`; one space means one level of nesting: `"node edit"`. */
  name: string;
  /** Each alias is dispatchable, listed in `verbs`, and gets its own declared
   *  row. An alias of a nested row must share its group: `"node change"`. */
  aliases?: readonly string[];
  /** This row's own flags; `globalFlags` are added to them. */
  flags: readonly F[];
  /** Arity is enforced from this, and it is what `schema` publishes. */
  positionals: readonly PositionalSpec[];
  /** One line for the rendered help. */
  describe: string;
  /** Added as the `hint` of this row's flag rejections. */
  rejectHint?: string;
  /** `false` hands node's own "Unexpected argument" refusal any positional. */
  allowPositionals?: boolean;
  /**
   * Flag-dependent arity (imago `handoff --clear`, mind-mapper `--to|--clear`)
   * and any other combination rule. Runs after the arity check; a returned
   * string is refused as a usage error naming this row. ⚠ The declaration
   * cannot express such a rule: a positional that `--clear` makes unnecessary
   * can only be declared `required: false`, and this hook enforces the rest.
   */
  check?: (inv: Invocation<F>) => string | undefined;
  /** A number is the exit code; anything else means 0. */
  run: (inv: Invocation<F>) => unknown;
};

/** A verbless CLI's one row (digestify). `path: []` in the declaration. */
export type RootSpec<F extends string = string> = Omit<CommandSpec<F>, "name" | "aliases">;

/**
 * Where a group's sub-verb is found.
 * - `adjacent` (default): the token right after the group (`node edit X`).
 * - `first-positional`: the first token after the group that is neither a flag
 *   nor a string flag's value, so flags may come first:
 *   `doc --project P delete D1 --force` resolves to `doc delete` (mind-mapper).
 *   The scan stops at a bare `--`, which is the escape hatch for a positional
 *   literally named like a sub-verb: `doc -- delete` reads the doc "delete".
 */
export type GroupSpec = { subVerbAt?: "adjacent" | "first-positional" };

export type CliSpec<O extends OptionsTable> = {
  /** `"bounty"`, used in messages and the rendered help. */
  name: string;
  /** The rendered help's first line: `${name} — ${summary}`. */
  summary?: string;
  /** The literal `CLI_OPTIONS` object. */
  options: O;
  commands?: readonly CommandSpec<keyof O & string>[];
  /**
   * A verbless CLI's row. Reserved tokens as `argv[0]` still select their rows
   * (`help`, `version`, `schema`, any `commands`, and the interceptors); every
   * other argv, the empty one included, belongs to the root. A positional that
   * happens to spell a reserved token goes after a bare `--`.
   */
  root?: RootSpec<keyof O & string>;
  /** Accepted by every row, by contract (grapevine's `--as`/`--from`). */
  globalFlags?: readonly (keyof O & string)[];
  grammar?: "verb-first" | "flags-anywhere";
  /** Per-group sub-verb placement, keyed by the group token (`"doc"`). */
  groups?: Readonly<Record<string, GroupSpec>>;
  /** The root row's positional name in `schema` (`"command"`; glamour: `"verb"`). */
  verbPositional?: string;
  /** Flags left off every usage line (glamour's per-verb `session`). */
  usageHides?: readonly (keyof O & string)[];
  /** The `version` row's payload, `{name, version}`. */
  version: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Replaces the rendered help (grapevine). */
  help?: () => string;
  /** Appended below the rendered rows. */
  helpFooter?: string;
};

export type DeclaredArg = { name: string; type: FlagType; status: "valid" };
export type DeclaredCommand = {
  path: string[];
  args: DeclaredArg[];
  positionals: PositionalSpec[];
};
export type Declaration = {
  formatVersion: "0";
  provenance: "emitted";
  selfDescription: { args: string[] };
  commands: DeclaredCommand[];
};

/** A row as the module holds it, for tests and wards. */
export type RowView = {
  name: string;
  aliases: readonly string[];
  /** The row's own flags, as declared. */
  flags: readonly string[];
  /** Own flags plus `globalFlags`, in options-table order. */
  accepted: readonly string[];
  positionals: readonly PositionalSpec[];
  describe: string;
  /** `true` for a `help`/`version`/`schema` row the module added. */
  auto: boolean;
};

export type Cli = {
  name: string;
  /** Envelope on failure, returns the exit code. For the spell's `run()`. */
  main(argv: string[]): Promise<number>;
  /** Throws `CliError`, for a spell whose main does its own triage. */
  dispatch(argv: string[]): Promise<number>;
  declaration(): Declaration;
  renderHelp(): string;
  /** A row's usage line (`"close <id> [--force]"`); `""` for an unknown path. */
  usageOf(path: string): string;
  /** Every first token that dispatches: verbs, aliases and group tokens. */
  verbs: readonly string[];
  /** Every full path that dispatches, aliases included (`"node edit"`). */
  paths: readonly string[];
  /** A row's accepted set as `--x` spellings, sorted. `""` is the root. */
  flagsFor(path: string): string[];
  /** Every flag in the options table, as `--x`, in table order. */
  recognizedFlags: readonly string[];
  rows: readonly RowView[];
};

// ── internals ─────────────────────────────────────────────────────────────

type Row = RowView & {
  rejectHint?: string;
  allowPositionals: boolean;
  check?: (inv: Invocation) => string | undefined;
  run: (inv: Invocation) => unknown;
};

/** The tokens the root answers itself. Declared at `path: []`. */
const INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" },
] as const;

/** Long first: a flag-set extractor reading left to right stops at the first
 *  token that is not a `--long` flag. */
const INTERCEPTOR_CHOICES = INTERCEPTORS.map((i) => i.name).sort(
  (a, b) => Number(b.startsWith("--")) - Number(a.startsWith("--")),
);

const errCode = (e: unknown): string =>
  e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function defineCli<const O extends OptionsTable>(spec: CliSpec<O>): Cli {
  const cliName = spec.name;
  const optionKeys = Object.keys(spec.options);
  const known = new Set(optionKeys);
  const grammar = spec.grammar ?? "verb-first";
  const globals = [...(spec.globalFlags ?? [])] as string[];
  const hides = new Set<string>((spec.usageHides ?? []) as string[]);

  for (const g of globals) {
    if (!known.has(g))
      throw new Error(`defineCli(${cliName}): global flag "${g}" is not in options`);
  }
  if ((spec.commands?.length ?? 0) === 0 && spec.root === undefined) {
    throw new Error(`defineCli(${cliName}): give commands, a root, or both`);
  }

  // `parseArgs` gets the table WITHOUT defaults: which flags the caller gave is
  // the question the per-row check asks, and a default is not something given.
  const parseOptions = Object.fromEntries(
    optionKeys.map((k) => {
      const { default: _d, ...rest } = spec.options[k] as OptionSpec;
      return [k, rest];
    }),
  ) as Record<string, { type: FlagType; multiple?: boolean; short?: string }>;
  const shortToKey = new Map<string, string>();
  for (const k of optionKeys) {
    const s = spec.options[k]?.short;
    if (s !== undefined) shortToKey.set(s, k);
  }

  const acceptedOf = (own: readonly string[]): string[] => {
    const set = new Set([...globals, ...own]);
    return optionKeys.filter((k) => set.has(k));
  };

  const toRow = (
    c: Omit<CommandSpec, "run"> & { run: (inv: Invocation) => unknown },
    auto: boolean,
  ): Row => {
    for (const f of c.flags) {
      if (!known.has(f)) {
        throw new Error(`defineCli(${cliName}): row "${c.name}" names flag "${f}", not in options`);
      }
    }
    return {
      name: c.name,
      aliases: [...(c.aliases ?? [])],
      flags: [...c.flags],
      accepted: acceptedOf(c.flags),
      positionals: c.positionals.map((p) => ({ ...p })),
      describe: c.describe,
      auto,
      rejectHint: c.rejectHint,
      allowPositionals: c.allowPositionals ?? true,
      check: c.check as Row["check"],
      run: c.run as Row["run"],
    };
  };

  const rows: Row[] = (spec.commands ?? []).map((c) => toRow(c as CommandSpec, false));

  // The auto rows. Added last, in this order, unless the spell has its own.
  const cli = {} as Cli;
  const autoRows: CommandSpec[] = [
    {
      name: "version",
      flags: [],
      positionals: [],
      describe: "this CLI's {name, version} as JSON (alias: --version, -V)",
      run: async () => {
        printJson(await spec.version());
      },
    },
    {
      name: "schema",
      flags: [],
      positionals: [],
      describe: "this CLI's machine-readable interface (acc declaration v0)",
      run: () => {
        process.stdout.write(`${JSON.stringify(cli.declaration(), null, 2)}\n`);
      },
    },
    {
      name: "help",
      flags: [],
      positionals: [],
      describe: "show this message (alias: --help, -h)",
      run: () => {
        const text = cli.renderHelp();
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      },
    },
  ];
  for (const a of autoRows) {
    if (!rows.some((r) => r.name === a.name)) rows.push(toRow(a, true));
  }

  const rootRow: Row | undefined =
    spec.root === undefined ? undefined : toRow({ ...(spec.root as RootSpec), name: "" }, false);

  // Index every spelling, and check the table is well formed.
  const byToken = new Map<string, Row>();
  for (const r of rows) {
    for (const t of [r.name, ...r.aliases]) {
      const parts = t.split(" ");
      if (t.trim() !== t || parts.length > 2 || parts.some((p) => p === "" || p.startsWith("-"))) {
        throw new Error(`defineCli(${cliName}): bad command name "${t}"`);
      }
      if (t !== r.name && parts.length !== r.name.split(" ").length) {
        throw new Error(`defineCli(${cliName}): alias "${t}" must nest like "${r.name}"`);
      }
      if (parts.length === 2 && t !== r.name && parts[0] !== r.name.split(" ")[0]) {
        throw new Error(`defineCli(${cliName}): alias "${t}" must share the group of "${r.name}"`);
      }
      if (byToken.has(t)) throw new Error(`defineCli(${cliName}): "${t}" is defined twice`);
      byToken.set(t, r);
    }
  }
  const subsOf = new Map<string, string[]>();
  for (const t of byToken.keys()) {
    const [group, sub] = t.split(" ");
    if (group !== undefined && sub !== undefined) {
      subsOf.set(group, [...(subsOf.get(group) ?? []), sub]);
    }
  }
  for (const g of Object.keys(spec.groups ?? {})) {
    if (!subsOf.has(g)) throw new Error(`defineCli(${cliName}): group "${g}" has no sub-verbs`);
  }

  const paths = [...byToken.keys()];
  const verbs = [...new Set(paths.map((p) => p.split(" ")[0] as string))];

  const rowFor = (path: string): Row | undefined => (path === "" ? rootRow : byToken.get(path));
  const flagsFor = (path: string): string[] =>
    [...(rowFor(path)?.accepted ?? [])].map((k) => `--${k}`).sort();
  const label = (r: Row): string => r.name || cliName;

  /**
   * A verbless root's rejection `choices`: its own flags PLUS the interceptors,
   * because the declaration publishes both at `path: []` and the root answers
   * both (the interceptors as `argv[0]`). Leaving the interceptors out made
   * one process say two things about its root — acc's census read `--help`,
   * `-h`, `--version` and `-V` as declared-not-accepted. Long spellings first
   * (sorted), then the shorts: a flag-set extractor reading left to right
   * stops at the first token that is not a `--long` flag.
   */
  const rootChoices: string[] = (() => {
    const all = [...flagsFor(""), ...INTERCEPTOR_CHOICES];
    const long = all.filter((f) => f.startsWith("--")).sort();
    return [...long, ...all.filter((f) => !f.startsWith("--"))];
  })();

  // ── help ──

  const renderPositional = (p: PositionalSpec): string => {
    const inner = p.variadic ? `${p.name}...` : p.name;
    return p.required ? `<${inner}>` : `[${inner}]`;
  };
  const renderFlag = (k: string): string =>
    spec.options[k]?.type === "boolean" ? `[--${k}]` : `[--${k} ..]`;
  const usageLine = (r: Row): string =>
    [
      label(r),
      ...r.positionals.map(renderPositional),
      ...r.flags.filter((k) => !hides.has(k)).map(renderFlag),
    ].join(" ");
  const expects = (r: Row): string => `expects: ${usageLine(r)}`;

  const renderHelp = (): string => {
    if (spec.help !== undefined) return spec.help();
    const listed = [...(rootRow ? [rootRow] : []), ...rows];
    const lines = listed.map((r) => [usageLine(r), r.describe] as const);
    const width = Math.min(Math.max(...lines.map(([u]) => u.length)), 44);
    const body = lines
      .map(([u, d]) =>
        u.length <= width ? `  ${u.padEnd(width)}  ${d}` : `  ${u}\n  ${"".padEnd(width)}  ${d}`,
      )
      .join("\n");
    const head = spec.summary ? `${cliName} — ${spec.summary}` : cliName;
    const tokens = `  ${INTERCEPTORS.map((i) => i.name).join(" | ")}  root tokens: help, or {name, version} as JSON`;
    return `${head}\n\n${body}\n${tokens}${spec.helpFooter ? `\n\n${spec.helpFooter}` : ""}`;
  };

  // ── the declaration ──

  const declaration = (): Declaration => {
    const arg = (k: string): DeclaredArg => ({
      name: `--${k}`,
      type: (spec.options[k] as OptionSpec).type,
      status: "valid",
    });
    const commands: DeclaredCommand[] = [
      {
        path: [],
        args: [
          ...INTERCEPTORS.map((i) => ({
            name: i.name,
            type: "boolean" as const,
            status: "valid" as const,
          })),
          ...(rootRow ? rootRow.accepted.map(arg) : []),
        ],
        positionals: rootRow
          ? rootRow.positionals.map((p) => ({ ...p }))
          : [{ name: spec.verbPositional ?? "command", required: true }],
      },
    ];
    for (const r of rows) {
      for (const t of [r.name, ...r.aliases]) {
        commands.push({
          path: t.split(" "),
          args: r.accepted.map(arg),
          positionals: r.positionals.map((p) => ({ ...p })),
        });
      }
    }
    const schemaRow = byToken.get("schema") as Row;
    return {
      formatVersion: "0",
      provenance: "emitted",
      selfDescription: { args: [schemaRow.name] },
      commands,
    };
  };

  // ── dispatch ──

  /**
   * The index of the first token that is neither a flag nor a string flag's
   * value, walking the way the parser will: `--k v` consumes `v` when `k` is a
   * string flag, `--k=v` consumes nothing, `-s v` likewise by the short's type.
   * At a bare `--`: `-1` when `stopAtTerminator`, else the index after it.
   */
  const scanPositional = (args: string[], stopAtTerminator: boolean): number => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (a === "--") return stopAtTerminator || i + 1 >= args.length ? -1 : i + 1;
      if (a.startsWith("--")) {
        if (a.includes("=")) continue;
        if (spec.options[a.slice(2)]?.type === "string") i++;
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        const key = a.length === 2 ? shortToKey.get(a.slice(1)) : undefined;
        if (key !== undefined && spec.options[key]?.type === "string") i++;
        continue;
      }
      return i;
    }
    return -1;
  };

  const without = (args: string[], i: number): string[] => [
    ...args.slice(0, i),
    ...args.slice(i + 1),
  ];

  const noCommand = (): never =>
    die("expected a command", "usage", {
      choices: [...verbs],
      hint: `run \`${cliName} help\` (or --help) for usage`,
    });

  /** A verb candidate and the args after it, to a row and that row's args. */
  const resolve = (cand: string, rest: string[]): { row: Row; token: string; args: string[] } => {
    const subs = subsOf.get(cand);
    if (subs !== undefined) {
      const at = spec.groups?.[cand]?.subVerbAt ?? "adjacent";
      let i = -1;
      if (at === "adjacent") {
        const next = rest[0];
        i = next !== undefined && !next.startsWith("-") ? 0 : -1;
      } else {
        i = scanPositional(rest, true);
      }
      const sub = i >= 0 ? (rest[i] as string) : undefined;
      const full = sub === undefined ? undefined : byToken.get(`${cand} ${sub}`);
      if (full !== undefined && sub !== undefined) {
        return { row: full, token: `${cand} ${sub}`, args: without(rest, i) };
      }
      const own = byToken.get(cand);
      if (own !== undefined) return { row: own, token: cand, args: rest };
      const extra = { choices: [...subs], hint: `run \`${cliName} help\` for usage` };
      if (sub === undefined) die(`${cand}: expected a sub-command`, "usage", extra);
      die(`unknown ${cand} sub-command: "${sub}"`, "usage", extra);
    }
    const row = byToken.get(cand);
    if (row === undefined) {
      die(`unknown command "${cand}"`, "usage", {
        choices: [...verbs],
        hint: `run \`${cliName} help\` for usage`,
      });
    }
    return { row, token: cand, args: rest };
  };

  /**
   * Contract 5's `--` made the caller's flag TEXT; say so (c1,
   * `docs/items/terminator-eats-session-key.md`). A post-`--` token that spells
   * a flag this row accepts — `--k`, `--k=v`, or the short `-s` of an accepted
   * `k`, globals included — is named in ONE `# warning:` line on stderr, with
   * the move that recovers it. Stdout and the exit code do not change, and the
   * row still runs: text containing a flag name is legitimate, which is what
   * `--` is for. A token the row does not accept is just text, and says nothing.
   *
   * ⚠ Called only once every refusal has passed, so a refused invocation's
   * stderr is still exactly one envelope. The `# ` prefix is the house's
   * success-path stderr form (`# warning:` in mind-mapper, `# pinned board`,
   * `# → channel`): an envelope reader looks for a `{` line and skips it.
   */
  const warnDemoted = (
    row: Row,
    accepted: ReadonlySet<string>,
    tokens: ReturnType<typeof parseArgs>["tokens"],
  ): void => {
    const end = tokens?.findIndex((t) => t.kind === "option-terminator") ?? -1;
    if (tokens === undefined || end < 0) return;
    const demoted: string[] = [];
    for (const t of tokens.slice(end + 1)) {
      if (t.kind !== "positional") continue;
      const v = t.value;
      let key: string | undefined;
      if (v.startsWith("--")) key = v.slice(2).split("=")[0];
      else if (v.length === 2 && v.startsWith("-")) key = shortToKey.get(v.slice(1));
      if (key !== undefined && key !== "" && accepted.has(key)) demoted.push(v);
    }
    if (demoted.length === 0) return;
    const which = demoted.join(", ");
    const one = demoted.length === 1;
    const it = one ? "it" : "them";
    const was = one ? "was" : "were";
    const asFlag = one ? "as a flag" : "as flags";
    process.stderr.write(
      `# warning: ${cliName}${row.name === "" ? "" : ` ${row.name}`}: ${which} after \`--\` ${was} read as text, not ${asFlag}; to use ${it} ${asFlag}, move ${it} before \`--\`\n`,
    );
  };

  const runRow = async (row: Row, token: string, args: string[]): Promise<number> => {
    setCurrentCommand(row.name === "" ? null : row.name);
    const name = label(row);
    const accepted = new Set(row.accepted);
    const choices = row.name === "" ? rootChoices : flagsFor(row.name);
    const flagHint = (): string | undefined =>
      [row.rejectHint, choices.length === 0 ? `${name} takes no flags` : undefined]
        .filter((s): s is string => s !== undefined)
        .join("; ") || undefined;

    let values: Record<string, unknown>;
    let positionals: string[];
    let tokens: ReturnType<typeof parseArgs>["tokens"];
    try {
      ({ values, positionals, tokens } = parseArgs({
        args,
        options: parseOptions,
        strict: true,
        allowPositionals: row.allowPositionals,
        tokens: true,
      }));
    } catch (e) {
      if (errCode(e) === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
        die(`${name}: ${errMessage(e)}`, "usage", { choices, hint: flagHint() });
      }
      // A missing value is not a choice from a set, so no `choices` here.
      die(`${name}: ${errMessage(e)}`, "usage", { hint: row.rejectHint ?? expects(row) });
    }

    // Stage 2: known to the spell, not taken by this row — MISPLACED, not
    // unknown. Only flags the caller GAVE are here: defaults are not applied yet.
    const stray = Object.keys(values).find((k) => !accepted.has(k));
    if (stray !== undefined) {
      die(
        `--${stray} is not accepted by \`${name}\` (it is a recognized ${cliName} flag, just not this ${row.name === "" ? "command" : "verb"}'s)`,
        "usage",
        { choices, hint: flagHint() },
      );
    }

    // Arity, from the declared shape, naming the missing or the extra token.
    const required = row.positionals.filter((p) => p.required).length;
    const variadic = row.positionals.some((p) => p.variadic);
    if (positionals.length < required) {
      const missing = row.positionals[positionals.length];
      die(`${name}: missing required <${missing?.name ?? "argument"}>`, "usage", {
        hint: expects(row),
      });
    }
    if (!variadic && positionals.length > row.positionals.length) {
      die(
        `${name}: unexpected argument ${JSON.stringify(positionals[row.positionals.length])}`,
        "usage",
        { hint: row.positionals.length === 0 ? `${name} takes no arguments` : expects(row) },
      );
    }

    // Defaults last, and only this row's.
    const flags: Record<string, FlagValue> = { ...(values as Record<string, FlagValue>) };
    for (const k of row.accepted) {
      const d = (spec.options[k] as OptionSpec).default;
      if (flags[k] === undefined && d !== undefined) {
        flags[k] = (Array.isArray(d) ? [...d] : d) as FlagValue;
      }
    }

    const inv: Invocation = { path: row.name, token, pos: positionals, flags };
    const refused = row.check?.(inv);
    if (refused !== undefined) die(`${name}: ${refused}`, "usage", { hint: expects(row) });

    warnDemoted(row, accepted, tokens);
    const out = await row.run(inv);
    return typeof out === "number" ? out : 0;
  };

  const dispatch = async (argv: string[]): Promise<number> => {
    setCurrentCommand(argv[0] ?? null);
    const first = argv[0];

    // 1. Interceptors pass the rest of the argv on to their row.
    const interceptor = INTERCEPTORS.find((i) => i.name === first);
    if (interceptor !== undefined) {
      return runRow(byToken.get(interceptor.runs) as Row, interceptor.runs, argv.slice(1));
    }

    // 2. A verbless root owns every argv that does not start with a reserved token.
    if (rootRow !== undefined) {
      if (first !== undefined && (byToken.has(first) || subsOf.has(first))) {
        const r = resolve(first, argv.slice(1));
        return runRow(r.row, r.token, r.args);
      }
      return runRow(rootRow, "", argv);
    }

    // 3. Bare invocation is a usage error (acc C2/D2).
    if (first === undefined) return noCommand();

    // 4. Find the verb.
    let cand: string;
    let rest: string[];
    if (grammar === "verb-first") {
      if (first === "--") {
        if (argv[1] === undefined) return noCommand();
        cand = argv[1];
        rest = ["--", ...argv.slice(2)];
      } else if (first.startsWith("-")) {
        return die(`unknown flag at the root: ${first}`, "usage", {
          choices: [...INTERCEPTOR_CHOICES],
          hint: `commands (each takes its own flags): ${verbs.join(" ")}`,
        });
      } else {
        cand = first;
        rest = argv.slice(1);
      }
    } else {
      const i = scanPositional(argv, false);
      if (i < 0) {
        // No verb anywhere: an unknown flag is refused with the root's set,
        // and a clean parse is a bare invocation. Neither ran a command, so
        // the envelope's `meta.command` is null, not the first flag's
        // spelling (`glamour --bogus` names no verb).
        setCurrentCommand(null);
        try {
          parseArgs({ args: argv, options: parseOptions, strict: true, allowPositionals: true });
        } catch (e) {
          die(errMessage(e), "usage", {
            choices: [...INTERCEPTOR_CHOICES],
            hint: `no command given — commands: ${verbs.join(" ")} (run: ${cliName} help)`,
          });
        }
        return noCommand();
      }
      cand = argv[i] as string;
      // A verb found right after a `--` leaves that `--` in place, so the
      // rest of the argv stays positional.
      rest = without(argv, i);
    }
    setCurrentCommand(cand);
    const r = resolve(cand, rest);
    return runRow(r.row, r.token, r.args);
  };

  const main = async (argv: string[]): Promise<number> => {
    try {
      return await dispatch(argv);
    } catch (e) {
      const reported = reportCliError(e);
      if (reported !== null) return reported;
      // The house contract is JSON on stderr for EVERY failure. A spell that
      // triages its own (glamour's ENOENT → usage) calls `dispatch` instead.
      return reportCliError(new CliError("internal", errMessage(e))) ?? 1;
    }
  };

  const view = (r: Row): RowView => ({
    name: r.name,
    aliases: r.aliases,
    flags: r.flags,
    accepted: r.accepted,
    positionals: r.positionals,
    describe: r.describe,
    auto: r.auto,
  });

  Object.assign(cli, {
    name: cliName,
    main,
    dispatch,
    declaration,
    renderHelp,
    usageOf: (path: string) => {
      const r = rowFor(path);
      return r === undefined ? "" : usageLine(r);
    },
    verbs,
    paths,
    flagsFor,
    recognizedFlags: optionKeys.map((k) => `--${k}`),
    rows: rows.map(view),
  } satisfies Cli);
  return cli;
}
