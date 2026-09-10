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

## D9 · The status pill gets a cva DIMENSION, not four variants

**Ruled:** implementing agent, 2026-09-06.

House-style's `registry-primitives-variant-extends-recipe` describes a spell's
variant as "two lines, one comment" inside the recipe's `cva` config. Bounty
needs more: the active status pill's colour IS which status it names — gold is
doing, ice is done, amethyst is review, loam is todo — so a single "selected"
look would erase the information. `button.tsx` gains a second variant dimension,
`tone`, alongside two new `variant` values (`chip`, `pill`) and one new `size`.

Still inside the cva config, still no call-site override, and tailwind-merge
resolves `tone` over `variant` because cva emits dimensions in declaration
order.

**Not taken:** four more `variant` values (`pillTodo`, `pillDoing`, …) — the
same information, spelled worse, and it makes the inactive/active pair two
unrelated names; `compoundVariants` pairing `variant:"pill"` with each tone —
correct and three times the config for no additional expressiveness; a colour
map at the call site — the exact "stacked override at the call site" the rule
forbids.

## D10 · `shared/` holds the wire's NOUNS; the surface re-declares its FRAMES

**Ruled:** implementing agent, 2026-09-06.

`Task`, `TaskStatus`, `StatusVisit`, `TaskSize`, `BoardState` are exported from
`shared/types.ts` and imported by both sides. The browser-facing frame unions
(`{type:"init",…}`, `{type:"task.move",…}`) are **re-declared** in
`src/bounty/surface/state/types.ts`.

The reason is mechanical rather than principled: those frames are not exported
from anywhere. They are built inline inside `server.ts`'s own websocket handlers
and its `broadcast()` calls, so there is nothing to import — and a
surface→`scripts/` import is what the import-boundary wards forbid.

**Not taken:** export the frame unions from `shared/wire.ts` and have the daemon
build its frames through them. That is the better end state and it is a change
to the daemon's write path, which this branch is not allowed to make (no new
behaviour, and a typed frame would invite a shape change). Filed as the obvious
next step for anyone touching the daemon's broadcast path.

## D11 · The `spell-css-scope` ward is amended, not re-pinned

**Ruled:** implementing agent, 2026-09-06.

Bounty's arrival produced five cross-spell leak lines, all of them `group` or
`peer`. Those are Tailwind's marker classes: they reach a stylesheet only inside
the compound selector generated for a `group-*`/`peer-*` variant, never as a
utility a spell could have written. Every spell before bounty escaped by
coincidence — each spells one of the two bare somewhere in its own markup.

The exemption covers those two names only, applies only to the spell being
accused (the accuser must still genuinely use the class), and a new cell pins
its membership so a later widening reds. Calibrated: adding a third marker takes
the cell red.

**Not taken:** spell a bare `group` somewhere in bounty's markup to make the
ward happy — adding markup to satisfy an instrument, which is the failure mode
wards exist to prevent; suppress the pair globally in `classSelectors` — the
same exemption with no cell behind it and no record of why.

## D12 · The dev import gets its own try/catch

**Ruled:** implementing agent, 2026-09-06, from the local-sim.

`server.ts` installs an `uncaughtException` handler that logs to
`$BOUNTY_HOME/daemon.log` and exits 1 **without writing to stderr** — correct
for a mid-flight invariant break (the teardown writes the snapshot, and flushing
possibly-corrupt state over a good one is the #73 failure with extra steps). It
also swallowed the forced-dev import failure: exit 1, stdout empty, stderr
empty, indistinguishable from a missing `bun`.

The dev import now catches and names `src/bounty/surface/index.html`, exiting 2.

**Not taken:** make the fatal handler write to stderr — it would print on every
mid-flight fault, which is what the file log is for, and the message would still
not name the surface; leave it silent and let `tests/release-serve.test.ts`
assert only the exit code — the playbook asks for an error that names the
missing surface precisely because "bun is missing" is what an operator otherwise
reads.
