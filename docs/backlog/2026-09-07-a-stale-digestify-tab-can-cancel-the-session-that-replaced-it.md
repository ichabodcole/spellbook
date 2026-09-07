# A stale digestify tab can cancel the session that replaced it

**Filed:** 2026-09-07 · **Found by:** the digestify conversion's browser drive ·
**Pre-existing:** yes — identical in `template.html` at `f4ee01b`. **NOT fixed
on that branch**, per the behaviour-faithful ruling.

## The behaviour

Digestify's session recovery works by re-binding the port encoded in the session
id (`digestify-<hex>-p<port>`), so that the relaunched page lands on the **same
origin** and the browser hands it the same `localStorage` draft. That is the
whole mechanism, and it is documented in `SKILL.md` under **Session Recovery**.

The consequence nobody had written down: **the user's OLD tab is still pointed
at that origin.** Its `beforeunload` handler beacons `/left` always and
`/cancel` when the user has interacted. So if the user closes (or reloads, or
navigates away from) the stale tab **after** the agent has relaunched:

1. the old tab beacons `POST /cancel` to `http://127.0.0.1:<same port>/`
2. that is now the NEW daemon
3. the new daemon resolves exit **130**, "closed without submitting"

The user sees their freshly restored review die the moment they tidy up the tab
it was restored from.

## How it was found

Not by reasoning — by losing an hour to it. The conversion's drive boots several
daemons on one port (which is what exercising origin-scoped `localStorage`
requires) and reported "the page will not render" on the second boot. The second
daemon had already exited 130, killed by the first page's departure beacon.

## Why it is not fixed here

The fidelity ruling for the conversion is behaviour-faithful, and this is
behaviour, not a defect in the port. Both halves of it are also deliberate:
`/cancel` on an engaged close is house-style's exit-code contract (130 means
"closed the tab after interacting"), and port re-binding is the recovery
mechanism. **The bug is the interaction, and fixing it is a design decision.**

## What a fix could look like

The daemon already mints a session id. A departure beacon could carry the
session id the page was served with, and `/cancel` could ignore a beacon whose
id is not the current session's — which makes the route's guarantee explicit
rather than positional. `/left` should probably still record it: "a tab from a
previous session of this review closed" is a true and useful fact.

That is one field on the beacon, one comparison in the route, and one new
sentence in the exit-code contract. It is not a port's decision to make.

## Related

`docs/projects/digestify-conversion/rewrite-journal.md`, Phase R / R8, third
drive artefact.
