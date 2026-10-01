---
type: item
title: "Scriptorium: Diff is enabled for a document with one version"
description:
  "GitHub #116: the Diff button is enabled with one version and the compare view
  then says the versions are identical; disable it and say there is nothing to
  compare."
status: draft
lifecycle: ready
id: 01a0f97e-9639-70b4-8804-2dc53f79e950
kind: bug
generated: { by: pdocs, at: 2026-10-01 }
source: "#116"
cycle: 2026-10-scriptorium-from-real-use-3
---

# Scriptorium: Diff is enabled for a document with one version

Filed as GitHub #116 from Cole's 5.0.1 session, 2026-10-01. With one version,
the Diff button is enabled, and the compare view it opens says "These two
versions are identical" (`CompareView.tsx`). The click is wasted, and
"identical" implies a comparison that never happened.

## Definition of done

- [ ] The Diff control is disabled while the document has one version, with a
      tooltip such as "Only one version — nothing to compare".
- [ ] Any other route into the compare view with one version (a shortcut, a deep
      link) shows that same message, never "identical".
- [ ] Driven in a real browser.
- [ ] #116 answered and closed once released.
