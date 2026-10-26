// enforces: none in house-style — Cole's 2026-10-24 ruling that an unfinished spell stays out of the shipped plugin (docs/items/mind-mapper-out-of-the-plugin.md)
//
// UNRELEASED SPELLS WARD — a spell held out of the plugin stays out.
//
// Cole, 2026-10-24: mind-mapper stays out of the shipped plugin until its app
// is finished. An install copies the whole plugin source folder that
// `.claude-plugin/marketplace.json` names (`./plugins/spellbook`), with no
// exclude list, so "out of the plugin" means "not under that folder". The
// spell's deployed folder lives at `plugins/unreleased/skills/<spell>/`
// instead (`src/deployRoots.ts`), where it still builds, runs and tests.
//
// This ward pins the three ways that could quietly undo itself:
//   1. a copy left behind (or made) under the shipped root while the real one
//      sits in the holding root — the stale copy would ship;
//   2. a spell with no SKILL.md in the shipped root — undeclared means
//      unfinished, which is exactly the state mind-mapper shipped in for months;
//   3. a marketplace entry that points at the holding root.
//
// ⛔ WHAT THIS WARD CANNOT SEE. It reads the TREE, not an install. That an
// install receives what the marketplace source holds was measured once, by
// installing from a local marketplace into a scratch Claude config dir
// (docs/items/mind-mapper-out-of-the-plugin.md records the before and after);
// if Claude Code ever learns an include or exclude list, re-measure.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, SHIPPED_ROOT, spellsIn, UNRELEASED_ROOT } from "../src/deployRoots.ts";

/** Pure, so the calibration below drives the same code the assertions do. */
export function findings(
  shipped: string[],
  unreleased: string[],
  hasSkill: (s: string) => boolean,
) {
  return {
    inBothRoots: unreleased.filter((s) => shipped.includes(s)),
    shippedWithoutSkill: shipped.filter((s) => !hasSkill(s)),
  };
}

/**
 * Marketplace sources an install would copy the holding root FROM: the root
 * itself, anything inside it, or any ANCESTOR of it (`./plugins`, `.`), since
 * a source folder is copied whole. Pure, for the same reason as `findings`.
 */
export function sourcesReachingHoldingRoot(sources: string[]): string[] {
  const HOLD = "plugins/unreleased";
  return sources.filter((raw) => {
    const s = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (s === "" || s === ".") return true; // the repo root contains everything
    return s === HOLD || s.startsWith(`${HOLD}/`) || HOLD.startsWith(`${s}/`);
  });
}

const shipped = spellsIn(SHIPPED_ROOT);
const unreleased = spellsIn(UNRELEASED_ROOT);

describe("unreleased spells ward", () => {
  test("zero-guard: the shipped root holds spells, and the census is printed", () => {
    console.warn(
      `\n  UNRELEASED SPELLS WARD — shipped: ${shipped.join(" ")}\n` +
        `  held out of the plugin (plugins/unreleased/skills/): ${unreleased.join(" ") || "(none)"}\n`,
    );
    expect(shipped.length).toBeGreaterThan(0);
  });

  test("no spell is in both roots, and every shipped spell declares a SKILL.md", () => {
    expect(
      findings(shipped, unreleased, (s) => existsSync(join(SHIPPED_ROOT, s, "SKILL.md"))),
    ).toEqual({ inBothRoots: [], shippedWithoutSkill: [] });
  });

  test("no marketplace entry installs from the holding root, inside it, or above it", () => {
    const m = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin/marketplace.json"), "utf8"));
    const sources: string[] = (m.plugins ?? []).map((p: { source: unknown }) => String(p.source));
    expect(sources.length).toBeGreaterThan(0);
    expect(sourcesReachingHoldingRoot(sources)).toEqual([]);
    // And the holding root is not shaped like a plugin, so pointing a
    // marketplace at it by mistake would not produce an installable plugin.
    expect(existsSync(join(REPO_ROOT, "plugins/unreleased/.claude-plugin"))).toBe(false);
  });
});

describe("unreleased spells ward — calibration", () => {
  test("a copy in both roots is named", () => {
    expect(findings(["a", "mm"], ["mm"], () => true).inBothRoots).toEqual(["mm"]);
  });

  test("a marketplace source that is, holds, or sits above the holding root is named", () => {
    expect(
      sourcesReachingHoldingRoot([
        "./plugins/spellbook",
        "./plugins",
        "./plugins/",
        ".",
        "./",
        "./plugins/unreleased",
        "./plugins/unreleased/skills",
        "./plugins/unreleased-other",
      ]),
    ).toEqual([
      "./plugins",
      "./plugins/",
      ".",
      "./",
      "./plugins/unreleased",
      "./plugins/unreleased/skills",
    ]);
  });

  test("a shipped spell with no SKILL.md is named", () => {
    expect(findings(["a", "mm"], [], (s) => s !== "mm").shippedWithoutSkill).toEqual(["mm"]);
  });
});
