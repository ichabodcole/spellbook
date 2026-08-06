# Glamour: `open` prints a URL and port for a daemon that is already gone

**Added:** 2026-08-06

Found during the `spell-hardening` P0 ratify round while fixturing a different
defect. **Not among the fourteen**, and out of P0's scope. Same defect class as
the rest of that project — **reports success, does not apply** — which makes it
the fourth independent instance of that shape found in one session.

## The observable (measured, and this part is not in doubt)

```
server.ts run DIRECTLY   ->  alive at t+4s, /state = 200        <- the daemon is HEALTHY
cli.ts open --no-open    ->  prints {"url":…,"port":51131,…}, exit 0
                             server procs at t+300ms:  0        <- and at every checkpoint to t+4.2s
```

The CLI receives a **real handshake**, so the daemon genuinely starts and
prints. It then dies between that print and ~300ms later. **The caller is handed
a URL and a port, exit 0, for something that no longer exists.**

Corroborating, from the canon side: `glamour/SKILL.md` documents a **60s idle
retirement**, and death was measured in **under 6s** — so this is against the
book, not a documented behaviour.

## Hypothesis — explicitly UNPROVEN, do not quote it as the cause

`cli.ts:326-332` spawns with `detached: true` + `unref()` but
`stdio: ["ignore", "pipe", "inherit"]`. The CLI reads the handshake off that
pipe and exits; the pipe's read end and the inherited stderr go with it, and the
daemon dies on its next write.

**That story fits every observation and the one-variable control was not built**
— same spawn with the parent held open. Anyone picking this up should run that
first rather than inheriting the theory.

## Acceptance Criteria

- [ ] **Isolate the mechanism** with the parent-held-open control before
      changing anything.
- [ ] **A daemon that `open` reports as ready is still alive** when the caller
      uses the URL it was just given.
- [ ] **Or `open` fails loudly** if the daemon does not survive its own startup
      — the unacceptable outcome is the current one, where a dead daemon is
      indistinguishable from a live one at the call site.
- [ ] **Check the sibling spells for the same spawn shape.** The pattern is
      shared; if the mechanism is confirmed, it is unlikely to be glamour's
      alone.

## Notes

The reason this matters beyond glamour: it is the same family as the
[session-key hijack](./2026-08-06-bounty-session-key-hijack-and-identity.md) and
`bounty add`'s ignored `applied` (#83) — **an envelope that describes a world
that is not there.** The
[CLI-contract investigation](../investigations/2026-08-06-spell-cli-contract-investigation.md)
is where "what does a success envelope actually promise" gets settled; this is
another datum for it.
