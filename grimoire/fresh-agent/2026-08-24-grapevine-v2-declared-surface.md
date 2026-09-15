# Fresh-agent run — grapevine V2.0 (declared surface), 2026-08-24

**Context:** ward-mandated ergonomics re-run after the declared-surface revision
(`feat/grapevine-self-declaration`): per-verb flags, bare invocation now errors,
`schema` verb. Fresh agent (alias `verdigris`) given SKILL.md only, isolated
`GRAPEVINE_HOME`, walked a full first session including deliberate mistakes.

**Verdict: onboardable from SKILL.md alone, no blockers.** The V2.0 banner and
"Flags are per-verb" note prepared it for every error it hit; the per-verb
rejections (verb named + `recognized flags:` set) and arity errors
(`expects: mark <name> <id> <disposition>`) taught the fix in one read each.
`--body-file` round-tripped backticks/`$`/quotes byte-perfect; `schema` output
matched the parser's actual behavior on spot-check.

**Findings** (fixed in-branch / routed to backlog):

1. _confusing_ — `wait` returns raw `kind:"status"` frames as messages; the
   folding rules cover `tail`/`pull`/`read` but the documented poll-consumer
   recipe gets disposition metadata as chat bubbles. → backlog
   (`docs/backlog/2026-08-24-grapevine-status-frame-leaks.md`).
2. _confusing_ — SKILL.md's send row bracketed identity as optional; it is
   required (exit 2). → fixed in-branch.
3. _papercut_ — `prune` (reap alias) enumerated by the CLI, absent from
   SKILL.md. → fixed in-branch.
4. _papercut_ — `mark` returns the bare status frame, not an `{ok, …}` envelope
   like every other verb. → backlog (same note).
5. _papercut_ — `tail --last <n>` replays fewer than n bubbles when the window
   contains status frames (dropped by design); grounding line also counts status
   frames as "earlier messages". → backlog (same note).

**Pattern worth keeping:** the errors, not the doc, did the last mile of
teaching — the declared-surface work's aim, observed working on a cold reader.
