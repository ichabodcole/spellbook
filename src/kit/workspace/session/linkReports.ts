/**
 * The link reports: the graph (`linkGraph`), what links to a document
 * (`backlinks`) and what it links to (`outlinks`), a board's summaries and the
 * links among its cards (`summaries`, `cardSummaries`, `linksAmong`), and one
 * document's text (`documentText`). Tier 5 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core, `places`, the
 * read index, `linkResolve`, `profiles`, `relations` and the `documents`.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { bundleOf, referencingBundle } from "../../lib/bundles.ts";
import { docFormat, withoutDocExtension } from "../../lib/docFormat.ts";
import { splitTarget } from "../../lib/linkTarget.ts";
import { BODY_LINKS, edgeBacklinksTo, edgeKeeps } from "../linkEdges";
import {
  backlinksTo,
  extractLinks,
  type GraphDoc,
  type LinkRef,
  landingName,
  linkGraph,
} from "../links";
import type {
  Backlinks,
  BacklinkView,
  DocCardSummary,
  DocSummary,
  DocText,
  EdgeBacklinkView,
  GraphNodeView,
  GraphOptions,
  LinkGraph,
  Outlinks,
  OutlinkView,
  ReferenceBacklinkView,
  ReferenceView,
} from "../protocol";
import { readsBack } from "../relations";
import { toPosix } from "../tree";
import type { Documents } from "./documents.ts";
import { SessionError } from "./errors.ts";
import { BACKLINK_CAP, cardFacts, type DocFacts, GRAPH_CAP, NO_FACTS, OUTWARD } from "./facts.ts";
import type { LinkResolve } from "./linkResolve.ts";
import { bundleNameAt } from "./names.ts";
import type { Places } from "./places.ts";
import type { Profiles } from "./profiles.ts";
import type { ReadIndex } from "./readIndex.ts";
import type { Relations } from "./relations.ts";
import type { State } from "./state.ts";

export class LinkReports {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly readIndex: ReadIndex,
    private readonly linkResolve: LinkResolve,
    private readonly profiles: Profiles,
    private readonly relations: Relations,
    private readonly documents: Documents,
  ) {}

  /**
   * The link graph: the session's documents and the typed links between them,
   * filtered by focus, hops, relation, kind and folder, then cut at GRAPH_CAP (or
   * `limit`) by degree, so a hub survives a cut a leaf does not (see `linkGraph`
   * in `links.ts`). It only reads.
   *
   * The documents read are the ones search, backlinks and the link check read
   * (`candidates`), through the same per-file cache and one context index, so a
   * second ask after an edit re-reads only the document that changed. A kind is
   * `kindOf`'s answer.
   */
  linkGraph(opts: GraphOptions = {}): LinkGraph {
    const index = this.places.contextIndex();
    const focus =
      opts.focus === undefined ? undefined : this.readIndex.linkSubject(opts.focus, index).path;
    if (opts.hops !== undefined && (!Number.isInteger(opts.hops) || opts.hops < 0 || opts.hops > 3))
      throw new SessionError(`graph: hops must be 0 to 3, not ${String(opts.hops)}`, 400);
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1))
      throw new SessionError(`graph: limit must be at least 1, not ${String(opts.limit)}`, 400);
    if (opts.within !== undefined && !isAbsolute(opts.within))
      throw new SessionError(`graph: within must be an absolute folder, not ${opts.within}`, 400);
    const within =
      opts.within === undefined ? undefined : this.places.canonical(opts.within, index);
    const inside = (p: string) =>
      within === undefined || p === focus || p === within || p.startsWith(within + sep);
    const all = this.readIndex.markdownCandidates().filter((c) => inside(c.path));
    const read = new Set<string>();
    const facts = new Map<string, DocFacts>();
    const sources = all.map((c) => {
      const got = this.readIndex.readOf(c, read);
      facts.set(c.path, got?.facts ?? NO_FACTS);
      return { path: c.path, links: got?.links ?? [], edges: got?.edges ?? [] };
    });
    const entryOf = this.readIndex.entryFinder(index);
    // Boards as nodes of their own kind (`bundles`, off by default): a bundle
    // whose type reads references, of its type's kind, labelled by its noun,
    // not canon (a board is not canon), with an edge to each document,
    // image or bundle it references.
    const bundleDocs: GraphDoc[] = [];
    const referenceEdges: { from: string; to: string }[] = [];
    if (opts.bundles === true)
      for (const c of this.readIndex.referenceCandidates()) {
        if (!inside(c.path)) continue;
        const rb = referencingBundle(c.path) as NonNullable<ReturnType<typeof referencingBundle>>;
        const noun = rb.references.noun;
        bundleDocs.push({
          path: c.path,
          kind: rb.type.type,
          label: noun.charAt(0).toUpperCase() + noun.slice(1),
          canon: false,
          bundle: { noun },
        });
        for (const ref of this.readIndex.readOf(c, read)?.refs ?? []) {
          const r = this.readIndex.resolveReference(ref.raw, c.path, entryOf(c.path), index);
          if (r.state === "in-context") referenceEdges.push({ from: c.path, to: r.path });
        }
      }
    // Only after a pass that read every candidate: a folder's graph read some.
    if (within === undefined) this.readIndex.pruneLinkCache(read);
    const limit = Math.min(opts.limit ?? GRAPH_CAP, GRAPH_CAP);
    const profiles = this.profiles.profilePass(index);
    // Relations are matched case-folded, as the CLI's `--rel` folds them: a wire
    // client asking for `Extends` means `extends`. Folded once, so the filter
    // and the "matches nothing" warning below can never disagree.
    const rels = opts.rel?.map((r) => r.toLowerCase());
    const g = linkGraph(
      [
        ...all.map((c) => ({
          path: c.path,
          ...this.profiles.kindView(c.path, facts.get(c.path) ?? NO_FACTS, profiles),
        })),
        ...bundleDocs,
      ],
      sources,
      // ⛔ As written in a DOCUMENT: no chat fallback, as backlinks reads them.
      (raw, from, kind) =>
        this.linkResolve.resolveFrom(raw, from, entryOf(from), "document", index, kind),
      {
        ...(focus !== undefined ? { focus } : {}),
        ...(opts.hops !== undefined ? { hops: opts.hops } : {}),
        ...(rels !== undefined ? { rel: rels } : {}),
        ...(opts.untyped !== undefined ? { untyped: opts.untyped } : {}),
        ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
        ...(opts.kindless !== undefined ? { kindless: opts.kindless } : {}),
        ...(opts.edge !== undefined ? { edge: opts.edge } : {}),
        limit,
      },
      referenceEdges,
    );
    const nodes: GraphNodeView[] = g.nodes.map((n) => {
      if (n.bundle) {
        const root = dirname(n.path);
        const entry = entryOf(n.path);
        return {
          path: n.path,
          name: basename(root),
          shown: entry ? toPosix(relative(entry.root, root)) : basename(root),
          title: bundleNameAt(root),
          kind: n.kind,
          label: n.label ?? n.kind,
          canon: false,
          linksIn: n.linksIn,
          linksOut: n.linksOut,
          ...(n.hop !== undefined ? { hop: n.hop } : {}),
          bundle: n.bundle,
        };
      }
      const f = facts.get(n.path) ?? NO_FACTS;
      const entry = entryOf(n.path);
      const name = basename(n.path);
      return {
        path: n.path,
        name,
        shown: entry ? toPosix(relative(entry.root, n.path)) : name,
        title: f.title ?? f.heading ?? withoutDocExtension(name),
        kind: n.kind,
        label: n.kind === null ? null : (n.label ?? n.kind),
        canon: n.canon ?? true,
        ...(f.status !== null ? { status: f.status } : {}),
        linksIn: n.linksIn,
        linksOut: n.linksOut,
        ...(n.hop !== undefined ? { hop: n.hop } : {}),
      };
    });
    // A filter that matches nothing is said, not left to look like an empty world.
    const warnings: string[] = [];
    if (within !== undefined && !all.some((c) => c.path !== focus))
      warnings.push(`within: no document in the session is under ${within}`);
    const kindNames = g.kinds.flatMap((k) => (k.kind === null ? [] : [k.kind]));
    const strayKinds = (opts.kind ?? []).filter((k) => !kindNames.includes(k));
    if (strayKinds.length > 0)
      warnings.push(
        `kind: no document is of kind ${strayKinds.join(", ")}; the kinds are ${kindNames.join(", ") || "none"}`,
      );
    const relNames = g.relations.map((r) => r.rel);
    const strayRels = (rels ?? []).filter((r) => !relNames.includes(r));
    if (strayRels.length > 0)
      warnings.push(
        `rel: no link in view carries ${strayRels.join(", ")}; the relations in view are ${relNames.join(", ") || "none"}`,
      );
    // An edge kind no link among the documents is of (kit-link-edges-slot).
    const edgeNames = g.edgeKinds?.map((k) => k.kind) ?? [BODY_LINKS];
    const strayEdges = (opts.edge ?? []).filter((k) => !edgeNames.includes(k));
    if (strayEdges.length > 0)
      warnings.push(
        `edge: no link is of kind ${strayEdges.join(", ")}; the edge kinds are ${edgeNames.join(", ")}`,
      );
    if (g.total.nodes === 0) warnings.push("the filter left no document");
    return {
      focus: focus ?? null,
      nodes,
      edges: g.edges,
      relations: g.relations,
      untyped: g.untyped,
      kinds: g.kinds,
      ...(g.edgeKinds ? { edgeKinds: g.edgeKinds } : {}),
      total: g.total,
      ...(g.total.nodes > nodes.length ? { truncated: true as const } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * What links to a document: every link, in the session's other documents,
   * that lands on it when followed from where it is written. `key` is a slug or
   * a held document's name (the open document when absent), or the absolute
   * path of any document in the context, held or not, so the agent can ask about
   * one the human has not opened. It only reads.
   *
   * The documents read are the ones search reads (`candidates`), bounded the
   * same way; the answer carries at most BACKLINK_CAP links and says when it was
   * cut. Each document's links come from `linksOf`'s cache, so asking again
   * after an edit re-reads only the document that changed.
   */
  backlinks(key?: string, opts: { edge?: readonly string[] } = {}): Backlinks {
    // ⛔ ONE INDEX PER ANSWER. Resolving a link asks "is this in the context?",
    // and `locate` answers by walking every entry's tree: once per link, a hub
    // that 644 of 2,500 documents link to took about 490 ms an ask, on every
    // snapshot while it was open. Built once here, each question is a lookup.
    const index = this.places.contextIndex();
    const target = this.readIndex.linkSubject(key, index, { images: true });
    const all = this.readIndex.markdownCandidates();
    const read = new Set<string>();
    const entryOf = this.readIndex.entryFinder(index);
    const keep = edgeKeeps(opts.edge);
    const found = backlinksTo(
      target.path,
      all.map((c) => ({
        path: c.path,
        // Belt and braces: a scheme link could never land here anyway, since
        // `resolveTarget` answers `missing` for one; filtering just skips the ask.
        links: keep(BODY_LINKS)
          ? this.readIndex.linksOf(c, read).filter((l) => l.scheme === undefined)
          : [],
      })),
      // ⛔ As written in a DOCUMENT: no chat fallback (see `backlinksTo`).
      (raw, from, kind) =>
        this.linkResolve.resolveFrom(raw, from, entryOf(from), "document", index, kind),
    );
    // The app's edges that land on it (kit-link-edges-slot), apart from the
    // links: Scriptorium's frontmatter references are a claim about the
    // document, a body link a citation in prose. Sifted by name as links are.
    const edges: EdgeBacklinkView[] = [];
    if (this.readIndex.appEdges) {
      const want = landingName(target.path);
      for (const e of edgeBacklinksTo(
        target.path,
        all.map((c) => ({
          path: c.path,
          edges: (this.readIndex.readOf(c, read)?.edges ?? []).filter((x) => keep(x.kind)),
        })),
        (raw) => landingName(splitTarget(raw).path) === want,
        (raw, from) => {
          const r = this.linkResolve.resolveFrom(raw, from, entryOf(from), "document", index);
          return r.state === "in-context" ? r.path : null;
        },
      )) {
        const entry = entryOf(e.source);
        edges.push({
          source: e.source,
          name: basename(e.source),
          shown: entry ? toPosix(relative(entry.root, e.source)) : basename(e.source),
          edge: e.kind,
          raw: e.target,
          ...(e.key !== undefined ? { key: e.key } : {}),
          ...(e.line !== undefined ? { line: e.line } : {}),
          rel: [...(e.rel ?? [])],
          ...(e.label !== undefined ? { label: e.label } : {}),
        });
      }
      edges.sort((a, b) => a.shown.localeCompare(b.shown) || (a.line ?? 0) - (b.line ?? 0));
    }
    // The bundles that reference it (the boards it is on), each once with its
    // references to it, apart from the links: a board is not canon. Sifted by
    // the name a reference would end in (a bundle's folder for its main file)
    // before anything is resolved.
    const landing = (p: string) =>
      basename(p.endsWith("/") ? p.slice(0, -1) : p)
        .normalize("NFC")
        .toLowerCase();
    const tb = bundleOf(target.path);
    const wantName = landing(tb && tb.inner === tb.type.main ? tb.root : target.path);
    const bundles: ReferenceBacklinkView[] = [];
    for (const c of this.readIndex.referenceCandidates()) {
      if (c.path === target.path) continue;
      const refs: ReferenceView[] = [];
      let head: Omit<ReferenceBacklinkView, "refs"> | null = null;
      for (const ref of this.readIndex.readOf(c, read)?.refs ?? []) {
        const name = landing(ref.raw);
        if (name !== wantName && name !== landing(target.path)) continue;
        const r = this.readIndex.resolveReference(ref.raw, c.path, entryOf(c.path), index);
        if (r.state !== "in-context" || r.path !== target.path) continue;
        const v = this.readIndex.referenceView(c.path, ref, entryOf);
        const { source, bundle, name: title, shown, noun, part, ...one } = v;
        head ??= { source, bundle, name: title, shown, noun, part };
        refs.push(one);
      }
      if (head) bundles.push({ ...head, refs });
    }
    bundles.sort((a, b) => a.name.localeCompare(b.name) || a.shown.localeCompare(b.shown));
    this.readIndex.pruneLinkCache(read);
    const views: BacklinkView[] = found.map((b) => {
      const entry = entryOf(b.source);
      return {
        source: b.source,
        name: basename(b.source),
        shown: entry ? toPosix(relative(entry.root, b.source)) : basename(b.source),
        line: b.line,
        raw: b.raw,
        rel: b.rel,
        kind: b.kind,
        ...(b.label !== undefined ? { label: b.label } : {}),
        ...(b.embed ? { embed: true as const } : {}),
        context: b.context,
        from: b.from,
        to: b.to,
      };
    });
    views.sort((a, b) => a.shown.localeCompare(b.shown) || a.line - b.line);
    const counts = new Map<string, number>();
    let bare = 0;
    for (const v of views) {
      if (v.rel.length === 0) bare++;
      for (const r of v.rel) counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    // How each relation reads from THIS end (kit-picker-relation-meanings): a
    // declared inverse ("grounds"), or a symmetric relation's own label. Read
    // from the vocabulary in force here, at the document linked to: a world
    // keeps one, and a reader stands at this end.
    const vocabulary = this.relations.relationPass(index).at(target.path);
    const relations = [...counts]
      .map(([rel, count]) => {
        const def = vocabulary.relations.get(rel);
        const as = def ? readsBack(def) : undefined;
        return { rel, count, ...(as !== undefined ? { as } : {}) };
      })
      .sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
    const kept = views.slice(0, BACKLINK_CAP);
    const keptEdges = edges.slice(0, BACKLINK_CAP);
    return {
      doc: target.doc,
      path: target.path,
      count: views.length,
      backlinks: kept,
      relations,
      bare,
      bundles,
      ...(this.readIndex.appEdges ? { edges: keptEdges, edgeCount: edges.length } : {}),
      ...(views.length > kept.length || edges.length > keptEdges.length
        ? { truncated: true as const }
        : {}),
    };
  }

  /**
   * Each of `paths` that is a markdown document in the session, as a report
   * names it: its path, name, title, and its kind, label and canon as the
   * profiles say (`kindView`, the one place that is decided). Paths that are
   * not documents here are dropped. One profile pass, and each document's facts
   * from the link cache, so asking about many costs one read each at most. It
   * only reads.
   */
  summaries(paths: readonly string[]): DocSummary[] {
    return this.summariesOf(paths, false);
  }

  /**
   * `summaries`, with what a card on a board shows besides: each document's
   * frontmatter `description` and how many links it writes. From the same
   * cache, so a board of many cards costs one read per changed document.
   */
  cardSummaries(paths: readonly string[]): DocCardSummary[] {
    return this.summariesOf(paths, true) as DocCardSummary[];
  }

  /**
   * The links among `paths`: for each that is a markdown document in the
   * session, every link it writes that lands on another of them, followed from
   * where it is written as backlinks follow it, with the heading it names
   * (`anchor`, as written after `#`) when it names one. Each pair and heading
   * once. For a board's faint lines between its document cards. One context
   * index and each document's links from the cache, so a board of many cards
   * costs one read per changed document. It only reads.
   */
  linksAmong(paths: readonly string[]): { from: string; to: string; anchor?: string }[] {
    const index = this.places.contextIndex();
    const entryOf = this.readIndex.entryFinder(index);
    const byPath = new Map(this.readIndex.markdownCandidates().map((c) => [c.path, c]));
    const want = new Set<string>();
    for (const p of paths) if (isAbsolute(p)) want.add(this.places.canonical(p, index));
    const read = new Set<string>();
    const out: { from: string; to: string; anchor?: string }[] = [];
    const seen = new Set<string>();
    for (const from of want) {
      const c = byPath.get(from);
      if (!c) continue;
      for (const l of this.readIndex.linksOf(c, read)) {
        if (l.scheme !== undefined) continue;
        // ⛔ As written in a DOCUMENT: no chat fallback, as backlinks reads them.
        const r = this.linkResolve.resolveFrom(
          l.raw,
          from,
          entryOf(from),
          "document",
          index,
          l.kind,
        );
        if (r.state !== "in-context" || r.path === from || !want.has(r.path)) continue;
        const hash = l.raw.indexOf("#");
        const anchor = hash === -1 ? "" : l.raw.slice(hash + 1);
        const key = `${from}\0${r.path}\0${anchor}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from, to: r.path, ...(anchor !== "" ? { anchor } : {}) });
      }
    }
    return out;
  }

  private summariesOf(paths: readonly string[], card: boolean): DocSummary[] {
    const index = this.places.contextIndex();
    const entryOf = this.readIndex.entryFinder(index);
    const profiles = this.profiles.profilePass(index);
    const byPath = new Map(this.readIndex.markdownCandidates().map((c) => [c.path, c]));
    const read = new Set<string>();
    const out: DocSummary[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      if (!isAbsolute(p)) continue;
      const own = this.places.canonical(p, index);
      const c = byPath.get(own);
      if (!c || seen.has(own)) continue;
      seen.add(own);
      const facts = this.readIndex.readOf(c, read)?.facts ?? NO_FACTS;
      const k = this.profiles.kindView(own, facts, profiles);
      const entry = entryOf(own);
      const name = basename(own);
      out.push({
        path: own,
        name,
        shown: entry ? toPosix(relative(entry.root, own)) : name,
        title: facts.title ?? facts.heading ?? withoutDocExtension(name),
        kind: k.kind,
        label: k.kind === null ? null : (k.label ?? k.kind),
        canon: k.canon,
        ...(facts.status !== null ? { status: facts.status } : {}),
        ...(card ? cardFacts(facts, this.readIndex.linksOf(c, read)) : {}),
      });
    }
    return out;
  }

  /**
   * The text of a held version, or of the active version or the file: the
   * version asked for must be one the session holds for that document.
   */
  private subjectText(
    subject: { doc: string | null; path: string },
    version: number | undefined,
  ): { text: string; version: number | null } {
    if (version !== undefined) {
      const d = subject.doc === null ? undefined : this.documents.findDoc(subject.doc);
      if (!d)
        throw new SessionError(
          `${this.places.display(subject.path)} is not open in the session, so it has no v${version}`,
          404,
        );
      this.documents.versionOrDie(d, version);
      return { text: readFileSync(this.core.versionPath(d, version), "utf8"), version };
    }
    const c = this.readIndex.candidates().find((x) => x.path === subject.path);
    if (!c) throw new SessionError(`no document ${subject.path} in this session`, 404);
    return { text: this.readIndex.candidateText(c), version: c.version };
  }

  /**
   * One document's text as the session holds it: its active version (an unsaved
   * edit counts, as search reads it), a held version when `version` names one,
   * or the file for a document the session does not hold. `key` is what
   * backlinks takes. It only reads.
   */
  documentText(key?: string, version?: number): DocText {
    const index = this.places.contextIndex();
    const subject = this.readIndex.linkSubject(key, index);
    const got = this.subjectText(subject, version);
    const entry = this.readIndex.entryFinder(index)(subject.path);
    return {
      path: subject.path,
      shown: entry ? toPosix(relative(entry.root, subject.path)) : basename(subject.path),
      version: got.version,
      text: got.text,
    };
  }

  /**
   * The links a document writes, each followed from where it is written as
   * backlinks follow them, with where it landed: a document in the session, a
   * file outside it, nothing, or a scheme (`op:doc/…` opens nothing here;
   * `https:` opens outward). Read from the active version, or the held version
   * `version` names. `key` is what backlinks takes. It only reads.
   */
  outlinks(key?: string, version?: number): Outlinks {
    const index = this.places.contextIndex();
    const subject = this.readIndex.linkSubject(key, index);
    const entryOf = this.readIndex.entryFinder(index);
    let links: LinkRef[];
    let read: number | null;
    if (version !== undefined) {
      const got = this.subjectText(subject, version);
      links = docFormat(subject.path) === "json" ? [] : extractLinks(got.text, { schemes: true });
      read = got.version;
    } else {
      const c = this.readIndex.markdownCandidates().find((x) => x.path === subject.path);
      links = c ? this.readIndex.linksOf(c, new Set()) : [];
      read = c?.version ?? null;
    }
    const entry = entryOf(subject.path);
    const views: OutlinkView[] = links.map((l) => {
      const base = {
        line: l.line,
        raw: l.raw,
        rel: l.rel,
        kind: l.kind,
        ...(l.label !== undefined ? { label: l.label } : {}),
        ...(l.embed ? { embed: true as const } : {}),
        context: l.context,
        from: l.from,
        to: l.to,
      };
      if (l.scheme !== undefined)
        return { ...base, state: "scheme", scheme: l.scheme, outward: OUTWARD.has(l.scheme) };
      const r = this.linkResolve.resolveFrom(l.raw, subject.path, entry, "document", index, l.kind);
      return r.state === "missing" ? { ...base, state: r.state } : { ...base, ...r };
    });
    const kept = views.slice(0, BACKLINK_CAP);
    return {
      path: subject.path,
      shown: entry ? toPosix(relative(entry.root, subject.path)) : basename(subject.path),
      version: read,
      count: views.length,
      links: kept,
      ...(views.length > kept.length ? { truncated: true as const } : {}),
    };
  }
}
