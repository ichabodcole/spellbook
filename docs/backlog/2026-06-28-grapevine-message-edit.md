# Grapevine: message edit (`kind:"edit"`)

**Added:** 2026-06-28 **Origin:** extracted from the grapevine-backlog living
doc (now archived); V1.7 design conversation. **Scope:** proposal-sized —
field-naming and render decisions warrant a project folder when promoted.

Let a message's sender post a corrected/updated version; renderers show the
edited content with an "edited" indicator. The self-correction case (complements
`kind:"correction"`, which is correcting someone else's message).

**Sketch:**

- New `kind:"edit"` with a required reference to the original (`in_reply_to` or
  a distinct `edits`/`supersedes` field — see open questions). Append-only:
  original stays in the JSONL; the edit supersedes it for rendering. Honors the
  "JSONL is the contract" principle.
- Watch UI renders edited content + an "edited" indicator (optional
  hover-to-show-history). CLI `tail` emits the edit unchanged; consumers opt to
  follow the chain. Honor-system authorization: daemon checks the editor's alias
  matches the original sender's.

**Open questions (why it's proposal-sized):** field naming (`in_reply_to` vs
`edits`/`supersedes`); edit-of-edit chains (point at original vs previous); edit
window (time-limited vs unbounded); render of the original (hidden vs
collapsed).

Pairs with threading + correction (V1.7) and grep (V1.6) — all share the
"messages reference other messages" model.

## References

- `plugins/spellbook/skills/grapevine/scripts/daemon.ts` — `Message.kind` union,
  `broadcast`
