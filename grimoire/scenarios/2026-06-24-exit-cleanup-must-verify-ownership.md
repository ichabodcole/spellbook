---
date: 2026-06-24
spell: grapevine
rule: house-style.md → "Drive a conjuration through a daemon + thin CLI"
disposition: judgment-only
---

# Cleanup of shared state must verify ownership — an unconditional teardown is a footgun when instances share a namespace

## The situation

Rolling the grapevine daemon to a new release, then clearing the pile of orphan
daemons left by past test runs, the maintainer `kill`ed a stale race-loser
daemon. That daemon's `shutdown()` ran and **deleted both
`~/.grapevine/daemon.port` and `daemon.pid`** — the discovery files the **live,
healthy** 1.9.0 daemon depended on. The live daemon kept serving (its socket and
the connected team were fine), but every CLI now read an empty port file and
concluded "no daemon running." A hand-restore of the two files recovered it.

## What the familiar concluded

`shutdown()` cleans up after itself — it removes the port/pid files on exit.
Obviously correct: a daemon shouldn't leave stale lifecycle files behind. The
code did exactly that, unconditionally:
`if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE)`.

## What the mage wanted instead

The files are **shared state in a single namespace** (`$GRAPEVINE_HOME`), and
more than one daemon process can exist at once (race losers, stale-version
holdovers, test orphans). "Clean up after myself" silently became "clean up
after **whoever currently owns the slot**" — so a _dying_ process clobbered a
_living_ one's files. The fix is one predicate: delete the port file only if it
still holds **my** port, the pid file only if it still holds **my** pid
(`fileHasValue(PORT_FILE, String(server.port))`). A stale daemon whose slot was
already reclaimed leaves the files alone. That single guard also caps the blast
radius of every other lifecycle op (a mis-aimed `kill`, the new `reap`): even a
wrong kill can no longer cascade into orphaning the live daemon — which is what
let the rest of the operator-safety work (`reap`, `roll`) be built on top
without fear.

## The distilled judgment

When a process tears down **shared** state on exit — a lock file, a port/pid
registry, a well-known socket path, a "current" pointer — it must first confirm
it still **owns** that state, not just that the state exists. In any system
where multiple instances can transiently coexist (version rolls, races, leftover
test processes), unconditional cleanup turns a dying instance into a saboteur of
the live one, and the failure is invisible: the live process keeps running while
everything that _discovers_ it breaks. Guard every teardown with an ownership
check, and put the ownership truth where the live instance writes it (the daemon
owns its own port/pid — the thin CLI only reads). Then layer the operator tools
(diagnose / reap / roll) on that floor: once a stale process can't wipe a live
one's files, "kill the errant process" stops being dangerous.
