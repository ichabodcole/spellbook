# Grapevine: `close` soft-by-default (or a confirm guard)

**Added:** 2026-06-28 **Origin:** extracted from the grapevine-backlog living
doc (now archived); grapevine-feedback triage (robin lost a shipped feature's
design dialogue to a `close`). **This is a decision, not just a task.**

`close` deletes the message log. V1.7 shipped `archive`/`unarchive` as the
non-destructive path, which mitigates this — but `close` is still
**destructive-by-default** and the safe path is opt-in, so the footgun remains
for anyone who reaches for the obvious verb.

**Options (pick one):**

- Leave as-is — `archive` is the documented safe path; `close` stays the
  explicit "I mean it" verb. (Cheapest; relies on the user knowing `archive`.)
- Add a typed-confirmation / `--yes` guard so deletion isn't a single keystroke.
- Flip the default: `close` archives (soft-preserve), opt-in `--purge` deletes
  (robin's suggested shape). Larger behavioral change; clearest safety story.

Cross-references the `restart --force|--yes` live-fleet guard already shipped —
same "destructive op wants a guard" instinct.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — `close` dispatch;
  `archive`/`unarchive` already exist as the soft path.
