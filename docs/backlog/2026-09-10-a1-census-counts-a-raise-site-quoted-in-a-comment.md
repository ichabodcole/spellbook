---
type: backlog
title:
  "The A1 `choices` census counts a raise site that is only quoted in a comment"
status: stable
lifecycle: open
generated: { by: unknown, at: 2026-09-10 }
---

# The A1 `choices` census counts a raise site that is only quoted in a comment

**Filed:** 2026-09-10 · **Found by:** type-debt Phase 4c · **Area:**
`grimoire/lib/error-sites.ts`, `grimoire/error-choices-census.test.ts`

A comment in `src/grapevine/backend/cli.ts` that quoted a usage refusal
literally — `` `if (!name) die("usage: …")` `` — moved grapevine's census row
from 58 to 59 raise sites. The census's text scan read the comment as code. The
comment was reworded (the count returned to 58), so nothing is wrong in the tree
today; the instrument still has the hole.

This is the same class the launcher comments warn about ("prose and code are
indistinguishable to a regex") and that `daemon-lifecycle-ward` fixed for its
own clauses (comment-stripped `code` on every row). A census that counts prose
can move without the code moving — up here, and in principle down if a site's
only spelling is in a comment the scan skips.

**Likely fix:** scan comment-stripped text, as `daemon-lifecycle-ward` does, and
add a calibration cell: a comment quoting `die("…")` must not change a spell's
count.
