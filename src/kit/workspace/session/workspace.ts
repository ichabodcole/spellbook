/**
 * Our own workspace, and no home: pointing the workspace at a folder
 * (`setWorkspace`, refused for an app with no home workspace), the set it
 * overlaps (`workspaceOverlap`, `overlapToSay`, which owns `m.overlapSaid`),
 * the app's own folder (`setAppHome`) and the app's slot (`appSlot`,
 * `updateApp`). Tier 2 of the session parts
 * (docs/architecture/workspace-session.md); ours, not Story Studio's (they
 * keep these in `projectMeta`). It takes the core and `places`, and the
 * facade's `persist` as a hook, so a test that replaces `persist` on a
 * session still sees every write.
 */

import { accessSync, constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Overlap } from "../doctor";
import { noWorkspaceToSet } from "../noHome";
import { SessionError } from "./errors.ts";
import { tilde } from "./names.ts";
import { overlapOf, refuseWorkspaceInBundle, shownOverlap } from "./paths.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";

export class Workspace {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly hooks: { persist: () => void },
  ) {}

  /** Point the workspace at an existing folder (relative paths resolve against the daemon's cwd: callers send absolute ones). */
  setWorkspace(rawPath: string): { path: string; from: string } {
    if (!this.core.hasHome) {
      const r = noWorkspaceToSet(this.core.app);
      throw new SessionError(r.message, 400, undefined, r.hint);
    }
    const abs = this.places.notOwnPlaceOrDie(resolve(rawPath));
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      throw new SessionError(`no such folder: ${abs}`, 404);
    }
    if (!isDir) throw new SessionError(`the workspace must be a folder: ${abs}`, 400);
    // Said when it is set, not at the first write it would refuse.
    refuseWorkspaceInBundle(abs);
    try {
      accessSync(abs, constants.W_OK);
    } catch {
      throw new SessionError(`the workspace must be a folder you can write to: ${abs}`, 400);
    }
    const overlap = overlapOf(abs, this.core.m.context);
    if (overlap)
      throw new SessionError(
        `the workspace cannot be ${overlap.same ? "the folder of" : "inside"} the set ${overlap.label} (${tilde(overlap.root)}): a file there would belong to both. Choose a folder outside it, such as ${tilde(dirname(overlap.root))}, or remove ${overlap.label} from the context first`,
        409,
      );
    const from = this.core.workspace;
    this.core.m.workspace = abs;
    this.hooks.persist();
    return { path: abs, from };
  }

  /**
   * The set the workspace folder is, or is inside, or null. A session from
   * before the block (`kit-workspace-set-overlap`) can still hold one: it opens,
   * and the daemon says what to change.
   */
  workspaceOverlap(): Overlap | null {
    if (!this.core.hasHome) return null;
    return overlapOf(this.core.workspace, this.core.m.context);
  }

  /**
   * The overlap to say at startup, with its paths as the app shows them, or
   * null: said once per session, and again only when it changed (another
   * workspace or another set). A session that no longer overlaps forgets it.
   */
  overlapToSay(): (Overlap & { workspace: string }) | null {
    const o = this.workspaceOverlap();
    const key = o ? `${this.core.workspace}\n${o.root}` : undefined;
    if (key === this.core.m.overlapSaid) return null;
    if (key === undefined) delete this.core.m.overlapSaid;
    else this.core.m.overlapSaid = key;
    this.hooks.persist();
    return o ? shownOverlap(o, this.core.workspace) : null;
  }

  /** The app's slot data, without its `version` (a copy: change it through `updateApp`). */
  get appSlot(): Record<string, unknown> {
    const { version: _version, ...data } = this.core.m.app;
    return structuredClone(data);
  }

  /** Change the app's slot and persist. The slot is the app's; the `version` key is not. */
  updateApp(change: (slot: Record<string, unknown>) => void): void {
    const slot = this.appSlot;
    change(slot);
    if ("version" in slot) throw new Error("`version` is reserved in the app slot");
    this.core.m.app = { ...slot, version: this.core.app.slot.version };
    this.hooks.persist();
  }

  /** Name the app's own folder (`appHome`): guarded as the sessions root is. */
  setAppHome(appHome: string | undefined): void {
    this.core.appHome = appHome === undefined ? undefined : resolve(appHome);
  }
}
