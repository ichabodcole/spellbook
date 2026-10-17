/**
 * Scriptorium's part of the kit's link layer (kit-link-edges-slot): its
 * frontmatter references as edges of kind `frontmatter`, and its wiki forms as
 * a resolver tried after the kit's.
 *
 * - **Edges.** `fieldRefs` (`../links.ts`) reads references out of any
 *   frontmatter key by their shape (`related`, `supersedes`,
 *   `sources[].resource`, …), exactly as the shipped `buildGraph` does. Each is
 *   one edge, its key the frontmatter key that carries it. The shipped
 *   `backlinks` calls them `related`, apart from the body `links`; on the kit
 *   path they are `edges`, apart from `backlinks`.
 * - **Wiki forms.** What the shipped `resolveTarget` resolves that the kit's
 *   does not (the links differential's `wikiForms`): a `type/slug` key, by the
 *   document's frontmatter `type` and its file name; a bare name, by file name;
 *   and an unanchored path from the git working tree the set sits in, a third
 *   place after the document's folder and the set's root. Documents are looked
 *   for in the set the link is written in, as the shipped resolver looks in its
 *   bundle.
 *
 * Daemon-side only: imported by `./server.ts`, never by `./app.ts` (which the
 * CLI bundle carries).
 */

import { existsSync } from "node:fs";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
import type {
  AppEdge,
  AppResolveInput,
  LinkSlot,
  ResolvableDocument,
} from "../../../kit/workspace/linkEdges";
import { fieldRefs } from "../links";

/** The edge kind Scriptorium's frontmatter references take. */
export const FRONTMATTER_EDGE = "frontmatter";

/** A document's frontmatter references, as edges. */
export function frontmatterEdges(frontmatter: Record<string, unknown> | null): AppEdge[] {
  if (frontmatter === null) return [];
  return fieldRefs(frontmatter).map((r) => ({
    kind: FRONTMATTER_EDGE,
    target: r.value,
    key: r.key,
  }));
}

const stem = (p: string) => basename(p, extname(p));

/** The git working tree `dir` is in, or null: a `.git` entry, file or folder (a worktree has a file). */
function gitRootOf(dir: string): string | null {
  let at = dir;
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * The resolver for Scriptorium's wiki forms, with what it learns kept per
 * answer: the documents by file name (keyed by the kit's array, which is the
 * same for every target in one answer) and each set's repo root.
 */
export function wikiFormsResolver(
  repoRoot: (dir: string) => string | null = gitRootOf,
): NonNullable<LinkSlot["resolve"]> {
  const byStem = new WeakMap<readonly ResolvableDocument[], Map<string, ResolvableDocument[]>>();
  const roots = new Map<string, string | null>();
  const named = (docs: readonly ResolvableDocument[]) => {
    let m = byStem.get(docs);
    if (!m) {
      m = new Map();
      for (const d of docs) {
        const k = stem(d.path);
        const list = m.get(k);
        if (list) list.push(d);
        else m.set(k, [d]);
      }
      byStem.set(docs, m);
    }
    return m;
  };
  return ({ target, root, documents }: AppResolveInput) => {
    const folderish = target.length > 1 && target.endsWith("/");
    const anchored = target.startsWith("/") || target.startsWith("./") || target.startsWith("../");
    // A path, as the shipped resolver tells one from a key: anchored, a folder,
    // or with any extension. Its one extra place is the repo root.
    if (folderish || anchored || extname(target) !== "") {
      if (anchored || folderish) return undefined;
      if (!roots.has(root)) roots.set(root, repoRoot(root));
      const repo = roots.get(root) ?? null;
      return repo === null ? undefined : [normalize(join(repo, target))];
    }
    // A key: in the set the link is written in, as the shipped resolver looks in its bundle.
    const inSet = (d: ResolvableDocument) => d.path.startsWith(root + sep);
    const m = named(documents());
    const out: string[] = [];
    const slash = target.indexOf("/");
    if (slash > 0) {
      // `type/slug`: the type is a claim the target's own frontmatter must make.
      const type = target.slice(0, slash);
      const hit = (m.get(target.slice(slash + 1)) ?? []).find((d) => inSet(d) && d.type === type);
      if (hit) out.push(hit.path);
    }
    // A bare name (or a key whose type did not match), by file name.
    const hit = (m.get(stem(target)) ?? []).find(inSet);
    if (hit) out.push(hit.path);
    return out;
  };
}

/** Scriptorium's slot, for `WorkspaceDaemonOptions.links`. */
export function scriptoriumLinkSlot(): LinkSlot {
  return {
    edges: ({ frontmatter }) => frontmatterEdges(frontmatter),
    resolve: wikiFormsResolver(),
  };
}
