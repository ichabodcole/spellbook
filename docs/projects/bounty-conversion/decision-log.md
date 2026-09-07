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
