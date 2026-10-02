// The review rule at a write: what `pdocs set` and `pdocs new` ask before they
// touch the tree. One function, so the two commands refuse the same change the
// same way.
//
// It compares the review rule's violations before and after the PROPOSED
// change. Under `checks.workItemReview.mode: strict` a violation the change
// INTRODUCES — a start, a cycle start, a join to the active cycle, an
// unreviewed item filed straight into started work — is refused before
// anything is written. One that was already there is not: a repair, or an
// unrelated edit to an item that already needs review, stays possible. A
// combined `--status stable --lifecycle active` is evaluated as one proposed
// state, so it succeeds.

import {
  REVIEW_SETTING,
  type ReviewItem,
  describeReviewItem,
  reviewAdvisory,
  reviewItems,
  reviewViolations,
} from "./advisories.ts";
import { ConflictError } from "./envelope.ts";
import type { Ctx } from "./lint/rules.ts";
import type { WorkEntity, WorkModel } from "./work.ts";

/**
 * Whether a finding is new: its item did not need review before, or it did
 * only as an unstarted member of the active cycle and is now started. Starting
 * an item the cycle already flagged is a start like any other; stepping one
 * back, or any edit that leaves its reason as it was, is not.
 */
function isIntroduced(f: ReviewItem, was: ReadonlyMap<string, ReviewItem["reason"]>): boolean {
  const before = was.get(f.path);
  return before === undefined || (before === "active-cycle" && f.reason === "started");
}

/**
 * The review findings among `touched` (entities of `after`) once the change is
 * made. Throws a `ConflictError` (exit 6) in strict mode when any of them is
 * introduced by it (`isIntroduced`). `command` says how the caller retries:
 * `set` names the item, which exists; `new` wrote nothing, so the same `new`
 * runs again with `--status stable`.
 */
export function reviewGuard(
  ctx: Ctx,
  before: WorkModel,
  after: WorkModel,
  touched: readonly WorkEntity[],
  command: "set" | "new" = "set"
): ReviewItem[] {
  const findings = reviewItems(after, touched);
  const mode = ctx.config.checks.workItemReview.mode;
  if (mode !== "strict" || findings.length === 0) return findings;
  const was = new Map(reviewViolations(before).map((f) => [f.path, f.reason] as const));
  const introduced = findings.filter((f) => isIntroduced(f, was));
  if (introduced.length === 0) return findings;
  const first = introduced[0] as ReviewItem;
  const one = introduced.length === 1;
  const retry =
    command === "new"
      ? "run this same `pdocs new` command again with `--status stable` added"
      : `run \`pdocs set ${first.ref} --status stable\` — in the same command as the start or join, if you like`;
  throw new ConflictError(
    `refusing: ${REVIEW_SETTING} is strict, and this change would leave ` +
      `${one ? "an item" : `${introduced.length} items`} started or in the active cycle without a reviewed ` +
      `document (\`status: stable\`): ${introduced.map(describeReviewItem).join(", ")}. Show the user ` +
      `${one ? "its" : "each one's"} description and definition of done; once they approve it, ${retry}. ` +
      "Nothing was written.",
    { details: { advisory: reviewAdvisory(introduced, mode) } }
  );
}
