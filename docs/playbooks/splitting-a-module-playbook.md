---
type: playbook
title: Splitting an oversized module
description:
  "Keeping source files under the 1,200-line limit by splitting a module along
  what owns which state, as a pure move with no behaviour change: the ownership
  rule, the tiers, and the lessons Story Studio's split paid for."
tags: [kit, refactor, lint]
status: draft
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# Splitting an oversized module

## Goal

Every source file under `src/` stays under 1,200 lines as Biome counts them, and
a file that has to shrink is split by what owns which state, never by line
count, with behaviour unchanged. Use this playbook when you add behaviour to the
workspace session or daemon, when a change would push a file past its limit, and
for every step of the kit split ([feature](../features/kit-split/feature.md)).
It is Story Studio's rules 19 and 20 (their
`docs/playbooks/implementing-a-branch-playbook.md`), ported with the kit's
layout.

## Steps

### Where new code goes

1. **Put new session behaviour in the part that owns the state it changes.** A
   new manifest key or field belongs to one part in
   `src/kit/workspace/session/`, and only that part writes it. If no part owns
   it, add a part in the lowest tier that can hold it, and give it its tier in
   `tests/architecture/session-tiers.test.ts` and on
   [the workspace session](../architecture/workspace-session.md) page, in the
   same change.
2. **Never add a method body to `WorkspaceSession` itself**, only a delegate
   while callers still use the facade. Until a part exists for the state you
   touch (before its split step lands), put the method where the step's module
   table says it will go, so the step moves it with its neighbours.
3. **Put pure logic (no session state) in a sibling module of `workspace/`**,
   not in a part.
4. **Hand a part what it needs as an object of functions**, built in the facade
   (`{ docOrDie: (s) => this.docOrDie(s), … }`), never the facade or a higher
   part. A daemon part is a `create…(needs)` closure that keeps its own `let`s
   and maps, only stores its needs while it is built, never hands out its state
   (only functions and reads), and returns a `stop()` for its timers, which
   `close` calls where it cleared them before.

### Keeping under the limit

5. **Measure with Biome, not `wc -l`.** The limit is
   `style/noExcessiveLinesPerFile` in `biome.json`, at 1,200 lines on
   `src/**/*.ts` and `src/**/*.tsx`, test files left out. Biome does not count
   the lines inside a JSDoc block or a template literal, so its count is below
   `wc -l`'s. Run `bunx biome lint <file>`: a file over its limit prints its
   count. To read a count under the limit, lint a scratch copy of the config
   with the limit set one below your guess.
6. **Do not grow a file that has an override.** The 15 files over 1,200 at G1
   (2026-11-24) each have their own entry in `biome.json`, frozen at their size.
   A change that would push one past its number splits it first.
7. **If a file would pass its limit, split it by what owns which state.** Never
   a `part2.ts`. Each shape splits its own way:
   - a class or closure holding a running thing's state (`session.ts`,
     `server.ts`, `verbs.ts`) becomes parts, each owning its fields;
   - a React component holding a view's state (`WorkspaceShell`, `DocumentPane`)
     becomes hooks that own state plus subcomponents that take props;
   - pure code (`protocol.ts`) splits by topic, with the old path kept as a
     re-export.
8. **When a change shrinks a listed file, lower its override to the new count**,
   and remove the entry once the file is under 1,200.

### A split is a pure refactor

9. **Change no test's expectations.** A test changes only where it reached into
   private state that moved, and then only to reach the same state at its new
   address. A step that has to change what a test expects is not a move: stop
   and report it.
10. **Keep hook and effect order.** Call each new hook where its block sat, and
    leave state declared earlier in the component where it is, passed in, since
    moving it changes the slot order. A memo or callback handed to a child keeps
    its identity; never put a fresh object (such as a shared `core`) in a
    dependency list.
11. **Watch for blind tests.** A test that replaces or counts a facade member or
    a module export stops seeing calls once code calls the new home directly.
    Grep for it in every style, repoint it to the new home, and show that its
    counter still moves. Tests that read source text need their folders widened
    when files move.
12. **Watch for free names.** In a new module, a name that was a local or a prop
    before can resolve to a DOM or Bun global (`history`, `stop`, `name`,
    `close`), which compiles and runs wrong. Check that every free name in the
    moved code is bound.
13. **Keep the start path.** A part imports only what its code used where it
    was. The CLI (`verbs.ts` and what it imports) loads neither `session.ts` nor
    `server.ts`, nor micromark or mdast; the daemon loads the markdown parser
    only through `loadNoteGuard`'s `await import`. Keep `notes.ts`'s guard lazy
    when it moves.

## Verification

- [ ] `bunx biome lint src` reports no `noExcessiveLinesPerFile` finding, and
      every override you touched is at the file's new count (a lowered number,
      never a raised one). Biome does not count comments or blank lines after a
      file's last token, so a file can grow there without failing: read the
      diff, not only the lint.
- [ ] `bun test tests/architecture/session-tiers.test.ts` passes, and every part
      you added is in its table and on the architecture page.
- [ ] `bun test src/kit/workspace/noteGuard.lazy.test.ts` passes: the CLI's and
      the daemon's start paths are as they were.
- [ ] `git diff` shows no change to any test's expected values; a test that
      changed only reaches the same state at a new address.
- [ ] For a moved test double: the counter it reads still moves (run the test
      with the call removed and see it fail).
- [ ] `bun run gate` passes.

## Related

- [The workspace session](../architecture/workspace-session.md)
- [Split the kit's oversized modules](../items/kit-split-oversized-modules/write-up.md)
- [The kit split](../features/kit-split/feature.md)
- Story Studio: `docs/playbooks/implementing-a-branch-playbook.md` (rules 19 and
  20), `docs/architecture/workspace-session.md`
