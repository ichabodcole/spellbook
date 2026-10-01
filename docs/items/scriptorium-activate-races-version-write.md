---
type: item
title: "Scriptorium: activating a fresh version races the agent's write into it"
description:
  "GitHub #117: version-new makes an unchanged copy the toast offers at once;
  activating it before the agent writes turns the write into an outside edit.
  Fix with version-new --body-file and a truer safeguard message."
status: draft
lifecycle: ready
id: 01a0f97e-96c7-71ef-891d-eac7bed19813
kind: bug
generated: { by: pdocs, at: 2026-10-01 }
source: "#117"
cycle: 2026-10-scriptorium-from-real-use-3
---

# Scriptorium: activating a fresh version races the agent's write into it

Filed as GitHub #117 from Cole's 5.0.1 session 3c362480, 2026-10-01; the issue
has the full repro. `version-new` creates a byte copy of its source, and since
5.0.0 the new-version toast offers **Activate** at once. If the human activates
before the agent writes its content to the printed path, the write lands on the
active version and trips the outside-write safeguard: the text is kept as
another version, nothing is lost, but both parties are confused, and the agent
made it worse by creating yet another version.

`version-new` today takes only `--doc`, `--from` and `--label`.

**Planned, from the issue's suggestions:**

1. `version-new --body-file <path>` (and `--stdin`): the version is created
   holding the agent's text, so there is no window. Same convention as
   `say`/`task`/`note`.
2. A truer safeguard message for this case (activated shortly after creation,
   content still equal to its source), telling the agent not to make another
   version.

Not taken: toasting only once the copy changes (hides the race rather than
removing it; a deliberate unchanged copy is a real use).

## Definition of done

- [ ] `version-new --body-file` / `--stdin` create a version already holding the
      given text; the toast never offers an unwritten copy made this way.
- [ ] The safeguard's message names the activated-before-written case and tells
      the agent what to do.
- [ ] The scriptorium `SKILL.md` teaches the one-step form.
- [ ] The issue's repro driven by a no-stake verifier, before and after.
- [ ] #117 answered and closed once released.
