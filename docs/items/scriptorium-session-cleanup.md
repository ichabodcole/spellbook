---
type: item
title: "Scriptorium: see old sessions and delete the ones you're done with"
description:
  Sessions pile up for good, because most are one-off reviews never reopened;
  Scriptorium shows the human what sessions it holds and lets the human or the
  agent delete finished ones, without touching the documents they showed.
status: draft
lifecycle: triage
id: 01a14b7a-f972-77ac-a2fb-bb4167368edb
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, scriptorium, sessions]
parent: feature/workspace-kit
---

# Scriptorium: see old sessions and delete the ones you're done with

Every Scriptorium session stays on disk forever. Cole's sessions are mostly
one-offs: open a session, review some documents, end it, and start a new one for
the next piece of work. They are rarely reopened. The trial conversion for the
wiki-layer cycle counted 54 sessions in his `~/.scriptorium`, and nothing in
Scriptorium tells him they are there or lets him clear them.

Today, neither CLI (shipped or kit path) has a verb that lists sessions or
deletes one. `close` ends a session but keeps it. `forget` drops a missing
document from a session; it does not remove the session. The only cleanup is
deleting folders by hand.

Cole raised this on 2026-10-17, when the trial conversion's count came up.

**What it needs to do:**

- **Show the human** which sessions exist: when each was last used, whether it
  is live or ended, and what it showed (its sets and documents), so the human
  can tell a finished one from one worth reopening.
- **Let the human delete** finished sessions from Scriptorium. Deleting one
  removes the session's own record (versions, notes, tasks, chat and anything
  imported into it) and **never** a document it showed from where it lives.
- **Let the agent do it too**: a verb that lists sessions with the same facts,
  and one that deletes a named ended session, so "end the session, we're done"
  can include cleanup when the human asks for it.

**Open questions for shaping:**

- **Where in the UI?** A sessions list in the surface (the panes, cycle 3 or
  later), a page of its own, or both.
- **Delete or archive?** Delete outright, or move to an archive or the Trash
  first, so a wrong delete can be undone.
- **Automatic suggestions?** For example, offer to clear ended sessions unused
  for some time. This should wait for a real-use signal; it is not built by
  default.
- **Which path?** Build only on the kit path, which takes over at the cutover,
  or add it to shipped Scriptorium as well.
- **Imported files.** A session's `imported/` folder holds copies the session
  owns, so deleting the session takes them too. The delete has to say so first.

**Constraints already settled:**

- **A live session is never deleted.** It has to be ended first.
- **Every delete is confirmed**, by the human in the UI or by the human's
  explicit ask to the agent.
- **The delete goes through the kit's single write module**
  (`src/kit/workspace/disk.ts`) and its ward, and refuses anything outside the
  sessions root, including through a link.

## Definition of done

- [ ] The human can see every session Scriptorium holds, with when it was last
      used, whether it is live or ended, and what it showed.
- [ ] The human can delete one or more ended sessions from Scriptorium, after a
      confirm that names what goes (including imported files).
- [ ] The agent has a verb that lists sessions with the same facts, and a verb
      that deletes a named ended session. The SKILL says the agent deletes only
      when the human asks.
- [ ] A delete removes only the session's own folder. A test shows a document it
      showed, and a planted link inside the session folder, are left alone.
- [ ] A live session is refused, with a hint to end it first.
