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
//     nothing in acc, so this ward asserts that the batch was READ, and that
//     its verbs are the CLI's: none the CLI does not advertise
//     (`recordedNotAdvertised`) and none it advertises left out
//     (`notCoveredByBatch`). Without the second, a census recorded on another
//     CLI passes conformant (measured at the scriptorium cutover: the shipped
//     census against the kit CLI exited 0 with two gone verbs and 13 uncovered).
//   - The census must also still be TRUE, record by record, which the verb
//     lists above cannot see. Two checks, both ours to assert because acc
//     passes and fails nothing on a batch:
//       - FLAGS. The CLI's own `schema` (an acc declaration, emitted) is passed
//         as `--declaration`, and acc diffs every recorded path's flag set (the
//         `choices` of its sentinel rejection) against it. A flag the verb
//         lost, or one a record invented, is a declaration finding, and this
//         ward asserts there are none and that every declared path compared.
//         (acc 0.1.15 has no option that re-checks a batch by itself.)
//       - OUTPUT. Every record is replayed against the launcher on scratch
//         homes and must answer byte-for-byte what it recorded: exit code,
//         stdout and stderr. A record is a sentinel-flag rejection, which a
//         parser answers before any work, so the replay is inert and
//         deterministic (229 records across nine spells in about 2s,
//         measured 2026-10-20). A changed error envelope, hint or exit code
//         on an existing verb fails here. The remedy is to re-record:
//         `acc probe-plan <launcher> --declaration <schema> --out capture.sh`,
//         then `sh capture.sh -o acc.recorded-surfaces.json` under a scratch home.
//         "Every record" means every entry of `records`. The batch's separate
//         `identity` record (the `--version` answer) is NOT replayed, on
//         purpose: it carries the release number, so replaying it would ask
//         for a re-record on every release. On 2026-10-20, 8 of the 9 censuses'
//         identity records named an older version (3.1.0 or 4.0.0) than the
//         CLI's 5.2.0; that is expected and not checked.
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
//   3. ONLY WHAT WAS RECORDED. The census holds sentinel rejections, so the
//      replay proves each verb still REFUSES the same way; it says nothing about
//      what a verb does when it runs. And a verb's flags are what its rejection
//      NAMES in `choices`: a flag the parser accepts without naming it is
//      invisible to both the census and the diff.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Spells whose CLI advertises no verb list, so acc has nothing to compare a
 * census's verbs against (`advertisedVerbs.status: "not-asserted"`). Every
 * other spell with a census must compare. digestify: one entry, `review.ts`,
 * with no subcommands.
 */
const NO_VERB_LIST = new Set(["digestify"]);

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
    advertisedVerbs?: {
      status: string;
      recordedNotAdvertised: string[];
      notCoveredByBatch: string[];
    };
    declaration?: {
      status: string;
      findings: unknown[];
      declaredCommands: number;
      checkedCommands: number;
      paths: { path: string[]; checked: boolean }[];
    };
  };
};
type Run = { exitCode: number; report: Report | null; stderr: string; ms: number };

/** One census record: a sentinel-flag invocation and what it answered. */
type SurfaceRecord = { argv: string[]; exitCode: number; stdout: string; stderr: string };

type Env = Record<string, string | undefined>;

/**
 * A scratch HOME, SCRIPTORIUM_HOME, TMPDIR and cwd per spell, so nothing this
 * ward runs can reach a real home. The test preload already moved this
 * process's HOME; these go one level further, one set per spell.
 *
 * Every other `*_HOME` and every `XDG_*` variable is dropped, not passed
 * through: each spell keeps its state under its own override when one is set
 * (GRAPEVINE_HOME, BOUNTY_HOME, GLAMOUR_HOME, IMAGO_HOME, MAGPIE_HOME,
 * MIND_MAPPER_HOME, ASTROLABE_HOME, as `src/` reads them on 2026-10-20), and a
 * caller's real one would otherwise win over the scratch HOME. Dropped by
 * pattern, so a spell that adds its own `*_HOME` is covered without an edit.
 */
const SCRATCH = mkdtempSync(join(tmpdir(), "acc-ward-"));
const LEAKS_A_HOME = /_HOME$|^XDG_/;
function scratchFor(name: string): { cwd: string; env: Env } {
  const root = join(SCRATCH, name);
  const [home, sh, tmp, cwd] = ["home", "scriptorium-home", "tmp", "cwd"].map((d) => {
    const p = join(root, d);
    mkdirSync(p, { recursive: true });
    return p;
  }) as [string, string, string, string];
  const env: Env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !LEAKS_A_HOME.test(k)),
  );
  return { cwd, env: { ...env, HOME: home, SCRIPTORIUM_HOME: sh, TMPDIR: tmp } };
}

async function spawnText(
  argv: string[],
  opts: { cwd: string; env: Env },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { ...opts, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** `bunx acc ...` from `cwd`, the way the acc skill and a developer run it. */
async function acc(cwd: string, args: string[], env: Env): Promise<Run> {
  const t0 = performance.now();
  const { stdout, stderr, exitCode } = await spawnText([process.execPath, "x", "acc", ...args], {
    cwd,
    env,
  });
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
/** The CLI's own `schema` run, per spell with a census: the declaration acc diffs against. */
const schemaRuns = new Map<string, { exitCode: number; stderr: string }>();
/** Census records whose replay no longer answers what they recorded, per spell. */
const replayDrift = new Map<string, string[]>();

/**
 * Replays every record against the launcher and names each one that answers
 * differently. LC_ALL=C is what the probe-plan harness records under.
 */
async function replayCensus(s: Spell & { launcher: string }): Promise<string[]> {
  const batch = JSON.parse(readFileSync(join(s.dir, RECORDED_SURFACES), "utf8")) as {
    records: SurfaceRecord[];
  };
  const { cwd, env } = scratchFor(`${s.spell}-replay`);
  const drift: string[] = [];
  for (const r of batch.records) {
    const now = await spawnText([process.execPath, join(s.dir, s.launcher), ...r.argv], {
      cwd,
      env: { ...env, LC_ALL: "C" },
    });
    const changed = (["exitCode", "stdout", "stderr"] as const).filter((k) => now[k] !== r[k]);
    if (changed.length === 0) continue;
    drift.push(
      `${r.argv.join(" ")}: ${changed
        .map((k) =>
          k === "exitCode"
            ? `exit ${r.exitCode} -> ${now.exitCode}`
            : firstDifference(k, r[k], now[k]),
        )
        .join("; ")}`,
    );
  }
  return drift;
}

/** Where two recordings of one stream part, with a little context either side. */
function firstDifference(stream: string, was: string, now: string): string {
  let i = 0;
  while (i < was.length && i < now.length && was[i] === now[i]) i++;
  const from = Math.max(0, i - 40);
  const cut = (t: string) => JSON.stringify(t.slice(from, i + 80));
  return `${stream} differs at offset ${i}: was ${cut(was)}, now ${cut(now)}`;
}

describe("acc conformance ward", () => {
  beforeAll(async () => {
    // Concurrent: each run probes its own launcher in its own temp cwd, and
    // L0 probes are inert (help, sentinel flags, bare invocation). Sequential
    // is ~4.5s for nine; concurrent keeps `bun test` from paying all of it.
    await Promise.all(
      checkable.map(async (s) => {
        const { cwd, env } = scratchFor(s.spell);
        const args = ["check", s.launcher, "--json"];
        if (existsSync(join(s.dir, RECORDED_SURFACES))) {
          args.push("--recorded-surfaces", RECORDED_SURFACES);
          // The CLI's own declaration, so acc diffs the census's flags against it.
          const schema = await spawnText([process.execPath, join(s.dir, s.launcher), "schema"], {
            cwd,
            env,
          });
          schemaRuns.set(s.spell, { exitCode: schema.exitCode, stderr: schema.stderr });
          if (schema.exitCode === 0) {
            const decl = join(SCRATCH, s.spell, "declaration.json");
            writeFileSync(decl, schema.stdout);
            args.push("--declaration", decl);
          }
          replayDrift.set(s.spell, await replayCensus(s));
        }
        runs.set(s.spell, await acc(s.dir, args, env));
      }),
    );
  }, 120_000);

  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

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

      test("a recorded-surfaces batch, where present, covers every verb the CLI advertises and no other", () => {
        const d = runs.get(s.spell)?.report?.data;
        if (!d) throw new Error(`${s.spell}: no report`);
        if (!existsSync(join(s.dir, RECORDED_SURFACES))) return;
        // Compared, or the two lists below are empty because nothing was looked
        // at. Only a CLI that advertises no verb list may be anything else.
        expect([s.spell, d.advertisedVerbs?.status]).toEqual([
          s.spell,
          NO_VERB_LIST.has(s.spell) ? "not-asserted" : "compared",
        ]);
        if (NO_VERB_LIST.has(s.spell)) return;
        expect({
          recordedNotAdvertised: d.advertisedVerbs?.recordedNotAdvertised,
          notCoveredByBatch: d.advertisedVerbs?.notCoveredByBatch,
        }).toEqual({ recordedNotAdvertised: [], notCoveredByBatch: [] });
      });

      test("a recorded-surfaces batch, where present, records the flags the CLI's own schema declares", () => {
        if (!existsSync(join(s.dir, RECORDED_SURFACES))) return;
        const schema = schemaRuns.get(s.spell);
        if (schema?.exitCode !== 0)
          throw new Error(
            `${s.spell}: \`${s.launcher} schema\` exited ${schema?.exitCode}, so there is no declaration to diff the census against\n${schema?.stderr.slice(0, 1000)}`,
          );
        const d = runs.get(s.spell)?.report?.data;
        if (!d) throw new Error(`${s.spell}: no report`);
        const decl = d.declaration;
        // Diffed, or the empty findings below mean nothing was looked at.
        expect([s.spell, decl?.status]).toEqual([s.spell, "checked"]);
        // A flag a verb lost, or one a record names that the verb never had.
        // Re-record the census (see the header) unless the schema is the side
        // that is wrong.
        expect({ spell: s.spell, findings: decl?.findings }).toEqual({
          spell: s.spell,
          findings: [],
        });
        const unchecked = (decl?.paths ?? [])
          .filter((p) => !p.checked)
          .map((p) => p.path.join(" "));
        expect({ spell: s.spell, unchecked }).toEqual({ spell: s.spell, unchecked: [] });
        expect(decl?.checkedCommands).toBe(decl?.declaredCommands);
      });

      test("a recorded-surfaces batch, where present, still answers what it recorded", () => {
        if (!existsSync(join(s.dir, RECORDED_SURFACES))) return;
        const drift = replayDrift.get(s.spell);
        if (!drift) throw new Error(`${s.spell}: the census was not replayed`);
        // Each line is one record whose exit code or bytes changed: re-record.
        expect({ spell: s.spell, drift }).toEqual({ spell: s.spell, drift: [] });
      });
    });
  }
});
