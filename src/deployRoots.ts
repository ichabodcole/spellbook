// WHERE A SPELL'S DEPLOYED FOLDER LIVES — launchers (`scripts/`), the built
// `dist/`, and the acc files. Every build, check and ward that needs that folder
// asks here, so the answer is spelled once.
//
// There are two roots, and the difference between them is what ships:
//
//   plugins/spellbook/skills/<spell>   SHIPPED. `.claude-plugin/marketplace.json`
//                                      names `./plugins/spellbook` as the plugin
//                                      source, and an install copies that whole
//                                      folder — every file under it reaches every
//                                      adopter. There is no exclude list.
//   plugins/unreleased/skills/<spell>  NOT SHIPPED. No marketplace names it. A
//                                      spell whose app is unfinished deploys here:
//                                      it still builds, runs and tests for
//                                      development, and nothing of it installs.
//
// Both roots sit at the same depth (`plugins/<x>/skills/<spell>/`) ON PURPOSE:
// the built `dist/` resolves the surface source and the dev cwd by a fixed
// number of `..` (see the daemon sources' `SURFACE_CWD` and dev-mode import),
// so a spell moves between the roots with `git mv` alone and no path edit.
//
// Membership is read off the tree, not kept as a list: a spell is unreleased
// exactly when its folder is under the unreleased root. To release one, `git mv`
// it back — `plugins/unreleased/README.md` has the steps.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..");

/** The shipped plugin's skills folder — what an install receives. */
export const SHIPPED_ROOT = join(REPO_ROOT, "plugins", "spellbook", "skills");

/** Deployed folders for spells held out of the plugin until they're finished. */
export const UNRELEASED_ROOT = join(REPO_ROOT, "plugins", "unreleased", "skills");

/** Both roots, shipped first. */
export const DEPLOY_ROOTS = [SHIPPED_ROOT, UNRELEASED_ROOT] as const;

/** Is this spell's deployed folder under the unreleased root? */
export const isUnreleased = (spell: string, root: string = REPO_ROOT): boolean =>
  existsSync(join(root, "plugins", "unreleased", "skills", spell));

/**
 * The deployed folder for a spell: the unreleased root if the spell is there,
 * otherwise the shipped root (also for a spell that has no folder yet, which is
 * where a new spell's launcher belongs). `root` lets a ward point this at a
 * scratch repo.
 */
export function deployDirFor(spell: string, root: string = REPO_ROOT): string {
  return isUnreleased(spell, root)
    ? join(root, "plugins", "unreleased", "skills", spell)
    : join(root, "plugins", "spellbook", "skills", spell);
}

/** Spell folders directly under one root, sorted (files such as README.md are
 *  not spells). An absent root holds none. */
export function spellsIn(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Every deployed spell, across BOTH roots, sorted. This is the population a
 * ward walks when its rule is about the spell and not about what ships: a ward
 * that read the shipped root alone would lose an unreleased spell and stay
 * green, and a shrunk population is not a red cell.
 */
export function deployedSpells(root: string = REPO_ROOT): string[] {
  return [
    ...spellsIn(join(root, "plugins", "spellbook", "skills")),
    ...spellsIn(join(root, "plugins", "unreleased", "skills")),
  ].sort();
}

/** A deployed-folder-relative path (`<spell>/scripts/cli.ts`) made absolute
 *  under whichever root holds that spell. */
export function deployedPath(rel: string, root: string = REPO_ROOT): string {
  const [spell = "", ...rest] = rel.split("/");
  return join(deployDirFor(spell, root), ...rest);
}
