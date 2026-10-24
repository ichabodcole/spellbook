---
type: item
title: An agent's reply to a note can't overwrite the human's note
description:
  note-edit on a human's note replaces their words when an agent means to reply,
  and its help line says it answers the note as a reply does; replies must sit
  beside the note, and an agent must not rewrite a human's text.
status: stable
lifecycle: ready
id: 01a17017-1a17-750a-95c5-bc307f6d078c
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-24 }
cycle: 2026-10-release-6
parent: feature/workspace-kit-follow-ups
priority: medium
from: cycle/2026-10-release-6
---

# An agent's reply to a note can't overwrite the human's note

Found 2026-10-24 in Cole's triage review in Scriptorium. Cole left a note on the
proposal ("I think we go 6.0.0, since this will be a big release"). The agent
answered with `note-edit`, whose help line says it "answers the note, as a reply
does". It replaced Cole's words with the agent's answer, keeping his text only
as `replacedBody`. The CLI has no other way to reply to a note, so an agent
following the help does exactly this. The agent restored the text by hand.

A note is the human's words about a passage. An agent may answer it, but must
not change what the human wrote.

## Definition of done

- [ ] An agent can reply to a note without changing the note's text, and the
      surface shows the reply with the note.
- [ ] `note-edit` refuses a note the human wrote, naming the reply verb; it
      still edits the agent's own notes.
- [ ] The CLI help and the Scriptorium SKILL say which verb answers a note.
- [ ] Tested on the wire and checked in a real browser; offered on kit-parity.
