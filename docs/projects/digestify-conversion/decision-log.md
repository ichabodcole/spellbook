# Digestify Conversion — decision log

Live record. Every choice, with the options not taken. Append as you go; do not
reconstruct at the end.

---

## D1 · Digestify goes last

**Ruled:** orchestrator, 2026-09-06, with Cole's assent to sequence the two
remaining ports.

Bounty was Alpine-over-CDN on a WebSocket — grapevine's structural twin — so it
went first and landed the pipeline's second exercise cheaply. Digestify carries
the two problems neither earlier port had (bundled runtime deps, a three-theme
runtime switch) and has no framework to enumerate, so it benefits most from an
exercised pipeline and a twice-amended playbook.

**Not taken:** digestify first on a size argument. It is the larger file (1,505
lines to bounty's 1,003) and the less structured one.

## D2 · Fidelity: behaviour-faithful, restyled

**Ruled:** Cole, 2026-09-06 — the same ruling grapevine and bounty ran under.

**Not taken:** behaviour- and look-faithful (keeps each spell's palette as its
own token set, more R4 work, leaves the spell visually apart from the roster);
splitting the ruling per spell.

## D3 · All three themes survive the port, tokenized

**Ruled:** Cole, 2026-09-06.

`--theme digestify|cthulhu|classic` keeps all three. The palette half is an L3
mode override on one set of token names; the content half (wordmark, mascots,
brand, button copy, stamp lines) is not styling and stays in code.

**Not taken:** port the default theme and file the other two as follow-up (ships
a knowingly narrowed CLI); retire the alternates (a breaking CLI change that
throws away commissioned artwork).

## D4 · The inlined payload stays inlined

**Ruled:** orchestrator, 2026-09-07, from the fidelity ruling.

`review.ts` text-substitutes `__TITLE__` and `__PAYLOAD__` into the page, which
reads its state from a `<script type="application/json">` tag and makes zero
round trips to render. The placeholder moves into
`src/digestify/surface/index.html`, the bundler carries it into
`dist/index.html`, and the daemon substitutes in memory at serve time — so
`dist/` stays byte-stable.

**Not taken:** a `GET /payload` route the surface fetches on mount. It is new
behaviour with new failure modes (loading state, request failure, a race with
the heartbeat) under a ruling that forbids new behaviour, and it trades away a
zero-round-trip first render for nothing the port needs.

## D5 · The backend stays Bun-native source

**Ruled:** orchestrator, 2026-09-06, from measurement.

`plugins/spellbook/skills/digestify/scripts/*.ts` imports nothing outside its
own folder. Contract 3 row 1: `scripts/` source plus a surface-only `dist/`.

**Not taken:** a built `dist/cli.js` launcher (Contract 3 row 2), which is
forced only by the first import outside the skill folder and drags acc
conformance in front of it. If the port lands there anyway, that is a different
branch.
