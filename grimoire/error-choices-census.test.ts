/**
 * THE `choices` CENSUS — register A1's instrument.
 *
 * A1 is the house's error-envelope row: eight spells all import
 * `src/kit/wire/errors.ts` and only some of them use its MACHINE-READABLE half.
 * `hint` is prose for a human; `choices` is *what WOULD have been accepted*, and
 * it is the field an agent ROUTES on. Measured at the row's close: 260 raise
 * sites, 42 carrying `choices`, and before this branch **five spells had none
 * of the ones they qualified for** — astrolabe (the spell the contract was
 * EXTRACTED from) worst, at zero across fifteen raises.
 *
 * ── THE RULE THIS WARD BACKSTOPS ────────────────────────────────────────────
 *
 * **`choices` is REQUIRED wherever a closed set of valid inputs exists AND is
 * in hand at the raise** — an unknown or absent verb, an unknown flag, an
 * invalid value of an enumerable type, a named member of a collection the code
 * has ALREADY loaded, and a required-input disjunction with two or more
 * members. **`hint` is required wherever there is a next act the caller can
 * take, and deliberately NOT otherwise** — 260 raises against 47 hints is why:
 * a hint on every failure would add ~200 strings of the form "run help", which
 * is noise wearing conformance's clothes. An absent `hint` is a DECISION here
 * (digestify's flag rejection carries none, on purpose: digestify answers no
 * `help` at all, so there is nothing to tell the caller to run).
 *
 * ⛔ **AND `choices` MUST BE THE ACTUAL SET.** A hand-typed list that drifts
 * from the dispatch table is worse than no list, because a caller can check
 * prose against reality and cannot check `choices` against anything.
 *
 * ── THREE ARMS, AND WHY EACH IS SHAPED THE WAY IT IS ────────────────────────
 *
 * **ARM 1 — no accepted set may be spelled as PROSE, derived, pinned at 0.**
 * The predicate is over the raise sites `grimoire/lib/error-sites.ts`
 * enumerates, and it looks for the two shapes a hand-typed set actually takes
 * in this roster: (i) a DECLARED array or object flattened with `.join(` inside
 * a rejection that carries no `choices` — the root identifier is resolved to a
 * `const … = [` / `= {` in the same file, so `spec.positionals.map(…).join(" ")`
 * (a positional SHAPE, not a value set) is correctly out; and (ii) an
 * unbracketed `a|b|c` alternation of bare lowercase words inside a message
 * literal. Bracketed, angled and braced spans are stripped first, because
 * `[--kind generate|edit]` is a usage SYNOPSIS and a synopsis is not a claim
 * about an accepted set. ⚠ That distinction is the whole calibration: an
 * earlier draft that did not strip them reported **50 sites** across six
 * spells, nearly all `usage:` lines, and acting on it would have converted
 * every synopsis into `choices` — the same noise the `hint` half of the ruling
 * refuses.
 *
 * **ARM 2 — the two ROOT sets are DRIVEN, not scanned.** Every spell with a
 * verb roster must answer an unknown verb with `choices`, and every spell with
 * a flag map must answer an unknown flag with `choices`. This arm spawns the
 * SHIPPED LAUNCHER, which is the only honest target: the launcher reads
 * `dist/`, so a source-only check would pass over a stale artifact — the
 * hazard that makes a mutation drive against a built entry silently vacuous
 * without `bun run build` first. It is a drive because a scan CANNOT answer it:
 * see the deleted-helper note in `error-sites.ts`.
 *
 * **ARM 3 — coverage, PINNED BY EXACT EQUALITY per spell (D27).** Printing a
 * population is not enough; D27's finding is that a green ward's console output
 * is not read, so coverage must be ASSERTED. Both numbers are pinned: total
 * raise sites and sites carrying `choices`. A new qualifying raise that lacks
 * `choices` moves the first and not the second, and the cell reds naming the
 * spell.
 *
 * ⛔ **THE PINS ARE HAND-DECLARED, NOT COMPUTED FROM THE PREDICATE THEY
 * BACKSTOP (D27).** `EXPECTED` below is a table someone wrote down after
 * driving the roster. Deriving it from `raiseSitesBySpell()` would make every
 * cell here tautological — the classic shape of a gate that computes its own
 * expectation — and the ward would go green over any change at all.
 *
 * ── ⛔ WHAT THIS WARD NAMES AND CANNOT EXAMINE (D42) ────────────────────────
 *
 * An area an instrument NAMES and does not EXAMINE must say **"not looked
 * at"**, never pass silently:
 *
 *  - **Whether a closed set EXISTS at a given raise is RULED, not measured.**
 *    No arm here can tell "unknown project id, and the snapshot is in hand"
 *    (qualifies) from "the daemon refused and the set lives upstream" (does
 *    not). Arm 3's pin is the guard: a new raise site changes a number, and a
 *    human answers the question. **The ward cannot close A1 by itself and does
 *    not claim to.**
 *  - **The daemon side is OUT OF THE POPULATION, not clean.** An HTTP JSON body
 *    is not the CLI envelope; the register's A1 measurement excludes those by
 *    name (grapevine's `daemon.ts` 404/409 bodies).
 *  - **Surfaces are invisible.** `error-sites.ts` is `.ts`-only, so a rejection
 *    rendered by a `.html`/inline-script surface is outside every arm.
 *  - **A raiser spelled in an unrecognised shape is invisible**, and arm 3
 *    cannot distinguish that from a file with fewer raises. The enumerator's
 *    header carries the concrete gap.
 *  - **Arm 2 drives the ROOT only.** A per-verb enumerated value (magpie's
 *    `--alpha`, imago's `--link`, mind-mapper's `activity <state>`) is covered
 *    by arm 1 and arm 3 and is NOT driven here; each spell's own suite drives
 *    those.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blankComments, type RaiseSite, raiseSitesBySpell } from "./lib/error-sites.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * ⛔ HAND-DECLARED. See the header: computing this from the predicate would
 * make every cell below tautological.
 *
 * `sites` — every raise site the enumerator finds. `choices` — how many carry
 * the field. `verbRoster` / `flagMap` — does the spell's ROOT have that closed
 * set at all, which is what arm 2 drives. digestify is the one spell with no
 * verbs: a single-shot entry that takes flags only.
 */
const EXPECTED: Record<
  string,
  { sites: number; choices: number; verbRoster: boolean; flagMap: boolean }
> = {
  astrolabe: { sites: 15, choices: 4, verbRoster: true, flagMap: true },
  bounty: { sites: 32, choices: 2, verbRoster: true, flagMap: true },
  digestify: { sites: 8, choices: 2, verbRoster: false, flagMap: true },
  glamour: { sites: 25, choices: 9, verbRoster: true, flagMap: true },
  grapevine: { sites: 58, choices: 5, verbRoster: true, flagMap: true },
  imago: { sites: 24, choices: 3, verbRoster: true, flagMap: true },
  magpie: { sites: 32, choices: 4, verbRoster: true, flagMap: true },
  "mind-mapper": { sites: 66, choices: 14, verbRoster: true, flagMap: true },
};

/**
 * ⚠ TWO SPELLS' ROOT FLAG REJECTION IS BELOW THEIR `choices` COUNT ON PURPOSE.
 * bounty and imago attach the flag roster to a private `UsageError`'s `extra`
 * and hand it to `die` one frame later, so the literal `choices:` sits at the
 * PARSER and the site arm 3 counts is `die(e.message, "usage", e.extra)` —
 * which has no literal. Arm 2 is what proves those two work, and this note is
 * why arm 3's number is not the whole story for them.
 */

/** How the shipped launcher is addressed, and the env that keeps its state in a temp home. */
const LAUNCHER: Record<string, string> = {
  astrolabe: "astrolabe/scripts/cli.ts",
  bounty: "bounty/scripts/cli.ts",
  digestify: "digestify/scripts/review.ts",
  glamour: "glamour/scripts/cli.ts",
  grapevine: "grapevine/scripts/cli.ts",
  imago: "imago/scripts/cli.ts",
  magpie: "magpie/scripts/cli.ts",
  "mind-mapper": "mind-mapper/scripts/cli.ts",
};

/** The argv that hits each root set. A verb every spell has is not assumable, so
 *  the unknown-flag probe rides an unknown verb where the spell scopes flags to
 *  a verb, and the root parse where it does not. */
const UNKNOWN_FLAG_ARGS: Record<string, string[]> = {
  astrolabe: ["state", "--acc-not-a-flag"],
  bounty: ["state", "--acc-not-a-flag"],
  digestify: ["--acc-not-a-flag"],
  glamour: ["state", "--acc-not-a-flag"],
  grapevine: ["who", "chan", "--acc-not-a-flag"],
  imago: ["state", "--acc-not-a-flag"],
  magpie: ["state", "--acc-not-a-flag"],
  "mind-mapper": ["state", "--acc-not-a-flag"],
};

function run(spell: string, args: string[]): { code: number; stderr: string; stdout: string } {
  const launcher = join(REPO_ROOT, "plugins", "spellbook", "skills", LAUNCHER[spell] as string);
  const p = Bun.spawnSync(["bun", launcher, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...tempHome(spell) },
  });
  return {
    code: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

/**
 * ⛔ EVERY DRIVE GETS ITS OWN HOME. A usage rejection should never reach a
 * daemon, but "should never" is not a guarantee, and a ward that can attach to
 * the operator's live board is a ward that can change it.
 */
function tempHome(spell: string): Record<string, string> {
  const dir = join(process.env.TMPDIR ?? "/tmp", `choices-census-${spell}-${process.pid}`);
  return {
    ASTROLABE_HOME: dir,
    BOUNTY_HOME: dir,
    GLAMOUR_HOME: dir,
    GRAPEVINE_HOME: dir,
    IMAGO_HOME: dir,
    MAGPIE_HOME: dir,
    MIND_MAPPER_HOME: dir,
  };
}

const CENSUS = raiseSitesBySpell();

// ── ARM 1 · no accepted set is spelled as prose ─────────────────────────────

/** A message literal's bare text: bracketed / angled / braced spans stripped. */
function bareLiterals(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/(?:"|`|')([^"`']*?)(?:"|`|')/g)) {
    const lit = m[1] ?? "";
    out.push(
      lit
        .replace(/\[[^\]]*\]/g, "")
        .replace(/<[^>]*>/g, "")
        .replace(/\{[^}]*\}/g, ""),
    );
  }
  return out;
}

function alternationsIn(site: RaiseSite): string[] {
  const out: string[] = [];
  for (const bare of bareLiterals(site.args))
    for (const a of bare.matchAll(/(?<![-\w])[a-z][a-z0-9-]{1,20}(?:\|[a-z][a-z0-9-]{1,20})+/g))
      out.push(a[0]);
  return out;
}

/** A DECLARED collection flattened into a message — resolved to its declaration
 *  in the same file, which is what keeps a positional-shape join out. */
function flattenedSetsIn(site: RaiseSite, src: string): string[] {
  if (site.hasChoices) return [];
  const declared = (root: string) =>
    new RegExp(`\\b(?:const|let|var)\\s+${root}\\s*(?::[^=\\n]*)?=\\s*[[{]`).test(src);
  const out: string[] = [];
  for (const m of site.args.matchAll(
    /([A-Za-z_$][\w$]*)(?:\.[\w$]+|\([^()]*\)|\[[^\]]*\])*\.join\s*\(/g,
  )) {
    const root = m[1] as string;
    if (declared(root)) out.push(m[0]);
  }
  if (/\.join\s*\(/.test(site.args))
    for (const m of site.args.matchAll(/Object\.keys\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      const root = m[1] as string;
      if (declared(root)) out.push(m[0]);
    }
  return out;
}

test.each(Object.keys(EXPECTED))("arm 1 · %s spells no accepted set as prose", (spell) => {
  const offenders: string[] = [];
  for (const site of CENSUS.get(spell) ?? []) {
    const src = blankComments(readFileSync(join(REPO_ROOT, "src", site.file), "utf8"));
    const alts = alternationsIn(site);
    const flat = flattenedSetsIn(site, src);
    if (alts.length > 0 || flat.length > 0)
      offenders.push(
        `${site.file}:${site.line} — ${[...alts, ...flat].join(" · ")}\n      ${site.args.replace(/\s+/g, " ").slice(0, 160)}`,
      );
  }
  // Pinned at 0, DECLARED: a set an agent must parse out of a sentence is the
  // defect A1 names, and it is repaired by moving the set — never by copying it.
  expect(offenders).toEqual([]);
});

// ── ARM 2 · the two ROOT closed sets, DRIVEN through the shipped launcher ────

const withVerbs = Object.keys(EXPECTED).filter((s) => EXPECTED[s]?.verbRoster);
const withFlags = Object.keys(EXPECTED).filter((s) => EXPECTED[s]?.flagMap);

test.each(withVerbs)("arm 2 · %s answers an unknown verb with the verb roster", (spell) => {
  const r = run(spell, ["acc-not-a-verb"]);
  // stdout carries DATA and a failure has none — asserted here too, because a
  // rejection that also prints is a second failure shape nobody named (A8).
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as {
    ok: boolean;
    error: { kind: string; exit_code: number; choices?: string[] };
  };
  expect(doc.ok).toBe(false);
  expect(doc.error.kind).toBe("usage");
  expect(doc.error.exit_code).toBe(r.code);
  expect(Array.isArray(doc.error.choices)).toBe(true);
  // A roster of one is a roster nobody can route on — every spell here has
  // several verbs, so a single-member answer means the set came from the wrong
  // place.
  expect((doc.error.choices ?? []).length).toBeGreaterThan(1);
});

test.each(withFlags)("arm 2 · %s answers an unknown flag with the flag set", (spell) => {
  const r = run(spell, UNKNOWN_FLAG_ARGS[spell] as string[]);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as {
    ok: boolean;
    error: { kind: string; exit_code: number; choices?: string[] };
  };
  expect(doc.ok).toBe(false);
  expect(doc.error.kind).toBe("usage");
  expect(doc.error.exit_code).toBe(r.code);
  expect(Array.isArray(doc.error.choices)).toBe(true);
  // Every member is a flag as the CALLER WOULD TYPE IT. A bare `theme` is the
  // parser's key, not an accepted token, and handing that to an agent is a
  // rejection it cannot act on.
  for (const c of doc.error.choices ?? []) expect(c.startsWith("-")).toBe(true);
});

/**
 * ── ARM 2b · THE PER-VERB CONVERTED SITES, DRIVEN AND PINNED ────────────────
 *
 * ⛔ AN ENVELOPE NOBODY RAN IS A CLAIM. Arm 2 drives the two ROOT sets; these
 * are the per-verb closed sets this row converted, each driven through the
 * shipped launcher with the EXACT set it must answer. Pinned by equality rather
 * than by "has choices", because the whole defect class is a set that drifts:
 * a `choices` present but wrong is the thing worse than no list.
 *
 * ⚠ EVERY ROW HERE IS DAEMON-FREE, AND THAT IS A SELECTION, NOT A COMPLETENESS
 * CLAIM. magpie's `extract --alpha bogus` refuses on the SESSION first
 * (`not_found`, 5) and only reaches the alpha check with a live daemon, so it is
 * driven by hand at the close and is **not looked at** here. Its set is the one
 * in the roster that cannot drift regardless: `AlphaPolicy` is derived FROM
 * `ALPHA_POLICIES` (`shared/alpha.ts`), so a policy added to the array is the
 * type, and one added to the type does not compile.
 */
const PER_VERB_DRIVES: Array<[spell: string, argv: string[], choices: string[]]> = [
  // astrolabe — the flag roster, off `CLI_OPTIONS`, only for an UNKNOWN OPTION.
  [
    "astrolabe",
    ["state", "--acc-not-a-flag"],
    [
      "--as",
      "--avatar",
      "--clear",
      "--description",
      "--from",
      "--id",
      "--no-open",
      "--path",
      "--phase",
      "--question",
      "--since",
      "--stdin",
      "--timeout",
    ],
  ],
  // bounty — the patch-contributing flags, the set whose emptiness IS the refusal.
  [
    "bounty",
    ["update", "acc-no-such-task"],
    ["--status", "--title", "--notes", "--owner", "--tag", "--size", "--expect", "--stdin"],
  ],
  // glamour — a CONJUNCTION, filtered: `choices` names what is actually missing.
  ["glamour", ["gen", "--url", "http://example.invalid"], ["--prompt", "--model", "--round"]],
  // glamour — a DISJUNCTION: the whole set, because either member satisfies it.
  ["glamour", ["gen-meta", "acc-no-such-id"], ["--prompt", "--custom"]],
  // grapevine — the identity disjunction four verbs share.
  ["grapevine", ["send", "acc-chan", "hello"], ["--as", "--from"]],
  // imago — an enumerated VALUE, and an enumerated POSITIONAL.
  ["imago", ["context", "prompt", "n", "--link", "acc-bogus"], ["active", "quickPrompts"]],
  ["imago", ["context", "acc-bogus", "n"], ["prompt", "style", "skill", "context"]],
  // mind-mapper — the one enumerated positional left in prose after eleven
  // other rejections already carried `choices`.
  ["mind-mapper", ["activity", "acc-bogus"], ["received", "thinking", "idle"]],
];

test.each(PER_VERB_DRIVES)("arm 2b · %s %j answers %j", (spell, argv, choices) => {
  const r = run(spell, argv);
  expect(r.stdout).toBe("");
  expect(r.code).toBe(2);
  const doc = JSON.parse(r.stderr) as { error: { kind: string; choices?: string[] } };
  expect(doc.error.kind).toBe("usage");
  expect(doc.error.choices).toEqual(choices);
});

// ── ARM 3 · coverage, pinned by exact equality (D27) ────────────────────────

test("arm 3 · the census matches its pin, spell by spell", () => {
  const actual: Record<string, { sites: number; choices: number }> = {};
  const lines: string[] = [];
  for (const spell of Object.keys(EXPECTED).sort()) {
    const sites = CENSUS.get(spell) ?? [];
    actual[spell] = { sites: sites.length, choices: sites.filter((s) => s.hasChoices).length };
    lines.push(
      `    ${spell.padEnd(12)} ${String(sites.length).padStart(3)} raise site(s) · ` +
        `${String(sites.filter((s) => s.hasChoices).length).padStart(2)} choices · ` +
        `${String(sites.filter((s) => s.hasHint).length).padStart(2)} hint · ` +
        `raisers: ${[...new Set(sites.map((s) => s.raiser))].sort().join(" ")}`,
    );
  }
  console.warn(
    `\n  \`choices\` CENSUS — register A1\n${lines.join("\n")}\n` +
      "  ⛔ NOT LOOKED AT: whether a closed set EXISTS at a site (ruled, not measured) · " +
      "daemon HTTP bodies · surfaces (.ts only) · a raiser in an unrecognised shape.\n" +
      "  A green means the counts are WHERE THEY WERE DECLARED, never that every qualifying site is covered.\n",
  );
  const pinned = Object.fromEntries(
    Object.entries(EXPECTED).map(([k, v]) => [k, { sites: v.sites, choices: v.choices }]),
  );
  expect(actual).toEqual(pinned);
});

test("arm 3 · the population spans all eight spells, and the ward knows the roster", () => {
  // A spell that leaves `EXPECTED` leaves every arm at once — the
  // `DECLARED_EMITTED_ROOTS` failure mode (D28), where an omission is not an
  // over-broad exemption but UNSEEING. Derived from the tree, like the build's
  // own predicate: `src/<spell>/backend/` exists ⇒ it must be pinned here.
  expect(Object.keys(EXPECTED).sort()).toEqual([...CENSUS.keys()].sort());
});
