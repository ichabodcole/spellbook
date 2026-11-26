---
type: item
title:
  Catch the reconcile faults the tests miss, first an original back with other
  text
description:
  21 of 44 faults planted in session/reconcile.ts at S9 pass every test; the
  worst lets Save overwrite an outside edit without asking.
status: draft
lifecycle: triage
id: 01a2173c-08f2-74b9-9929-0bf0ceacef84
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-26 }
parent: feature/kit-split
from: items/kit-split-s9/sessions/2026-11-26-kit-split-s9.md
---

# Catch the reconcile faults the tests miss, first an original back with other text

S9's adversarial review planted 44 single faults in `session/reconcile.ts` and
its call sites. 21 pass the Definition of done's files, `src/kit/workspace` and
`tests/architecture`. None came in with S9.

**The one that matters most:** when a missing original comes back with different
text, `outsideChanged` is not set. Save can then write over that outside text
without asking: the "reverts an outside edit" risk S9 named.

**Announced twice:** a changed version file not owned, so an identical repeat
write is announced again; an adopted version not owned, so adoption is
re-announced as a change; `markMissing` re-announcing a document already
missing.

**State and order:** a clean reload skipping `persist`, or persisting before
`writeActive`; missing → back dropping `relink`; the renumber threshold `<` →
`<=`; `markMissing` skipping `persist`; `originalsUnder` never reporting
`original.back`; `onFileEvents` adding a bundle event for a deleted member; the
bundle branch or `refreshBundle` skipping `refreshListed`; `revert` keeping
`outsideHash` or skipping `persist`; `forgetDoc` skipping `relink` and
`closeOrphaned`.

**Matching:** `originalsUnder`'s prefix check without the separator (a sibling
sharing a name prefix); the version-file pattern ignoring the extension; nested
paths under `docs/` accepted. (Two more were near-equivalent: the held-doc check
in `onFileEvents`, and adopting without a sort.)

## Definition of done

- [ ] A test fails when an original that comes back with other text is not
      marked changed, and Save then refuses as it does for any outside change.
- [ ] Each other fault above, planted alone, fails a test (or is shown
      unobservable and noted here).
- [ ] No existing test's expectations change.
- [ ] The gate passes.

## Related Documents

- [The watcher's reconcile (S9) — 2026-11-26](./kit-split-s9/sessions/2026-11-26-kit-split-s9.md)
