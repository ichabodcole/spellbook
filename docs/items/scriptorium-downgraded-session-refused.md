---
type: item
title: A converted session that 5.2.0 wrote to is refused by 6.0.0
description:
  After 6.0.0 restores a 5.2.0 session, any write by 5.2.0 adds old-shape chat
  entries, and 6.0.0 then refuses the whole session (exit 6) instead of
  converting the mixed manifest.
status: draft
lifecycle: triage
id: 01a177c2-9225-736c-8998-45fdfb660d6d
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-26 }
tags: [scriptorium, kit]
from: items/release-6-breaking-marker.md
---

# A converted session that 5.2.0 wrote to is refused by 6.0.0

Found by the no-stake verifier of `release-6-breaking-marker` (2026-10-26).
Evidence: `scratchpad/c6/mvx/rst2/restore.log`, script `mvx/restore2.ts`.

1. 5.2.0 makes a session, and 6.0.0 restores it, converting the manifest.
2. 5.2.0 then runs `open --restore` on it. It opens with exit 0 and sets
   `workspace` to `$HOME`, so its new files and imports would land in the home
   folder.
3. Any 5.2.0 write (version, task, note, `say`, `new-doc`) adds a chat line with
   `who` and millisecond times.
4. 6.0.0's `open --restore` then fails with exit 6: "was not written by
   scriptorium … will not read it". `looksLikeScriptorium`
   (`src/kit/workspace/session.ts`) refuses any manifest with a chat entry
   holding `who`, and the converter doesn't handle a manifest that is part kit,
   part 5.2.0.

`manifest.pre-migrate.json` keeps only the bytes from before the first
conversion, so rolling back to it loses everything done in 6.0.0. The 6.0.0
upgrade note tells adopters not to open a converted session with 5.2.0.

## Definition of done

- [ ] 6.0.0 restores a manifest that is part converted and part 5.2.0,
      converting the 5.2.0 entries, or refuses it with a message that says how
      to recover.
- [ ] Tested with a session 5.2.0 wrote to after a conversion.
