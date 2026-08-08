// Isolation preflight — the gate cell that makes the isolation UN-SKIPPABLE.
//
// A preflight script you remember to run is not a guard: the destructive command
// works fine without it. So the same pure function that an ad-hoc drive calls is
// also asserted HERE, against this suite's own resolved environment — forgetting
// it is red, not silent. Same move as the source-scanning spawn guard in
// server.test.ts: a prose instruction cannot stop the sixth site; a test can.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AMBIENT_BINDINGS, isolationReport } from "./bounty-preflight";

// A fully-isolated input, used as the control arm. Every negative case below is
// this object with exactly ONE field spoiled, so a red cell names one cause.
function isolated(over: Partial<Parameters<typeof isolationReport>[0]> = {}) {
  return {
    env: {
      BOUNTY_HOME: "/scratch/home",
      TMPDIR: "/scratch/tmp",
      BOUNTY_SESSION_KEY: undefined,
      BOUNTY_SESSION: undefined,
      BOUNTY_AS: undefined,
    } as Record<string, string | undefined>,
    cwd: "/scratch/run",
    scratchRoots: ["/scratch"],
    protectedIds: ["k-spellbook-f4249899"],
    exists: () => false,
    readDir: () => [] as string[],
    ...over,
  };
}

const cell = (r: ReturnType<typeof isolationReport>, name: string) => {
  const c = r.cells.find((x) => x.name === name);
  if (!c)
    throw new Error(`no cell named "${name}" — cells: ${r.cells.map((x) => x.name).join(", ")}`);
  return c;
};

describe("isolationReport — the control arm", () => {
  test("a fully isolated environment passes every cell", () => {
    const r = isolationReport(isolated());
    const degenerate = r.cells.filter((c) => c.status !== "PASS");
    // Name the offenders in the failure message — a bare `ok===true` tells you
    // nothing about WHICH cell went red when this eventually breaks.
    expect(degenerate.map((c) => `${c.name}: ${c.observed}`)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("every ambient binding the CUT reads has a cell — the union is TOTAL", () => {
    // Derived, not hand-listed: a binding added to AMBIENT_BINDINGS without a
    // cell fails here instead of silently going unchecked. The events.ts
    // totality-guard move, applied to the environment.
    const covered = new Set(r0.cells.map((c) => c.binding));
    for (const b of AMBIENT_BINDINGS) expect(covered.has(b)).toBe(true);
  });
});

const r0 = isolationReport(isolated());

describe("isolationReport — one spoiled field per cell", () => {
  test("BOUNTY_HOME outside the scratch roots is DEGENERATE", () => {
    const r = isolationReport(
      isolated({ env: { ...isolated().env, BOUNTY_HOME: "/Users/someone/.bounty" } }),
    );
    expect(cell(r, "BOUNTY_HOME").status).toBe("DEGENERATE");
    expect(r.ok).toBe(false);
  });

  test("an UNSET BOUNTY_HOME is DEGENERATE — the default is the user's real store", () => {
    // The dangerous case is absence, not a wrong value: unset resolves to
    // ~/.bounty, which is exactly the store this preflight exists to protect.
    const env = { ...isolated().env };
    delete env.BOUNTY_HOME;
    expect(cell(isolationReport(isolated({ env })), "BOUNTY_HOME").status).toBe("DEGENERATE");
  });

  test("TMPDIR outside the scratch roots is DEGENERATE — this is the one that escaped last sprint", () => {
    // BOUNTY_HOME scopes the SNAPSHOT STORE only. Discovery pointers
    // (bounty-<id>.json and the machine-global bounty-latest.json) go through
    // tmpdir(), so a suite that redirects only BOUNTY_HOME is NOT isolated.
    const r = isolationReport(isolated({ env: { ...isolated().env, TMPDIR: "/var/folders/T" } }));
    expect(cell(r, "TMPDIR").status).toBe("DEGENERATE");
    expect(r.ok).toBe(false);
  });

  test("an inherited BOUNTY_SESSION_KEY is DEGENERATE", () => {
    const r = isolationReport(
      isolated({ env: { ...isolated().env, BOUNTY_SESSION_KEY: "spellbook" } }),
    );
    expect(cell(r, "BOUNTY_SESSION_KEY").status).toBe("DEGENERATE");
  });

  test("an inherited BOUNTY_SESSION is DEGENERATE — the var a `process.env.` grep cannot see", () => {
    // resolveSession (cli.ts:182) reads this off an INJECTED env param, so the
    // literal `process.env.BOUNTY_SESSION` spelling appears nowhere in the spell.
    // A scrub list derived by grepping `process.env.` omits it and looks complete.
    const r = isolationReport(isolated({ env: { ...isolated().env, BOUNTY_SESSION: "k-x-1234" } }));
    expect(cell(r, "BOUNTY_SESSION").status).toBe("DEGENERATE");
  });

  test("an inherited BOUNTY_AS is DEGENERATE — not data loss, but the scrub list never heard of it", () => {
    const r = isolationReport(isolated({ env: { ...isolated().env, BOUNTY_AS: "daedalus" } }));
    expect(cell(r, "BOUNTY_AS").status).toBe("DEGENERATE");
  });

  test("a reachable .bounty-session is DEGENERATE — the binding NO env scrub can cover", () => {
    // convene writes one at the repo root. It is a FILE, found by walking UP
    // from cwd, so hermeticEnv() cannot touch it and its absence must be
    // asserted positively.
    const r = isolationReport(
      isolated({ cwd: "/scratch/run/deep", exists: (p) => p === "/scratch/.bounty-session" }),
    );
    expect(cell(r, ".bounty-session").status).toBe("DEGENERATE");
    expect(cell(r, ".bounty-session").observed).toContain("/scratch/.bounty-session");
  });
});

describe("isolationReport — the protected board, asserted POSITIVELY", () => {
  // cassandra's cell (#460): assert the file we are actually protecting is not
  // in the resolved store — a path-SHAPE check passes on a correctly-shaped path
  // pointing at the wrong place; naming the file is the version that cannot.
  test("the protected board's snapshot inside the resolved store is DEGENERATE", () => {
    const r = isolationReport(
      isolated({
        readDir: (d) =>
          d === join("/scratch/home", "snapshots") ? ["k-spellbook-f4249899.json"] : [],
      }),
    );
    expect(cell(r, "protected snapshot").status).toBe("DEGENERATE");
    expect(cell(r, "protected snapshot").observed).toContain("k-spellbook-f4249899");
    expect(r.ok).toBe(false);
  });

  test("the protected board's discovery pointer inside the resolved TMPDIR is DEGENERATE", () => {
    const r = isolationReport(
      isolated({
        readDir: (d) => (d === "/scratch/tmp" ? ["bounty-k-spellbook-f4249899.json"] : []),
      }),
    );
    expect(cell(r, "protected pointer").status).toBe("DEGENERATE");
  });

  test("an unrelated board in the store does NOT trip the protected cells", () => {
    // The guard must discriminate, or it is a blanket refusal wearing a check's
    // label — and a check that fires on everything gets disabled.
    const r = isolationReport(
      isolated({ readDir: (d) => (d.endsWith("snapshots") ? ["k-mine-deadbeef.json"] : []) }),
    );
    expect(cell(r, "protected snapshot").status).toBe("PASS");
    expect(r.ok).toBe(true);
  });
});

describe("the SCRUB — asserted against the enumeration, which is the un-skippable half", () => {
  // ⛔ AN EARLIER VERSION OF THIS BLOCK ASSERTED THE AMBIENT WORLD, AND IT WAS
  // WRONG IN A WAY WORTH RECORDING. It read `process.env` and failed if the
  // suite's own shell held a session key. It went red immediately and honestly —
  // an anthill seat shell really does carry BOUNTY_SESSION_KEY=spellbook — but
  // that condition is NOT a live hazard: every spawn goes through hermeticEnv()
  // and every resolveSession unit test injects its env explicitly, so nothing in
  // the suite can reach the team board through it.
  //
  // A guard that fires where there is no hazard gets disabled, and then it is
  // not guarding the case it was written for. So this asserts the DEFENCE covers
  // the enumerated population, rather than asserting the world is clean.
  test("hermeticEnv scrubs EVERY env-typed binding the CUT reads", () => {
    // Source-scanned, not called: hermeticEnv is local to server.test.ts. The
    // sprint-01 lineage — a test that reads a file's own source beats a mutation
    // test of the mechanism you already thought of, because the gap is always in
    // the sites that never call it.
    const src = readFileSync(
      join(import.meta.dir, "..", "plugins/spellbook/skills/bounty/scripts/server.test.ts"),
      "utf8",
    );
    const body = src.slice(src.indexOf("function hermeticEnv"));
    const decl = body.slice(0, body.indexOf("}\n", body.indexOf("return")));

    // TMPDIR is ASSIGNED rather than deleted (children need a private one), and
    // BOUNTY_HOME is assigned per-test by uniqHome(); the rest must be dropped.
    const mustDrop = AMBIENT_BINDINGS.filter(
      (b) => b !== "TMPDIR" && b !== ".bounty-session" && b !== "BOUNTY_HOME",
    );
    const missing = mustDrop.filter((b) => !decl.includes(b));
    expect(missing).toEqual([]);
  });

  test(".bounty-session is NOT claimed to be covered by the scrub — it is a file", () => {
    // The honest negative. No env scrub can cover a walk-up file, so the
    // enumeration must carry it while the scrub deliberately does not — and that
    // asymmetry has to be asserted, or a future reader closes the "gap".
    expect(AMBIENT_BINDINGS).toContain(".bounty-session");
    const r = isolationReport(
      isolated({ env: {}, cwd: "/x", exists: (p) => p === "/x/.bounty-session" }),
    );
    expect(cell(r, ".bounty-session").status).toBe("DEGENERATE");
  });
});
