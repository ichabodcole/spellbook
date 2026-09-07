# Bounty Conversion — decision log

Live record. Every choice, with the options not taken. Append as you go; do not
reconstruct at the end.

---

## D1 · Conversion order: bounty before digestify

**Ruled:** orchestrator, 2026-09-06, with Cole's assent to sequence the two.

Bounty is Alpine-over-CDN on a WebSocket — structurally grapevine's twin — and
the playbook's R7 was written naming it. Digestify is not Alpine at all (~600
lines of imperative vanilla DOM), carries three CDN runtime deps that must move
into the bundle, and a three-theme runtime switch. Putting the familiar shape
first lets digestify's genuinely novel problems land on an exercised pipeline.

**Not taken:** digestify first, on the theory that it is smaller. It is not —
1,505 template lines to bounty's 1,003, and more invention per line.

## D2 · Fidelity: behaviour-faithful, restyled

**Ruled:** Cole, 2026-09-06. Same ruling grapevine ran under.

The palettes map onto kit token roles; brand pairs keep their own names; the
look shifts where the kit and the page disagree.

**Not taken:** _behaviour- and look-faithful_ (keep each spell's palette as its
own token set — more R4 work, and the two spells stay visually apart from the
ported roster); _split the ruling by spell_ (faithful for bounty's board because
status colour is load-bearing, restyle digestify's decorative flair).

## D3 · Phase S runs inside Phase R

**Ruled:** playbook canon, not a fresh call. `surface/ui/` is CLI-owned from the
first commit that creates it.

**Not taken:** vendor primitives now, run the registry later. Grapevine did
exactly that and paid a second branch for it
(`docs/projects/grapevine-shadcn/`).

## D4 · The backend stays Bun-native source

**Ruled:** orchestrator, 2026-09-06, from measurement.

`plugins/spellbook/skills/bounty/scripts/*.ts` imports nothing outside its own
folder. The R7 seam puts shared predicates in
`plugins/spellbook/skills/bounty/shared/`, which is inside the tracked subtree,
so Contract 3 row 1 survives the cut: `scripts/` source + a surface-only
`dist/`.

**Not taken:** a built `dist/cli.js` launcher (Contract 3 row 2). Forced only by
the first import outside the skill folder — e.g. `src/kit/`. If the seam lands
there anyway, that is a different branch; stop and say so.

## D5 · Digestify's three themes survive the port

**Ruled:** Cole, 2026-09-06. Recorded here because it was ruled in the same
sitting; it binds the _next_ branch, not this one.

`--theme digestify|cthulhu|classic` keeps all three, tokenized as three token
sets swapped at runtime.

**Not taken:** port the default only and file the rest as follow-up (ships a
knowingly narrowed CLI); retire the two alternates (breaking CLI change, throws
away commissioned artwork).

## D6 · Three server-side HTML substitutions become two runtime derivations and one additive WS field

**Ruled:** implementing agent, 2026-09-06.

`template.html` is not served as a file — the daemon reads it and substitutes
`__TITLE__`, `__SESSION_ID__` and `__WS_URL__` before every response
(`server.ts:1498–1501`). A built `dist/index.html` is a static artifact the
daemon serves verbatim (Contract 2), and in **dev** mode Bun's own HTMLBundle
serves it, so there is no point at which the daemon can substitute in both
modes. The three values are resolved instead as:

- `__WS_URL__` → derived in the browser: `ws://${location.host}/ws`. The daemon
  binds `127.0.0.1:<port>` and the page is served from that same origin, so the
  string is identical.
- `__TITLE__` → already canonical on the WS `init` frame; `applyInit` sets both
  the state and `document.title`. The built page ships `<title>bounty</title>`
  as the pre-connect placeholder.
- `__SESSION_ID__` → an **additive `sessionId` field on the WS `init` frame**.

**Not taken:** (a) keep the placeholders in the built HTML and have the release
daemon `.replace()` them — works in release, silently does nothing in dev, so
the two modes diverge in exactly the way Contract 1 exists to prevent; (b) a new
`GET /session` route — the brief says _same routes_; (c) put `session_id` on
`GET /state` — that route calls `touch()`, so a browser read would count as
board activity and change the idle-close clock (a real behaviour change); (d)
drop the session id from the header — it is the string a human pastes into a
joining agent.

The `init` frame was chosen because `server.ts`'s own b16 comment argues the
case already: _"Rides `init` rather than a new message type because it is a boot
fact, and `init` is the only frame that carries boot facts."_ `sessionId` is a
boot fact. It is additive and browser-only: the agent-facing event log, `/state`
and `/cmd` are untouched.

## D7 · The seam is five symbols, not the ten the brief listed

**Ruled:** implementing agent, 2026-09-06, from the consumer sets.

The brief named ten pure predicates. Resolving consumers rather than reading the
list: the surface uses **four** of them (`cardPassesFilter`, `cardOverdue`,
`ownersOverWip`, `expectedMinutes`) plus a count form of the module-private
`isBlocked`. `computeDuePokes`, `isNoOpMove`, `isNoOpUpdate`, `validateTask`,
`cleanTags` and `snapshotTaskCount` have **no** surface consumer — the daemon
alone enforces them — so they stay in `scripts/`.

Note the shape, because it contradicts a naive reading of Phase 1 action 2:
three of the four moving symbols (`cardOverdue`, `cardPassesFilter`,
`ownersOverWip`) are **not called by the daemon at all** — their `server.ts`
header comments say so explicitly ("NOT used by the daemon — it's the canonical
the surface copies"). By _runtime_ consumer set they are surface-only; by
_total_ consumer set they are two-sided, because `server.test.ts` is what guards
them and it lives in `scripts/`. They go to `shared/` on the total set, which is
what keeps `server.test.ts` passing with an import-path-only edit.

**Not taken:** move the three surface-only-at-runtime helpers into
`src/bounty/surface/state/` and re-point `server.test.ts` at them. That is a
`plugins/ → src/` test edge, which is Gotcha 6's illegal small fix, and it would
put the canonical predicate outside the shipped artifact.

## D8 · `isBlocked` is re-expressed as `liveBlockerCount`

**Ruled:** implementing agent, 2026-09-06.

The surface needs a **count** (`⛔ blocked by 3`); the daemon needs a
**boolean**. Rather than ship two implementations again — which is the exact
defect this branch exists to remove — `shared/predicates.ts` exports
`liveBlockerCount(task, tasks): number` and defines
`isBlocked = liveBlockerCount(...) > 0`. `server.test.ts`'s existing cells are
unchanged; they test `isBlocked` through the helpers that call it.

**Not taken:** export only `isBlocked` and let the surface re-count (keeps the
mirror alive, which is the thing being deleted); export only the count and make
the daemon compare (a body change to a tested predicate, forbidden by the
"import path only" rule).
