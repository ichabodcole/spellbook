// enforces: honor-exit-code-contract
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
 * (the kit registry's unknown-flag rejection carries none where `choices` is
 * non-empty, on purpose: "pass one of these" is the whole next act).
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
  // +1 site on every tail but scriptorium's (fix/tail-rearm-without-plugin-path):
  // `tail --since` refuses a form it does not accept with the forms named
  // (`kit/wire/tailHandoff.ts`, `readSince`), where it used to misparse it. No
  // `choices`: an id is not a closed set; the message names the shapes.
  // 16/4 -> 12/1 (2026-09-26): astrolabe moved onto the kit registry, as
  // glamour did — its bare-invocation, parse, unknown-verb and root-flag raises
  // left for the kit. `join`'s unknown-project rejection (the board's ids) stays.
  // 12/1 -> 14/1 (2026-09-27, s5-8): `close` gained `cmd()`'s rejection raise
  // (applied:false WITH an error) and an `internal` raise for a daemon still
  // answering after the 3s teardown wait. Neither ranges over a closed set.
  // 14/1 -> 16/2 (2026-09-28, one-act-one-answer): a verb naming a project is
  // refused from the on-disk registry when no daemon is up, instead of starting
  // one to ask. The unknown-project raise carries the registry's ids (in hand);
  // `add`'s cold duplicate raise (the reducer's own message) has no closed set.
  // 16/2 -> 17/2 (2026-09-28, data-you-cant-get-back): an unreadable
  // registry.json is refused cold as `conflict` instead of read as the empty
  // board. No `choices`: no set is in hand — that is the whole refusal; the
  // hint names the two acts (fix it, or `open` to set it aside).
  astrolabe: { sites: 17, choices: 2, verbRoster: true, flagMap: true },
  // 33/2 -> 27/1 (2026-09-26): bounty moved onto the kit registry, as
  // glamour did — its parse, unknown-verb and missing-id raises left for the kit.
  // 27 -> 28 (2026-09-27): `update --stdin` refuses an empty stdin (s5-9).
  // 28 -> 29 (2026-09-27, #98): `tail` on a NAMED target (`--session`,
  // `--session-key`) that never resolves exits `not_found` after a grace. No
  // `choices`: a session id is not a closed set; the hint names the fix.
  // 29/1 -> 30/2 (2026-09-27, verifier on s5-9): `add`/`update` refuse a
  // `--status` outside the set with `choices` (one shared raise, `checkStatus`)
  // where the daemon used to drop it silently under `fields:["status"]`.
  // 30 -> 31 (2026-09-28, one act one answer): `init --stdin-tasks` over a
  // board that has tasks is the daemon's `conflict`, raised with a hint that
  // names `--replace` (a CLI flag, so the CLI's raise). No `choices`: the fix
  // is one flag, not a set to pick from.
  // 31 -> 32 (2026-09-28, one act one answer): `open --restore` of a snapshot
  // that does not exist is `not_found` before any daemon is spawned, where it
  // used to start an unrelated empty board at exit 0. No `choices`: the
  // snapshots are the host's, and the hint names `sessions` to list them.
  // 32 -> 33 (2026-09-28, data-you-cant-get-back follow-ups): `open` refuses as
  // `conflict` when the board's lock holder is a live pid whose liveness `ps`
  // cannot check. No `choices`: the hint names the two acts (fix `ps`, or
  // remove a lock whose pid is not this board's daemon).
  // 33 -> 34 (same follow-ups): `close` whose final snapshot write failed is a
  // `conflict` (the board was dumped to an `unsaved` file; the hint names the
  // restore). No `choices`.
  // 34 -> 35 (same follow-ups): a `close` (or any bounded `postCmd`) whose
  // daemon does not answer within the timeout is `internal`, naming the pid,
  // where it used to hang. No `choices`: the hint names resume or end the pid.
  bounty: { sites: 35, choices: 2, verbRoster: true, flagMap: true },
  // 8/2 -> 7/1 (2026-09-26): digestify's flag rejection moved onto the kit
  // registry, as glamour's did. `--theme`'s `choices` is the one left here.
  digestify: { sites: 7, choices: 1, verbRoster: false, flagMap: true },
  // 25 -> 26 on 2026-09-10, type-debt Phase 3c: `positional()` in cli.ts, a
  // named usage throw for a builder called without the positional arity
  // dispatch guarantees. No `choices` by A1's ruling — an id positional is not
  // an enumerated set — so `choices` stays 9. Impossible through the CLI.
  // ⚠ MOVED, NOT LOST (2026-09-26, the kit CLI registry): glamour, grapevine
  // and scriptorium dispatch through `src/kit/cli/registry.ts` now, so their
  // parse, root, unknown-verb, misplaced-flag and arity raises (7 sites each;
  // 6, 4 and 6 of them with `choices`) left their CLIs for the kit, which this
  // census does not walk. The rejections still carry `choices`: arm 2 drives
  // them through each spell's process, and the registry's own tests pin them.
  // glamour 27/9 -> 20/3, grapevine 59/5 -> 52/1: that move.
  glamour: { sites: 20, choices: 3, verbRoster: true, flagMap: true },
  grapevine: { sites: 52, choices: 1, verbRoster: true, flagMap: true },
  // imago 25/3 -> 14/2 (2026-09-26): the move onto the kit registry, as
  // glamour's — its parse, unknown-verb and per-verb arity raises left for the
  // kit. The enumerated `context <kind>` and `--link` rejections stay here.
  imago: { sites: 14, choices: 2, verbRoster: true, flagMap: true },
  // magpie 33/4 -> 26/1 (2026-09-26): the move onto the kit registry, as
  // imago's — its bare-invocation, unknown-verb and flag-scope raises (and the
  // arity `die`s the table now declares) left for the kit. The enumerated
  // `--alpha` rejection is the one `choices` left here.
  magpie: { sites: 26, choices: 1, verbRoster: true, flagMap: true },
  // mind-mapper 67/14 -> 34/2 (2026-09-26): the move onto the kit registry,
  // as glamour's. Its parse, root, unknown-verb, sub-command, misplaced-flag
  // and no-positional raises left for the kit, and so did the per-verb
  // `if (!id)` arity raises the declared positionals now enforce. The two left
  // are `activity <state>` and `open --project`'s known-project set.
  "mind-mapper": { sites: 34, choices: 2, verbRoster: true, flagMap: true },
  // scriptorium (2026-09-11) — the first spell SCAFFOLDED onto the build, so its
  // row is a design, not an archaeology: every enumerable usage rejection
  // carries `choices` from day one (A1 inherited, not converted into).
  // 26/8 -> 27/9 (verify pass, 2026-09-11): `open`/`add` validate every path
  // before a daemon exists (a non-document file names the accepted extensions
  // as `choices`), and `tail --since` refuses a non-integer.
  // 27/9 -> 30/10 (organizing slice, E24): `import <file>` refuses a missing
  // file (not_found) and a non-document (usage, the extensions as `choices`),
  // and `workspace` reports a daemon refusal on its `/state` read.
  // 30/10 -> 31/10 (E32): `find --since` refuses a non-date, so a typo cannot
  // silently widen a search — the same shape as `tail --since`'s refusal.
  // 31/10 -> 32/10 (E35): `meta-set` refuses a positional that is not
  // `key=value`, with the shape in the hint rather than a set of choices — the
  // keys are the document's own vocabulary, so there is no closed set to name.
  // 32/10 -> 33/10 (E36): `merge` refuses a hunk id the current diff does not
  // hold, naming the range it does have. No `choices`: the ids are positions in
  // a comparison that has already moved, so listing them would invite a retry
  // against numbers that are themselves stale — the hint says re-run `diff`.
  // 33/10 -> 34/10 (E45): `note` refuses without `--quote`, with the shape in
  // the hint rather than a set of choices — the quote is the document's own
  // text, so there is no closed set to name. (The daemon's own refusals —
  // a quote the active version does not contain, an empty body, a range
  // outside the text — are SessionErrors, which this census does not count.)
  // 34/10 -> 27/4 (2026-09-26): the move onto the kit registry, as glamour's.
  scriptorium: { sites: 27, choices: 4, verbRoster: true, flagMap: true },
};

/**
 * ⚠ ONE SPELL'S ROOT FLAG REJECTION IS BELOW ITS `choices` COUNT ON PURPOSE.
 * imago attaches the flag roster to a private `UsageError`'s `extra` and hands
 * it to `die` one frame later, so the literal `choices:` sits at the PARSER and
 * the site arm 3 counts is `die(e.message, "usage", e.extra)` — which has no
 * literal. Arm 2 is what proves it works, and this note is why arm 3's number
 * is not the whole story for it. (bounty had the same shape until it moved
 * onto the kit registry, 2026-09-26.)
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
  scriptorium: "scriptorium/scripts/cli.ts",
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
  scriptorium: ["state", "--acc-not-a-flag"],
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
    SCRIPTORIUM_HOME: dir,
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
  // astrolabe — a verb's own flag set, from the kit registry's row (2026-09-26:
  // per-verb sets; `state` takes no flags, so the drive moved to a verb that does).
  [
    "astrolabe",
    ["attention", "p1", "--acc-not-a-flag"],
    ["--as", "--clear", "--from", "--question"],
  ],
  // bounty — the patch-contributing flags, the set whose emptiness IS the refusal.
  [
    "bounty",
    ["update", "acc-no-such-task"],
    [
      "--status",
      "--title",
      "--notes",
      "--owner",
      "--tag",
      "--size",
      "--expect",
      "--stdin",
      "--clear-notes",
    ],
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
