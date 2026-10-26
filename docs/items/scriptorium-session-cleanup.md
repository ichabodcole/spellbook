---
type: item
title: "Scriptorium: see old sessions and delete the ones you're done with"
description:
  Sessions pile up for good, because most are one-off reviews never reopened;
  Scriptorium shows the human what sessions it holds and lets the human or the
  agent delete finished ones, without touching the documents they showed.
status: stable
lifecycle: backlog
id: 01a14b7a-f972-77ac-a2fb-bb4167368edb
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, scriptorium, sessions]
parent: feature/workspace-kit-follow-ups
priority: high
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

**A session says too little about itself to be judged.** The kit's manifest (the
`Session` type, `src/kit/workspace/protocol.ts`) records what a session showed,
but not what it was for. It has no title or description. Its only end-state is
`ended` (who ended the daemon, and when), and a restore clears it. So `ended`
means "the daemon stopped", not "this work is finished". A session whose daemon
died without closing has no `ended` at all.

Cole's direction (2026-10-17, to explore in shaping): give a session the kind of
metadata a work item has, without copying the project-docs frontmatter verbatim.

- **A short description** of what the session is about, so a list of sessions
  reads "oh, that was the cycle-2 review, that's done". The agent can write it
  when it opens the session, since it knows the purpose, and the human can edit
  it.
- **A lifecycle the human sets on purpose**, separate from whether the daemon is
  running. "Done" means everything in the session has been looked at and no more
  work will go into it. "Open" means it is kept to be reopened. This is what
  decides deletion: done sessions are the ones to clear, open ones are left
  alone.

**What it needs to do:**

- **Record what a session is for and where it got to:** a description, and a
  lifecycle the human or the agent sets (open or done). Both survive restore,
  unlike `ended`.
- **Show the human** which sessions exist: each one's description and lifecycle,
  when it was last used, whether its daemon is running, and what it showed (its
  sets and documents), so the human can tell a finished one from one worth
  reopening.
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

**Cole's rulings (2026-10-17):**

- **Two states, open and done.** Start simple; add a state when real use asks
  for one.
- **Ending a session is not marking it done.** Ending only means nobody is using
  the session right now: the agent isn't listening, and the human may come back
  after a break and reopen it. "Done" is a separate, deliberate mark. A new
  session starts open.
- **The end of a session is the moment to ask.** When the human ends a session,
  the agent asks whether to mark it done or leave it open. This rides on the
  end-session message the agent already receives, plus a line in the SKILL. It
  is not a dialog that blocks the end.
- **Sessions saved before this are shown, not hidden.** They have no description
  and are open. Showing them is how they get cleaned up: the human and the agent
  can go through them, see what is in them, and mark them done or delete them.
  The list falls back to what each one showed, such as its documents' names.

**Constraints already settled:**

- **A live session is never deleted.** It has to be ended first.
- **Every delete is confirmed**, by the human in the UI or by the human's
  explicit ask to the agent.
- **The delete goes through the kit's single write module**
  (`src/kit/workspace/disk.ts`) and its ward, and refuses anything outside the
  sessions root, including through a link.

## Definition of done

- [ ] A session's manifest carries a description and a lifecycle (`open` or
      `done`, `open` by default). Both survive restore and ending, and the human
      or the agent can set them. The SKILL says the agent writes a description
      when it opens a session.
- [ ] Ending a session leaves its lifecycle alone. When the human ends one, the
      agent is told, and the SKILL says to ask whether to mark it done or leave
      it open.
- [ ] The human can see every session Scriptorium holds, with its description,
      its lifecycle, when it was last used, whether its daemon is running, and
      what it showed. Sessions from before this are listed too, as open,
      labelled by what they showed.
- [ ] The human can delete one or more ended sessions from Scriptorium, after a
      confirm that names what goes (including imported files). Done sessions are
      offered first.
- [ ] The agent has a verb that lists sessions with the same facts, verbs that
      set a session's description and lifecycle, and a verb that deletes a named
      ended session. The SKILL says the agent deletes only when the human asks.
- [ ] A delete removes only the session's own folder. A test shows a document it
      showed, and a planted link inside the session folder, are left alone.
- [ ] A live session is refused, with a hint to end it first.
