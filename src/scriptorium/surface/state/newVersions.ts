// "There's a new version" — the pure half of the new-version toast.
//
// ⛔ IT WATCHES THE FACT, NOT THE ACTION, like "Now editing" (E42). The agent's
// `version-new` never activates, so its versions used to arrive in the menu
// with no signal at all (Cole, 2026-09-28: his feedback loop stalled silently).
// What is news is a version the surface has not SEEN on this document, that is
// not the active one. The active case already has its toast; announcing it
// here too would say the same thing twice.
import type { ClientMsg, DiffSide, DocView, Version } from "../../backend/protocol";

/** The label if it has one, else the number: the menu's rule (E37). */
export function versionName(doc: DocView, n: number): string {
  const label = doc.versions.find((v) => v.n === n)?.label?.trim();
  return label ? `v${n} · ${label}` : `v${n}`;
}

/**
 * The versions of `doc` that are news, given the ones already seen on it.
 * `seen` undefined is the first sight of the document (opening it, or the
 * first snapshot after a reconnect): a baseline, never news.
 */
export function spotNewVersions(
  seen: ReadonlySet<number> | undefined,
  doc: DocView,
): { fresh: Version[]; seen: Set<number> } {
  const now = new Set(doc.versions.map((v) => v.n));
  if (seen === undefined) return { fresh: [], seen: now };
  const fresh = doc.versions.filter((v) => !seen.has(v.n) && v.n !== doc.active);
  return { fresh, seen: now };
}

/** What the toast says. The author is recorded on every version, so it is known. */
export function newVersionToast(
  doc: DocView,
  version: Version,
): { title: string; description: string } {
  const who = version.author === "agent" ? "the agent" : "you";
  return {
    title: `New version: ${versionName(doc, version.n)}`,
    description: `Made by ${who} in ${doc.name}. You're still editing v${doc.active}.`,
  };
}

export type VersionTarget = { doc: string; n: number };

/**
 * Whether an announced version's toast has stopped being true: the version
 * became active ("Now editing" says so), was deleted, or its document is no
 * longer the open one (Show diff acts on the open document's compare view).
 */
export function withdrawn(target: VersionTarget, open: DocView | null): boolean {
  if (!open || open.slug !== target.doc) return true;
  if (open.active === target.n) return true;
  return !open.versions.some((v) => v.n === target.n);
}

export type VersionAct = { send: ClientMsg } | { mode: "compare" } | { against: DiffSide };

/**
 * What each button does (Cole's ruling, 2026-09-28): two different use cases,
 * never combined. Activate is exactly the menu's `activate`. Show diff puts the
 * pane in compare mode against the new version, active on the left, and does
 * NOT activate.
 */
export function newVersionActs(kind: "activate" | "diff", target: VersionTarget): VersionAct[] {
  if (kind === "activate")
    return [{ send: { type: "activate", doc: target.doc, version: target.n } }];
  return [{ mode: "compare" }, { against: target.n }];
}
