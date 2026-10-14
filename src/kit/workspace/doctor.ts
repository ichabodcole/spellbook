// What is wrong with this session, and what to do about each thing.
//
// Reports, never repairs. Silently pruning a ghost entry would throw away the
// fact that the human asked for that file to be in their context, and a
// document record whose file has gone still holds versions the human can save
// back: forgetting it for them would discard content on their behalf. The
// report names the act and leaves the decision to the human.
//
// The checks are evidenced, not imagined. Each one is a state that happens: a
// record whose original was deleted outside the app, a context entry that
// points at nothing (a mirrored folder is rescanned, a listed file is not),
// links nothing answers (the Dreamwood export's twelve `op:doc/…` links), and
// two documents sharing a file name (`00-overview.md`, twice in one world), so a
// link to that name can open the other one.

/** The verb that lists the link check's detail; the link findings name it. */
export const LINK_CHECK_VERB = "link-check";

/** The verb that lists the profile check's detail; the profile findings name it. */
export const PROFILE_CHECK_VERB = "profile-check";

/** The verb that lists the relation vocabulary and its broken files. */
export const RELATIONS_VERB = "relations";

/** One thing worth looking at, and what to do about it. */
export type Finding = {
  kind:
    | "original.missing"
    | "context.ghost"
    | "links.dangling"
    | "links.unsupported"
    | "links.heading"
    | "names.shared"
    | "profiles.broken"
    | "profiles.warnings"
    | "relations.broken"
    | "relations.warnings"
    | "relations.folded"
    | "workspace.overlap";
  /** What it is about: a path, or for a link finding the verb that lists them. */
  subject: string;
  /** What the human reads. */
  message: string;
  /** What to do, in words: the agent has no verb that repairs, so it tells the human. */
  fix: string;
  /** How many of something the finding is about, when that is the point. */
  count?: number;
};

/** The facts a checkup needs, gathered by whoever can touch the disk. */
export type Checkup = {
  /** Every document record, with whether its file of record still exists. */
  docs: readonly {
    slug: string;
    name: string;
    original: string;
    exists: boolean;
    versions: number;
  }[];
  /** Every doc node in every context entry, with whether the path exists. */
  nodes: readonly { entry: string; path: string; shown: string; exists: boolean }[];
  /** The link check's counts. Absent: not checked, and nothing said about links. */
  links?: {
    /** Links that resolve to nothing. */
    dangling: number;
    /** Links with a scheme nothing here opens, and those schemes (`op`). */
    unsupported: number;
    schemes: readonly string[];
    /** File names more than one document has. */
    duplicates: number;
    /** Links whose document resolves but whose heading anchor names no heading. */
    headings?: number;
  };
  /** The profile check's counts. Absent: not checked, and nothing said about profiles. */
  profiles?: {
    /** Profile warnings across the world, and the documents carrying them. */
    warnings: number;
    documents: number;
    /** Profile files that do not parse or are not a usable schema. */
    broken: number;
  };
  /** Relation vocabulary files (`_relations.json`) that do not parse or are not usable. Absent: not checked. */
  relations?: {
    broken: number;
    /** Keys the vocabulary ignores, of every kind, `folded` ones included. */
    warnings?: number;
    /**
     * The ignored keys that are an earlier key in another case (`relations.ts`,
     * `FoldedKey`), each with its file. Absent: not told apart, and every
     * ignored key is said by one message that covers both kinds.
     */
    folded?: { key: string; earlier: string; file: string }[];
  };
  /**
   * The set the workspace folder is, or is inside (a session from before the
   * block). Absent: none.
   */
  overlap?: Overlap & { workspace: string };
};

/** A set the workspace folder overlaps: its label and folder, and whether the two are one folder. */
export type Overlap = { label: string; root: string; same: boolean };

/** A path's parent, without `node:path`: this module stays pure. */
function parentOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p.slice(0, 1) : p.slice(0, i);
}

/**
 * What a session that overlaps says, at startup and in `doctor`: what is wrong,
 * and what to change. It still opens, and nothing is changed for the human.
 */
export function overlapMessage(o: Overlap & { workspace: string }): string {
  return `The workspace folder (${o.workspace}) is ${
    o.same ? "the folder of" : "inside"
  } the set ${o.label}, so a file there belongs to both, and a drop on the list lands in the set. Set the workspace to a folder outside ${o.label}, such as ${parentOf(o.root)}, with the pencil in the sidebar or \`workspace <dir>\`, or remove ${o.label} from the context.`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Shape the facts into findings.
 *
 * Pure on purpose: the fs reads belong to the session, and what counts as a
 * problem, and what to say about it, is the part worth pinning with tests.
 */
export function findings(c: Checkup): Finding[] {
  const out: Finding[] = [];

  for (const d of c.docs) {
    if (d.exists) continue;
    out.push({
      kind: "original.missing",
      subject: d.original,
      message: `${d.name} is in this session but its file is gone from disk. ${
        d.versions === 1 ? "1 version is" : `${d.versions} versions are`
      } still held here, and saving would recreate the file, once the human chooses to.`,
      fix: "ask the human: Save in the document's banner would recreate the file, and Close puts it away",
      count: d.versions,
    });
  }

  const o = c.overlap;
  if (o)
    out.push({
      kind: "workspace.overlap",
      subject: o.workspace,
      message: overlapMessage(o),
      fix: `ask the human to set the workspace to a folder outside ${o.label} (the pencil in the sidebar, or \`workspace <dir>\`), or to remove ${o.label} from the context`,
    });

  for (const n of c.nodes) {
    if (n.exists) continue;
    // A record and an entry can point at the same missing path, and both are
    // reported: they are two different things to clean up, and merging them
    // would leave whichever one the human did not do.
    out.push({
      kind: "context.ghost",
      subject: n.path,
      message: `${n.shown} is in the context but not on disk.`,
      fix: "remove its entry from the context pane, or restore the file",
    });
  }

  // The link findings use the status bar mark's words: shared file names, broken
  // links, unsupported links.
  const l = c.links;
  if (l && l.duplicates > 0) {
    out.push({
      kind: "names.shared",
      subject: LINK_CHECK_VERB,
      message: `${plural(
        l.duplicates,
        "shared file name:",
        "shared file names:",
      )} more than one document has it, so a link to that name may open the wrong one.`,
      fix: `run \`${LINK_CHECK_VERB}\` for the files and a suggested name for each; rename with \`rename\` only if the human agrees, then offer to update the links to the old name`,
      count: l.duplicates,
    });
  }
  // ⚠ A dangling link is not an error: a world points at things not written yet.
  // It is a finding because it is worth a look, and the fix says so.
  if (l && l.dangling > 0)
    out.push({
      kind: "links.dangling",
      subject: LINK_CHECK_VERB,
      message: `${plural(l.dangling, "broken link:", "broken links:")} ${
        l.dangling === 1 ? "it points" : "they point"
      } at nothing in this session.`,
      fix: `run \`${LINK_CHECK_VERB}\` for each link's file, line, target as written and where it looked; a broken link is not an error, so fix or keep each one as the human prefers`,
      count: l.dangling,
    });
  if (l && l.unsupported > 0) {
    const schemes = l.schemes.map((s) => `${s}:`).join(", ");
    out.push({
      kind: "links.unsupported",
      subject: LINK_CHECK_VERB,
      message: `${plural(l.unsupported, "unsupported link:", "unsupported links:")} ${
        l.unsupported === 1 ? "it uses" : "they use"
      } a scheme nothing here opens${schemes ? ` (${schemes})` : ""}.`,
      fix: `run \`${LINK_CHECK_VERB}\` for each link's file, line and target as written; such a link names no file here, so it may need rewriting as a path, or keeping as it is`,
      count: l.unsupported,
    });
  }

  if (l?.headings) {
    out.push({
      kind: "links.heading",
      subject: LINK_CHECK_VERB,
      message: `${plural(l.headings, "link to a heading that is not there:", "links to a heading that is not there:")} ${
        l.headings === 1 ? "its document opens" : "their documents open"
      }, but no heading has that name.`,
      fix: `run \`${LINK_CHECK_VERB}\` for each link and the nearest remaining heading (often the heading reworded); offer to update the anchor in a new version the human saves`,
      count: l.headings,
    });
  }

  // A broken profile file is a contract nobody can read: every document of its
  // kind beneath it is unchecked until it is fixed, so it is said at startup.
  const p = c.profiles;
  if (p && p.broken > 0)
    out.push({
      kind: "profiles.broken",
      subject: PROFILE_CHECK_VERB,
      message: `${plural(p.broken, "broken profile file:", "broken profile files:")} ${
        p.broken === 1 ? "it does" : "they do"
      } not parse or ${p.broken === 1 ? "is" : "are"} not a usable schema, so documents of ${
        p.broken === 1 ? "its kind match" : "their kinds match"
      } no profile.`,
      fix: `run \`${PROFILE_CHECK_VERB}\` for each file and the reason; offer to fix the file in a new version the human saves`,
      count: p.broken,
    });
  // ⚠ A profile warning is not an error: nothing blocks a save, and a world may
  // be mid-change. It is a finding because it is worth a look.
  if (p && p.warnings > 0)
    out.push({
      kind: "profiles.warnings",
      subject: PROFILE_CHECK_VERB,
      message: `${plural(p.warnings, "profile warning", "profile warnings")} in ${plural(
        p.documents,
        "document",
        "documents",
      )}: frontmatter that does not match its kind's profile.`,
      fix: `run \`${PROFILE_CHECK_VERB}\` for each document, field and fix; offer to fix them in new versions, or to change the profile if the convention changed, as the human prefers`,
      count: p.warnings,
    });

  // A broken vocabulary defines nothing: the link picker loses its meanings
  // and the link check its symmetry hints beneath it, and nothing else shows it.
  const r = c.relations;
  if (r && r.broken > 0)
    out.push({
      kind: "relations.broken",
      subject: RELATIONS_VERB,
      message: `${plural(r.broken, "broken relation vocabulary file", "broken relation vocabulary files")} (_relations.json): until fixed, ${
        r.broken === 1 ? "it defines" : "they define"
      } no relation, and the relations declared above ${r.broken === 1 ? "it" : "them"} apply instead.`,
      fix: `run \`${RELATIONS_VERB}\` for each file and the reason; offer to fix the file in a new version the human saves`,
      count: r.broken,
    });
  // A key a relation does not read is ignored, which is quiet by nature: a
  // typo such as `symetric` leaves a relation one-way and says nothing. Said
  // here, and kept out of the startup line, like profile warnings. A key that
  // is an earlier one in another case is ignored too, and is no typo: said
  // apart, naming the key that stands, when the counts tell them apart.
  const folded = r?.folded ?? [];
  const unread = (r?.warnings ?? 0) - folded.length;
  if (r && unread > 0)
    out.push({
      kind: "relations.warnings",
      subject: RELATIONS_VERB,
      message:
        r.folded === undefined
          ? `${plural(unread, "key", "keys")} in the relation vocabulary (_relations.json) ${
              unread === 1 ? "is" : "are"
            } ignored: one a relation does not read (perhaps a typo of label, means, symmetric, inverse or color), or a relation repeated in another case.`
          : `${plural(unread, "key", "keys")} in the relation vocabulary (_relations.json) ${
              unread === 1 ? "is" : "are"
            } not read and ignored, perhaps a typo of label, means, symmetric, inverse or color.`,
      fix: `run \`${RELATIONS_VERB}\` for each file's warnings; offer to fix the key in a new version the human saves`,
      count: unread,
    });
  if (folded.length > 0)
    out.push({
      kind: "relations.folded",
      subject: RELATIONS_VERB,
      message: `${plural(folded.length, "key", "keys")} in the relation vocabulary (_relations.json) ${
        folded.length === 1 ? "repeats" : "repeat"
      } an earlier key in another case, and ${folded.length === 1 ? "is" : "are"} ignored (a relation is read case-insensitively): ${folded
        .map((f) => `${f.key} in ${f.file}, after ${f.earlier}`)
        .join("; ")}.`,
      fix: "offer to merge each into the key that stands, or remove it, in a new version the human saves",
      count: folded.length,
    });

  return out;
}

/**
 * The one line the chat gets at startup, or null when there is nothing to say.
 *
 * One line, and silence when clean. A check that announces itself every time
 * it finds nothing trains the reader to skip it. The detail lives behind the
 * `doctor` verb.
 *
 * The link check's findings are left out. The status bar's mark already shows
 * them to the human, a world with a dozen `op:` links would otherwise say so at
 * every start, and the `doctor` event on the tail still carries them for the
 * agent.
 *
 * Profile warnings are left out too: a world mid-change could carry dozens,
 * and saying so at every start trains the reader to skip the line. A broken
 * profile file is said, because nothing else shows it and every document of
 * its kind goes unchecked until it is fixed.
 */
export const SUMMARY_LEAVES_OUT: readonly Finding["kind"][] = [
  "links.dangling",
  "links.unsupported",
  "names.shared",
  "profiles.warnings",
  "relations.warnings",
  "relations.folded",
  // Said in full by its own startup line, which names what to change.
  "workspace.overlap",
];

export function summary(list: readonly Finding[]): string | null {
  const said = list.filter((f) => !SUMMARY_LEAVES_OUT.includes(f.kind));
  if (said.length === 0) return null;
  const byKind = new Map<Finding["kind"], number>();
  for (const f of said) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  // Both forms written out: appending "s" produced "ghost in the contexts".
  const label: Partial<Record<Finding["kind"], [one: string, many: string]>> = {
    "original.missing": ["missing file", "missing files"],
    "context.ghost": ["ghost in the context", "ghosts in the context"],
    "profiles.broken": ["broken profile file", "broken profile files"],
    "relations.broken": ["broken relation vocabulary file", "broken relation vocabulary files"],
  };
  const parts = [...byKind].map(([kind, n]) => `${n} ${label[kind]?.[n === 1 ? 0 : 1] ?? kind}`);
  return `Startup check: ${parts.join(", ")}. Run \`doctor\` for the detail.`;
}
