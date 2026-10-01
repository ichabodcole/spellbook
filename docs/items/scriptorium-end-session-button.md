---
type: item
title: "Scriptorium: an End session button for the human"
description:
  The human has no way to tell the agent they are done; closing the tab is not
  that signal. Add an End session affordance in the top bar that goes through
  the daemon.
status: draft
lifecycle: triage
id: 01a0f97b-8ac4-7769-8210-b071edb8a5e5
kind: task
generated: { by: pdocs, at: 2026-10-01 }
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

**The question for convene:** what does the press do?

- **The daemon closes the session itself.** The agent's `tail` already receives
  `closed` and exits 0 (scriptorium `SKILL.md`), so the agent learns at once and
  stops monitoring with no new wire. The event would need to say the human ended
  it, so the agent does not read it as a crash.
- **It sends the agent an intent ("the human is done"), and the agent closes.**
  The agent can wrap up first (save, summarise, answer a last message), but a
  session whose agent is gone never closes.

Also to settle: whether it asks for confirmation (it ends the session for both
parties), and what the page shows afterwards.

## Definition of done

- [ ] The top bar has an End session control, reachable by keyboard, that ends
      the session through the daemon.
- [ ] The agent's `tail` learns that the human ended the session, and can tell
      it apart from a crash or an agent-run `close`.
- [ ] Closing the tab alone still ends nothing.
- [ ] Saying it in chat remains a path; the skill tells the agent what to do in
      either case.
- [ ] Driven in a real browser by a no-stake verifier.
