// acc for the kit path: the pinned `acc check`, run the way the house ward runs
// it for every spell (`grimoire/acc-conformance.test.ts`), with the flag set.
//
// - From the SKILL FOLDER, so acc reads Scriptorium's own `acc.config.json`
//   (asserted below), and against the LAUNCHER, never `dist/`.
// - With `SCRIPTORIUM_KIT=1`, so the launcher hands off to the kit path. The
//   `--version` the report quotes carries `path: "kit"`, which is how this file
//   knows the flagged CLI is the one that was checked.
// - With the kit path's own census, `acc.recorded-surfaces.json` beside this
//   file. It is kept here and not in the skill folder: the ward passes the
//   folder's batch to the DEFAULT CLI, and the two verb sets differ. Re-record it
//   when the kit's verbs change (the harness is `acc probe-plan`, run with the
//   flag set under a scratch home: see the item for the commands).
//
// The default CLI's check is the ward's, unchanged.
import { beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL = join(
  KIT_DIR,
  "..",
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "scriptorium",
);
const BATCH = join(KIT_DIR, "acc.recorded-surfaces.json");

type Report = {
  data: {
    conformant: boolean;
    configSource: { origin: string; path: string | null };
    counts: { coreFailures: number };
    targetIdentity: { said?: string };
    recordedSurfaces?: { records: number };
    advertisedVerbs: {
      status: string;
      recordedNotAdvertised: string[];
      notCoveredByBatch: string[];
    };
  };
};

let report: Report;
let exitCode = -1;

beforeAll(async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      "x",
      "acc",
      "check",
      "scripts/cli.ts",
      "--json",
      "--recorded-surfaces",
      BATCH,
    ],
    {
      cwd: SKILL,
      env: { ...process.env, SCRIPTORIUM_KIT: "1" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  exitCode = code;
  report = JSON.parse(stdout) as Report;
}, 120_000);

describe("acc on the kit path (SCRIPTORIUM_KIT=1)", () => {
  test("the flagged CLI is the one checked, with Scriptorium's own config", () => {
    expect(JSON.parse(report.data.targetIdentity.said ?? "{}")).toMatchObject({
      name: "scriptorium",
      path: "kit",
    });
    expect(report.data.configSource.path).toBe(join(SKILL, "acc.config.json"));
  });

  test("conformant at L0, no core rule violated", () => {
    expect(exitCode).toBe(0);
    expect(report.data.conformant).toBe(true);
    expect(report.data.counts.coreFailures).toBe(0);
  });

  test("the census was read, and covers every verb the CLI advertises and no other", () => {
    expect(report.data.recordedSurfaces?.records).toBeGreaterThan(0);
    expect(report.data.advertisedVerbs.status).toBe("compared");
    expect(report.data.advertisedVerbs.recordedNotAdvertised).toEqual([]);
    expect(report.data.advertisedVerbs.notCoveredByBatch).toEqual([]);
  });
});
