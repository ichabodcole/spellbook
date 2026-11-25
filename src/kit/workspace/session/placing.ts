/**
 * Placing a new thing on disk: a free name for it (`freeName`,
 * `freeImageName`), the refusal of a name already taken (`refuseExisting`),
 * and the tree taking in what landed (`adoptNew`). Tier 2 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core and `places`,
 * and the context's members still on the facade (`rescan`, `refreshListed`,
 * `relink`, the scan filter, `listedBundleHolding`) as hooks.
 */

import { extname, join, sep } from "node:path";
import { bundleTypeOf } from "../../lib/bundles.ts";
import { sidecarOf } from "../../lib/sidecar.ts";
import { entryForPath, type ScanGuard, type ScanSkip } from "../tree";
import { SessionError } from "./errors.ts";
import { entryAt, FREE_NAME_TRIES, fitName, randHex, tilde } from "./names.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";

export class Placing {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly hooks: {
      listedBundleHolding: (abs: string) => string | null;
      rescan: (entryId: string) => boolean;
      refreshListed: (abs: string) => void;
      scanSkip: (entryId: string, root: string) => ScanSkip | undefined;
      scanGuard: () => ScanGuard;
      relink: () => void;
    },
  ) {}

  /** After a file or folder landed at `abs`: re-read the set it is in, or give it an entry. */
  adoptNew(abs: string): void {
    const set = this.places.coveringEntry(abs);
    const listed = set ? null : this.hooks.listedBundleHolding(abs);
    // Every set whose root holds it, not only the first: a linked folder added
    // as a set of its own sits under the set holding its link, which shows it
    // only as a link's row, and the thing made is shown by the other one.
    if (set) {
      for (const e of this.core.m.context) {
        const holds = abs === e.root || abs.startsWith(e.root + sep);
        if (e.membership === "mirrored" && holds) this.hooks.rescan(e.id);
      }
    }
    // Made in a member folder of a bundle listed on its own: its row is read
    // again. An entry of its own would be the bundle a second time.
    else if (listed) this.hooks.refreshListed(listed);
    else {
      // Every write that lands here passed the backstop; a new entry still
      // takes the one set guard.
      this.places.mayBeASetOrDie(abs);
      const id = `c-${randHex(3)}`;
      this.core.m.context.push(
        entryForPath(abs, id, (root) => this.hooks.scanSkip(id, root), this.hooks.scanGuard()),
      );
    }
    this.hooks.relink();
  }

  /**
   * A name in `dir` that is free: `name`, else `stem N.ext` with N the first
   * free number from 2 (`Untitled 2.md`, filling a gap). A plain folder's
   * name has no extension; a bundle's keeps its own. Bounded: past
   * FREE_NAME_TRIES it is refused rather than counted further.
   */
  freeName(
    dir: string,
    name: string,
    isDir: boolean,
    taken: (abs: string) => boolean = (abs) => !!entryAt(abs),
  ): string {
    if (!taken(join(dir, name))) return name;
    const ext = isDir ? "" : (bundleTypeOf(name)?.extension ?? extname(name));
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let i = 2; i < 2 + FREE_NAME_TRIES; i++) {
      const n = fitName(stem, ` ${i}${ext}`);
      if (!taken(join(dir, n))) return n;
    }
    throw new SessionError(
      `no free name like "${fitName(stem, ` 2${ext}`)}" is left in ${tilde(dir)}`,
      409,
    );
  }

  /**
   * A free name for an incoming image: one with neither the image nor its
   * description sidecar (`<name>.md`) there, so a description left behind by
   * an image that went is never taken up by a new one under its old name.
   */
  freeImageName(dir: string, name: string): string {
    return this.freeName(dir, name, false, (abs) => !!entryAt(abs) || !!entryAt(sidecarOf(abs)));
  }

  refuseExisting(abs: string): void {
    if (entryAt(abs)) throw new SessionError(`${abs} already exists: nothing was overwritten`, 409);
  }
}
