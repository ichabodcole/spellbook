# Agent Guide — Spellbook

## Team-based development (anthill)

This repo runs an **anthill** agent team — a lead plus specialist seats that
coordinate over grapevine + bounty. The team's living docs and config live in
[`.anthill/`](./.anthill/) (`.anthill/config.json` is the keystone; each seat
has a doc under `.anthill/dev/`).

The seats:

| Handle    | Role     | Owns                                                                       |
| --------- | -------- | -------------------------------------------------------------------------- |
| prospero  | lead     | orchestration, the atomic land, human liaison, repo ops                    |
| daedalus  | engine   | conjuration backends (`server`/`daemon`/`backend`) + thin `cli.ts` + tests |
| circe     | surface  | React studios + Alpine surfaces + theme tokens                             |
| thoth     | grimoire | craft canon + the `inscribe`/`ward` authoring rituals + naming             |
| cassandra | verify   | cold-agent usability + end-to-end drive of the assembled spell             |

**To engage the team:** run `/anthill:convene` to start a working session (the
invoking agent becomes the lead, stands up coordination, and briefs the seats).
A seat agent joins with `/anthill:join <handle>`. Wrap a session with
`/anthill:finalize-session`.

## Working conventions

Project build/runtime conventions (Bun-first, testing, frontend) live in
[`CLAUDE.md`](./CLAUDE.md). The craft canon — what a spell is, house style, the
authoring rituals — lives in
[`docs/PROJECT_MANIFESTO.md`](./docs/PROJECT_MANIFESTO.md) and
[`grimoire/house-style.md`](./grimoire/house-style.md).
