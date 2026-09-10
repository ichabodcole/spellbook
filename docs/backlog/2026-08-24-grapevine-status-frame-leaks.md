# grapevine: status frames leak through `wait`, and two folding papercuts

**Found:** 2026-08-24, fresh-agent ergonomics run for the V2.0 declared-surface
revision (findings 1, 4, 5 of
`grimoire/fresh-agent/2026-08-24-grapevine-v2-declared-surface.md`). **Status:**
backlog — pre-existing V1.9 behavior, out of scope for
`feat/grapevine-self-declaration`.

The V1.9 disposition model says status frames are metadata, folded into their
target message, never chat bubbles: `tail` drops them, `pull`/`read` fold them
into a `disposition` badge. Three places don't honor that:

1. **`wait` returns raw `kind:"status"` frames in `messages`.** The documented
   poll-consumer recipe (Codex loop) therefore processes disposition metadata as
   chat bubbles. Fix: apply the same fold/drop the daemon's pull path uses to
   the wait path.
2. **`mark` returns the appended status frame itself** rather than an `{ok, …}`
   envelope — the only data verb whose success response has no `ok`. A script
   checking `.ok` gets `null`. Fix: wrap in the standard envelope
   (`{ok: true, ...frame}`), or document the exception.
3. **`tail --last <n>` and the grounding line count status frames.** `--last 2`
   can replay one bubble (the other slot was a dropped status frame), and "M
   earlier messages exist" overstates readable history. Fix: count/slice over
   non-status frames.

All three are one design decision applied inconsistently — worth fixing as one
small chore branch. Tests: extend the disposition describe block in
`cli.test.ts` (wait-after-mark, mark envelope shape, --last window spanning a
status frame).
