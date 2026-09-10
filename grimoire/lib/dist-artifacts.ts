/**
 * The shared enumerator for **what a spell's emitted `dist/` actually holds** —
 * split into the SURFACE's own graph and the BACKEND artifacts a launcher
 * spawns.
 *
 * Extracted from `launcher-pairing-ward.test.ts` (D43's follow-through) because
 * a SECOND instrument needed the same split and reached for the cheap version
 * instead. `spawn-path-ward.test.ts` carried
 *
 *     const isBackendArtifact = (abs) =>
 *       abs.endsWith("/cli.js") || abs.endsWith("/server.js");
 *
 * — the exact hard-coding D43 removed from `src/build.ts`, surviving one
 * instrument over. It is correct today and correct for the wrong reason: the
 * derived entry set happens to be `cli` + `server` for all four built spells.
 * It goes **silently blind** on bounty's `join.js`, digestify's `review.js` and
 * grapevine's `daemon.js` the day those land — and a spawn-path ward that
 * cannot see a backend artifact reports no coverage row for it, which is D42's
 * "not looked at, spelled the same way as nothing to find".
 *
 * ⛔ THE SPLIT IS DERIVED FROM `index.html`, NOT FROM THE NAMES, AND THAT IS
 * D36's rule applied to this population. The obvious split is "`cli.js` and
 * `server.js` are the backend" — the hard-coding above, which would make every
 * instrument built on it blind to exactly the entries D43 exists to allow. The
 * next-most-obvious is "a hashed name is a surface chunk", which is a name test
 * wearing a behaviour costume. So the surface set is the REFERENCE CLOSURE from
 * the emitted `index.html`: whatever the served page actually pulls in,
 * transitively. Everything else in `dist/` is something only a launcher can
 * reach.
 *
 * ⛔ D42 GOVERNS THE RETURN SHAPE. `surface`/`backend` are `null` — never `[]`
 * — when there was nothing to look at, so a caller cannot spell "this spell has
 * no backend artifacts" and "this spell was never examined" the same way. The
 * two absences are different facts and `present` says which:
 *
 *   - no `dist/` at all (nothing built) → `present: false`, both sets `null`;
 *   - a `dist/` with no `index.html` (a backend-only spell) → LOOKED AT: the
 *     empty surface closure is the right answer, every `.js` is backend.
 *
 * ⚠ THE DISK, NOT THE INDEX (D42, third instance). All four remaining ports
 * FIRST-EMIT their backend artifacts, so on the commit that ports them the
 * artifact is on disk and not yet in the index. An index-derived population
 * would name the spell and produce no row for it. Staging is
 * `scripts/dist-check.ts`'s question, not this module's.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Where a spell's build emits — the same expression `src/build.ts` uses. The
 *  `root` parameter exists so a calibration cell can drive this against a
 *  throwaway tree it chose, rather than proving only that it can read this one. */
export const distDirFor = (spell: string, root: string = REPO_ROOT): string =>
  join(root, "plugins", "spellbook", "skills", spell, "dist");

/** `surface`/`backend` are basenames within `dist/`. `null` means NOT LOOKED
 *  AT — see the D42 note in the module header. */
export type DistClassification = {
  present: boolean;
  hasIndex: boolean;
  surface: string[] | null;
  backend: string[] | null;
};

export function classifyDist(spell: string, root: string = REPO_ROOT): DistClassification {
  const dir = distDirFor(spell, root);
  if (!existsSync(dir)) return { present: false, hasIndex: false, surface: null, backend: null };
  const all = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const js = all.filter((f) => f.endsWith(".js")).sort();
  const index = join(dir, "index.html");
  if (!existsSync(index)) return { present: true, hasIndex: false, surface: [], backend: js };

  // Transitive closure by NAME MENTION: start from index.html's text, and keep
  // pulling in any dist file whose name is mentioned by something already
  // reached. Substring search rather than a parser because the emitted forms
  // differ per asset kind (`href`, `src`, a bare `import`), and a parser for
  // three of them is a fourth thing to keep in step.
  const reached = new Set<string>();
  const frontier = [readFileSync(index, "utf8")];
  while (frontier.length > 0) {
    const text = frontier.pop() as string;
    for (const f of all) {
      if (reached.has(f) || f === "index.html") continue;
      if (!text.includes(f)) continue;
      reached.add(f);
      try {
        frontier.push(readFileSync(join(dir, f), "utf8"));
      } catch {
        /* a binary asset contributes no further references */
      }
    }
  }
  return {
    present: true,
    hasIndex: true,
    surface: js.filter((f) => reached.has(f)),
    backend: js.filter((f) => !reached.has(f)),
  };
}

/**
 * Is this ABSOLUTE emitted path one of its spell's backend artifacts?
 *
 * ⛔ `null` MEANS NOT LOOKED AT, and a caller that treats it as `false` has
 * re-committed the defect this module was extracted to end. The only way to get
 * `null` is a path whose own `dist/` does not exist — which cannot happen for a
 * path read OFF that directory, so a caller enumerating from the disk should
 * make it LOUD rather than skipping it.
 *
 * The spell is taken from the path itself (`…/skills/<spell>/dist/<file>`), so
 * a caller cannot pass a path and a spell that disagree.
 */
export function isBackendArtifact(abs: string, root: string = REPO_ROOT): boolean | null {
  const dir = dirname(abs);
  const spell = basename(dirname(dir));
  const { backend } = classifyDist(spell, root);
  if (backend === null) return null;
  return backend.includes(basename(abs));
}
