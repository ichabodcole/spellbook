/**
 * Comparing and merging: the active version against the original or another
 * version (`compare`), and taking named hunks from that side into the active
 * version (`merge`), through the documents' `edit` so a merge obeys every
 * rule a keystroke does. Tier 4 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core and the
 * `documents`.
 */

import { readFileSync } from "node:fs";
import { docFormat } from "../../lib/docFormat.ts";
import { describeJsonProblem, jsonProblem } from "../../lib/json.ts";
import { applyHunks, diffText } from "../diff";
import type { DiffPayload, DiffSide, Doc, Version } from "../protocol";
import type { Documents } from "./documents.ts";
import { SessionError } from "./errors.ts";
import { sideName } from "./names.ts";
import type { State } from "./state.ts";

export class Compare {
  constructor(
    private readonly core: State,
    private readonly documents: Documents,
  ) {}

  /**
   * The text of one side of a comparison. `"original"` is read from disk, not
   * from a cache: the point of comparing against it is to see what the file of
   * record says right now, including a change someone else made while this
   * session was open.
   */
  private sideText(d: Doc, side: DiffSide): string {
    if (side === "original") return readFileSync(d.original, "utf8");
    this.documents.versionOrDie(d, side);
    return readFileSync(this.core.versionPath(d, side), "utf8");
  }

  /**
   * Compare the active version (left) against another side (right).
   *
   * With `pick`, the side is the first whose text differs from the active
   * version's: the file on disk, then the other versions, newest first. A
   * comparison opened on a side that matches could only say "identical" (the
   * agent's `version-new` without a body is an untouched copy). When none
   * differs it is `against`, and the payload says `everyMatches`.
   */
  compare(opts: { doc?: string; against: DiffSide; pick?: boolean }): DiffPayload {
    const d = this.documents.docOrDie(opts.doc);
    const left = readFileSync(this.core.versionPath(d, d.active), "utf8");
    if (opts.pick) {
      const sides: DiffSide[] = [
        "original",
        ...d.versions
          .map((v) => v.n)
          .filter((n) => n !== d.active)
          .sort((a, b) => b - a),
      ];
      for (const side of sides) {
        let right: string;
        try {
          right = this.sideText(d, side);
        } catch {
          continue; // a file gone from disk is no side to open on
        }
        if (right !== left)
          return {
            doc: d.slug,
            active: d.active,
            against: side,
            diff: diffText(left, right),
            picked: true,
          };
      }
    }
    if (opts.against === d.active)
      throw new SessionError(
        `v${d.active} is the active version of ${d.slug}: comparing it with itself says nothing`,
        400,
      );
    return {
      doc: d.slug,
      active: d.active,
      against: opts.against,
      diff: diffText(left, this.sideText(d, opts.against)),
      ...(opts.pick ? { picked: true as const, everyMatches: true as const } : {}),
    };
  }

  /**
   * Take named hunks from `against` into the active version.
   *
   * The write goes through `edit`, which is what makes a merge obey every rule
   * an ordinary keystroke obeys: it lands on the active version and never the
   * original, and check-before-write preserves an outside write as a new
   * version first. A merge writing the file directly would be the one path into
   * the document that could silently clobber the agent.
   */
  merge(opts: { doc?: string; against: DiffSide; hunks: number[]; json?: "refuse" }): {
    slug: string;
    version: number;
    text: string;
    applied: number;
    preserved: (Version & { path: string }) | null;
  } {
    const d = this.documents.docOrDie(opts.doc);
    const payload = this.compare({ doc: d.slug, against: opts.against });
    const known = new Set(payload.diff.hunks.map((h) => h.id));
    const missing = opts.hunks.filter((id) => !known.has(id));
    if (missing.length)
      throw new SessionError(
        `${d.slug} has no hunk ${missing.join(", ")} against ${sideName(opts.against, d.name)}: ` +
          `it has ${known.size === 0 ? "none" : `1..${Math.max(...known)}`}. Run diff again: ` +
          `the text changed under the numbers.`,
        409,
      );
    const before = readFileSync(this.core.versionPath(d, d.active), "utf8");
    const text = applyHunks(before, payload.diff.hunks, opts.hunks);
    // The agent's merge must leave a JSON document parsing; the human's may not,
    // since they can see the text and fix it.
    if (opts.json === "refuse" && docFormat(d.original) === "json") {
      const p = jsonProblem(text);
      if (p) {
        const from = sideName(opts.against, d.name);
        throw new SessionError(
          `taking change${opts.hunks.length === 1 ? "" : "s"} ${opts.hunks.join(", ")} from ${from} into v${d.active} of ${d.name} would leave invalid JSON (${describeJsonProblem(p)}, in the merged text): fix ${from}, or take fewer changes. Nothing was merged.`,
          409,
        );
      }
    }
    const { preserved } = this.documents.edit(d.slug, d.active, text);
    return {
      slug: d.slug,
      version: d.active,
      text,
      applied: opts.hunks.filter((id) => known.has(id)).length,
      preserved,
    };
  }
}
