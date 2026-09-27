// CLI GOLDEN SNAPSHOT — what each of the nine spell CLIs does TODAY, recorded
// from its launcher, so the move onto the kit registry (`src/kit/cli/registry.ts`)
// has a regression net. Every later diff to a fixture is either a deliberate,
// named change or a bug. The registry's contract tests compare its table with
// itself, so they cannot see a dropped flag; this can: a documented flag that
// stops parsing turns an `accepted` record into `rejected`.
//
// WHAT A RECORD HOLDS: argv (+ stdin), exit code, the parse-level verdict (exit
// 2 = rejected; ANY other exit, including 5 "no session", = accepted), which
// stream carried output, the JSON envelope's `ok` / `error.kind` /
// `error.choices`, and for help / version / schema the normalized output itself.
// Messages are deliberately NOT recorded: the move rewords them, and the
// contract is the kind, the choices and the exit.
//
// BUGS INCLUDED. The snapshot records today, not the intended behaviour (e.g.
// `glamour version --bogus` exits 0). Fixing one is a fixture diff, on purpose.
//
// UPDATING, after a deliberate change:
//   GOLDEN_UPDATE=1 bun test grimoire/cli-golden.test.ts
// then review the diff under grimoire/fixtures/cli-golden/ and name it in the
// commit. Launchers import the built dist/, so run `bun run build` first or you
// snapshot stale code.
//
// ISOLATION: see `lib/cli-golden.ts`. Each invocation gets a fresh temp HOME,
// TMPDIR, cwd and <SPELL>_HOME; daemon-spawning verbs are excluded (listed per
// spell with the reason in the fixture); grapevine's daemon verbs meet a respawn
// hold, and astrolabe's auto-spawning verbs meet a stub daemon. After the run
// the ward fails if any process still carries the temp root in its environment
// or any pid file was written.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Case,
  daemonTraces,
  pool,
  type Rec,
  type RunCtx,
  runCase,
  type SpellSpec,
} from "./lib/cli-golden";
import { SPECS } from "./lib/cli-golden-corpus";

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".claude-plugin/marketplace.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found (no .claude-plugin/marketplace.json above cwd)");
}

const REPO = repoRoot();
const FIXTURES = join(REPO, "grimoire/fixtures/cli-golden");
const UPDATE = process.env.GOLDEN_UPDATE === "1";
const EXPECTED_SPELLS = 9;

type Documented = { line: number; argv: string[]; stdin?: string; exclude?: string };

type Fixture = {
  spell: string;
  launcher: string;
  /** From the CLI's own unknown-verb `choices` (digestify: its flag `choices`). */
  verbCount: number;
  verbs: string[];
  excluded: Record<string, string>;
  excludedInvocations: { argv: string[]; doc?: string; reason: string }[];
  invocationCount: number;
  invocations: Rec[];
};

const ROOT_TOKENS = ["--help", "-h", "help", "--version", "-V", "version", "schema"];

function documented(spell: string): Documented[] {
  const p = join(FIXTURES, "documented", `${spell}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Documented[]) : [];
}

/** The verb a case names: its first token that is one of the CLI's verbs. */
function verbOf(argv: string[], verbs: Set<string>): string | undefined {
  return argv.find((t) => verbs.has(t));
}

function buildCases(spec: SpellSpec, verbs: string[]) {
  const verbSet = new Set(verbs);
  const cases: Case[] = [];
  const excludedInvocations: Fixture["excludedInvocations"] = [];
  const problems: string[] = [];

  cases.push({ argv: [] });
  for (const t of ROOT_TOKENS) cases.push({ argv: [t], capture: true });
  cases.push({ argv: ["--acc-bogus-flag"] });
  cases.push({ argv: ["zz-bogus-verb"] });
  cases.push({ argv: ["--", "--x"] });
  cases.push({ argv: ["version", "--bogus"] });
  if (spec.verbFirst) {
    for (const v of verbs) {
      cases.push({ argv: [v, "--acc-bogus-flag"] });
      cases.push({ argv: [v, "--help"], capture: true });
    }
  }
  for (const c of spec.cases) {
    const v = verbOf(c.argv, verbSet);
    if (v && spec.excluded[v]) problems.push(`hand case names excluded verb: ${c.argv.join(" ")}`);
    cases.push(c);
  }
  for (const d of documented(spec.spell)) {
    const doc = `SKILL.md:${d.line}`;
    const v = verbOf(d.argv, verbSet);
    const reason = d.exclude ?? (v ? spec.excluded[v] : undefined);
    if (reason) {
      excludedInvocations.push({ argv: d.argv, doc, reason });
      continue;
    }
    cases.push({ argv: d.argv, ...(d.stdin !== undefined ? { stdin: d.stdin } : {}), doc });
  }

  // Dedupe on argv + stdin; a documented duplicate lends its line to the first.
  const seen = new Map<string, Case>();
  const unique: Case[] = [];
  for (const c of cases) {
    const key = JSON.stringify([c.argv, c.stdin ?? null]);
    const prior = seen.get(key);
    if (prior) {
      if (c.doc && !prior.doc) prior.doc = c.doc;
      if (c.capture) prior.capture = true;
      continue;
    }
    const copy: Case = { ...c };
    const v = verbOf(copy.argv, verbSet);
    if (v && spec.stubVerbs?.includes(v)) copy.stub = true;
    seen.set(key, copy);
    unique.push(copy);
  }

  // Coverage: every verb that is run for real has at least one hand-written case.
  if (spec.verbFirst) {
    const handVerbs = new Set(spec.cases.map((c) => verbOf(c.argv, verbSet)));
    for (const v of verbs) {
      if (spec.excluded[v] || v === "help" || v === "version" || v === "schema") continue;
      if (!handVerbs.has(v)) problems.push(`verb "${v}" has no hand-written case`);
    }
    for (const v of Object.keys(spec.excluded)) {
      if (!verbSet.has(v)) problems.push(`excluded verb "${v}" is not a verb of the CLI`);
    }
  }
  return { cases: unique, excludedInvocations, problems };
}

/** Processes still carrying the run root in their environment (darwin/linux). */
function leakedProcesses(runRoot: string): string[] {
  const args =
    process.platform === "darwin"
      ? ["ps", "-axEww", "-o", "pid=,command="]
      : ["ps", "axeww", "-o", "pid=,command="];
  const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore" });
  return p.stdout
    .toString()
    .split("\n")
    .filter((l) => l.includes(runRoot) && !l.includes(" ps -ax") && !l.includes(" ps axe"))
    .map((l) => l.trim().slice(0, 200));
}

const results = new Map<string, Fixture>();
const problemsBySpell = new Map<string, string[]>();
let leaks: string[] = [];
let traces: string[] = [];
let runRoot = "";
let elapsedMs = 0;

beforeAll(async () => {
  const t0 = performance.now();
  runRoot = mkdtempSync(join(tmpdir(), "cli-golden-"));
  // astrolabe's stub daemon: up on GET /state, and applies every /cmd without
  // doing anything, so an accepted parse exits 0 and a daemon refusal can never
  // be mistaken for a parse rejection (astrolabe reports those as exit 2 too).
  const stubServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/state")
        return Response.json({ title: "Observatory", projects: [] });
      if (url.pathname === "/cmd")
        return Response.json({ ok: true, applied: true, outcome: "golden-stub" });
      return Response.json({ ok: false, error: "golden stub daemon" }, { status: 503 });
    },
  });
  const ctx: RunCtx = { repo: REPO, runRoot, stubPort: stubServer.port ?? 0, seq: { n: 0 } };
  const limit = Math.max(4, availableParallelism());
  try {
    // Phase 1: each CLI names its own verbs (digestify: its flags).
    const probes = await pool(SPECS, limit, (spec) =>
      runCase(spec, { argv: spec.verbFirst ? ["zz-bogus-verb"] : ["--acc-bogus-flag"] }, ctx),
    );
    const verbsBySpell = new Map<string, string[]>();
    SPECS.forEach((spec, i) => {
      const choices = probes[i]?.choices ?? [];
      verbsBySpell.set(spec.spell, [...new Set(choices.filter((t) => !t.startsWith("-")))]);
      if (!spec.verbFirst) verbsBySpell.set(spec.spell, [...new Set(choices)]);
    });

    // Phase 2: the whole corpus, every spell at once.
    const plan = SPECS.map((spec) => {
      const verbs = verbsBySpell.get(spec.spell) ?? [];
      return { spec, verbs, ...buildCases(spec, verbs) };
    });
    const jobs = plan.flatMap((p, pi) => p.cases.map((c, ci) => ({ pi, ci, c })));
    const recs = await pool(jobs, limit, (j) => runCase(plan[j.pi]?.spec as SpellSpec, j.c, ctx));
    for (const [pi, p] of plan.entries()) {
      const invocations = jobs.flatMap((j, k) => (j.pi === pi ? [recs[k] as Rec] : []));
      problemsBySpell.set(p.spec.spell, p.problems);
      results.set(p.spec.spell, {
        spell: p.spec.spell,
        launcher: p.spec.launcher,
        verbCount: p.verbs.length,
        verbs: p.verbs,
        excluded: p.spec.excluded,
        excludedInvocations: p.excludedInvocations,
        invocationCount: invocations.length,
        invocations,
      });
    }
  } finally {
    stubServer.stop(true);
    leaks = leakedProcesses(runRoot);
    traces = daemonTraces(runRoot);
    elapsedMs = performance.now() - t0;
  }
}, 240_000);

afterAll(() => {
  if (runRoot && leaks.length === 0) rmSync(runRoot, { recursive: true, force: true });
  const rows = [...results.values()].map(
    (f) =>
      `${f.spell.padEnd(12)} verbs ${String(f.verbCount).padStart(2)}  invocations ${String(f.invocationCount).padStart(3)}  excluded verbs ${Object.keys(f.excluded).length}`,
  );
  console.log(
    `cli-golden: ${results.size} CLIs in ${(elapsedMs / 1000).toFixed(1)}s\n${rows.join("\n")}`,
  );
});

describe("cli golden snapshot", () => {
  test("covers every spell CLI", () => {
    expect(results.size).toBe(EXPECTED_SPELLS);
  });

  test("leaves no process, daemon or pid file behind", () => {
    expect(leaks).toEqual([]);
    expect(traces).toEqual([]);
  });

  for (const spec of SPECS) {
    describe(spec.spell, () => {
      test("the CLI names its verbs, and the corpus covers them", () => {
        const f = results.get(spec.spell);
        expect(f?.verbCount ?? 0).toBeGreaterThan(0);
        expect(problemsBySpell.get(spec.spell)).toEqual([]);
      });

      test("no invocation timed out", () => {
        const f = results.get(spec.spell);
        const hung = (f?.invocations ?? []).filter((r) => r.verdict === "timeout");
        expect(hung.map((r) => r.argv.join(" "))).toEqual([]);
      });

      test("matches the golden fixture", () => {
        const actual = results.get(spec.spell);
        expect(actual).toBeDefined();
        const path = join(FIXTURES, `${spec.spell}.json`);
        if (UPDATE) {
          mkdirSync(FIXTURES, { recursive: true });
          writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
          Bun.spawnSync(["bunx", "biome", "format", "--write", path], { cwd: REPO });
          return;
        }
        if (!existsSync(path)) {
          throw new Error(
            `no fixture at ${path}; run GOLDEN_UPDATE=1 bun test ${import.meta.path}`,
          );
        }
        const expected = JSON.parse(readFileSync(path, "utf8")) as Fixture;
        // Per invocation first, so a failure names the argv that moved.
        const key = (r: Rec) => JSON.stringify([r.argv, r.stdin ?? null]);
        const want = new Map(expected.invocations.map((r) => [key(r), r]));
        const drift: string[] = [];
        for (const r of actual?.invocations ?? []) {
          const w = want.get(key(r));
          if (!w) drift.push(`NEW      ${r.argv.join(" ")}`);
          else if (JSON.stringify(w) !== JSON.stringify(r))
            drift.push(
              `CHANGED  ${r.argv.join(" ")}\n  was ${JSON.stringify(w)}\n  now ${JSON.stringify(r)}`,
            );
          want.delete(key(r));
        }
        for (const w of want.values()) drift.push(`GONE     ${w.argv.join(" ")}`);
        expect(drift).toEqual([]);
        expect(actual).toEqual(expected);
      });
    });
  }
});
