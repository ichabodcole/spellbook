---
type: item
title: The kit path answers an ended session with another session's hint
description:
  On the kit path, state or say on a session the human ended answers no running
  session with a hint naming a different session id, where the shipped app says
  the human ended it on purpose.
status: stable
lifecycle: done
id: 01a1486e-3c60-7055-b105-5f9dcffcbdd5
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# The kit path answers an ended session with another session's hint

Found by the migrate-hook verifier (2026-10-17). On the kit path, `state` or
`say` against a session the human ended answers "no running session" with a hint
naming a different session id. The shipped app says the human ended it on
purpose and not to reopen it. The cause is kit `verbs.ts` `endedBy`, used only
for a bound tail. This matters at the cutover.

## Definition of done

- [x] On the kit path, a verb against an ended session says the human ended it,
      as the shipped app does, with a test.

## Done and verified

`fix(kit): a verb with no --session reaches the newest session, and a human end says so`
on `impl/kit-cli-contract-v2` (2026-10-19), with two verifier rounds folded in.

**The human end.** The kit CLI's `requireSession` (`src/kit/workspace/verbs.ts`)
reads the manifest's `ended.by` for the session asked about before it falls back
to the generic hint. `by: "human"` answers `not_found` with the message
`the human ended session <id>`, a hint that says it was on purpose and not to
reopen it unless they ask (with `` `open --restore <id>` `` only for that case),
and no `choices`, so nothing invites the reopen. This is the shipped CLI's
`noSession` rule (`src/scriptorium/backend/cli.ts`), routed on `by`, not on
prose, as the SKILL's ended-session contract says. The kit's hints name bare
verbs, so the kit's wording drops the shipped `cli.ts` prefix.

**The session asked about, when none is named (the lead's ruling).** A verb with
no `--session` never silently reaches a session other than the newest one, live
or not. The first version still did: with an older session A live, after the
human ended B (the kit removes `latest` on a clean exit, and the discovery
fallback picked whatever was live) or after B crashed (the hardened `latest`
read skipped B's dead pid).

- **One recency rule: the session a daemon last started, new or restored.** The
  kit daemon records its session id in `last-opened.json`, beside the sessions
  folder (beside `prefs.json`), when it starts (`recordLastOpened`,
  `src/kit/wire/discovery.ts`). It outlives the daemon and its pointer, so B
  stays the newest even when A's manifest is written later. The write goes to a
  temp opened exclusively, mode 600, renamed over the file, so a symlink planted
  at its path is replaced, never written through. It is counted in
  `grimoire/kit-disk-write-ward.test.ts` (`server.ts::recordLastOpened`, and
  `recordLastOpened` among the writers from other folders).
- **A record that cannot be trusted is refused, never guessed past.** If it is
  corrupt, not a plain file of this user's, names no session, or names one no
  longer saved here, a bare verb (and a bare `tail`) answers `not_found`: "the
  newest <app> session is unknown: the record … cannot be trusted: <why>", the
  saved sessions as `choices`, and a hint to name one with `--session`. Only a
  home with no record at all (none of its daemons has started since the record
  existed) falls back to the newest manifest, so at the cutover the window is
  one daemon start.
- **The target's pointer is read by name.** A bare verb reads the newest
  session's own pointer; the temp directory's `latest` is no longer read by the
  kit CLI. `requireSession` treats a pointer whose pid is dead as not running
  (`pidAlive`, exported from `../wire/discovery`), so a crash is a `not_found`
  refusal naming the session with its own restore, rather than a transport
  failure on its port. `tail` still reads the dead pointer, so it grounds on B
  and ends with `tail.lost`, as the base and the shipped CLI do. A named
  `--session` whose daemon crashed is refused the same way; the shipped CLI
  answers that as an internal transport failure.

Tests:

- `src/kit/workspace/verbs.test.ts`: a human-ended session for `state`, `say`
  and `close`, named and as the newest saved; and, with B newest by the record,
  A live and A's manifest newer: B crashed (refused naming B, never reaching A;
  still B with A gone too), B ended by the human (the shipped refusal), B
  crashed under a bare `tail` (grounding on B, then `tail.lost` naming B), and a
  record naming a deleted session or a corrupt one (refused for `state`, `say`,
  `close` and `tail`, with the saved sessions as choices; a named session still
  reached). The contract tests that planted a `latest` pointer now plant the
  newest session's own pointer, with this process's pid, so no test signals a
  process it did not start.
- `src/kit/wire/discovery.test.ts`: the record written and read back (mode 600,
  no temp left), a planted symlink replaced with its target untouched, and a
  corrupt record or one naming no session read as untrusted.
- `src/kit/workspace/server.test.ts`: a daemon's start records its session, new
  and restored. `src/kit/workspace/daemon.integration.test.ts`: `open` through
  the launchers writes the record (its id, and when).

Mutations, each planted, seen red, and restored:

| Mutation                                                                                                  | Red    |
| --------------------------------------------------------------------------------------------------------- | ------ |
| the human-end branch off                                                                                  | 2      |
| the record ignored                                                                                        | 3      |
| the dead-pid check in `requireSession` dropped                                                            | 1      |
| the old `latest` read restored                                                                            | 5      |
| an untrusted record falls back to the newest manifest                                                     | 1      |
| the record's "still saved" check dropped (the verifier's M12)                                             | 1      |
| the record written with a plain `writeFileSync`                                                           | 2      |
| the record's plain-file check dropped                                                                     | 1      |
| the daemon's start write dropped (`server.test`, and `daemon.integration`'s own test, the verifier's M13) | 1 each |

Driven side by side on scratch homes: the verifier's repros (`ended.ts` human,
agent and crash, with and without a live A, and `tailcrash.ts live`) give the
shipped answers on the kit path, except that a crashed session is a `not_found`
refusal where the shipped CLI gives an internal transport failure.

## Port-back notes

- `src/kit/workspace/verbs.ts`: `requireSession` checks the session asked about
  with the existing `endedBy` and refuses a human end with its own message and
  hint and no `choices`; `newestSession()` (the record, refusing an untrusted
  one; else the newest manifest) is the target of every verb with no
  `--session`, read by name; a pointer whose pid is dead is not running. Story
  Studio's `requireSession` at `develop` `5b3bd8d`
  (`packages/kit/src/workspace/verbs.ts:429`) uses `endedBy` only for a bound
  tail, and reaches a bare verb through `latest` and its live-pointer fallback.
- `src/kit/wire/discovery.ts`: `recordLastOpened` and `readLastOpened` (the
  record, beside the sessions folder), a private `writePointerFile` (random temp
  name, `wx`, mode 600, rename), `ownedByMe`, and `pidAlive` exported (Story
  Studio already exports it).
- `src/kit/workspace/server.ts`: the daemon calls `recordLastOpened` after it
  publishes its pointer.
