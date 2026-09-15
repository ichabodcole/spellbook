// ROSTER DRIFT WARD — mechanises `ward`'s "quick drift check", which existed only
// as a human-invoked checklist and therefore never ran. A spell shipped in v2.2.0
// declared in NONE of the four listings; the check that would have caught it was
// one line of prose (spellbook comms #989).
//
// ⛔ WHAT THIS WARD CANNOT SEE — read this before citing a green from it.
//   1. NAMES ONLY. It asserts a spell's name appears in each listing. It does NOT
//      check the row is CORRECT (kind, description, status). `magpie | cantrip`
//      passes.
//   2. ASYMMETRIC ON marketplace.json. `tags` deliberately mixes spell names with
//      non-spell tags ("bun", "spells"), so a leftover tag for a REMOVED spell is
//      indistinguishable from a legitimate tag. folder->tags is checked;
//      tags->folder is NOT. The three markdown tables are checked BOTH ways.
//   3. NOT A CONTRACT CHECK. A spell satisfies this ward with no SKILL.md at all
//      — the neighbouring defect found the same night. Different rule, different
//      ward.
//   4. TABLE-SCOPED BY HEADER, so a spell name in prose does not count as a
//      listing. A reworded header yields zero rows — guarded, because a sweep
//      that fails to run reports the same thing as a sweep that found nothing.
//   5. PINNED DEBT: this ward is GREEN while a known-undeclared spell exists. The
//      pinned set is printed on every run (see PINNED) — a cell that pins
//      violations and reports a bare green is an instrument reporting a green it
//      did not earn.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ⛔ PINNED — spell folders deliberately excluded from the assertions below, and
// PRINTED on every run. The `pin is still required` cell fails when a pinned
// spell becomes declared everywhere, so a pin cannot outlive its reason.
//
// ⚠ THE REASON HERE IS "DELIBERATE WIP", NOT "DEBT" — corrected the day after
// this landed, and the correction is the point. The pin originally read as debt
// awaiting repair. **Cole then RULED the undeclared state INTENTIONAL AND
// CORRECT** (`47238d7`): mind-mapper is unfinished, it is undeclared BECAUSE it
// is unfinished, and there is nothing to repair in the four listings, the trigger
// registry, or the missing `SKILL.md`. A spell that has not coalesced should not
// claim a roster slot.
//
// The pin is MECHANICALLY unchanged — the folder exists and is in no listing, so
// asserting it would fail either way. What changed is what a reader should DO
// about it: nothing. That distinction is exactly what this ward's own "state the
// reason" discipline exists to keep honest, and a pin whose stated reason has
// been overturned is a false reassurance wearing a measurement's clothes.
//
// FULL CONTEXT, and deliberately a FILE rather than a board card: cards do not
// survive teardown and a committed test read cold cannot resolve an id that no
// longer exists. (This comment previously cited board card `s5-9`, which was
// later minted for an unrelated bounty defect — a wrong id carrying the authority
// of a green cell.)
//   docs/backlog/2026-08-10-mind-mapper-is-undeclared-and-shipped.md
//
// Left OPEN by that ruling, and NOT this ward's business: whether the built
// artifact belongs in the published package while the spell is WIP.
const PINNED: Record<string, string> = {
  "mind-mapper": "WIP by Cole's ruling (47238d7) — correctly undeclared, nothing to repair",
};

function repoRoot(): string {
  // Anchored on the INVOCATION root, not this file's path: the ward's subject is
  // "the repo this suite runs against", and it makes an out-of-tree draft and the
  // landed file byte-identical — a path that changes between drafting and landing
  // is a second, untested file.
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".claude-plugin/marketplace.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found (no .claude-plugin/marketplace.json above cwd)");
}

const REPO = repoRoot();

function folderRoster(): string[] {
  return readdirSync(join(REPO, "plugins/spellbook/skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** First-column code-spans of the table whose header contains every `headerCells`
 *  entry. Structural: anchored on the table, never on a spell name. */
export function tableColumn(md: string, headerCells: string[]): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("|") && headerCells.every((h) => l.includes(h)),
  );
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    // `?.` is safe HERE and only here: both branches (absent row, non-table row)
    // mean "stop", so collapsing null/undefined loses nothing. It is on the
    // outcome contract's erasing list for VALUE positions — see the note below.
    if (!line?.startsWith("|")) break;
    const m = (line.split("|")[1]?.trim() ?? "").match(/^`([^`]+)`$/);
    if (m?.[1]) out.push(m[1]);
  }
  return out.sort();
}

const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const LISTINGS = [
  {
    name: "README.md spell table",
    both: true,
    entries: () => tableColumn(read("README.md"), ["Spell", "Kind"]),
  },
  {
    name: "plugins/spellbook/skills/README.md spell table",
    both: true,
    entries: () => tableColumn(read("plugins/spellbook/skills/README.md"), ["Spell", "Kind"]),
  },
  {
    name: "grimoire/trigger-registry.md reserved table",
    both: true,
    entries: () => tableColumn(read("grimoire/trigger-registry.md"), ["Name", "Kind", "Status"]),
  },
  {
    name: ".claude-plugin/marketplace.json tags",
    both: false, // blind spot 2
    entries: () => {
      const m = JSON.parse(read(".claude-plugin/marketplace.json"));
      const tags = m.plugins?.[0]?.tags ?? m.tags;
      if (!Array.isArray(tags)) throw new Error("marketplace tags is not an array");
      return [...tags].sort();
    },
  },
];

const asserted = () => folderRoster().filter((s) => !(s in PINNED));

describe("roster drift ward", () => {
  test("STATES WHAT IT IS NOT ASSERTING (clause i)", () => {
    const all = folderRoster();
    const pinned = all.filter((s) => s in PINNED);
    // A green from this ward means "the ASSERTED set is consistent" — never "the
    // roster is consistent". The difference is printed, not left in the source.
    console.warn(
      [
        "",
        "  ROSTER DRIFT WARD — asserted over " +
          `${asserted().length} of ${all.length} spell folders.`,
        ...pinned.map((s) => `  ⛔ NOT ASSERTED: ${s} — ${PINNED[s]}`),
        "  Blind by construction: names only · marketplace tags one-way · no SKILL.md check.",
        "",
      ].join("\n"),
    );
    expect(all.length).toBeGreaterThan(0); // zero-guard, operand 1
  });

  test("every PINNED spell is still undeclared — the pin cannot outlive its reason", () => {
    // Widen the guard while it is green: when a pinned spell becomes declared
    // everywhere, this fails and the pin must be deleted. Without this, the pin is
    // a permanent silent exemption — the class this project exists to close.
    const stale = Object.keys(PINNED).filter((s) =>
      LISTINGS.every((l) => new Set(l.entries()).has(s)),
    );
    expect({ pinsNowFullyDeclared: stale }).toEqual({ pinsNowFullyDeclared: [] });
  });

  for (const listing of LISTINGS) {
    test(`${listing.name} — parses to a non-empty set`, () => {
      // Zero-guard, operand 2. A two-sided diff has TWO denominators, and guarding
      // one feels like guarding the check.
      expect(listing.entries().length).toBeGreaterThan(0);
    });

    test(`${listing.name} — every asserted spell folder is listed`, () => {
      const listed = new Set(listing.entries());
      const missing = asserted().filter((s) => !listed.has(s));
      expect({ listing: listing.name, missing }).toEqual({ listing: listing.name, missing: [] });
    });

    if (listing.both) {
      test(`${listing.name} — every listed name has a folder`, () => {
        const folders = new Set(folderRoster());
        const orphaned = listing.entries().filter((s) => !folders.has(s));
        expect({ listing: listing.name, orphaned }).toEqual({
          listing: listing.name,
          orphaned: [],
        });
      });
    }
  }
});

// ── CALIBRATION ──────────────────────────────────────────────────────────────
// Anchored on APPLIED MUTATIONS of synthetic input, never on a live defect: a
// live-defect anchor goes green the day someone fixes it and the calibration is
// lost silently. These stay red-for-the-right-reason after mind-mapper is
// resolved either way.
describe("roster drift ward — calibration", () => {
  const TABLE = [
    "| Spell       | Kind        | What it conjures |",
    "| ----------- | ----------- | ---------------- |",
    "| `alpha`     | cantrip     | a                |",
    "| `beta`      | conjuration | b                |",
    "",
    "prose mentioning `gamma`, which is NOT a listing",
  ].join("\n");

  test("reads exactly the table rows", () => {
    expect(tableColumn(TABLE, ["Spell", "Kind"])).toEqual(["alpha", "beta"]);
  });

  test("MUTATION — a removed row is detected", () => {
    const mutated = TABLE.replace("| `beta`      | conjuration | b                |\n", "");
    expect(tableColumn(mutated, ["Spell", "Kind"])).toEqual(["alpha"]);
  });

  test("MUTATION — a name in PROSE is not counted as a listing", () => {
    expect(tableColumn(TABLE, ["Spell", "Kind"])).not.toContain("gamma");
  });

  test("MUTATION — a reworded header yields ZERO, which the zero-guard must catch", () => {
    const mutated = TABLE.replace("| Spell       | Kind ", "| Charm       | Sort ");
    // The silent-filter failure this ward's zero-guard exists for: without it the
    // reworded table reports every spell missing, or (reversed) nothing orphaned.
    expect(tableColumn(mutated, ["Spell", "Kind"])).toEqual([]);
  });
});
