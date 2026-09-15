// What is wrong with this session, and the verb that fixes each thing (E62).
//
// ⛔ REPORTS, NEVER REPAIRS. Silently pruning a ghost entry would throw away the
// fact that the human ASKED for that file to be in their context — and if it
// comes back from a `git checkout`, they would have to notice it is missing and
// add it again. The same logic protects a document record whose file has gone:
// the session is still holding versions the human can save back, so forgetting
// it for them would be discarding content on their behalf. Cole ruled it:
// "report, name the verb, let you decide."
//
// ⛔ AND EVERY FINDING CARRIES ITS VERB. A report that says "3 problems" and
// leaves you to work out what to type is the shape this spell keeps failing at
// and fixing — the conflict banner with no route to the comparison, the
// "gone from disk" notice with no way to answer it. A finding without a fix is
// half a finding.
//
// ⚠ THE CHECKS ARE EVIDENCED, NOT IMAGINED. Each one is a state that has
// actually happened here: a record whose original was deleted (E60's residue,
// and any delete in Finder), a `listed` context entry pointing at nothing
// (never rescanned — measured, and reachable today with no bug at all), and
// links a set cannot answer (E54). Nothing is checked because it sounded
// plausible.

/** One thing worth looking at, and what to do about it. */
export type Finding = {
  kind: "original.missing" | "context.ghost" | "links.dangling";
  /** What it is about: a path, or an entry id. */
  subject: string;
  /** What the human reads. */
  message: string;
  /** What the agent would run, with the argument already in it. */
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
  /** Dangling link counts per mirrored entry. */
  links: readonly { entry: string; label: string; dangling: number }[];
};

/**
 * Shape the facts into findings.
 *
 * Pure on purpose: the fs reads belong to the session, and what counts as a
 * problem — and what to say about it — is the part worth pinning with cells.
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
      } still held here — saving would recreate the file.`,
      fix: `forget --doc ${d.slug}`,
      count: d.versions,
    });
  }

  for (const n of c.nodes) {
    if (n.exists) continue;
    // ⚠ A record and an entry can point at the SAME missing path, and both are
    // reported: they are two different things to clean up, with two different
    // verbs, and merging them would leave whichever the human did not do.
    out.push({
      kind: "context.ghost",
      subject: n.path,
      message: `${n.shown} is in the context but not on disk.`,
      fix: `hide ${n.path}`,
    });
  }

  for (const l of c.links) {
    if (l.dangling <= 0) continue;
    out.push({
      kind: "links.dangling",
      subject: l.entry,
      message:
        l.dangling === 1
          ? `${l.label} has 1 link that answers nothing.`
          : `${l.label} has ${l.dangling} links that answer nothing.`,
      fix: `dangling --entry ${l.entry}`,
      count: l.dangling,
    });
  }

  return out;
}

/**
 * The one line the chat gets at startup, or null when there is nothing to say.
 *
 * ⛔ ONE LINE, AND SILENCE WHEN CLEAN. A check that announces itself every time
 * it finds nothing trains the reader to skip it, and then it is not a check any
 * more. The detail lives behind the verb.
 */
export function summary(list: readonly Finding[]): string | null {
  if (list.length === 0) return null;
  // ⚠ Counted by KIND rather than described, because a sentence that tries to
  // name three categories in one breath reads worse than the numbers do.
  const byKind = new Map<Finding["kind"], number>();
  for (const f of list) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  // ⚠ BOTH FORMS WRITTEN OUT. Appending "s" produced "ghost in the contexts",
  // which is the kind of small wrongness that makes a tool read as careless.
  const label: Record<Finding["kind"], [one: string, many: string]> = {
    "original.missing": ["missing file", "missing files"],
    "context.ghost": ["ghost in the context", "ghosts in the context"],
    "links.dangling": ["set with dangling links", "sets with dangling links"],
  };
  const parts = [...byKind].map(([kind, n]) => `${n} ${label[kind][n === 1 ? 0 : 1]}`);
  return `Startup check: ${parts.join(", ")} — run \`doctor\` for the detail.`;
}
