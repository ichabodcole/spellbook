---
type: item
title: "Scriptorium: open JSON documents, with a strict validator"
description:
  "GitHub #138: open .json documents raw, report a parse problem by line and
  column, and refuse to save JSON that doesn't parse; the kit shipped this in
  6.0.0, unconfirmed in Scriptorium."
status: draft
lifecycle: dropped
id: 01a1eabe-f064-7793-b79f-b84891f305d4
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, editor]
parent: feature/workspace-kit-follow-ups
source: "#138"
---

# Scriptorium: open JSON documents, with a strict validator

Filed as GitHub #138, from Story Studio's `ichabodcole/story-studio@6f49c7e`.
The request:

- A `.json` document opens raw in CodeMirror with `@codemirror/lang-json` and a
  gutter. Markdown-only tools stand aside.
- A strict RFC 8259 reader (`jsonProblem`, `describeJsonProblem`) reports line,
  column and the problem in plain words.
- Save refuses JSON that doesn't parse, in the pane and in the daemon. A version
  that doesn't parse raises `json.invalid` and can't be made active.
- `docFormat(name)` decides the format in one place.

The issue names `backend/tree.ts` and `surface/components/context/model.ts`,
which predate the kit. On develop the kit has each named part:
`src/kit/lib/docFormat.ts` (`DOC_EXTENSIONS`), `src/kit/document/jsonMode.ts`,
`jsonProblem` in `src/kit/workspace/session.ts`, `json.invalid` in `events.ts`,
with `json.test.ts` and `json.server.test.ts`. It shipped in 6.0.0. Not checked
in Scriptorium's own surface yet.

**Dropped on filing (2026-11-17):** a check found GitHub #138 already
implemented in spellbook 6.0.0, so the issue was closed with the evidence and
there is nothing to do here.

## Definition of done

- [ ] In Scriptorium, in a real browser: a `.json` in a set opens raw, a bad
      save is refused with line and column, and the file is left untouched.
- [ ] Anything missing is ported or filed.
- [ ] #138 answered and closed once released.
