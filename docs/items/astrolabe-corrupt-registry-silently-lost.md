---
type: item
title: A corrupt astrolabe registry is read as empty and then overwritten
description:
  A corrupt registry.json boots the daemon empty and its next save overwrites
  the file, so the registry is lost with no word; cold refusals say unknown
  project with empty choices.
status: draft
lifecycle: triage
id: 01a0e711-ee2e-76c4-a20b-9017891d4e5e
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
---

# A corrupt astrolabe registry is read as empty and then overwritten

Found by the no-stake verifier of
[cycle/2026-09-one-act-one-answer](../cycles/2026-09-one-act-one-answer.md),
2026-09-28, on `a7c041d3`, under a scratch `HOME`; filed, not chased. Its
scripts were `t1.sh`–`t9.sh` in that session's scratchpad (not kept).

Tried: invalid JSON, `{"projects":"x"}`, and `registry.json` as a directory.

- **The CLI (new this cycle):** a cold refusal says `unknown project 'beta'`
  with `choices: []`, and never mentions that the registry could not be read.
- **The daemon (older):** it boots empty from a corrupt file, and its next save
  overwrites the file, so every registered project is lost without a word.

A registry that can't be read is not the same thing as an empty one. The likely
fix is to refuse or warn with the file's path, and not to overwrite a file the
daemon could not parse (move it aside first). An invalid single entry is already
dropped consistently by both sides; that part is fine.
