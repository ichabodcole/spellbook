/**
 * Placing a new thing on disk: a free name for it (`freeName`,
 * `freeImageName`), the refusal of a name already taken (`refuseExisting`),
 * and the tree taking in what landed (`adoptNew`). Tier 2 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core, `places` and
 * the `context` (`rescan`, `refreshListed`, `relink`, the scan filter,
 * `listedBundleHolding`), tier 2, one way.
 */

import { extname, join, sep } from "node:path";
import { bundleTypeOf } from "../../lib/bundles.ts";
import { sidecarOf } from "../../lib/sidecar.ts";
import { entryForPath } from "../tree";
import type { Context } from "./context.ts";
import { SessionError } from "./errors.ts";
import { entryAt, FREE_NAME_TRIES, fitName, randHex, tilde } from "./names.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";

export class Placing {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly context: Context,
  ) {}

  /** After a file or folder landed at `abs`: re-read the set it is in, or give it an entry. */
  adoptNew(abs: string): void {
    const set = this.places.coveringEntry(abs);
    const listed = set ? null : this.context.listedBundleHolding(abs);
    // Every set whose root holds it, not only the first: a linked folder added
    // as a set of its own sits under the set holding its link, which shows it
    // only as a link's row, and the thing made is shown by the other one.
    if (set) {
      for (const e of this.core.m.context) {
        const holds = abs === e.root || abs.startsWith(e.root + sep);
        if (e.membership === "mirrored" && holds) this.context.rescan(e.id);
      }
    }
    // Made in a member folder of a bundle listed on its own: its row is read
    // again. An entry of its own would be the bundle a second time.
    else if (listed) this.context.refreshListed(listed);
    else {
      // Every write that lands here passed the backstop; a new entry still
      // takes the one set guard.
      this.places.mayBeASetOrDie(abs);
      const id = `c-${randHex(3)}`;
      this.core.m.context.push(
        entryForPath(abs, id, (root) => this.context.scanSkip(id, root), this.context.scanGuard()),
      );
    }
    this.context.relink();
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
