/**
 * Relations: the relation vocabulary files' reader (`relationsReader`, one
 * instance, parsed once per stamp), the vocabulary in force at a path
 * (`relationPass`, `relationsAt`), the typed links (`typedLinks`), and the
 * `relations` report and the doctor's counts (`vocabularyHealth`). Tier 4 of
 * the session parts (docs/architecture/workspace-session.md); it takes
 * `places`, the read index, `linkResolve` and `profiles`.
 */

import { basename, dirname, relative } from "node:path";
import type { RelationsAt, RelationsReport, RelationUse } from "../protocol";
import {
  NO_VOCABULARY,
  type RelationsLookup,
  RelationsReader,
  relationOffers,
  type Vocabulary,
} from "../relations";
import type { Candidate } from "../search";
import { toPosix } from "../tree";
import { NO_FACTS, relationUses } from "./facts.ts";
import type { LinkResolve } from "./linkResolve.ts";
import type { Places } from "./places.ts";
import type { Profiles } from "./profiles.ts";
import type { ReadIndex } from "./readIndex.ts";
import type { ContextIndex } from "./types.ts";

export class Relations {
  constructor(
    private readonly places: Places,
    private readonly readIndex: ReadIndex,
    private readonly linkResolve: LinkResolve,
    private readonly profiles: Profiles,
  ) {}

  /** The world's relation vocabulary files (`_meta/profiles/_relations.json`), parsed once per stamp (see `relations.ts`). */
  private relationsReader = new RelationsReader();

  /**
   * The relations in force at `path` (a file or folder in the context, read as
   * a document there would be: its folder's vocabulary, the nearest file
   * winning per relation), offered as the link picker offers them, with how
   * the world's typed links use each relation between each pair of kinds, and
   * the nearest vocabulary file. For an app that types something between two
   * documents other than a link in one. It only reads.
   */
  relationsAt(path: string): RelationsAt {
    const index = this.places.contextIndex();
    const all = this.readIndex.markdownCandidates();
    const { kinds, links } = this.typedLinks(index, all);
    const { uses, pairs } = relationUses(kinds, links);
    const own = this.places.canonical(path, index);
    const pass = this.relationPass(index);
    const vocabulary = pass.at(own);
    const entry = this.readIndex.entryFinder(index)(own);
    const near = entry ? pass.lookup.nearest(dirname(own), entry.root) : null;
    return {
      vocabulary: vocabulary.any,
      relations: relationOffers(uses, vocabulary),
      pairs,
      file: near?.path ?? null,
      ...(near && "broken" in near.read ? { broken: near.read.broken } : {}),
    };
  }

  /**
   * Every candidate's kind, and every TYPED link (one with `?rel=`) with the
   * document it lands on, resolved as written in a DOCUMENT; null for a link
   * that lands on no document in the session (a scheme link, `op:doc/…`, is
   * still a use of its relations). Read through the link cache, as the check
   * and the graph read; it read every candidate, so the cache is pruned.
   */
  typedLinks(
    index: ContextIndex,
    all: Candidate[] = this.readIndex.markdownCandidates(),
  ): {
    kinds: Map<string, string | null>;
    links: { source: string; rel: string[]; to: string | null }[];
  } {
    const read = new Set<string>();
    const pass = this.profiles.profilePass(index);
    const entryOf = this.readIndex.entryFinder(index);
    const kinds = new Map<string, string | null>();
    const sources = all.map((c) => {
      const got = this.readIndex.readOf(c, read);
      kinds.set(c.path, this.profiles.kindOf(c.path, got?.facts ?? NO_FACTS, pass));
      return { path: c.path, links: got?.links ?? [] };
    });
    this.readIndex.pruneLinkCache(read);
    const links: { source: string; rel: string[]; to: string | null }[] = [];
    for (const s of sources)
      for (const l of s.links) {
        if (l.rel.length === 0) continue;
        let to: string | null = null;
        if (l.scheme === undefined) {
          const r = this.linkResolve.resolveFrom(
            l.raw,
            s.path,
            entryOf(s.path),
            "document",
            index,
            l.kind,
          );
          if (r.state === "in-context" && kinds.has(r.path)) to = r.path;
        }
        links.push({ source: s.path, rel: l.rel, to });
      }
    return { kinds, links };
  }

  /**
   * One pass's relation vocabulary: what is in force for a document or image
   * at a path, the nearest `_meta/profiles/_relations.json` winning per
   * relation, up to the root of the context entry that holds it and never
   * above (`relations.ts`). None outside every entry.
   */
  relationPass(index: ContextIndex): {
    lookup: RelationsLookup;
    at: (path: string) => Vocabulary;
  } {
    const lookup = this.relationsReader.pass();
    const entryOf = this.readIndex.entryFinder(index);
    return {
      lookup,
      at: (path) => {
        const entry = entryOf(path);
        return entry ? lookup.at(dirname(path), entry.root) : NO_VOCABULARY;
      },
    };
  }

  /**
   * The world's relation vocabulary and how its links use it: every vocabulary
   * file (broken ones with why), each declared relation with the links using it
   * where its definition is the one in force, the relations used where a
   * vocabulary is in force but does not declare them, and every relation in
   * use. It only reads. The `relations` verb answers from here.
   */
  relations(): RelationsReport {
    const index = this.places.contextIndex();
    const all = this.readIndex.markdownCandidates();
    const { links } = this.typedLinks(index, all);
    const pass = this.relationPass(index);
    // Every document's folder looked in, so a file nothing links under is still listed.
    for (const c of all) pass.at(c.path);
    const entryOf = this.readIndex.entryFinder(index);
    const shown = (path: string) => {
      const entry = entryOf(path);
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    const used = new Map<string, number>();
    const undeclared = new Map<string, number>();
    const declaredUses = new Map<string, number>();
    for (const l of links) {
      const v = pass.at(l.source);
      for (const rel of l.rel) {
        used.set(rel, (used.get(rel) ?? 0) + 1);
        const def = v.relations.get(rel);
        if (def) {
          const key = `${def.source}\0${rel}`;
          declaredUses.set(key, (declaredUses.get(key) ?? 0) + 1);
        } else if (v.any) undeclared.set(rel, (undeclared.get(rel) ?? 0) + 1);
      }
    }
    const files = pass.lookup.files();
    this.relationsReader.prune(pass.lookup.seen());
    const declared: RelationsReport["declared"] = [];
    for (const f of files)
      if (!("broken" in f.read))
        for (const d of f.read.relations)
          declared.push({
            rel: d.rel,
            label: d.label,
            ...(d.means !== undefined ? { means: d.means } : {}),
            symmetric: d.symmetric,
            ...(d.inverse !== undefined ? { inverse: d.inverse } : {}),
            ...(d.color !== undefined ? { color: d.color } : {}),
            file: shown(f.path),
            uses: declaredUses.get(`${f.path}\0${d.rel}`) ?? 0,
          });
    const byUse = (m: Map<string, number>): RelationUse[] =>
      [...m]
        .map(([rel, count]) => ({ rel, count }))
        .sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
    return {
      files: files.map((f) => ({
        path: f.path,
        shown: shown(f.path),
        relations: "broken" in f.read ? 0 : f.read.relations.length,
        ...("broken" in f.read ? { broken: f.read.broken } : {}),
        ...(!("broken" in f.read) && f.read.warnings ? { warnings: f.read.warnings } : {}),
      })),
      broken: files.filter((f) => "broken" in f.read).length,
      warnings: files.reduce(
        (n, f) => n + ("broken" in f.read ? 0 : (f.read.warnings?.length ?? 0)),
        0,
      ),
      declared,
      undeclared: byUse(undeclared),
      used: byUse(used),
    };
  }

  /**
   * How many vocabulary files in the context are broken, how many keys they
   * ignore, and which of those repeat an earlier key in another case (each
   * with its file, shown as `relations` shows it): the doctor's counts.
   */
  vocabularyHealth(index: ContextIndex): {
    broken: number;
    warnings: number;
    folded: { key: string; earlier: string; file: string }[];
  } {
    const pass = this.relationPass(index);
    for (const c of this.readIndex.markdownCandidates()) pass.at(c.path);
    const files = pass.lookup.files();
    const entryOf = this.readIndex.entryFinder(index);
    const shown = (path: string) => {
      const entry = entryOf(path);
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    const folded: { key: string; earlier: string; file: string }[] = [];
    for (const f of files)
      if (!("broken" in f.read))
        for (const k of f.read.folded ?? []) folded.push({ ...k, file: shown(f.path) });
    return {
      broken: files.filter((f) => "broken" in f.read).length,
      warnings: files.reduce(
        (n, f) => n + ("broken" in f.read ? 0 : (f.read.warnings?.length ?? 0)),
        0,
      ),
      folded,
    };
  }
}
