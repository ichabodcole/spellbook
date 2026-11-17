---
type: session
title: Keep mine overwrites only what it showed — 2026-11-17
description:
  Save after the Changed-on-disk banner now writes only over the outside text
  the banner was raised for; a newer missed change is asked about again.
tags: [kit, save, conflict]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Keep mine overwrites only what it showed — 2026-11-17

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md).

## Context

Once the "Changed on disk" banner was up, the next Save counted as Keep mine. If
a second outside write was also missed, Save overwrote it unseen.

## What Happened

Ported Story Studio's rule (kit-parity message 62). When the banner is raised,
the session records the hash of the outside text shown (`Doc.outsideHash`). At
Save with the flag up, a file whose hash is neither that, nor the original, nor
the text being saved is refused (409) and asked about again with the new hash;
the next Save writes. A watched newer change while the flag is up also asks
again (it used to be dropped). The hash survives a restart; a flag raised fresh
at restore records the current hash. `DocView` carries the hash, optional, so
the pane's comparison and the toast pick up the newer text. An old manifest
(flag up, no hash) asks once more, without saying "again".

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
Bash); `general-purpose` (`*`) chosen.

It confirmed every hash is taken over the same bytes (a BOM and CRLF probe),
traced the watch, restore, missing-then-back, revert and save paths, probed an
old manifest, and reverted `session.ts` (4 new tests fail). Gate exit 0.
Verdict: with fixes — the restore hunk had no test. A test was added (it fails
with the hunk removed) and the refusal's wording fixed for old manifests; a
focused re-review forced each wording branch and confirmed both are guarded.
Ready.

Landing note: the branch's dist rebuild conflicted with develop's after other
branches landed, so the source commits were replayed on develop (identical
patches, checked with `git range-diff`) and dist rebuilt once.

## Follow-up

- [kit-reload-keeps-outside-flag](../../kit-reload-keeps-outside-flag.md), in
  triage: a clean reload keeps the flag, where Story Studio clears it.

---

**Related Documents:**

- [A second missed outside change after the banner is overwritten without asking](../item.md)
