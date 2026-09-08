/**
 * The house's ONE CLI failure contract — the taxonomy, the exit codes, the
 * envelope, and the `die` that raises one.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/` — ward 2's
 * assertion, not a convention, and it is what makes this module safe to inline
 * into any spell's bundle (see `../lib/printJson.ts`, the kit's first
 * inhabitant, for the full account).
 *
 * ── WHY THIS IS A CONTRACT AND NOT A UTILITY ────────────────────────────────
 *
 * `kind` is the contract; `message` is presentation. Rewording a message must
 * never break a caller, which it does the moment anyone matches on prose. An
 * agent routes on `kind` and on the exit code, so changing either is a change
 * an agent OBSERVES and the spell needs an acc re-grade. That is the cut this
 * directory is named for.
 *
 * ── ⛔ `die` THROWS. IT DOES NOT EXIT, AND THAT IS THE POINT ────────────────
 *
 * Bun's stdout is ASYNCHRONOUS on a pipe (synchronous on a TTY or file), so
 * `process.exit()` discards whatever has not drained — measured at exactly
 * 65,536 bytes, and the caller gets well-formed-looking JSON that stops
 * mid-string. Reproduced, fixed and gated in bounty first (P0, #77/#78).
 *
 * The old shape wrote one short envelope to stderr and exited immediately,
 * which is safe ONLY while the payload fits the 64 KiB pipe buffer — stderr
 * is cut short exactly like stdout (measured). It also meant every `die` was a
 * second place the process could end, opaque to whatever the verb had
 * already written to stdout.
 *
 * So: `die` raises a `CliError`, the spell's `main` catches it with
 * `reportCliError`, and the process ends the one way the house sanctions —
 * `process.exitCode` plus a natural return. glamour and mind-mapper reached
 * this shape independently at their acc L0 passes; this module is where the
 * three copies stop being three.
 *
 * ⚠ A `die` inside a `try` whose `catch` SWALLOWS is now a silent
 * continue rather than an exit. Every call site in an adopting spell must be
 * read for that before it adopts. Audited for astrolabe (16 sites) and magpie
 * (30) on adoption: every one is either outside a `try` or inside a `catch`,
 * from which the throw propagates.
 */

/**
 * The failure taxonomy. Exit codes follow the acc standard: a usage error is
 * the caller's to fix by changing the command, an internal fault is not, and
 * collapsing them into one number leaves an agent with nothing to route on.
 */
export type ErrKind = "usage" | "internal" | "not_found" | "conflict";

export const EXIT_FOR: Record<ErrKind, number> = {
  usage: 2, // the caller can fix this by changing the command
  internal: 1, // the spell broke; the invocation may have been fine
  not_found: 5, // the named thing does not exist
  conflict: 6, // a precondition failed
};

/** Extra fields a failure may carry. `hint` is prose for a human or an agent;
 *  `choices` enumerates what WOULD have been accepted. */
export type ErrExtra = { hint?: string; choices?: string[] };

/** The verb under execution, so an envelope can name it. Set once by `main`. */
let currentCommand: string | null = null;

export function setCurrentCommand(command: string | null): void {
  currentCommand = command;
}

export function getCurrentCommand(): string | null {
  return currentCommand;
}

/**
 * ONE JSON document on stderr, and stdout stays empty — stdout carries data
 * and a failure has none. A caller that gets one JSON document from a verb and
 * prose from a failure has to parse two formats to use one tool, and the
 * failure is the case where it can least afford to guess.
 */
export function errorEnvelope(kind: ErrKind, message: string, extra?: ErrExtra): string {
  return `${JSON.stringify({
    ok: false,
    error: {
      kind,
      exit_code: EXIT_FOR[kind],
      // Only rate limits are worth retrying unchanged; nothing the house raises is.
      retryable: false,
      message,
      ...(extra?.hint ? { hint: extra.hint } : {}),
      ...(extra?.choices ? { choices: extra.choices } : {}),
    },
    meta: { command: currentCommand },
  })}\n`;
}

/** A failure with a taxonomy `kind`, raised by `die` and caught by `main`. */
export class CliError extends Error {
  readonly kind: ErrKind;
  readonly extra?: ErrExtra;

  constructor(kind: ErrKind, message: string, extra?: ErrExtra) {
    super(message);
    this.name = "CliError";
    this.kind = kind;
    this.extra = extra;
  }

  get exitCode(): number {
    return EXIT_FOR[this.kind];
  }
}

/** Raise a taxonomy failure. Returns `never`, so definite-assignment analysis
 *  still narrows after it — the property that let the old exiting form sit in
 *  a `catch` and leave the variable it guards assigned. */
export function die(message: string, kind: ErrKind = "usage", extra?: ErrExtra): never {
  throw new CliError(kind, message, extra);
}

/**
 * Report a caught error as the house envelope and hand back an exit code, or
 * `null` when the error is NOT a `CliError` — which the caller must rethrow.
 * Swallowing an unknown throw here would report an internal fault as a tidy
 * taxonomy failure and lose the stack that says what actually broke.
 */
export function reportCliError(
  e: unknown,
  err: { write(chunk: string): unknown } = process.stderr,
): number | null {
  if (!(e instanceof CliError)) return null;
  err.write(errorEnvelope(e.kind, e.message, e.extra));
  return e.exitCode;
}
