// The contract `pdocs` has with whatever is calling it: how the output format
// is chosen, what shape machine output takes, and what the exit status means.
//
// Nothing here knows about documents. It is the part of the CLI an agent reads
// once and then relies on for every command, which is why it lives in its own
// file rather than inside `cli.ts` — a contract buried in a dispatcher is a
// contract nobody can find.

/**
 * Exit codes are an API.
 *
 * A caller cannot read prose — it reads the exit status. These values are a
 * published contract: changing one is a breaking change for every script and
 * agent that branches on it. ADD, NEVER RENUMBER.
 *
 * Everything from 124 up is RESERVED and never allocated here, so a delegating
 * CLI can pass a child's exit code through verbatim without collision. 124 is
 * `timeout`'s "time limit reached" and 125 is its (and Docker's) "the wrapper
 * itself failed"; 126, 127 and "greater than 128" are POSIX. A code another
 * convention has already claimed is not ours to allocate, however unassigned it
 * looks from inside this table.
 *
 * Modelled on `src/acc/exit-codes.ts` in `agent-cli-conformance`, which is the
 * catalogue this CLI is trying to be a first-party example of. Only the codes
 * `pdocs` can actually produce are declared — the gaps (`3` auth, `4`
 * permission, `7` rate limit, `8` confirmation) are deliberately left where
 * that catalogue put them rather than reused for something else, so a caller
 * that already knows the bands is never surprised.
 */
export const ExitCode = {
  /** The command did what was asked. */
  Success: 0,
  /** Anything unexpected — a bug, an unhandled shape. The safe default for an
   *  unclassified fault. */
  Internal: 1,
  /** The invocation itself was wrong: bad flags, unknown command, bare
   *  invocation. */
  Usage: 2,
  /** The named thing does not exist: no docs root, no `.project-docs.json`, no
   *  such document. */
  NotFound: 5,
  /** A precondition failed; the request conflicts with current state — the
   *  document `pdocs new` was asked to write is already there. */
  Conflict: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * OUTCOME codes — deliberately NOT errors.
 *
 * An error means the invocation failed. An outcome means the invocation
 * SUCCEEDED and the answer was negative. `pdocs check` on a dirty tree did its
 * job perfectly; the report is accurate, well-formed data and stays on stdout
 * as `ok: true`. But it must still exit non-zero, because non-zero-ness is what
 * makes a finding visible to a harness that does not parse JSON.
 *
 * The bands: 1-8 = why the INVOCATION failed. 9-123 = what the SUBJECT turned
 * out to be. 124+ = what a CHILD PROCESS did, or what the shell did on our
 * behalf.
 *
 * `agent-cli-conformance` already allocates `9` (`NonConformant`) and `10`
 * (`Stale`) in its own table. `10` is therefore NOT free for a second meaning
 * here: the two CLIs are read by the same agents, and a code that means two
 * things across a family is worse than an unallocated one.
 */
export const Outcome = {
  /** The check ran successfully; the documentation tree has problems. */
  Dirty: 9,
} as const;

export type OutcomeValue = (typeof Outcome)[keyof typeof Outcome];

/** Stable machine identifiers, paired 1:1 with the error codes above. The
 *  `kind` is the contract; the message is presentation. */
export const ErrorKind = {
  Internal: "internal",
  Usage: "usage",
  NotFound: "not_found",
  Conflict: "conflict",
} as const;

export type ErrorKindValue = (typeof ErrorKind)[keyof typeof ErrorKind];

/**
 * Whether retrying the SAME invocation, unchanged, could succeed.
 *
 * Every failure `pdocs` raises is deterministic over a tree that did not move:
 * a bad flag is bad twice, a missing docs root stays missing, and a document
 * that already exists still does. Nothing here waits on a network, a lock or a
 * quota, so the honest answer is `false` for all four kinds — and the field is
 * emitted anyway, because a consumer branches on `retryable === false` and not
 * on the absence of a key it never saw.
 *
 * A `conflict` is the one worth reading twice. It is not retryable and it IS
 * resolvable: the caller changes the TREE — archives the document in the way —
 * and the same command then works. That is a different claim from "run it
 * again", which is what this field answers.
 */
const RETRYABLE: Record<ErrorKindValue, boolean> = {
  internal: false,
  usage: false,
  not_found: false,
  conflict: false,
};

/**
 * The optional half of an error — everything past `kind` and `message`.
 *
 * `choices` is the one that earns its keep. Where the valid alternatives form a
 * CLOSED SET — the commands, the flags a command takes, `text|json`, the types
 * `new` can create — the rejection hands the caller that set instead of making
 * it go and read help. Every one is derived from the same table the parser
 * enforces, so the list in an error cannot drift from the list that is true.
 */
export interface ErrorDetail {
  /**
   * The token the rejection is ABOUT — the flag, verb, value or type the caller
   * got wrong, verbatim.
   *
   * This one is rule-bound where the others are guidance. A3 requires that in
   * machine mode the offending token appear as a FIELD and "not only inside the
   * prose `message`": prose gets rewritten, a field is a contract. It is
   * carried inside `details` rather than beside `kind`, because the canonical
   * envelope's error keys are a closed list and `details` is where it puts
   * everything a specific failure needs and prose cannot hold.
   */
  token?: string;
  /** Prose remediation, for a human. Never parsed. */
  hint?: string;
  /** The closed set the caller got wrong, as data. */
  choices?: string[];
  /** Structured context — whatever the caller needs and prose cannot carry. */
  details?: Record<string, unknown>;
}

/** A failure with a code and a machine-readable kind attached. Thrown anywhere;
 *  caught once, at the top of `cli.ts`. */
export class CliError extends Error {
  readonly hint: string | undefined;
  readonly choices: string[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    readonly kind: ErrorKindValue,
    readonly exitCode: ExitCodeValue,
    detail: ErrorDetail = {}
  ) {
    super(message);
    this.name = "CliError";
    this.hint = detail.hint;
    this.choices = detail.choices;
    // `token` is folded into `details` here so that every rejection that names
    // one publishes it under the same key, and a call site cannot spell it two
    // ways. An explicit `details.token` wins, since it was written on purpose.
    const details =
      detail.token === undefined
        ? detail.details
        : { token: detail.token, ...detail.details };
    this.details = details;
  }
}

/** The invocation was malformed. Retrying it unchanged will fail identically. */
export class UsageError extends CliError {
  constructor(message: string, detail: ErrorDetail = {}) {
    super(message, ErrorKind.Usage, ExitCode.Usage, detail);
    this.name = "UsageError";
  }
}

/** The named thing does not exist. */
export class NotFoundError extends CliError {
  constructor(message: string, detail: ErrorDetail = {}) {
    super(message, ErrorKind.NotFound, ExitCode.NotFound, detail);
    this.name = "NotFoundError";
  }
}

/**
 * The invocation is well-formed and the tree is in a state that refuses it.
 *
 * Distinct from `UsageError` because retrying is not futile: the caller can
 * change the tree — archive the document that is in the way, close the cycle
 * that is already open — and run exactly the same command again.
 */
export class ConflictError extends CliError {
  constructor(message: string, detail: ErrorDetail = {}) {
    super(message, ErrorKind.Conflict, ExitCode.Conflict, detail);
    this.name = "ConflictError";
  }
}

/**
 * The formats `--format` accepts — ONE declaration.
 *
 * The type, the parser's validation and the `choices` a rejection enumerates
 * all read from this array, so a third format is one edit rather than three
 * that have to be remembered together.
 */
export const FORMATS = ["text", "json"] as const;

export type Format = (typeof FORMATS)[number];

/**
 * The rejection for a value outside a flag's declared set — ONE MESSAGE, two
 * callers.
 *
 * `resolveFormat` below raises it while resolving the format; `run` in
 * `cli.ts` raises it for a flag that is ALSO misplaced, because a value
 * outside the set is wrong wherever the flag sits. Written out twice they
 * would drift, and which of the two an agent parsed would depend on which
 * branch happened to fire.
 */
export function outOfSet(
  flag: string,
  value: string,
  values: readonly string[]
): UsageError {
  return new UsageError(
    `${flag}: unknown value \`${value}\` — expected one of: ${values.join(", ")}.`,
    { token: value, choices: [...values] }
  );
}

/**
 * The value of `flag` in `argv`, in EITHER SPELLING — `--flag value` and
 * `--flag=value` are the same request written two ways.
 *
 * ONE READER FOR BOTH, because `repoRootFrom` in `cli.ts` and `resolveFormat`
 * below both scan argv before the parser proper ever runs. A spelling the
 * parser understood and those two did not would be worse than one understood
 * nowhere: `pdocs check --root=/elsewhere` would parse, and then lint THIS
 * repository while reporting on that one.
 *
 * `asks` deliberately does not read through here. It answers for `--help` and
 * `--version`, which take no value, so `--help=x` is not a second spelling of
 * anything — it is a malformed token, and the parser says so rather than
 * shrugging and printing help.
 *
 * It lives here beside `resolveFormat` rather than in `cli.ts` for the dull
 * reason: `cli.ts` imports this file, so a helper the other way round is a
 * cycle.
 *
 * `found` and `value` are separate answers. A flag given without a value is
 * `{ found: true, value: undefined }`, and the caller decides what that means
 * — a missing path and a missing format read differently to whoever typed it.
 */
export function readFlag(
  argv: string[],
  flag: string
): { found: boolean; value: string | undefined } {
  const prefix = `${flag}=`;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === flag) {
      const next = argv[i + 1];
      return {
        found: true,
        // A following token that is itself a flag is not this one's value —
        // `--root --json` is a missing path, not a path named `--json`.
        value: next === undefined || next.startsWith("-") ? undefined : next,
      };
    }
    if (token.startsWith(prefix)) {
      const value = token.slice(prefix.length);
      // `--format=` named the flag and gave it nothing, which is the same
      // request as `--format` at the end of the line and gets the same answer.
      return { found: true, value: value === "" ? undefined : value };
    }
  }
  return { found: false, value: undefined };
}

/**
 * Which format to render in.
 *
 * An explicit `--format` wins over everything. Absent that, the pipe decides:
 * a human at a terminal gets prose, and anything reading stdout through a pipe
 * — an agent, a CI step, a `$(...)` — gets JSON, because that is who is on the
 * other end when stdout is not a TTY.
 *
 * The heuristic is NOT sufficient on its own, and an `npm` script proves it:
 * measured under a real pty, `npm run` inherits the parent's stdio and stdout
 * IS a TTY, so a `docs:graph` script would render text unless it says
 * `--format json`. A resolver that guesses needs a way to be told. That the
 * shorthand has to defeat the resolution to be useful is half the argument for
 * not shipping one.
 *
 * THAT LAST BRANCH IS DECLARABLE, not an implementation detail. An
 * `acc.config.json` carrying `{ "defaultOutput": "json" }` tells
 * `agent-cli-conformance` that a caller off a terminal is in machine mode, and
 * its checkers then hold every outcome to the envelope — the parser error and
 * `--version` included — with no flag selected. Change the branch and that
 * declaration becomes false.
 *
 * The scaffold template's own repository carries one and gates on it. A project
 * generated from it does NOT, deliberately: acc is a dev tool of that
 * repository, and shipping its config into every generated project would ask
 * the consumer to adopt a tool project-docs does not otherwise require. Adding
 * the file is one line, and it is worth it the day you point acc at this CLI.
 */
export function resolveFormat(argv: string[], isTTY: boolean): Format {
  const { found, value } = readFlag(argv, "--format");
  if (found) {
    const list = FORMATS.join(", ");
    if (value === undefined)
      throw new UsageError(`--format needs a value — one of: ${list}.`, {
        token: "--format",
        choices: [...FORMATS],
        hint: "`--json` is shorthand for `--format json`.",
      });
    if (!(FORMATS as readonly string[]).includes(value))
      throw outOfSet("--format", value, FORMATS);
    return value as Format;
  }
  if (argv.includes("--json")) return "json";
  return isTTY ? "text" : "json";
}

/**
 * The machine envelope, in `agent-cli-conformance`'s canonical shape.
 *
 * TWO TOP-LEVEL SHAPES AND NO THIRD: `{ ok: true, data }` on success and
 * `{ ok: false, error }` on failure, with `meta` carrying what is true of the
 * invocation either way. A discriminated union over `ok` is the whole algebra a
 * consumer has to handle — there is no `status` field, and there is never a
 * `data` beside an `error`.
 *
 * `ok` says whether the INVOCATION succeeded, not whether the answer was
 * positive: `pdocs check` on a dirty tree is `ok: true` with `clean: false`,
 * and exits 9. Conflating the two is the mistake this field exists to prevent.
 *
 * Shape taken from `docs/wiki/concepts/error-envelope.md` in
 * `agent-cli-conformance`. That page is explicit that it is DESIGN GUIDANCE
 * rather than a rule — no checker reads `kind`, `retryable` or the two-shape
 * discipline — and this CLI adopts it whole anyway, because it is trying to be
 * a first-party example of that catalogue rather than a partial one. The single
 * rule-bound clause it satisfies on the way is A3's: in machine mode the
 * offending token must appear as a FIELD, which is what `choices` is.
 */
export interface Meta {
  /** The command the caller asked for — `check`, `new`, or `pdocs` where the
   *  invocation never got as far as naming one. */
  command: string;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: Meta;
}

/** The error object. `kind` is the contract; `message` is presentation. */
export interface ErrorPayload {
  kind: ErrorKindValue;
  /** The status this failure exits with — the envelope and the exit code can
   *  never disagree, because the caller reads them both. */
  exit_code: ExitCodeValue;
  retryable: boolean;
  message: string;
  hint?: string;
  choices?: string[];
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  ok: false;
  error: ErrorPayload;
  meta: Meta;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function envelope<T>(command: string, data: T): SuccessEnvelope<T> {
  return { ok: true, data, meta: { command } };
}

/** The failure half, built from a thrown `CliError`. Optional members are
 *  OMITTED rather than emitted as null: a key that is absent says nothing, and
 *  a key holding null says something a consumer then has to interpret. */
export function errorEnvelope(
  command: string,
  error: CliError
): ErrorEnvelope {
  return {
    ok: false,
    error: {
      kind: error.kind,
      exit_code: error.exitCode,
      retryable: RETRYABLE[error.kind],
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.choices === undefined ? {} : { choices: error.choices }),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
    meta: { command },
  };
}

/** Machine output goes to stdout, and only ever the envelope. */
export function printEnvelope<T>(command: string, data: T): void {
  console.log(JSON.stringify(envelope(command, data), null, 2));
}

/**
 * Diagnostics go to stderr — always, in both formats.
 *
 * Keeping them off stdout is what lets `pdocs check --format json | jq` work on
 * a tree that turns out not to have a docs root: the pipe stays parseable and
 * the reason is still visible.
 */
export function printDiagnostic(
  command: string,
  error: CliError,
  format: Format
): void {
  if (format === "json") {
    console.error(JSON.stringify(errorEnvelope(command, error), null, 2));
    return;
  }
  // The prose half carries the same closed set the envelope carries as data —
  // a caller reading a terminal is owed the alternatives as much as one reading
  // JSON, and both are rendered from the one list on the error.
  const hint = error.hint === undefined ? "" : `\n       ${error.hint}`;
  console.error(`pdocs: ${error.message}${hint}`);
}
