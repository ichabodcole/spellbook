/**
 * The read index: what the link layer reads every document through. The
 * per-file caches (`linkCache`, `headingCache`), the documents a pass reads
 * (`candidates`, `markdownCandidates`) and how each is read (`readOf`,
 * `linksOf`, `headingsAt`), the entry that holds a document (`entryFinder`),
 * the document a question is about (`linkSubject`), a bundle's references
 * (kit-canvas-references), and the app's link slot (`linkSlot`,
 * `linkCheckOpts`, `resolvable`). Tier 4 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core (`state`),
 * `places` and the `documents`, and the facade's `filteredOut` (the scan
 * filter) as a hook.
 *
 * Each cache is one instance, held here: the other read parts read through
 * this one, and only after a pass that read every candidate is a cache pruned
 * (`pruneLinkCache`; the link check prunes `headingCache` after its pass).
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import {
  type BundleReference,
  bundleOf,
  isBundleMain,
  type ReferencePlace,
  referencingBundle,
} from "../../lib/bundles.ts";
import { docFormat } from "../../lib/docFormat.ts";
import { type Heading, headingsOf } from "../../lib/headings.ts";
import {
  type AppEdge,
  checkLinkSlot,
  type EdgeSpot,
  type LinkSlot,
  locateEdges,
  type ResolvableDocument,
  readEdges,
} from "../linkEdges";
import { extractLinks, type LinkRef, type Resolution } from "../links";
import type {
  ContextEntry,
  Doc,
  LinkCheckOptions,
  ReferenceBacklinkView,
  ReferenceView,
} from "../protocol";
import type { Candidate } from "../search";
import { docPaths, isDocName, toPosix } from "../tree";
import type { Documents } from "./documents.ts";
import { type DocFacts, docFacts, NO_FACTS } from "./facts.ts";
import { bundleNameAt } from "./names.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";
import type { ContextIndex } from "./types.ts";

export class ReadIndex {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly documents: Documents,
    private readonly hooks: {
      filteredOut: () => (abs: string) => boolean;
    },
  ) {}

  /**
   * A document's links, by the file they were read from, with the stamp
   * (inode, size, mtime, ctime) of the file when they were. Backlinks are asked for
   * whenever the surface's snapshot changes, and re-reading every document each
   * time would make that a full read of the world; with this, an answer stats
   * each document and re-reads only the ones that changed. An edit lands by
   * rename, so the active version's inode changes with every edit, which the
   * stamp catches even within one mtime tick.
   *
   * ⛔ MTIME AND SIZE ARE NOT ENOUGH (found by the source editor's verifier). An
   * outside edit that keeps the byte count and puts the old mtime back
   * (`touch -r`, a sync tool) left the link check answering from the old links. The stamp carries ctime,
   * which no userland call can set back. The headings, profile and relation
   * caches stamp the same way.
   */
  private linkCache = new Map<
    string,
    {
      stamp: string;
      links: LinkRef[];
      fragments: LinkRef[];
      facts: DocFacts;
      /** A bundle's references, for a main file whose type reads them; else empty. */
      refs: BundleReference[];
      /** The app's edges from it (kit-link-edges-slot), read from the same text. */
      edges: AppEdge[];
      /** Where each of `edges` is written, in order (`locateEdges`): what the link check opens. */
      edgeAt?: (EdgeSpot | undefined)[];
    }
  >();
  /** The app's part of the link layer: its edges and its resolver (`setLinkSlot`). */
  linkSlot: LinkSlot = {};
  /** What the app asks of the link check beyond the kit's own (`setLinkCheck`). */
  linkCheckOpts: LinkCheckOptions = {};
  /** The documents the app's resolver may land on, built once per context index. */
  private resolvable = new WeakMap<ContextIndex, readonly ResolvableDocument[]>();
  /**
   * A document's headings, by the file they were read from and its stamp, as
   * `linkCache` holds links: read only for a document some link names with an
   * anchor (the link check), or the picker asks about.
   */
  headingCache = new Map<string, { stamp: string; headings: Heading[] }>();

  /**
   * The app's part of the link layer (kit-link-edges-slot): edges it adds
   * beside the body links, and a resolver for its own forms. Set once, as the
   * daemon boots (`WorkspaceDaemonOptions.links`); what was read before is
   * read again.
   */
  setLinkSlot(slot: LinkSlot | undefined): void {
    this.linkSlot = checkLinkSlot(slot);
    this.linkCache.clear();
  }

  /**
   * What the app asks of the link check (`WorkspaceDaemonOptions.linkCheck`):
   * the links leaving their set, and its word for a set. Set once, as the
   * daemon boots; without it the check is the kit's own.
   */
  setLinkCheck(opts: LinkCheckOptions | undefined): void {
    this.linkCheckOpts = { ...(opts ?? {}) };
  }

  /** Whether the app adds edges of its own: what decides that the answers carry them. */
  get appEdges(): boolean {
    return this.linkSlot.edges !== undefined;
  }

  /**
   * Every document in the session, once: what each context entry lists, then
   * any document opened by path that no entry lists, which is still one the
   * human has. What search looks through and what a link can point at.
   */
  candidates(): Candidate[] {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const add = (path: string, d: Doc | undefined) => {
      if (seen.has(path)) return;
      seen.add(path);
      // A bundle's main file is found by its bundle's name ("The well"), not
      // by the name every main file of its type shares.
      const bundle = isBundleMain(path) ? bundleOf(path) : null;
      candidates.push({
        path,
        name: bundle ? bundleNameAt(bundle.root) : (d?.name ?? basename(path)),
        slug: d?.slug ?? null,
        version: d?.active ?? null,
      });
    };
    for (const entry of this.core.m.context)
      for (const path of docPaths(entry))
        add(
          path,
          this.core.m.docs.find((d) => d.original === path),
        );
    // A document the session keeps but no entry lists (opened, then its entry
    // left) is still one the human has, unless a set's folder holds it and the
    // app's filter leaves it out there (`ScanRule.skip`): then it is out of
    // search and links as it is out of the tree. Its record stays, versions
    // and unsaved text, for when the filter lets it back.
    const filtered = this.hooks.filteredOut();
    for (const d of this.core.m.docs)
      if (!(d.entryId === null && filtered(d.original))) add(d.original, d);
    return candidates;
  }

  /**
   * The candidates read as markdown: every markdown document. A JSON document
   * has no links, frontmatter or title to read, and is not a place on the map,
   * so link targets, backlinks, the link check, the graph and the profile
   * survey pass over it (a world's profile files are JSON documents too, and
   * are not untyped documents). Search does not: it matches names and plain
   * text, no markdown.
   */
  markdownCandidates(): Candidate[] {
    return this.candidates().filter((c) => docFormat(c.path) === "markdown");
  }

  /** A candidate's text: its ACTIVE VERSION when the session holds it, else the file. */
  candidateText(c: Candidate): string {
    const d = c.slug === null ? undefined : this.core.m.docs.find((x) => x.slug === c.slug);
    return d ? this.documents.activeText(d) : readFileSync(c.path, "utf8");
  }

  /**
   * The headings of the markdown document at `path` (absolute, in the
   * context's form), read from its ACTIVE version when the session holds it,
   * else from its file; cached per stamp. Null when it cannot be read, and
   * empty for a JSON document, which has none.
   */
  headingsAt(path: string): Heading[] | null {
    if (docFormat(path) === "json") return [];
    const d = this.core.m.docs.find((x) => x.original === path);
    const file = d ? this.core.versionPath(d, d.active) : path;
    let stamp: string;
    try {
      const st = statSync(file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return null;
    }
    const hit = this.headingCache.get(file);
    if (hit?.stamp === stamp) return hit.headings;
    let headings: Heading[];
    try {
      headings = headingsOf(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    this.headingCache.set(file, { stamp, headings });
    return headings;
  }

  /**
   * Every markdown document in the context, with its frontmatter, for the
   * app's resolver: built once per context index (one answer), read through
   * the link cache, so the same array is handed to every target in it.
   */
  resolvableDocs(index: ContextIndex): readonly ResolvableDocument[] {
    const had = this.resolvable.get(index);
    if (had) return had;
    const read = new Set<string>();
    const docs = this.markdownCandidates().map((c) => {
      const f = this.readOf(c, read)?.facts ?? NO_FACTS;
      return { path: c.path, type: f.type, frontmatter: f.fields };
    });
    this.resolvable.set(index, docs);
    return docs;
  }

  /**
   * What a link (or a reference) landing on `p` lands on in the session, in
   * the context's own form, so a link written `./Part/B.md` on a
   * case-insensitive disk reports (and opens) the file as it is named; null
   * when `p` is no document the session may open and no image it shows.
   */
  inContextAt(p: string, index: ContextIndex): string | null {
    const own = this.places.canonical(p, index);
    // An image the tree shows answers a link as a document does: the
    // image's backlinks then say where it is used (kit-image-embeds).
    if (index.entryOf.has(own) || index.images.has(own)) return own;
    // A document gone from disk (deleted outside, or moved to the Trash)
    // is held only as a record: a link to it answers nothing.
    return (
      this.core.m.docs.find((x) => !x.missing && (x.original === p || x.original === own))
        ?.original ?? null
    );
  }

  // ── a bundle's references (kit-canvas-references) ─────────────────────
  //
  // A bundle whose type reads references (Atlas's board) has links of its own:
  // its type reads them from the main file, says where each could land, and
  // writes and swaps them; the kit decides what each lands on, by the same
  // test a markdown link's target meets (`inContextAt`). They are kept apart
  // from markdown links throughout, so nothing that reads a link's `?rel=` or
  // `#anchor` sees a reference's path.

  /** The candidates that are a bundle's main file whose type reads references. */
  referenceCandidates(): Candidate[] {
    return this.candidates().filter((c) => referencingBundle(c.path) !== null);
  }

  /** Where the bundle whose main file is `main` is, for its type's questions. */
  placeOf(main: string, bundle: string, entry: ContextEntry | undefined): ReferencePlace {
    return {
      main,
      bundle,
      entryRoot: entry?.root ?? dirname(bundle),
      isDir: (p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
    };
  }

  /**
   * Where a reference written `raw` in the bundle whose main file is `main`
   * lands: the first of its type's candidates that is on disk, read as a
   * link's target is (in the context, outside it, a file the workspace does
   * not open, a folder). A candidate that is a bundle's folder stands for its
   * main file, as opening one does. `missing` when none is on disk.
   */
  resolveReference(
    raw: string,
    main: string,
    entry: ContextEntry | undefined,
    index: ContextIndex,
  ): Resolution {
    const rb = referencingBundle(main);
    if (!rb) return { state: "missing", tried: [] };
    const tried = rb.references.candidates(raw, this.placeOf(main, rb.root, entry));
    for (const c of tried) {
      let dir: boolean;
      try {
        dir = statSync(c).isDirectory();
      } catch {
        continue;
      }
      const target = dir ? this.documents.mainOf(c) : c;
      const own = this.inContextAt(target, index);
      if (own !== null) return { state: "in-context", path: own };
      if (dir && target === c) return { state: "folder", path: c };
      return isDocName(target) || isBundleMain(target)
        ? { state: "outside", path: target }
        : { state: "not-a-doc", path: target };
    }
    return { state: "missing", tried };
  }

  /** A bundle's reference as a report shows it: the bundle, named as its row is, and the reference. */
  referenceView(
    main: string,
    ref: BundleReference,
    entryOf: (path: string) => ContextEntry | undefined,
  ): Omit<ReferenceBacklinkView, "refs"> & ReferenceView {
    const rb = referencingBundle(main) as NonNullable<ReturnType<typeof referencingBundle>>;
    const entry = entryOf(main);
    return {
      source: main,
      bundle: rb.root,
      name: bundleNameAt(rb.root),
      shown: entry ? toPosix(relative(entry.root, rb.root)) : basename(rb.root),
      noun: rb.references.noun,
      part: rb.references.part,
      id: ref.id,
      line: ref.line,
      raw: ref.raw,
      ...(ref.label !== undefined ? { label: ref.label } : {}),
      ...(ref.subpath !== undefined ? { subpath: ref.subpath } : {}),
      from: ref.from,
      to: ref.to,
    };
  }

  /**
   * A candidate's links, read as search reads it (its ACTIVE VERSION when the
   * session holds it, so an unsaved edit counts), from the cache while the file
   * it was read from is unchanged. A document gone from disk has none.
   */
  linksOf(c: Candidate, read: Set<string>): LinkRef[] {
    return this.readOf(c, read)?.links ?? [];
  }

  /**
   * A candidate's links and facts (`linksOf`'s cache): read once per change of
   * the file they came from, both from the same read. Null for a document gone
   * from disk. `version` reads one of a held document's other versions
   * instead of its active one (the link check's `proposed`).
   */
  readOf(
    c: Candidate,
    read: Set<string>,
    version?: number,
  ): {
    links: LinkRef[];
    fragments: LinkRef[];
    facts: DocFacts;
    refs: BundleReference[];
    edges: AppEdge[];
    edgeAt?: (EdgeSpot | undefined)[];
  } | null {
    const d = c.slug === null ? undefined : this.core.m.docs.find((x) => x.slug === c.slug);
    const file = d ? this.core.versionPath(d, version ?? d.active) : c.path;
    read.add(file);
    let stamp: string;
    try {
      const st = statSync(file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return null;
    }
    // Belt and braces: the link layer and the profile survey read
    // `markdownCandidates`, which has no JSON document, but nothing here may
    // run markdown over one.
    // A bundle's main file whose type reads references (a board) has those,
    // read by its type; any other JSON document has nothing here.
    const bundle = referencingBundle(c.path);
    if (docFormat(c.path) === "json" && !bundle)
      return { links: [], fragments: [], facts: NO_FACTS, refs: [], edges: [] };
    const hit = this.linkCache.get(file);
    if (hit?.stamp === stamp) return hit;
    let entry: {
      stamp: string;
      links: LinkRef[];
      fragments: LinkRef[];
      facts: DocFacts;
      refs: BundleReference[];
      edges: AppEdge[];
      edgeAt?: (EdgeSpot | undefined)[];
    };
    if (bundle) {
      try {
        const refs = bundle.references.read(readFileSync(file, "utf8"));
        entry = { stamp, links: [], fragments: [], facts: NO_FACTS, refs, edges: [] };
      } catch {
        return null;
      }
      this.linkCache.set(file, entry);
      return entry;
    }
    try {
      const text = readFileSync(file, "utf8");
      // Scheme targets kept, for the link check; backlinks passes over them.
      // Links to a place in the same document (`#heading`) are read apart,
      // for the link check's headings; nothing that resolves paths sees them.
      const all = extractLinks(text, { schemes: true, fragments: true });
      const facts = docFacts(text);
      // The app's edges, from the same read and kept under the same stamp,
      // so a save or an edit on disk re-reads them with the links.
      const edges = readEdges(this.linkSlot, { path: c.path, text, frontmatter: facts.fields });
      entry = {
        stamp,
        links: all.filter((l) => !l.fragment),
        fragments: all.filter((l) => l.fragment),
        facts,
        refs: [],
        edges,
        ...(edges.length > 0 ? { edgeAt: locateEdges(text, edges) } : {}),
      };
    } catch {
      return null;
    }
    this.linkCache.set(file, entry);
    return entry;
  }

  /**
   * The entry that holds a source, as `resolveLink` picks it: the one that lists
   * it, else (a document opened by path) the one whose folder it is in.
   */
  entryFinder(index: ContextIndex): (path: string) => ContextEntry | undefined {
    const byId = new Map(this.core.m.context.map((e) => [e.id, e]));
    return (path) => {
      const id = index.entryOf.get(path);
      return (
        (id !== undefined ? byId.get(id) : undefined) ??
        this.core.m.context.find((e) => path.startsWith(e.root + sep))
      );
    };
  }

  /**
   * Forget what was read for documents the session no longer has (or for a
   * version no longer active), so the cache is bounded by the context, not by
   * everything ever read. Only after a pass that read every candidate.
   */
  pruneLinkCache(read: Set<string>): void {
    for (const file of this.linkCache.keys()) if (!read.has(file)) this.linkCache.delete(file);
  }

  /**
   * The document a link question is about: `key` is a slug or a held
   * document's name (the open document when absent), or the absolute path of any
   * document in the context, held or not.
   */
  linkSubject(
    key: string | undefined,
    index: ContextIndex,
    opts: { images?: boolean } = {},
  ): { doc: string | null; path: string } {
    if (key !== undefined && isAbsolute(key) && !this.documents.findDoc(key)) {
      const own = this.places.canonical(key, index);
      if (index.entryOf.has(own)) return { doc: null, path: own };
      // An image is a link target and nothing more: backlinks ask about one,
      // the graph and the profile never do (they read text).
      if (opts.images && index.images.has(own)) return { doc: null, path: own };
    }
    const d = this.documents.docOrDie(key, { takesPath: true });
    return { doc: d.slug, path: this.places.canonical(d.original, index) };
  }
}
