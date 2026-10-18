// What the frontmatter header makes of a document's profile (`DocumentProfile`,
// the daemon's `profile` answer), as plain data: the kind chip's label and hover
// text, the warning chip's words, and the chat message "Ask the agent to fix"
// posts. The header draws them; nothing here decides whether a warning is right.
//
// A document with no profile (`match: "none"`), in a world with none or of a kind
// none describes, gets nothing from here: the header is exactly as it was.

import type { DocumentProfile, ProfileWarningView } from "../workspace/protocol";
import type { FrontmatterChip } from "./FrontmatterHeader.tsx";
import { stringField } from "./frontmatter.ts";

/**
 * Whether the answer is about the block on screen. The answer is read from the
 * active version on disk, a beat behind the text being typed: while its `type`
 * differs from the block's (the human just changed it), it is not shown, so the
 * header never labels a document with the kind it is leaving.
 */
export function profileFits(
  profile: DocumentProfile | null | undefined,
  fields: Readonly<Record<string, unknown>>,
): profile is DocumentProfile {
  if (!profile || profile.match === "none") return false;
  return stringField(fields, "type") === profile.type;
}

/**
 * The profile answer when it is about the version on screen: the same document,
 * and the version it was read from still the active one. Another version made
 * active shows nothing until its own answer comes, never the last one's chip.
 */
export function profileFor(
  profile: DocumentProfile | null,
  doc: { slug: string; active: number },
): DocumentProfile | null {
  if (!profile || profile.doc !== doc.slug) return null;
  return profile.version === undefined || profile.version === doc.active ? profile : null;
}

/** The kind chip's hover text: the file the profile came from, and its shared files. */
export function profileSourceTitle(profile: DocumentProfile): string {
  const from = `${profile.label ?? profile.type ?? "This"} profile, from ${profile.sourceShown ?? profile.source ?? "?"}`;
  const refs = profile.refs ?? [];
  return refs.length === 0 ? from : `${from}\nShared fields from ${refs.join(", ")}`;
}

/** The words on the quiet chip beside a kind the world does not count as canon. */
export const NOT_CANON = "not canon";

/**
 * The kit's chips with the profile applied: the `type` chip shows the profile's
 * label ("Location") in place of the raw value, and names its file on hover. A
 * kind whose profile says `"canon": false` gets a quiet "not canon" chip just
 * after it ("Guide · not canon · stable"). Any other answer leaves the chips as
 * they are.
 */
export function withProfileLabel(
  chips: readonly FrontmatterChip[],
  profile: DocumentProfile | null,
): FrontmatterChip[] {
  if (profile?.match !== "matched" || !profile.label) return [...chips];
  const label = profile.label;
  const title = profileSourceTitle(profile);
  // No key: it shows the profile's word, not a frontmatter field, and claims none.
  const notCanon: FrontmatterChip = {
    label: NOT_CANON,
    tone: "faint",
    title: `The world does not count ${label} documents as canon (${profile.sourceShown ?? "its profile"} says "canon": false)`,
  };
  return chips.flatMap((c) => {
    if (c.key !== "type") return [c];
    const typed = { ...c, label, title };
    return profile.canon === false ? [typed, notCanon] : [typed];
  });
}

/** "1 profile warning", "3 profile warnings". */
export function warningCountLabel(n: number): string {
  return `${n} profile warning${n === 1 ? "" : "s"}`;
}

/** Words as a sentence: a capital first, and a full stop unless they end already. */
export const profileSentence = (s: string) => {
  const t = s.trim();
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?!]$/.test(capped) ? capped : `${capped}.`;
};

/** A warning's message as the popover lists it: a sentence. */
export const warningSentence = (w: ProfileWarningView) => profileSentence(w.message);

/**
 * The chat message "Ask the agent to fix" posts for one warning, from the
 * human: the document, the problem, the file whose rule it is, and the fix in
 * words. The document is the message's subject (`about.path`), so the agent has its path.
 */
export function askFixText(profile: DocumentProfile, w: ProfileWarningView): string {
  const rule = w.fileShown ?? profile.sourceShown;
  return [
    `Please fix this profile warning in ${profile.shown}: ${profileSentence(w.message)}`,
    rule ? `The rule is in ${rule}.` : "",
    w.fix ? `Suggested fix: ${profileSentence(w.fix)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The file to fix for a broken kind: the shared file it refers to when that is
 * what is broken (`through`), else the kind's own file.
 */
export function brokenFileShown(profile: DocumentProfile): string {
  return profile.throughShown ?? profile.sourceShown ?? profile.source ?? "its profile file";
}

/** The chat message for a document whose kind's profile file is broken. */
export function askBrokenText(profile: DocumentProfile): string {
  const file = brokenFileShown(profile);
  const why = profile.reason ? `cannot be used (${profile.reason})` : "cannot be used";
  const via =
    profile.throughShown && profile.sourceShown
      ? ` ${profile.sourceShown} refers to it, so the fix goes in the shared file.`
      : "";
  return `The profile for ${profile.shown} is broken, so it is not checked: ${file} ${why}.${via} Please fix ${file}.`;
}
