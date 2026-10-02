---
type: item
title: "Scriptorium: an End session button for the human"
description:
  The human has no way to tell the agent they are done; closing the tab is not
  that signal. Add an End session affordance in the top bar that goes through
  the daemon.
status: draft
lifecycle: done
id: 01a0f97b-8ac4-7769-8210-b071edb8a5e5
kind: task
generated: { by: pdocs, at: 2026-10-01 }
cycle: 2026-10-scriptorium-from-real-use-3
---

# Scriptorium: an End session button for the human

From Cole's real use, 2026-10-01. When he finishes working in a Scriptorium he
has no way to tell the agent he is done. Closing the tab is not that signal, and
should not become it: a closed tab can mean a reload, a second window, or a
break, and the session should outlive it. So the agent keeps monitoring a
session nobody is using.

**Wanted:** an **End session** affordance in the top bar. It goes through the
daemon, so the agent hears it as an act rather than guessing from silence.

**It is a shortcut for a conversational act** (house rule: buttons are
shortcuts, never the only path). Typing "we're done" in chat must still work,
and the button is the faster way to say it.

**Cole's ruling, 2026-10-01:**

- **The daemon ends the session itself.** The agent's `tail` already receives
  `closed` and exits 0, so the agent learns at once. The event says the human
  ended it, so the agent does not read it as a crash; the agent is still in the
  terminal to wrap up afterwards, and the button works when no agent is there.
- **A confirmation modal in the browser, and no round trip through the agent.**
  The modal only guards against a stray click. Asking the agent to confirm would
  make the shortcut slower than typing. The worst case of a mistaken end is
  asking the agent to reopen: no data is lost.

Options not taken: the button asks the agent to close (a session whose agent is
gone never closes); no confirmation at all (a stray click ends the session).

**After the end (Cole, 2026-10-01, in session 12e4c09d):** no lock-out and no
new page; the human can still look around what is loaded. Two small changes
only:

- Ending stops the daemon, so today the status would read "daemon unreachable —
  retrying" and retry forever (`App.tsx`). After a deliberate end it reads
  **"Session ended"** and stops retrying.
- If the open document has **unsaved edits**, the confirmation modal says so.
  The session's versions survive (`open --restore`), but the file on disk will
  not have them.

**The agent must know the end was intentional** (Cole), so it never treats the
disconnect as something to repair. The `closed` event, and the line `tail` ends
on, say both what happened and the next act: _the human ended this session on
purpose; do not reopen it unless they ask._ The skill says the same.

## Definition of done

- [x] The top bar has an End session control, reachable by keyboard. It asks for
      confirmation in a modal, then ends the session through the daemon.
- [x] The agent's `tail` learns that the human ended the session, can tell it
      apart from a crash or an agent-run `close`, and is told not to reopen it
      unless asked.
- [x] After a deliberate end the page reads "Session ended" and stops retrying;
      the modal warns about unsaved edits.
- [x] Closing the tab alone still ends nothing.
- [x] Saying it in chat remains a path; the skill tells the agent what to do in
      either case.
- [x] Driven in a real browser by a no-stake verifier.
