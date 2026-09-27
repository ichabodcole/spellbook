// enforces: none in house-style — the acc conformance standard (pinned `acc check`, L0 core rules, each spell's acc.config.json)
//
// ACC CONFORMANCE WARD — runs the pinned `acc check` over every spell CLI, so a
// conformance regression fails `bun test` (and so `bun run gate`) instead of
// waiting for someone to run the kit by hand.
//
// HOW EACH SPELL IS CHECKED — the house pattern, and each clause is load-bearing:
//   - From the spell's SKILL FOLDER (`plugins/spellbook/skills/<spell>/`). acc
//     reads `acc.config.json` from its cwd only, with no search upward, so the
//     directory IS part of the verdict. The report's `configSource` is asserted
//     below, so a run that silently read no config cannot pass.
//   - Against the LAUNCHER (`scripts/cli.ts`, or `scripts/review.ts` for a spell
//     whose one entry is not named cli). Never `dist/`: `dist/cli.js` run alone
//     exits 0 silently, which reads as a CLI with nothing to say.
//   - Recorded surfaces, where the spell has them: a batch at
//     `<skill>/acc.recorded-surfaces.json` is passed as `--recorded-surfaces`, so
//     the census runs in the gate and not only the root probes. acc.config.json
//     has no key for this (its vocabulary is rules / knownFailures /
//     defaultOutput), hence the sidecar convention. The census passes or fails
//     nothing in acc; this ward asserts only that the batch was READ.
//
// DEBT, NOT WAIVERS. Today's failures sit in each spell's `knownFailures`, each
// with a reason that points at the spell's item
// (`docs/items/acc-conformance-<spell>.md`). That keeps the gate green while the
// defect stays visible (`excused`, never hidden). Two ratchets hold it:
//   - a STALE entry (the rule now passes) fails this ward — delete the line;
//   - an INERT entry (the kit no longer evaluates the rule) fails it too — that
//     is NOT evidence of a fix, so find out why before deleting it.
// `rules: { severity: "off" }` is a waiver — a permanent design decision — and
// is not what debt is for.
//
// ⛔ WHAT THIS WARD CANNOT SEE.
//   1. ROOT ONLY, unless a spell records surfaces. `acc check` probes the top
//      level; a verb that accepts an unknown flag is invisible to it.
//   2. L0 ONLY. `conformant` means no core rule was VIOLATED, not that every
//      rule was established — B3 stays unverified on every spell today.
//   3. A STALE RECORDED BATCH is still read. Re-record when the surface changes.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function repoRoot(): string {
  // Same anchor as roster-drift: the invocation root, not this file's path.
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".claude-plugin/marketplace.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found (no .claude-plugin/marketplace.json above cwd)");
}

const REPO = repoRoot();
const SKILLS = join(REPO, "plugins/spellbook/skills");

// FLOOR, not an exact count: the roster held nine spells when this landed. A
// walk that returns fewer lost spells (or found none) and must not pass; a new
// spell raises the count and is checked automatically.
const EXPECTED_MIN_SPELLS = 9;

// The launcher candidates, in order. A spell folder with none of these fails
// by name rather than being skipped.
const LAUNCHERS = ["scripts/cli.ts", "scripts/review.ts"];

const RECORDED_SURFACES = "acc.recorded-surfaces.json";

type Spell = { spell: string; dir: string; launcher: string | null };

/** Enumerated from the skill folders, as roster-drift's folderRoster does. */
function spellRoster(): Spell[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((spell) => {
      const dir = join(SKILLS, spell);
      const launcher = LAUNCHERS.find((l) => existsSync(join(dir, l))) ?? null;
      return { spell, dir, launcher };
    });
}

/** The version the repo pins: the `#v<semver>` tag on the git dependency. */
function pinnedVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const spec = pkg.devDependencies?.["agent-cli-conformance"];
  const m = spec?.match(/#v(\d+\.\d+\.\d+)$/);
  if (!m?.[1]) throw new Error(`agent-cli-conformance is not pinned to a #v<semver> tag: ${spec}`);
  return m[1];
}

type Finding = {
  ruleId: string;
  verdict: "pass" | "fail" | "unverified";
  tier: "core" | "diagnostic";
  detail: string;
  excused: boolean;
  applicable: boolean;
};
type Report = {
  ok: boolean;
  data: {
    kitVersion: string;
    conformant: boolean;
    configSource: { origin: string; path: string | null };
    findings: Finding[];
    knownFailures: { ruleId: string; reason: string }[];
    staleExpectations: unknown[];
    inertExpectations: unknown[];
    recordedSurfaces?: { records: number };
  };
};
type Run = { exitCode: number; report: Report | null; stderr: string; ms: number };

/** `bunx acc ...` from `cwd`, the way the acc skill and a developer run it. */
async function acc(cwd: string, args: string[]): Promise<Run> {
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, "x", "acc", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let report: Report | null = null;
  try {
    report = JSON.parse(stdout) as Report;
  } catch {
    report = null;
  }
  return { exitCode, report, stderr, ms: Math.round(performance.now() - t0) };
}

const roster = spellRoster();
const checkable = roster.filter((s): s is Spell & { launcher: string } => s.launcher !== null);
const runs = new Map<string, Run>();

describe("acc conformance ward", () => {
  beforeAll(async () => {
    // Concurrent: each run probes its own launcher in its own temp cwd, and
    // L0 probes are inert (help, sentinel flags, bare invocation). Sequential
    // is ~4.5s for nine; concurrent keeps `bun test` from paying all of it.
    await Promise.all(
      checkable.map(async (s) => {
        const args = ["check", s.launcher, "--json"];
        if (existsSync(join(s.dir, RECORDED_SURFACES)))
          args.push("--recorded-surfaces", RECORDED_SURFACES);
        runs.set(s.spell, await acc(s.dir, args));
      }),
    );
  }, 120_000);

  test("the denominator: every spell folder found, each with a launcher", () => {
    console.log(
      `  acc conformance: ${roster.length} spell(s) — ${roster
        .map(
          (s) =>
            `${s.spell}:${s.launcher ?? "NO-LAUNCHER"}${existsSync(join(s.dir, RECORDED_SURFACES)) ? "+surfaces" : ""}`,
        )
        .join(" ")}`,
    );
    expect(roster.length).toBeGreaterThanOrEqual(EXPECTED_MIN_SPELLS);
    expect(roster.filter((s) => s.launcher === null).map((s) => s.spell)).toEqual([]);
  });

  test("the installed kit is the pinned kit", async () => {
    const pin = pinnedVersion();
    // Asked from a skill folder, the cwd every check below runs from: bunx
    // resolves the same install there, or the ward is measuring with a
    // different instrument than the one it names.
    const first = roster[0];
    if (!first) throw new Error("empty roster");
    const proc = Bun.spawnSync([process.execPath, "x", "acc", "--version"], { cwd: first.dir });
    const out = proc.stdout.toString();
    let version: string | undefined;
    try {
      version = (JSON.parse(out) as { data?: { version?: string } }).data?.version;
    } catch {
      version = undefined;
    }
    if (version !== pin)
      throw new Error(
        `acc version mismatch: package.json pins v${pin}, \`bunx acc --version\` reports ${version ?? `unparseable: ${out.slice(0, 200)}`}. Run \`bun install\`.`,
      );
    // And every report carries the same kit version, so no run slipped past it.
    const drift = [...runs.entries()]
      .filter(([, r]) => r.report?.data.kitVersion !== pin)
      .map(([spell, r]) => `${spell}:${r.report?.data.kitVersion ?? "no-report"}`);
    expect(drift).toEqual([]);
  });

  for (const s of checkable) {
    describe(s.spell, () => {
      test(`acc check ${s.launcher} is conformant (L0)`, () => {
        const run = runs.get(s.spell);
        if (!run) throw new Error(`${s.spell}: acc did not run`);
        if (!run.report)
          throw new Error(
            `${s.spell}: acc exited ${run.exitCode} with no JSON report (exit 9 is "not conformant"; anything else is acc itself failing)\n${run.stderr.slice(0, 2000)}`,
          );
        const d = run.report.data;
        const excused = d.findings.filter((f) => f.excused).map((f) => f.ruleId);
        console.log(
          `  acc ${s.spell}: exit ${run.exitCode}, conformant=${d.conformant}, excused [${excused.join(",")}], ${run.ms}ms`,
        );
        const violations = d.findings
          .filter((f) => f.tier === "core" && f.verdict === "fail" && !f.excused)
          .map((f) => `${f.ruleId}: ${f.detail}`);
        // Named, not counted: the remedy is per rule.
        expect(violations).toEqual([]);
        expect(d.conformant).toBe(true);
        expect(run.exitCode).toBe(0);
      }, 60_000);

      test("the config it read is this spell's own", () => {
        const d = runs.get(s.spell)?.report?.data;
        if (!d) throw new Error(`${s.spell}: no report`);
        const cfg = join(s.dir, "acc.config.json");
        if (existsSync(cfg)) {
          expect(d.configSource.origin).toBe("discovered");
          expect(d.configSource.path).toBe(cfg);
        } else {
          expect(d.configSource.origin).toBe("none");
        }
      });

      test("recorded debt is live: no stale or inert knownFailures", () => {
        const d = runs.get(s.spell)?.report?.data;
        if (!d) throw new Error(`${s.spell}: no report`);
        // Stale: the rule passes now, so delete its knownFailures line.
        expect({ stale: d.staleExpectations }).toEqual({ stale: [] });
        // Inert: the kit no longer evaluates the rule. NOT a fix — find out why.
        expect({ inert: d.inertExpectations }).toEqual({ inert: [] });
      });

      test("every knownFailures reason points at the spell's item", () => {
        const d = runs.get(s.spell)?.report?.data;
        if (!d) throw new Error(`${s.spell}: no report`);
        const item = `docs/items/acc-conformance-${s.spell}.md`;
        const unpointed = d.knownFailures
          .filter((k) => !k.reason.includes(item))
          .map((k) => k.ruleId);
        expect(unpointed).toEqual([]);
        if (d.knownFailures.length > 0) expect(existsSync(join(REPO, item))).toBe(true);
      });

      test("a recorded-surfaces batch, where present, was read", () => {
        const d = runs.get(s.spell)?.report?.data;
        if (!d) throw new Error(`${s.spell}: no report`);
        if (!existsSync(join(s.dir, RECORDED_SURFACES))) {
          expect(d.recordedSurfaces).toBeUndefined();
          return;
        }
        expect(d.recordedSurfaces?.records ?? 0).toBeGreaterThan(0);
      });
    });
  }
});
