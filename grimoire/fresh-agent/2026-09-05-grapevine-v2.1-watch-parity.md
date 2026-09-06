# Fresh-agent run — grapevine V2.1 (watch human parity), 2026-09-05

**Context:** ward-mandated ergonomics re-run after the UX revision
(`feat/grapevine-ux`): the watch surface gained create / edit topic / archive /
unarchive / delete from the rail's context menu and header, and a _Show
archived_ switch. Fresh agent given SKILL.md's V2.1 banner and the Human Control
Plane section only, a live release-mode surface behind a fixed-port proxy, and
the CLI against the same daemon; walked every promised action by mouse and
keyboard and checked the agent side (`list`, `pull`, `topic`) after each.

**Verdict: onboardable from SKILL.md alone, no blockers** (2 confusing, 7
papercuts). Every action the text promises worked both ways, and each was
visible to an agent through the same daemon state a CLI action produces.

**Findings** (fixed in-branch / routed):

1. _confusing_ — the You box shows the browser-remembered alias while a lurker's
   create-with-topic and topic edit are signed with the `/identity` default
   (`cole`), with nothing on the surface saying who signs. → **fixed
   in-branch**: the topic editor's placeholder and the line's `title` name the
   signer (`set a topic (as cole)…`), the create dialog's topic field shows
   `Set as cole.` once a topic is typed, and SKILL.md says the two can differ.
2. _confusing_ — "pre-fills the human's alias from `config.json`" reads as
   "always", but the localStorage override wins after the first visit. → the
   watch paragraph already said "editable in the right sidebar"; the signer
   sentence now names the override explicitly. Left otherwise.
3. _papercut_ — after Enter or Escape in the topic editor, focus dropped to
   `body`. → **fixed in-branch** (focus returns to the topic line on a keyboard
   close; a blur means focus already moved).
4. _papercut_ — after Archive / Unarchive from the menu, focus dropped to `body`
   in every path (the trigger is a non-focusable row div). → **fixed
   in-branch**: focus returns to the row's link; when the act hid the row (the
   archived filter is off), focus goes to the _Show archived_ switch, which is
   the control that brings it back. Delete… hands focus to its dialog.
5. _papercut / undocumented_ — _Edit topic_ on a non-current row switches
   channel (a full reload) before opening the editor. → **fixed in-branch**:
   SKILL.md says so.
6. _papercut_ — three names for one act: the menu says _Delete…_, the confirm
   says _Close channel_, the CLI verb is `close`. → decision-logged; the
   dialog's text is inventory C11 verbatim and changing it is Cole's call.
7. _papercut_ — the create dialog's 409 lands as a red network line in the
   browser console. → browser-layer; the same class of entry the reconnect rows
   (E4) produce. Noted in the inventory.
8. _papercut_ — "the switch has no accessible name" — **not reproduced**: the
   accessibility tree reads `switch "Show archived (N hidden)"` through the
   `<label for>` association. Left.
9. _papercut_ — Tab order puts the header's topic line before the rail, and each
   row's 🗑 is its own stop. → the old page's order is the floor and is kept
   beneath the three new stops (inventory L6); left.
10. _agent side_ — archive / unarchive emit no frame in either direction (same
    as the CLI), and a CLI `pull <deleted>` silently re-creates the channel
    empty, so an agent polling a channel the human deleted resurrects it. →
    backend, out of scope by ruling; filed as
    `docs/backlog/2026-09-06-grapevine-lifecycle-route-gaps.md`.

**Drive record:** created and deleted `cold-read-test`; archived / unarchived
`archived-one`, `fresh-one`, `other` from the surface and the CLI; set a topic
on `archived-one` from the CLI.
