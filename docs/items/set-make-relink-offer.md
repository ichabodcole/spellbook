---
type: item
title: Turning a document into a set reports broken links but offers no fix
description:
  make-set lists the links its move breaks but, unlike move, offers no relink; a
  warning needs an action.
status: stable
lifecycle: done
id: 01a1486e-3bb8-74b7-b965-0ad8d262f898
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# Turning a document into a set reports broken links but offers no fix

Found by the set-promotion verifier (2026-10-17). `make-set` moves a document
into a new folder and reports the links that broke as `broken`, but offers no
`relink`, unlike `move`. A warning needs an action.

## Definition of done

- [x] After `make-set` breaks links, the agent and the surface get the same fix
      offer a move gives, and taking it repairs the links, with a test.

## Done and verified

On `impl/set-make-relink-offer`, from `cycle/shell` at `eda1545e`: the kit
change, then the flagged Scriptorium's words and test, then the rebuilt `dist`.
`set.make` now goes through the same link path as `move`. The daemon keeps a
`relinkOffer` for it, and the shell's `RelinkBar` shows it. No Scriptorium code
was needed for the bar, because `WorkspaceShell` already renders `state.relink`.
The reply's `broken.hint` names `relink`, the verb that fixes them. Accepting
the offer, from the bar or with `relink`, rewrites the links as part of the act.
One undo puts back the document and its links, and redo does both again.

How:

- **The way back carries the links.** `set.make`'s inverse is an `app` inverse,
  because the session holds `unmakeSet`. The `app` kind gains an optional
  `links: { edits, what }`. `applyInverse` follows them after the app's own undo
  or redo, as a move's are. A redo that carries links drops what its own
  `makeSet` noted as broken, so nothing is reported twice.
- **Redo offers too.** A redone `set.make` that breaks links again now offers
  `relink`, as a redone move does. Two things are gone: the set-make-only hint
  (`SET_MAKE_LINKS_HINT`, "does not rewrite links") and the `hint` field on a
  redo's breakage.
- **Scriptorium's words.** `make-set`'s help now names `relink`. The move dialog
  (`surface/kit/movePlan.tsx`) again says that the context column offers the
  update after a move, since the shell's bar now shows it. The panes cycle had
  reworded it so it would not promise an offer.
- **Not done:** `make-set --update-links`, which would make the set and rewrite
  the links in one act, as `move --update-links` does. Nothing asked for it, and
  the offer is the fix.

Verified in three places:

- **`setPromotion.server.test.ts`:**
  - the offer and the agent's hint;
  - the human accepting it;
  - one undo and one redo, with the links;
  - the agent's `relink`;
  - the redo's fresh offer.
- **`Frame.test.tsx`:** Turn into a set, the bar, Update, and the links on disk.
- **A real browser** on the flagged Scriptorium (`SCRIPTORIUM_KIT=1`, scratch
  home):
  - Turn into a set on a document another document links to;
  - the bar: "2 links in 2 documents still point at where fable.md was";
  - Update, then both links resolving on disk;
  - the agent's `make-set`, whose reply names `relink`, with the bar shown for
    it too;
  - `relink`, then `link-check` at 0;
  - one undo, which put back the file and its links.

## Port-back notes

Story Studio's kit has no `set.make` (checked at `1d0355fd`), so only the
generic half applies:

- **`history.ts`:** the `app` inverse may carry
  `links?: { edits: LinkEdit[]; what: string }`, put back after its `undo` as a
  move's are.
- **`server.ts`:**
  - `carriesLinks` and `carryLinks` let `relink`, `--update-links` and the act's
    link fact work on any inverse that can carry links (move, rename or app),
    not only on move and rename;
  - the `app` case of `applyInverse` follows carried links and returns them
    reversed.
- **Removed:** the redo-breakage `hint` override, which was ours for `set.make`.
  Story Studio never had it.
