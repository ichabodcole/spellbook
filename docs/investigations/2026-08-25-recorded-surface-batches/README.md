# Recorded-surface batches — grapevine (full below-root) and bounty (SG-8)

**Date:** 2026-08-25 · **Session:** `standard-grapevine` channel, round 2 (item
2a of acc's below-the-root plan) · **Format:** acc recorded-surface batch v0
(`docs/plans/2026-08-25-the-recorded-surface-batch.md` in the acc repo, pinned
at `80104df`).

Captured per the spec: separated streams, verbatim UTF-8 bytes, exit codes
observed directly (no shell, no pipes — python subprocess), sentinel
`--acc-not-a-flag`, no root records, `path` a prefix of `argv`, every record
`completeness: complete`, one identity observation per batch.

## Files

- `grapevine.recorded-surfaces.json` — **32 records, one per declared below-root
  path** (every verb and alias the schema declares), captured from the Spellbook
  develop working tree (post-`1c61d13`). All exit 2; each stderr carries the
  verb-scoped `recognized flags:` enumeration. Identity: exit 0,
  `{"name":"grapevine","version":"2.2.0"}`.
- `grapevine.declaration.json` — the same tree's `schema` emission, regenerated
  at capture time (byte-comparable to the drift-experiment `clean` fixture).
- `bounty.recorded-surfaces.json` — 3 records (`state`, `claim`, `list` — the
  modelled-declaration paths). All exit 2 with the global-registry enumeration.
  Identity: **included verbatim as a failed observation** — bounty has no
  `--version`; the record is exit 2, empty stdout, `unknown verb` on stderr.
- `bounty.modelled.declaration.json` — the hand-written modelled declaration
  from the round-1 session (unchanged), for the SG-8 diff.

## Caveats, stated rather than assumed

1. **The version string narrows less than usual here.** Spellbook's release is
   deferred, so `2.2.0` currently names BOTH the plugin-cache build (which has
   no `schema` verb) and the develop working tree these records came from. The
   identity observation ties the batch to _a_ grapevine that answers
   `--version`; the `recordedBy` field carries the tree pointer that actually
   disambiguates. This is acc's "narrows, does not close" caveat in its sharpest
   live form.
2. **Observed enumeration size vs the pre-registration.** The SG-8 prediction
   was pre-registered as "roughly 17 of 21 accepted-not-declared for `state`".
   This capture's `state` stderr enumerates **22** `--` tokens. Recorded here
   before any diff is run; the kit's own read is the one that counts.
3. bounty's `claim` record errors on the unknown flag before its required
   positional is checked — the rejection is a flag rejection, as the read rules
   require.
