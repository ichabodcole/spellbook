---
type: item
title: The origin guard lets a DNS-rebound page read a spell's daemon
description:
  "GitHub #143: refuseForeignOrigin let through any request with no Origin,
  which a rebound same-origin GET is; a Host check closes it, and develop
  appears to have one since 03570830."
status: draft
lifecycle: dropped
id: 01a1eabe-f30a-707a-8b57-016d92949119
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, security]
parent: feature/workspace-kit-follow-ups
source: "#143"
---

# The origin guard lets a DNS-rebound page read a spell's daemon

Filed as GitHub #143. **A security bug** in every daemon built on the kit's
wire, not only Scriptorium.

`refuseForeignOrigin` (`src/kit/wire/origin.ts`) lets a request with no `Origin`
through, so the CLI and tests work. A browser also leaves `Origin` off a
same-origin GET. Under DNS rebinding, a page rebinds its own host name to
`127.0.0.1` and fetches `http://evil.example:<port>/state`. The browser sees a
same-origin request, so the guard allows it, and the page reads the whole
session state. The issue's check:
`curl -H "Host: evil.example:<port>" http://127.0.0.1:<port>/state` should
return 403.

Story Studio's fix (`820bec7`): `ownHost` refuses a request unless `Host` is
absent, `127.0.0.1:<port>` or `localhost:<port>`, before the Origin rule.

Develop appears to have this. `ownHost` is in `src/kit/wire/origin.ts` and
`refuseForeignOrigin` calls it, from `03570830` ("refuse a foreign Host header,
the DNS-rebinding half of the origin guard") and `0762df92` (bracketed IPv6).
Both are in 6.0.0. Not rerun here yet. #139 asks for the same check.

**Dropped on filing (2026-11-17):** a check found GitHub #143 already
implemented in spellbook 6.0.0, so the issue was closed with the evidence and
there is nothing to do here.

## Definition of done

- [ ] The issue's `curl` gets 403 from a released daemon, and a test holds it.
- [ ] Every kit spell daemon is confirmed to go through the guard.
- [ ] #143 answered and closed once released.
