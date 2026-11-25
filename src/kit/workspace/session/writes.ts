/**
 * The write ledger: what the daemon itself wrote, so the watcher can tell its
 * own writes from anyone else's. Tier 1 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core (`state`) and
 * `places`, and imports only tier 0 and those two.
 *
 * ⛔ `owned` is private to this part. A write through `writeOwned` (or
 * `writeVersion`) is remembered before it lands; any other write the session
 * makes is remembered with `own(path, text)` before it lands, and a file the
 * session removes is `disown`ed. A write that is not shows only as the watcher
 * announcing the daemon's own write as foreign.
 */

import { dirname } from "node:path";
import type { Disk } from "../disk";
import { contentHash } from "./names.ts";
import type { Places } from "./places.ts";
import { refuseWrite, type State } from "./state.ts";

export class Writes {
  constructor(
    private readonly core: State,
    private readonly places: Places,
  ) {}

  /** path to hash of the daemon's last write to it. */
  private owned = new Map<string, string>();

  /**
   * A bundle folder the session itself just wrote whole (made, copied,
   * renamed, retitled), to when that is no longer news: the watcher's echo
   * of the session's own act is not reported as a change to the bundle.
   */
  private ownBundles = new Map<string, number>();

  /** A version file written: only inside the session's own `docs/` (`ownFileOrDie`). */
  writeVersion(path: string, text: string): void {
    this.writeOwned(this.places.ownFileOrDie(path), text, this.core.own);
  }

  /** A write the watcher will know as the daemon's own: a version (`this.own`) or an original (`this.world`). */
  writeOwned(path: string, text: string, disk: Disk): void {
    // Checked before anything: a refused write leaves no hash behind.
    const why = disk.refusal(path);
    if (why !== null) throw refuseWrite(why);
    disk.mkdir(dirname(path), { recursive: true });
    // Remember before writing: the watcher's event can arrive before this
    // function returns, and it must find the hash already there.
    this.owned.set(path, contentHash(text));
    disk.writeFile(path, text);
  }

  /** True iff `text` at `path` is exactly what the daemon last wrote there. */
  isOwnWrite(path: string, text: string): boolean {
    return this.owned.get(path) === contentHash(text);
  }

  /** How long the watcher's echo of the session's own write to a bundle is not news. */
  static readonly OWN_BUNDLE_ECHO_MS = 2000;

  /** The session itself just wrote the bundle at `abs` whole. */
  wroteBundle(abs: string): void {
    this.ownBundles.set(abs, Date.now() + Writes.OWN_BUNDLE_ECHO_MS);
  }

  /** Remember a write the session makes other than through `writeOwned`, before it lands. */
  own(path: string, text: string): void {
    this.owned.set(path, contentHash(text));
  }

  /** Forget a file the session removed. */
  disown(path: string): void {
    this.owned.delete(path);
  }

  /**
   * Whether a change inside `bundle` is the watcher's echo of the session's
   * own write of it (`wroteBundle`), still within `OWN_BUNDLE_ECHO_MS`. Once
   * it is not, the bundle is forgotten.
   */
  isOwnBundleEcho(bundle: string): boolean {
    if ((this.ownBundles.get(bundle) ?? 0) > Date.now()) return true;
    this.ownBundles.delete(bundle);
    return false;
  }
}
