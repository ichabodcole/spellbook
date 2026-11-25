/**
 * Search: fuzzy on names, exact in text, over every document in the session
 * (`search`, `searchEach`). Tier 4 of the session parts
 * (docs/architecture/workspace-session.md); it takes `places` and the read
 * index, and `imageOfDoc` from the facade as a hook.
 */

import { bundleOf, isBundleMain } from "../../lib/bundles.ts";
import type { SearchReport, SearchResult } from "../protocol";
import { type Candidate, DEFAULT_LIMIT, searchDocuments } from "../search";
import { SessionError } from "./errors.ts";
import { bundleNameAt } from "./names.ts";
import type { Places } from "./places.ts";
import type { ReadIndex } from "./readIndex.ts";
import type { ContextIndex } from "./types.ts";

export class Search {
  constructor(
    private readonly places: Places,
    private readonly readIndex: ReadIndex,
    private readonly hooks: {
      imageOfDoc: (path: string, index?: ContextIndex) => string | null;
    },
  ) {}

  /**
   * Search the context: fuzzy on names, exact in text. A document the session
   * holds is read as its ACTIVE VERSION, which lives under the session folder and
   * not at the original path, so an edit made a minute ago is found and `grep`
   * over the workspace would miss it. A document not yet opened is read from disk.
   */
  search(opts: { query: string; limit?: number }): SearchReport {
    const q = opts.query.trim();
    if (q === "") throw new SessionError("search: the query is empty", 400);
    const report = searchDocuments(
      this.readIndex.candidates(),
      q,
      (c) => this.readIndex.candidateText(c),
      opts.limit ?? DEFAULT_LIMIT,
    );
    // A hit in an image's description is a hit on the image: it carries the
    // image's path, which is what a surface opens.
    const index = this.places.contextIndex();
    for (const r of report.results) {
      const image = this.hooks.imageOfDoc(r.path, index);
      if (image) r.image = image;
      this.labelBundleHit(r);
    }
    return report;
  }

  /** A hit in a bundle's main file says which bundle it is in, as its row names it. */
  private labelBundleHit(r: SearchResult): void {
    if (!isBundleMain(r.path)) return;
    const b = bundleOf(r.path);
    if (b) r.bundle = { path: b.root, name: bundleNameAt(b.root), label: b.type.label };
  }

  /**
   * `search` for several queries in one pass: each document's text is read
   * once, however many queries there are, and each query gets its own report,
   * as `search` would give it. For a caller that asks about several words at
   * once (Atlas's impact check), where a search per word would read the whole
   * context once per word.
   */
  searchEach(opts: { queries: readonly string[]; limit?: number }): SearchReport[] {
    const queries = opts.queries.map((q) => q.trim());
    if (queries.some((q) => q === "")) throw new SessionError("search: a query is empty", 400);
    const candidates = this.readIndex.candidates();
    const texts = new Map<string, string | null>();
    const read = (c: Candidate) => {
      if (!texts.has(c.path)) {
        let t: string | null;
        try {
          t = this.readIndex.candidateText(c);
        } catch {
          t = null;
        }
        texts.set(c.path, t);
      }
      return texts.get(c.path) ?? null;
    };
    const index = this.places.contextIndex();
    return queries.map((q) => {
      const report = searchDocuments(candidates, q, read, opts.limit ?? DEFAULT_LIMIT);
      for (const r of report.results) {
        const image = this.hooks.imageOfDoc(r.path, index);
        if (image) r.image = image;
        this.labelBundleHit(r);
      }
      return report;
    });
  }
}
