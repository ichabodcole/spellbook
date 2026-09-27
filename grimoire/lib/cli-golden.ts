// The engine behind `grimoire/cli-golden.test.ts`: runs a corpus of argv through
// a spell's LAUNCHER in a throwaway home and reduces each run to a record that is
// stable across runs and machines. The corpus lives in `cli-golden-corpus.ts`.
//
// ISOLATION — every invocation gets its OWN fresh temp root, used as HOME,
// TMPDIR, cwd and `<SPELL>_HOME`, with an env built from scratch (PATH only),
// so no identity or session variable from the caller's shell leaks in. TMPDIR
// matters as much as the spell's home: bounty's session discovery reads a
// machine-global pointer in the temp dir (see terminator-invariant).
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Case = {
  argv: string[];
  /** Piped to the process. Without it stdin is /dev/null. */
  stdin?: string;
  /** Where the invocation is documented, e.g. `SKILL.md:120`. The contract. */
  doc?: string;
  /** Record the normalized output itself (help, version, schema). */
  capture?: boolean;
  /** astrolabe: point the spell at a stub daemon instead of letting it spawn one. */
  stub?: boolean;
};

export type Rec = {
  argv: string[];
  stdin?: string;
  doc?: string;
  exit: number | null;
  /** Parse level: exit 2 is a rejection; any other exit (0, 5 …) was accepted. */
  verdict: "accepted" | "rejected" | "timeout";
  stream: "stdout" | "stderr" | "both" | "none";
  ok?: boolean;
  kind?: string;
  choices?: string[];
  text?: string[];
  json?: unknown;
};

export type SpellSpec = {
  spell: string;
  /** Relative to the skill folder. */
  launcher: string;
  /** Env var(s) naming the spell's data home; each is pointed into the temp root. */
  homeEnv: string[];
  /** Verbs run ONLY as `<verb> --acc-bogus-flag` and `<verb> --help`, with why. */
  excluded: Record<string, string>;
  /** Documented invocations that are NOT run, with why. */
  excludedInvocations?: { argv: string[]; doc?: string; reason: string }[];
  /** Prepare the temp root before the run (e.g. grapevine's respawn hold). */
  setup?: (home: string) => void;
  /** The spell has verbs (digestify is one verbless command). */
  verbFirst: boolean;
  /** Verbs that auto-spawn a daemon: every case naming one runs against the stub. */
  stubVerbs?: string[];
  /** Do not seed `golden.md` / `golden.png` in the working directory. */
  noWorkFiles?: boolean;
  cases: Case[];
};

export const RUN_TIMEOUT_MS = 20_000;

/** Placeholders for everything that changes between runs or machines. */
export function normalize(s: string, roots: string[]): string {
  let out = s;
  for (const r of roots) out = out.split(r).join("<ROOT>");
  return out
    .replace(/<ROOT>\/golden-[A-Za-z0-9]+/g, "<HOME>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b/g, "<TS>")
    .replace(/\bv?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\b/g, "<VERSION>")
    .replace(/((?:127\.0\.0\.1|localhost|0\.0\.0\.0)):\d{2,5}/g, "$1:<PORT>")
    .replace(/("port"\s*:\s*)\d+/g, "$1<PORT>")
    .replace(/("pid"\s*:\s*)\d+/g, "$1<PID>")
    .replace(/\b1\d{12}\b/g, "<EPOCH_MS>")
    .replace(/\b1\d{9}\b/g, "<EPOCH_S>");
}

function normalizeJson(v: unknown, roots: string[]): unknown {
  return JSON.parse(normalize(JSON.stringify(v), roots));
}

function firstJsonObject(text: string): Record<string, unknown> | null {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {}
  }
  // A pretty-printed document (schema) spans lines.
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  return null;
}

export type RunCtx = {
  repo: string;
  /** Parent of every per-invocation temp root. */
  runRoot: string;
  /** astrolabe stub daemon port. */
  stubPort: number;
  seq: { n: number };
};

export async function runCase(spec: SpellSpec, c: Case, ctx: RunCtx): Promise<Rec> {
  const home = join(ctx.runRoot, `golden-${spec.spell.replace(/-/g, "")}${ctx.seq.n++}`);
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(join(home, "work"), { recursive: true });
  // Belt and braces: a browser opener that does nothing, first on PATH, so a
  // case that reaches an `open` call cannot open a real browser tab.
  mkdirSync(join(home, "bin"), { recursive: true });
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(home, "bin", opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  // Files the documented invocations name, so they fail (or not) on the verb,
  // not on a missing path. digestify opts out: a readable file makes it serve.
  if (!spec.noWorkFiles) {
    writeFileSync(join(home, "work", "golden.md"), "# golden\n\nhello\n");
    writeFileSync(join(home, "work", "golden.png"), "");
  }
  const env: Record<string, string> = {
    PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    TMPDIR: join(home, "tmp"),
    NO_COLOR: "1",
  };
  for (const v of spec.homeEnv) env[v] = join(home, `.${spec.spell}`);
  spec.setup?.(home);
  if (c.stub) {
    const dir = join(home, `.${spec.spell}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.port"), `${ctx.stubPort}\n`);
  }
  const launcher = join(ctx.repo, "plugins/spellbook/skills", spec.spell, spec.launcher);
  // Bun strips a bare `--` placed right after the script path, so a record
  // whose argv starts with `--` would reach the CLI without it (decision #18).
  // The added `--` is the one Bun consumes; the CLI gets exactly `c.argv`.
  const proc = Bun.spawn(["bun", launcher, "--", ...c.argv], {
    cwd: join(home, "work"),
    env,
    stdin: c.stdin === undefined ? "ignore" : new Blob([c.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, RUN_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  clearTimeout(timer);

  const roots = [home, safeRealpath(home), ctx.runRoot, safeRealpath(ctx.runRoot), ctx.repo];
  roots.sort((a, b) => b.length - a.length);
  const hasOut = stdout.trim() !== "";
  const hasErr = stderr.trim() !== "";
  const rec: Rec = {
    argv: c.argv,
    ...(c.stdin !== undefined ? { stdin: c.stdin } : {}),
    ...(c.doc ? { doc: c.doc } : {}),
    exit: timedOut ? null : exit,
    verdict: timedOut ? "timeout" : exit === 2 ? "rejected" : "accepted",
    stream: hasOut && hasErr ? "both" : hasOut ? "stdout" : hasErr ? "stderr" : "none",
  };
  // The envelope rides stderr on failure, stdout on success.
  const carrier = exit === 0 ? stdout : hasErr ? stderr : stdout;
  const env0 = firstJsonObject(carrier);
  if (env0) {
    if (typeof env0.ok === "boolean") rec.ok = env0.ok;
    const err = env0.error as Record<string, unknown> | undefined;
    if (err && typeof err === "object") {
      if (typeof err.kind === "string") rec.kind = err.kind;
      if (Array.isArray(err.choices)) rec.choices = normalizeJson(err.choices, roots) as string[];
    }
  }
  if (c.capture && exit === 0) {
    const doc = firstJsonObject(stdout);
    if (doc && stdout.trim().startsWith("{")) rec.json = normalizeJson(doc, roots);
    else rec.text = normalize(stdout, roots).replace(/\s+$/, "").split("\n");
  }
  return rec;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Files a spawned daemon leaves behind. None may exist after a run. */
export function daemonTraces(root: string): string[] {
  if (!existsSync(root)) return [];
  const hits: string[] = [];
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    const base = rel.split("/").pop() ?? "";
    if (base.endsWith(".pid") || base === "session.json" || base.endsWith(".sock")) hits.push(rel);
  }
  return hits;
}
