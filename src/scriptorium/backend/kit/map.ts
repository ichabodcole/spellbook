/**
 * The map's one ask (`scriptorium.map`): a set's link graph and its documents'
 * frontmatter, read in the same handler, so the map draws one moment.
 *
 * ⛔ WHY NOT THE PAGE'S OWN `docMeta`. The surface holds `appState.docMeta` from
 * the last state push, and a change on disk to a document the session does not
 * hold sends no push (only `context.changed`, a cue that carries nothing). A
 * map that joined the page's copy with a fresh `link.graph` drew a node's new
 * status beside its old stale mark and tags (found by the map's verifier with
 * `meta-set status=deprecated`). Here both are read from disk now.
 *
 * The graph is the kit's (`session.linkGraph`, `within` the set's root: the
 * same answer `link.graph` gives); the frontmatter is `docMeta`'s, cut to the
 * graph's documents. Read-only.
 */

import type { VerbHandler } from "../../../kit/workspace/server";
import { SessionError } from "../../../kit/workspace/session";
import type { DocSummary } from "./frontmatter";
import { docMeta } from "./wiki";

export const mapVerbs: Record<string, VerbHandler> = {
  "scriptorium.map": (ctx, args, call) => {
    const within = args.within;
    if (typeof within !== "string" || within === "")
      throw new SessionError("map needs within: the set's root, absolute", 400);
    const graph = ctx.session.linkGraph({ within });
    const all = docMeta(ctx.session).docMeta;
    const meta: Record<string, DocSummary> = {};
    for (const n of graph.nodes) {
      const m = all[n.path];
      if (m) meta[n.path] = m;
    }
    const out = { within, graph, docMeta: meta };
    call.reply({ op: "scriptorium.map", ...out });
    return out;
  },
};
