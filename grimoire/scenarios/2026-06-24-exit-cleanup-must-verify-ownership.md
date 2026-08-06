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

## Boundary check — added 2026-08-06, after the rule was obeyed and the failure happened anyway

**Ownership-of-the-delete is not ownership-of-the-namespace, and the rule above
only governs the delete.**

The rule propagated well. Four spells built after it — bounty, glamour, imago,
magpie — each implement the predicate faithfully
(`if (parsed.session_id === sessionId) unlinkSync(latestFile)`). None of them
ignored it.

**And all four put that pointer in `tmpdir()`,** where the filename is shared
with every process on the machine. The scenario above reasons about
`$GRAPEVINE_HOME` — a namespace the spell **controls**, shared between a handful
of its own daemons. That premise is what makes an ownership check sufficient,
and it was never written down, so it did not travel. The guard is the visible
artifact; the condition that makes the guard enough is invisible, and it is
silently re-assumed at every copy.

The failure this leaves open is not a bad teardown — it is a **claim-time
collision**. A daemon writes the pointer, and any daemon booting anywhere
overwrites it before the first one's caller reads it back. Measured on bounty
(2026-08-06): a joiner emitted `type:"joined"` and connected **to a foreign live
board**, exit 0 — a silent mis-join, not the clean "session not running" error
the shipped code's own comment promised.

**So the imperative gains its boundary: verify ownership before you release
shared state, AND own the namespace you claim in.** If the namespace is
machine-global, no teardown discipline can save you, because the damage is done
before any teardown runs. See `house-style.md` → "Drive a conjuration through a
daemon + thin CLI" for the placement rule this produced.

**The transmission lesson, which is the general one:** a scenario carries its
**imperative** with high fidelity and its **premise** invisibly. Four correct
implementations, four identical defects, zero deviations. When you write one,
state the boundary — it is the half that does not travel on its own.
