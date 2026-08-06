# A performed `--restore` is as unannounced as a skipped one

**Added:** 2026-08-06

Found during `spell-hardening` sprint 01's P0b field work. **Not among the
fourteen**, and deliberately **not** folded into P0b.

`spell-hardening` P0b adds `restoreSkipped` so that a **discarded** `--restore`
stops being silent. But a `--restore` that **works** is equally silent — the
envelope looks the same either way. So after P0b a caller can distinguish
"skipped" from "not skipped", and still cannot distinguish "restored 97 tasks"
from "restored nothing because the snapshot was empty."

That matters because `--restore` is a **recovery** verb: it is reached only
after the caller has already accepted something is wrong, which is exactly when
they are primed to believe a thin result.

## ⚠ Do not mint a field name for this

The obvious move — add `restorePerformed` or similar — is blocked. `#82` governs
cross-tool envelope vocabulary and is on hold, and sprint 01 measured that
**`restoreSkipped`, `snapshotBackedUp` and `hydrated` do not exist anywhere
yet**. They will each be spelled for the **first** time, possibly in different
phases and different sessions — and **a first spelling has no prior spelling to
disagree with, so no grep, no test and no reviewer catches a divergence.**

**Route this to the CLI-contract investigation**, which owns envelope shape, and
let the name be minted once with its siblings. It is not currently recorded
there — that is the gap this file closes.

## Acceptance Criteria

- [ ] The contract investigation carries the question: does a "skipped" field
      owe a positive twin, here and on the other destructive verbs
      (`snapshotBackedUp` raises the identical question for `close`)?
- [ ] Whatever is decided, it is decided for the family, not for `--restore`
      alone.

## References

- `docs/projects/spell-hardening/sprints/01-drained-exit/plan.md` — candidate 4,
  and the "Vocabulary: the freeze guards the WRONG direction" section for the
  measured evidence
- `docs/investigations/2026-08-06-spell-cli-contract-investigation.md` — the
  intended home
- Related: `#82`, `#85`–`#88`
