// Isolation preflight for destructive bounty drives (#73/#74 lane, sprint 03).
//
// ⚠ WHY THIS LIVES IN REPO `scripts/` AND NOT IN THE BOUNTY SPELL.
// It was written at `bounty/scripts/preflight.ts` and the flag-invariant ward
// went red on it — correctly, and for a better reason than the one I would have
// given. Neither escape hatch fit: it is not INTERNAL (nothing spawns it; that
// set means "spawned only by a sibling"), and documenting `--scratch`/`--protect`
// in bounty's SKILL.md would tell a cold agent that preflight is a bounty VERB.
// It is not. It is DEV TOOLING for an experiment we run on the spell, and by
// Contract 4 everything git-tracked under `plugins/spellbook/` ships to the
// consumer cache. So the ward did not find a documentation gap; it found a
// PACKAGING mistake, and the fix is the move, not an exemption.
// Sibling of `land-check.ts`, which is the same genre.
//
// ⚠ NO LINE NUMBERS IN THIS FILE, DELIBERATELY. The first cut of this header
// pinned ~10 sites as `cli.ts:590`, `server.ts:1206-1207` and so on. Within the
// same session I changed both files and MOST OF THOSE PINS ROTTED — cli.ts:590
// became 648, server.ts:1206 became 1411. Symbol names survive an edit; line
// numbers are a claim about a file's shape at one instant. Anchor on names.
//
// WHAT THIS IS FOR. A drive that closes, restores or clobbers a board must first
// prove it is pointed somewhere disposable. The plan's safety section says to
// "print the resolved paths and confirm each is under scratch" — that is a
// discipline, and a discipline is skippable because the destructive command
// works fine without it. So the same pure function lives in the gate
// (bounty-preflight.test.ts) as well as here: forgetting it is red, not silent.
//
// ⛔ THE ENUMERATION IS THE LOAD-BEARING PART, NOT THE CHECKS.
// The bindings below are derived from every ambient input the SHIPPED code
// actually reads — not from a set someone remembered. A set-list cannot notice a
// variable it never heard of, and that is precisely how sprint 01's suite
// inherited a live session key and destroyed the team board: BOUNTY_HOME scopes
// the SNAPSHOT STORE only, and the discovery pointers went out through tmpdir().
//
// ⚠ AND THE OBVIOUS ENUMERATION METHOD IS BROKEN. `grep 'process\.env\.'` over
// the spell returns BOUNTY_AS / BOUNTY_HOME / BOUNTY_SESSION_KEY — a clean,
// well-formed, INCOMPLETE answer. `resolveSession` in cli.ts takes `env` as an
// injected parameter, so it reads `env.BOUNTY_SESSION` and
// the literal `process.env.BOUNTY_SESSION` spelling exists nowhere. Injecting a
// dependency for testability MOVES the read out of the pattern that finds it.
// When re-deriving this list, grep BOTH spellings — and treat an injected
// default (`= process.env`) as the tell that you must.
//
// ⚠ TMPDIR is not read as an env var at all: it arrives via `tmpdir()` — in
// cli.ts (`sessionFilePath`, `cmdList`), join.ts, and server.ts's discovery
// writer. It is listed here
// because it is an ambient BINDING, which is the population that matters — the
// spelling is an implementation detail of how the code reaches it.
//
// ⚠ `.bounty-session` is a FILE found by walking UP from cwd (`resolveSession`),
// so NO env scrub can cover it. `anthill convene` writes one at the repo root.
// It is in this list because the question is "what can bind me to a board I did
// not name", not "what environment variables exist".

import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Every ambient input that can bind a bounty command to a board or a store the
 * caller did not name. Adding one here without adding a cell fails the totality
 * guard in bounty-preflight.test.ts, so this list and the checks cannot drift apart.
 */
export const AMBIENT_BINDINGS = [
  "BOUNTY_HOME",
  "TMPDIR",
  "BOUNTY_SESSION_KEY",
  "BOUNTY_SESSION",
  "BOUNTY_AS",
  ".bounty-session",
] as const;

export type AmbientBinding = (typeof AMBIENT_BINDINGS)[number];

/** PASS = isolated. DEGENERATE = this cell cannot vouch for isolation, so nothing may run. */
export type CellStatus = "PASS" | "DEGENERATE";

export interface Cell {
  /** Display name — stable, used by tests and by the printed report. */
  name: string;
  /** Which ambient binding (or protected artifact) this cell speaks for. */
  binding: string;
  status: CellStatus;
  /** What was actually observed. A DEGENERATE cell must name the offender. */
  observed: string;
  /** Why this matters — the report is read by someone deciding whether to proceed. */
  why: string;
}

export interface IsolationInput {
  env: Record<string, string | undefined>;
  cwd: string;
  /** Absolute path prefixes that count as disposable. */
  scratchRoots: string[];
  /** Board ids that must be UNREACHABLE — asserted positively, by name. */
  protectedIds: string[];
  exists: (path: string) => boolean;
  readDir: (path: string) => string[];
}

export interface IsolationReport {
  ok: boolean;
  cells: Cell[];
}

/** True iff `path` sits at or under one of `roots` — on a path-SEGMENT boundary. */
function underAny(path: string, roots: string[]): boolean {
  const p = resolve(path);
  return roots.some((r) => {
    const root = resolve(r);
    if (p === root) return true;
    // The separator matters: without it "/scratch-real" reads as under "/scratch".
    return p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/** The nearest `.bounty-session` at or above `from`, or null. Mirrors resolveSession's walk-up. */
function findAmbientPin(from: string, exists: (p: string) => boolean): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, ".bounty-session");
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function pathCell(
  name: AmbientBinding,
  value: string | undefined,
  fallback: string,
  roots: string[],
  why: string,
): Cell {
  // ABSENCE is the dangerous case, not a wrong value: an unset BOUNTY_HOME
  // resolves to ~/.bounty, which is the very store this exists to protect. So an
  // unset variable is DEGENERATE and says what it would have fallen back to.
  if (value === undefined || value === "")
    return {
      name,
      binding: name,
      status: "DEGENERATE",
      observed: `<unset> — falls back to ${fallback}`,
      why,
    };
  return {
    name,
    binding: name,
    status: underAny(value, roots) ? "PASS" : "DEGENERATE",
    observed: value,
    why,
  };
}

function scrubCell(name: AmbientBinding, value: string | undefined, why: string): Cell {
  return {
    name,
    binding: name,
    status: value === undefined || value === "" ? "PASS" : "DEGENERATE",
    observed: value === undefined || value === "" ? "<unset>" : value,
    why,
  };
}

/**
 * Report whether this environment is safe to run a destructive bounty drive in.
 * Pure — every filesystem touch is injected, so the whole thing is unit-testable
 * and the gate cell can drive it against a synthetic environment.
 */
export function isolationReport(input: IsolationInput): IsolationReport {
  const { env, cwd, scratchRoots, protectedIds, exists, readDir } = input;
  const cells: Cell[] = [];

  cells.push(
    pathCell(
      "BOUNTY_HOME",
      env.BOUNTY_HOME,
      join(homedir(), ".bounty"),
      scratchRoots,
      "scopes the snapshot store and daemon.log (SNAPSHOTS_DIR in cli.ts and server.ts, plus cmdOpen's daemon.log fd)",
    ),
  );
  cells.push(
    pathCell(
      "TMPDIR",
      env.TMPDIR,
      tmpdir(),
      scratchRoots,
      "carries the discovery pointers INCLUDING the machine-global bounty-latest.json — BOUNTY_HOME does not cover these, and this is the one that escaped in sprint 01",
    ),
  );
  cells.push(
    scrubCell(
      "BOUNTY_SESSION_KEY",
      env.BOUNTY_SESSION_KEY,
      "resolves a board id at precedence 3 in resolveSession, and is read again by cmdOpen",
    ),
  );
  cells.push(
    scrubCell(
      "BOUNTY_SESSION",
      env.BOUNTY_SESSION,
      "a RAW board id at precedence 4 in resolveSession — read off an injected param, so a `process.env.` grep does not find it",
    ),
  );
  cells.push(
    scrubCell(
      "BOUNTY_AS",
      env.BOUNTY_AS,
      "stamps the actor on every write (resolveAs in cli.ts) — not a data-loss route, listed because the scrub list must not be a set someone remembered",
    ),
  );

  const pin = findAmbientPin(cwd, exists);
  cells.push({
    name: ".bounty-session",
    binding: ".bounty-session",
    status: pin === null ? "PASS" : "DEGENERATE",
    observed: pin ?? "<none on the walk-up>",
    why: "binds a board at precedence 5 by walking UP from cwd (resolveSession); convene writes one at the repo root and NO env scrub can cover a file",
  });

  // The protected boards, asserted POSITIVELY and BY NAME. A path-shape check
  // ("is it under scratch?") passes on a correctly-shaped path that points at
  // the wrong place; naming the file we are protecting is the version that
  // cannot. Both directories are read, because the two ways to reach a live
  // board are its snapshot and its discovery pointer.
  const store = env.BOUNTY_HOME
    ? join(env.BOUNTY_HOME, "snapshots")
    : join(homedir(), ".bounty", "snapshots");
  const pointers = env.TMPDIR ?? tmpdir();
  const listed = (dir: string) => {
    try {
      return readDir(dir);
    } catch {
      return [] as string[];
    }
  };
  const snapHits = listed(store).filter((f) => protectedIds.some((id) => f === `${id}.json`));
  const ptrHits = listed(pointers).filter((f) =>
    protectedIds.some((id) => f === `bounty-${id}.json`),
  );

  cells.push({
    name: "protected snapshot",
    binding: "protected snapshot",
    status: snapHits.length === 0 ? "PASS" : "DEGENERATE",
    observed:
      snapHits.length === 0
        ? `${store}: none of ${protectedIds.length} protected id(s)`
        : `${store} CONTAINS ${snapHits.join(", ")}`,
    why: "the resolved store must not contain a board we are protecting — this is the file, not the path shape",
  });
  cells.push({
    name: "protected pointer",
    binding: "protected pointer",
    status: ptrHits.length === 0 ? "PASS" : "DEGENERATE",
    observed:
      ptrHits.length === 0
        ? `${pointers}: none of ${protectedIds.length} protected id(s)`
        : `${pointers} CONTAINS ${ptrHits.join(", ")}`,
    why: "a protected board's discovery pointer in the resolved TMPDIR means a bare verb can still reach it",
  });

  return { ok: cells.every((c) => c.status === "PASS"), cells };
}

/** Render the report as the printed preflight — one line per cell, verdict last. */
export function formatReport(r: IsolationReport): string {
  const width = Math.max(...r.cells.map((c) => c.name.length));
  const lines = r.cells.map(
    (c) => `${c.status === "PASS" ? "  ok" : "DEGN"}  ${c.name.padEnd(width)}  ${c.observed}`,
  );
  const bad = r.cells.filter((c) => c.status !== "PASS");
  lines.push("");
  lines.push(
    r.ok
      ? "PREFLIGHT PASS — isolated; destructive commands may run."
      : "PREFLIGHT DEGENERATE — DO NOT RUN. Offending cells:",
  );
  for (const c of bad) lines.push(`  - ${c.name}: ${c.observed}\n      why: ${c.why}`);
  return lines.join("\n");
}

if (import.meta.main) {
  // Ad-hoc drive entry point. `--scratch <dir>` may repeat; `--protect <id>` may
  // repeat and defaults to nothing (a caller protecting nothing must say so by
  // omission, rather than the tool guessing which boards matter).
  const argv = process.argv.slice(2);
  const collect = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const next = argv[i + 1];
      if (argv[i] === flag && next !== undefined) out.push(next);
    }
    return out;
  };
  const scratchRoots = collect("--scratch");
  const protectedIds = collect("--protect");
  if (scratchRoots.length === 0) {
    process.stderr.write(
      "preflight: --scratch <dir> is required (repeatable). Refusing to guess what counts as disposable.\n",
    );
    process.exitCode = 2;
  } else {
    const report = isolationReport({
      env: process.env as Record<string, string | undefined>,
      cwd: process.cwd(),
      scratchRoots,
      protectedIds,
      exists: existsSync,
      readDir: readdirSync,
    });
    // process.exitCode + a natural return, NEVER process.exit(code). Bun's
    // stdout is not drained by process.exit, and this report is the whole point.
    process.stdout.write(`${formatReport(report)}\n`);
    process.exitCode = report.ok ? 0 : 2;
  }
}
