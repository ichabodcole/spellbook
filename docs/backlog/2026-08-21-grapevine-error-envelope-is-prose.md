# Backlog — grapevine's error envelope is prose, on a CLI that is JSON everywhere else

**Status:** idea / backlog (not scheduled). Captured 2026-08-21. Measured, not
suspected.

## The finding

grapevine emits **JSON on stdout for every success path** (`printJson`, with
`--human` as the opt-out), and **prose on stderr for every failure** — a bare
`grapevine: <message>` from `die()`, exit 2.

An agent driving grapevine can machine-read every success and must regex every
failure. On a CLI whose entire purpose is agent-to-agent coordination, the half
that reports _why something went wrong_ is the half a machine cannot parse.

Measured:

```
$ grapevine --acc-probe-xyzzy-flag
grapevine: unknown command: --acc-probe-xyzzy-flag     # stderr, prose, exit 2
$ grapevine --version
{"name":"grapevine","version":"2.2.0"}                 # stdout, JSON, exit 0
```

## Why it came up

Found by an external conformance kit
([agent-cli-conformance](https://github.com/ichabodcole/agent-cli-conformance)
v0.2.0, rule **B5** — "machine mode holds on parser errors") during a trial on
branch `chore/agent-cli-conformance-trial`. The kit reported:

> `FAIL B5 — machine mode via the declared default and the parser error came back as prose on stderr (exit 2)`

**The interesting part is why we never caught it ourselves.** `cli.test.ts` has
107 tests and none of them compare the success envelope to the error envelope.
The error path has been prose since the first commit, so nothing ever had reason
to contrast the two. It took a tool with no stake in our history to put them
side by side. (Round 1 of the same trial found nothing here — the rule couldn't
reach us until v0.2.0 added a way to declare that machine mode is our default.)

## Why it is not already fixed

Deliberately deferred rather than done in the trial branch. Fixing it means
touching every `die()` call site (~50) and changing grapevine's **stderr
contract**, which every existing consumer — including anthill seats and the
bounty/grapevine tooling — reads today. That is a breaking change and a product
decision, not a drive-by.

## Shape of a fix, if taken

Open questions, all real:

- **Where does the structured error go?** stderr (keeps stdout data-only,
  satisfies B1) or stdout (easier for naive consumers)? B5 accepts either.
- **Envelope shape.** The spell-hardening project already built an
  outcome-envelope contract; this should reuse it rather than invent a second
  one.
- **Compatibility.** Prose is what humans at a terminal read. A `--human`
  fallback on the error path mirrors the success path and keeps both audiences.
- **Blast radius.** Every consumer that greps grapevine's stderr today.

Likely belongs to **spell-hardening** rather than a standalone item — it is
exactly the "success-shaped lies" / envelope-conformance family sprints 02 and
05 worked in.

## Related

- Sibling spells almost certainly share this: they were generated from the same
  scaffold, and `astrolabe` shows the identical prose-error shape
  (`astrolabe: unknown verb '--version'`). Worth checking the whole roster
  before scoping — a per-spell fix would be the wrong unit of work.
