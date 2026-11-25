/**
 * Profiles: the one place a document's kind is decided (`kindOf`,
 * `kindView`), the profile files' reader (`profileReader`, one instance,
 * parsed once per change of its stamp), and the profile survey and its reports
 * (`profiles`, `documentProfile`, `profileCheck`). Tier 4 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core, `places` and
 * the read index.
 */

import { basename, dirname, relative, sep } from "node:path";
import { docFormat } from "../../lib/docFormat.ts";
import {
  checkFields,
  fixFor,
  NO_MATCH,
  type ProfileLookup,
  type ProfileMatch,
  ProfileReader,
} from "../profiles";
import type {
  BrokenProfileView,
  DocumentProfile,
  ProfileCheck,
  ProfilesReport,
  ProfileWarningView,
} from "../protocol";
import type { Candidate } from "../search";
import { toPosix } from "../tree";
import {
  type DocFacts,
  NO_FACTS,
  PROFILE_CHECK_CAP,
  PROFILE_WARNINGS_PER_DOC,
  type ProfilePass,
  ruleView,
} from "./facts.ts";
import type { Places } from "./places.ts";
import type { ReadIndex } from "./readIndex.ts";
import type { State } from "./state.ts";
import type { ContextIndex } from "./types.ts";

export class Profiles {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly readIndex: ReadIndex,
  ) {}

  /**
   * The world's profile files (`_meta/profiles/<kind>.json`), each parsed once
   * per change of its stamp, as `linkCache` holds documents (see `profiles.ts`).
   */
  private profileReader = new ProfileReader();

  /**
   * ⛔ THE ONE PLACE A DOCUMENT'S KIND IS DECIDED: the kind of the profile that
   * matches it (the nearest `_meta/profiles/<type>.json`, matched by `type`; see
   * `profilePass`), else its frontmatter `type` exactly as written, or null. A
   * document no profile matches, or whose nearest profile file is broken, keeps
   * the kind it had before profiles, so a world with none behaves as it did. In
   * v1 a profile matches only its own `type`, so the two agree; what changed is
   * where the answer comes from. The graph, its `kind` filter and every map that
   * colours or groups by kind read it from here and nowhere else.
   */
  kindOf(path: string, facts: DocFacts, profiles: ProfilePass): string | null {
    return this.kindView(path, facts, profiles).kind;
  }

  /**
   * `kindOf`'s answer with what the matched profile says of the kind: its
   * `label` (the kind itself without a profile) and whether it is `canon` (true
   * without a profile, or with a broken one). One match per document.
   */
  kindView(
    path: string,
    facts: DocFacts,
    profiles: ProfilePass,
  ): { kind: string | null; label?: string; canon: boolean; labelDepth?: number } {
    const m = profiles.match(path, facts);
    return m.state === "matched"
      ? {
          kind: m.profile.kind,
          label: m.profile.label,
          canon: m.profile.canon,
          // The graph labels a kind by its root-most profile.
          labelDepth: m.path.split(sep).length,
        }
      : { kind: facts.type, canon: true };
  }

  /**
   * One pass's profile lookup: the profile each document matches, the nearest
   * folder's file for its `type`, looking up to the root of the context entry
   * that holds it and never above (`profiles.ts`). A folder's profile files are
   * listed once per pass, and each file parsed once per change of its stamp. A
   * document no entry holds matches nothing.
   */
  profilePass(index: ContextIndex): ProfilePass {
    const lookup = this.profileReader.pass();
    const entryOf = this.readIndex.entryFinder(index);
    return {
      lookup,
      match: (path, facts) => {
        const entry = entryOf(path);
        if (!entry) return NO_MATCH;
        return lookup.match(dirname(path), entry.root, facts.type);
      },
    };
  }

  /**
   * Every document in the session with how it matched a profile and its
   * warnings, read through the link cache (each document once per change) and
   * one profile pass. Both caches are pruned to what this pass saw.
   *
   * `profileShown` is a profile file's path from the root of the entry whose
   * document first reached it, so a file in a listed document's folder reads
   * from that document's own entry, whatever other entry also covers it. When
   * two files would read the same (two listed entries in different folders,
   * each with `_meta/profiles/location.json`), each is led by its entry's
   * folder name, or failing that given whole.
   */
  private profileSurvey(): {
    rows: {
      path: string;
      shown: string;
      facts: DocFacts;
      match: ProfileMatch;
      warnings: ProfileWarningView[];
    }[];
    lookup: ProfileLookup;
    profileShown: (path: string) => string;
    broken: { files: BrokenProfileView[]; count: number };
    notes: { path: string; shown: string; note: string }[];
  } {
    const index = this.places.contextIndex();
    const all = this.readIndex.markdownCandidates();
    const read = new Set<string>();
    const pass = this.profilePass(index);
    const entryOf = this.readIndex.entryFinder(index);
    const shown = (path: string) => {
      const entry = entryOf(path);
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    const rows = all.map((c) => {
      const facts = this.readIndex.readOf(c, read)?.facts ?? NO_FACTS;
      const match = pass.match(c.path, facts);
      const warnings =
        match.state === "matched" ? checkFields(match.profile, facts.fields ?? {}) : [];
      return { path: c.path, shown: shown(c.path), facts, match, warnings };
    });
    this.readIndex.pruneLinkCache(read);
    this.profileReader.prune(pass.lookup.seen());
    const lookup = pass.lookup;
    const base = (path: string) => {
      const root = lookup.rootOf(path);
      return root === undefined ? shown(path) : toPosix(relative(root, path));
    };
    const led = (path: string) => {
      const root = lookup.rootOf(path);
      return root === undefined ? path : `${basename(root)}/${base(path)}`;
    };
    const clash = (f: (p: string) => string) => {
      const by = new Map<string, Set<string>>();
      for (const p of lookup.seen()) {
        const k = f(p);
        by.set(k, (by.get(k) ?? new Set()).add(p));
      }
      return (p: string) => (by.get(f(p))?.size ?? 0) > 1;
    };
    const clashes = clash(base);
    const ledClashes = clash(led);
    const profileShown = (path: string) =>
      !clashes(path) ? base(path) : !ledClashes(path) ? led(path) : path;
    // The broken files: each kind file broken in itself, each shared file
    // broken in itself (once, however many kinds refer to it), and each kind
    // broken only through a shared file, which says so and points there.
    // `count` is the files that need a fix.
    const docsOf = new Map<string, number>();
    for (const r of rows)
      if (r.match.state === "broken") docsOf.set(r.match.path, (docsOf.get(r.match.path) ?? 0) + 1);
    const files: BrokenProfileView[] = [];
    for (const l of lookup.loads())
      if (l.broken !== undefined)
        files.push({
          path: l.path,
          shown: profileShown(l.path),
          kind: l.kind,
          reason: l.broken,
          ...(l.through !== undefined ? { through: profileShown(l.through) } : {}),
          documents: docsOf.get(l.path) ?? 0,
        });
    for (const b of lookup.sharedBroken()) {
      const dependents = lookup
        .loads()
        .filter((l) => l.broken !== undefined && l.through === b.path);
      files.push({
        path: b.path,
        shown: profileShown(b.path),
        kind: null,
        reason: b.reason,
        documents: dependents.reduce((n, l) => n + (docsOf.get(l.path) ?? 0), 0),
      });
    }
    files.sort((a, b) => a.shown.localeCompare(b.shown));
    const notes = lookup
      .notes()
      .map((n) => ({ path: n.path, shown: profileShown(n.path), note: n.note }));
    return {
      rows,
      lookup,
      profileShown,
      broken: { files, count: files.filter((f) => f.through === undefined).length },
      notes,
    };
  }

  /**
   * The world's profiles: each usable profile file with the documents it is
   * the nearest for, the `type` values no profile defines, the documents with no
   * `type`, the documents whose frontmatter does not parse, and the broken files
   * with why. It only reads.
   */
  profiles(): ProfilesReport {
    const { rows, lookup, profileShown, broken, notes } = this.profileSurvey();
    const bySource = new Map<string, { documents: number; withWarnings: number }>();
    const unprofiled = new Map<string, number>();
    const unparsed: ProfilesReport["unparsed"]["documents"] = [];
    let untyped = 0;
    for (const r of rows) {
      if (r.facts.unparsed !== null) {
        unparsed.push({ path: r.path, shown: r.shown, reason: r.facts.unparsed });
        continue;
      }
      if (r.match.state === "none") {
        if (r.facts.type === null) untyped++;
        else unprofiled.set(r.facts.type, (unprofiled.get(r.facts.type) ?? 0) + 1);
        continue;
      }
      const n = bySource.get(r.match.path) ?? { documents: 0, withWarnings: 0 };
      n.documents++;
      if (r.warnings.length > 0) n.withWarnings++;
      bySource.set(r.match.path, n);
    }
    const order = (a: { kind: string; shown: string }, b: { kind: string; shown: string }) =>
      a.kind.localeCompare(b.kind) || a.shown.localeCompare(b.shown);
    const kinds: ProfilesReport["kinds"] = [];
    for (const l of lookup.loads()) {
      const n = bySource.get(l.path) ?? { documents: 0, withWarnings: 0 };
      if (l.profile)
        kinds.push({
          kind: l.kind,
          label: l.profile.label,
          canon: l.profile.canon,
          source: l.path,
          shown: profileShown(l.path),
          refs: l.profile.refs.map(profileShown),
          ...n,
        });
    }
    unparsed.sort((a, b) => a.shown.localeCompare(b.shown, undefined, { numeric: true }));
    return {
      documents: rows.length,
      kinds: kinds.sort(order),
      unprofiled: [...unprofiled]
        .map(([type, documents]) => ({ type, documents }))
        .sort((a, b) => b.documents - a.documents || a.type.localeCompare(b.type)),
      untyped,
      unparsed: {
        count: unparsed.length,
        documents: unparsed.slice(0, PROFILE_CHECK_CAP),
      },
      broken: broken.files.map((f) => ({ ...f, documents: f.documents ?? 0 })),
      brokenFiles: broken.count,
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  /**
   * How one document matched a profile: its kind, the profile's label and the
   * file it came from, its warnings, and what the profile expects field by
   * field; when nothing matched, why. `key` is a slug or a held document's name
   * (the open document when absent), or the absolute path of any document in
   * the context. It only reads. The header chip and the map read a document's
   * profile from here.
   */
  documentProfile(key?: string): DocumentProfile {
    const index = this.places.contextIndex();
    const subject = this.readIndex.linkSubject(key, index);
    // A JSON document (a profile file among them) has no frontmatter to match.
    if (docFormat(subject.path) === "json") {
      const entry = this.readIndex.entryFinder(index)(subject.path);
      return {
        doc: subject.doc,
        path: subject.path,
        shown: entry ? toPosix(relative(entry.root, subject.path)) : basename(subject.path),
        type: null,
        kind: null,
        canon: true,
        match: "none",
        reason: "a JSON file, not a frontmatter document: profiles describe markdown documents",
        warnings: [],
      };
    }
    const c: Candidate = this.readIndex
      .markdownCandidates()
      .find((x) => x.path === subject.path) ?? {
      path: subject.path,
      name: basename(subject.path),
      slug: subject.doc,
      version: null,
    };
    const facts = this.readIndex.readOf(c, new Set())?.facts ?? NO_FACTS;
    const pass = this.profilePass(index);
    const match = pass.match(c.path, facts);
    const entry = this.readIndex.entryFinder(index)(c.path);
    const shown = (p: string) => (entry ? toPosix(relative(entry.root, p)) : basename(p));
    // The version the facts were read from, for a held document: the header
    // shows an answer only for the version on screen.
    const held = c.slug === null ? undefined : this.core.m.docs.find((x) => x.slug === c.slug);
    const base = {
      doc: subject.doc,
      ...(held ? { version: held.active } : {}),
      path: c.path,
      shown: shown(c.path),
      type: facts.type,
      kind: this.kindOf(c.path, facts, pass),
      // Not canon only when a usable profile says so: no profile, or a broken
      // one, leaves the document as it was before profiles.
      canon: match.state === "matched" ? match.profile.canon : true,
    };
    if (match.state === "none") {
      const reason =
        facts.unparsed !== null
          ? `its frontmatter ${facts.unparsed}`
          : !entry
            ? "it is not under a folder in the context, so no profile is looked for"
            : facts.type === null
              ? facts.fields === null
                ? "it has no frontmatter, so no type"
                : "its frontmatter has no type"
              : `no _meta/profiles/${facts.type}.json between its folder and the root of its context entry`;
      return { ...base, match: "none", reason, warnings: [] };
    }
    if (match.state === "broken")
      return {
        ...base,
        match: "broken",
        source: match.path,
        sourceShown: shown(match.path),
        reason: match.reason,
        // Broken only through a shared file: that file is the one to fix.
        ...(match.through !== undefined
          ? { through: match.through, throughShown: shown(match.through) }
          : {}),
        warnings: [],
      };
    const p = match.profile;
    // Each file's fields as that file writes them, the kind's own first: two
    // files may both name a field, and each rule applies (no merging).
    const fields: NonNullable<DocumentProfile["fields"]> = [];
    for (const part of [
      { path: p.path, properties: p.properties, required: p.required },
      ...p.shared,
    ]) {
      const from = { file: part.path, fileShown: shown(part.path) };
      for (const [field, rule] of Object.entries(part.properties))
        fields.push({ field, required: part.required.includes(field), ...ruleView(rule), ...from });
      for (const field of part.required)
        if (!Object.hasOwn(part.properties, field)) fields.push({ field, required: true, ...from });
    }
    return {
      ...base,
      match: "matched",
      label: p.label,
      source: match.path,
      sourceShown: shown(match.path),
      ...(p.description !== undefined ? { description: p.description } : {}),
      // With its fix in words, as `profileCheck` lists it: the header's "Ask
      // the agent to fix" says it, and the agent's `profile` verb shows it.
      warnings: checkFields(p, facts.fields ?? {}).map((w) => ({
        ...w,
        ...(w.file !== undefined ? { fileShown: shown(w.file) } : {}),
        fix: fixFor(w),
      })),
      ...(p.refs.length > 0 ? { refs: p.refs.map(shown) } : {}),
      fields,
    };
  }

  /**
   * Every profile warning in the session, each with its document, field, rule
   * and a fix in words, and every broken profile file with why: shaped like the
   * link check. A document lists at most PROFILE_WARNINGS_PER_DOC warnings
   * (`more` counts the rest), so one document cannot fill the list, and the
   * list is cut at PROFILE_CHECK_CAP; `count` is always the whole. It only
   * reads; a warning never blocks a save.
   */
  profileCheck(): ProfileCheck {
    const { rows, profileShown, broken: bad, notes } = this.profileSurvey();
    const list: ProfileCheck["warnings"]["list"] = [];
    const more: NonNullable<ProfileCheck["warnings"]["more"]> = [];
    let documents = 0;
    let count = 0;
    for (const r of rows) {
      if (r.match.state !== "matched" || r.warnings.length === 0) continue;
      documents++;
      count += r.warnings.length;
      for (const w of r.warnings.slice(0, PROFILE_WARNINGS_PER_DOC))
        list.push({
          ...w,
          source: r.path,
          name: basename(r.path),
          shown: r.shown,
          kind: r.match.profile.kind,
          profile: profileShown(r.match.path),
          ...(w.file !== undefined ? { fileShown: profileShown(w.file) } : {}),
          fix: fixFor(w),
        });
      if (r.warnings.length > PROFILE_WARNINGS_PER_DOC)
        more.push({
          source: r.path,
          shown: r.shown,
          count: r.warnings.length - PROFILE_WARNINGS_PER_DOC,
        });
    }
    // Stable: a document's warnings keep the order the profile gave them.
    const byShown = (a: { shown: string }, b: { shown: string }) =>
      a.shown.localeCompare(b.shown, undefined, { numeric: true });
    list.sort(byShown);
    more.sort(byShown);
    const broken: ProfileCheck["broken"]["files"] = bad.files.map(({ documents: _d, ...f }) => ({
      ...f,
      fix:
        f.through !== undefined
          ? `fix ${f.through}, which this kind refers to: until it is fixed, a document of type ${JSON.stringify(f.kind)} beneath ${f.shown} matches no profile`
          : f.kind === null
            ? `fix ${f.shown}: until it is fixed, every kind that refers to it matches no document`
            : `fix ${f.shown}: until it is fixed, a document of type ${JSON.stringify(f.kind)} beneath it matches no profile`,
    }));
    return {
      count: count + bad.count,
      warnings: {
        count,
        documents,
        list: list.slice(0, PROFILE_CHECK_CAP),
        ...(more.length > 0 ? { more } : {}),
      },
      broken: { count: bad.count, files: broken },
      ...(notes.length > 0 ? { notes } : {}),
      ...(list.length > PROFILE_CHECK_CAP ? { truncated: true as const } : {}),
    };
  }
}
