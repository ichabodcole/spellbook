---
type: item
title:
  "Flagged Scriptorium gets a surface: an interim frame with the context and
  chat panes"
description:
  Replace the kit path's placeholder page with a thin interim frame holding the
  kit's context sidebar, chat, Notes and Tasks; hide, make-set and the move plan
  go in through menuActions and the confirm slot. The frame is thrown away at
  the shell cycle.
status: stable
lifecycle: triage
id: 01a14bca-1792-702e-9950-a08158191b3f
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# Flagged Scriptorium gets a surface: an interim frame with the context and chat panes

Today the kit path (`SCRIPTORIUM_KIT=1`) opens a page that says it has no
surface. This cycle gives it one: a thin interim frame of about 150 lines,
holding the kit's `ContextSidebar`, `ChatSidebar`, Notes and Tasks
([port shape, §2b](workspace-stack-port-shape/write-up.md#2b-the-cycles)). The
document pane arrives in cycle 4 and the shell in cycle 5. The frame is thrown
away then, so it is kept small.

Scriptorium's wiki verbs reach the human through the panes' slots:

- hide and unhide, and make-set, through `menuActions`;
- the move plan, through the pre-move confirm slot.

## Definition of done

- [x] `open` on the kit path, without `--no-open`, shows the frame: the context
      tree, chat with the composer, Notes and Tasks. It carries the scroll-text
      favicon.
- [x] The human can chat with the agent, add and remove sets, hide and unhide,
      make a set, and move with the plan confirm, all against the kit daemon.
- [x] The centre says the document pane comes in the next cycle. Opening a
      document doesn't fail silently.
- [x] A browser check drives the main gestures on a scratch home, and the gate
      and acc are green.
- [x] The shipped Scriptorium is unchanged.

## Done and verified

Commits `5862da29` (the build emits a spell's further surfaces,
`src/<spell>/surface/<sub>/index.html` into `dist/<sub>/`, each by its own
`Bun.build` call; the surface-build-mode ward reads them) and `98532009` (the
frame, `src/scriptorium/surface/kit/Frame.tsx`, served by the kit daemon at `/`
from `dist/kit/`), plus the commit carrying this note. Deliberate choices:

- **The frame's own bundle, not the shipped one.** The shipped surface's
  `index.html`, JS and CSS are byte-identical before and after. The frame uses
  only classes the shipped surface already emits, because the shipped stylesheet
  scans all of `surface/`, this folder included.
- **Found by bundle-shaped arithmetic**
  (`FRAME_DIST = join(import.meta.dir, "kit")`), which the spawn-path ward
  reads; its dev entry is enumerated there as an escape, and the opaque kit
  `serveFromDist` call is re-ruled. Run from source the daemon serves no page;
  the served page is held end to end through the launchers
  (`kit.integration.test.ts`).
- **Hide inside a set; the list row keeps the kit's Remove.** "Hide from
  Scriptorium" is offered on rows inside a set, "Show N hidden" on a set that
  hides something, and "Turn into a set" on a document listed on its own.
- **A refusal's hint** is read off the error frame by the frame (the kit's
  client keeps only the message) and shown with it as the sidebar's notice.

Verified: happy-dom tests against a real flagged daemon
(`surface/kit/Frame.test.tsx`), each mutation-checked; a real-browser pass
(Playwright) on a scratch home through every gesture but Remove, which is
covered in happy-dom; the full gate; acc on both CLIs; shipped parity.

For the next item ([ask for a location](scriptorium-kit-ask-location.md)): every
create the panes send names its folder. The one route with none is dropping
files or images on the list's background, where there is no workspace: the
daemon refuses it, and the notice shows its hint. That hint is written for the
CLI (`new-doc <folder>/<name>.md`, `add-folder <path>`), so it reads oddly to
the human. The list still says "Drop documents or images here to copy them in".
Separately, the frame does not show the relink offer after a move that breaks
links (the chat line says so); that belongs with
[set-make-relink-offer](set-make-relink-offer.md) or the shell.

## Port-back notes

No Story Studio kit code was changed. What is ours alone:

- `src/build.ts` builds further surfaces (`dist/<sub>/`): a Spellbook build
  concern, not the kit's.
- The frame composes the panes as Story Studio's `WorkspaceShell` does
  (`packages/kit/src/shell/WorkspaceShell.tsx` at `develop`, `fb34b86`), read
  only, nothing ported from it: it is thrown away at the shell cycle.
- The daemon client drops an error frame's `hint`; the frame recovers it with
  `onFrame`. If Story Studio wants hints shown, `lastError` carrying the hint
  would be the kit-side change.
