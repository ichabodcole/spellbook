# Agent Guide — Spellbook

The single source of truth for agent onboarding in this repo. `CLAUDE.md` (and
any other tool-specific file) is a thin redirect here — keep the content in one
place.

> **Maintain this file as you work.** It exists to tell a fresh agent what it
> needs the moment it arrives _and couldn't easily discover on its own_. So:
>
> - If something here is wrong or stale, **fix it in the same change** — a
>   grounding file that lies is worse than one that stays silent.
> - If you hit a non-obvious rule, a "there's a tool for X — use it" pointer, or
>   a signpost to where important hidden things live, **add it**.
> - Keep the bar high: leave out anything discoverable with a little effort
>   (runtime basics, `package.json` contents, standard framework usage). This is
>   a curated synthesis, **not** a changelog.

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

## Project conventions (Bun-first)

This is a Bun project — **default to Bun, not Node.** These are the conventions
that bite if unknown; for full Bun API docs read
`node_modules/bun-types/docs/**.mdx`.

- **Tooling:** `bun <file>` (not `node`/`ts-node`), `bun test` (not
  jest/vitest), `bun install` (not npm/yarn/pnpm), `bun run <script>`, `bunx`
  (not npx), `bun build` (not webpack/esbuild). Bun auto-loads `.env` — don't
  use `dotenv`.
- **Prefer Bun built-ins over libraries:** `Bun.serve()` (not express),
  `bun:sqlite` (not better-sqlite3), `Bun.redis` (not ioredis), `Bun.sql` (not
  pg/postgres.js), built-in `WebSocket` (not ws), `Bun.file` (not `node:fs`
  read/write), `` Bun.$` `` (not execa).
- **Frontend:** HTML imports with `Bun.serve()` (not vite) — HTML files import
  `.tsx`/`.jsx`/`.js` directly and Bun bundles them; `<link>` to CSS/Tailwind
  bundles too. Full React/CSS/Tailwind support, no separate bundler.

## Where the canon lives

- **What a spell is, and why** —
  [`docs/PROJECT_MANIFESTO.md`](./docs/PROJECT_MANIFESTO.md) (agent-as-runtime,
  surface-fit, co-presence, the craft loop).
- **House style** — [`grimoire/house-style.md`](./grimoire/house-style.md): the
  operational conventions, each an imperative + boundary + repeal criterion.
- **Current state** — [`docs/PROJECT-SUMMARY.md`](./docs/PROJECT-SUMMARY.md).
- **The authoring rituals** — `inscribe` (grow a spell) and `ward` (pre-merge
  consistency checklist), owned by the grimoire seat.
