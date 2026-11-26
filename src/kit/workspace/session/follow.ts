/**
 * Following a move: the model brought along after something moved on disk
 * (`followMove`), and the moves this daemon made (`moves`), which the link
 * check reads to say where a broken link's target went (`movedFrom`,
 * `movedTarget`). Tier 3 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core, `places`, the
 * `viewer` and the `context` (`rescan`, `refreshListedContents`, `relink`),
 * and as a hook `linkResolve.resolveFrom` (tier 4), which `movedTarget` asks
 * whether a moved target lands.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { bundleTypeOf } from "../../lib/bundles.ts";
import { splitTarget } from "../../lib/linkTarget.ts";
import { type LinkKind, type LinkOrigin, type Resolution, retarget } from "../links";
import type { ContextEntry } from "../protocol";
import { bundleNode, docNode, listedFile } from "../tree";
import type { Context } from "./context.ts";
import { MOVES_KEPT } from "./facts.ts";
import { realOr } from "./paths.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";
import type { ContextIndex } from "./types.ts";
import type { Viewer } from "./viewer.ts";

export class Follow {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly viewer: Viewer,
    private readonly context: Context,
    private readonly hooks: {
      resolveFrom: (
        target: string,
        src: string | null,
        entry: ContextEntry | undefined,
        origin: LinkOrigin,
        index: ContextIndex,
        kind?: LinkKind,
      ) => Resolution;
    },
  ) {}

  /**
   * Every move and rename this daemon made (`followMove`), oldest first, an
   * undo's way back included: what the link check's `proposed` reads to say
   * where a proposal's old target went. Memory only, so a restart forgets it
   * and a proposal's broken link is then reported with no `suggest`.
   */
  private moves: [from: string, to: string][] = [];

  /**
   * After something moved on disk from `from` to `to`, bring the model with it:
   * opened documents keep their versions under the new path, entries rooted at
   * or holding the moved thing follow it, and every mirror is re-read. An entry
   * that now sits inside another set is dropped: the set shows it already.
   */
  followMove(from: string, to: string): void {
    // Kept for the link check's `proposed`: where a proposal's old target went.
    this.moves.push([from, to]);
    if (this.moves.length > MOVES_KEPT) this.moves.splice(0, this.moves.length - MOVES_KEPT);
    const moved = (p: string): string | null =>
      p === from ? to : p.startsWith(from + sep) ? to + p.slice(from.length) : null;
    for (const d of this.core.m.docs) {
      const now = moved(d.original);
      if (now) {
        d.original = now;
        d.name = basename(now);
      }
    }
    // The open image follows a rename or a move, as an open document does.
    this.viewer.followMove(moved);
    // A converted image's remembered name follows it; one left by a file that
    // was where the moved thing now is goes.
    if (this.core.m.importedAs) {
      const names: Record<string, string> = {};
      for (const [p, n] of Object.entries(this.core.m.importedAs)) {
        const now = moved(p);
        if (now) names[now] = n;
        else if (p !== to && !p.startsWith(to + sep)) names[p] = n;
      }
      this.core.m.importedAs = names;
    }
    const drop = new Set<string>();
    for (const e of this.core.m.context) {
      if (e.membership === "listed") {
        const only = listedFile(e);
        if (!only) continue;
        const now = moved(only.abs);
        if (!now) continue;
        if (this.places.coveringEntry(now, e.id)) drop.add(e.id);
        else {
          e.root = dirname(now);
          e.realRoot = realOr(e.root);
          e.label = basename(now);
          const bundle = only.kind === "bundle" ? bundleTypeOf(now) : null;
          e.nodes = [
            only.kind === "image"
              ? { kind: "image", rel: basename(now) }
              : bundle
                ? bundleNode(basename(now), now, bundle)
                : docNode(basename(now), now),
          ];
        }
      } else {
        const now = moved(e.root);
        if (!now) continue;
        if (this.places.coveringEntry(now, e.id)) drop.add(e.id);
        else {
          e.root = now;
          e.realRoot = realOr(now);
          e.label = basename(now) || now;
        }
      }
    }
    this.core.m.context = this.core.m.context.filter((e) => !drop.has(e.id));
    for (const e of this.core.m.context) if (e.membership === "mirrored") this.context.rescan(e.id);
    this.context.refreshListedContents();
    this.context.relink();
  }

  /** Where `path` is now, after the moves this daemon made, in order. */
  private movedTo(path: string): string {
    let p = path;
    for (const [from, to] of this.moves)
      if (p === from) p = to;
      else if (p.startsWith(from + sep)) p = to + p.slice(from.length);
    return p;
  }

  /** Where `path` was before the moves this daemon made: `movedTo` run back. */
  movedFrom(path: string): string {
    let p = path;
    for (let i = this.moves.length - 1; i >= 0; i--) {
      const [from, to] = this.moves[i] as [string, string];
      if (p === to) p = from;
      else if (p.startsWith(to + sep)) p = from + p.slice(to.length);
    }
    return p;
  }

  /**
   * A broken link's target as a move left it: each place the link was looked
   * for (`tried`, and the same places from where its document was, `wasAt`),
   * followed through the moves this daemon made; the first that moved (or
   * whose document did) and lands, rewritten from where the document is now
   * as relink writes it. Undefined when no move explains it: no guess.
   */
  movedTarget(
    raw: string,
    src: string,
    wasAt: string,
    tried: readonly string[],
    entry: ContextEntry | undefined,
    index: ContextIndex,
  ): string | undefined {
    if (this.moves.length === 0) return undefined;
    // Every place in `tried` is missing, so one that exists once followed
    // through the moves is one a move explains. From where the document was,
    // the same places (a relative link only) explain a move of the document.
    const looked = [...tried];
    if (wasAt !== src && !raw.startsWith("/"))
      for (const t of tried) looked.push(join(dirname(wasAt), relative(dirname(src), t)));
    for (const at of looked) {
      const now = this.movedTo(at);
      if (!existsSync(now)) continue;
      const written = retarget(raw, src, now, entry?.root ?? null);
      // ⛔ Offered only when it is sure to land, as relink's own offer is,
      // and lands as what it named: a link to a file never lands on a folder
      // (a file moved away and a folder made in its place).
      const r = this.hooks.resolveFrom(written, src, entry, "document", index, "markdown");
      const folderLink = splitTarget(raw).path.endsWith("/");
      if (r.state !== "missing" && (folderLink || r.state !== "folder")) return written;
    }
    return undefined;
  }
}
