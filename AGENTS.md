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
coordinate over **two message wires and a board**: `anthill comms` (the
seat-aware log, durable across sessions), the `spellbook` grapevine channel (the
back-channel, cleared each session), and the bounty board (task state). The
team's living docs and config live in [`.anthill/`](./.anthill/)
(`.anthill/config.json` is the keystone — including the `gate` every seat's land
runs; each seat has a doc under `.anthill/dev/`, and the team's earned
principles in `.anthill/principles.md`).

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
A seat agent joins with `/anthill:join <handle>`. For a feature spanning several
seats, the lead scaffolds the plan with `/anthill:plan` (skeleton → the owning
seats ratify the seams they touch) before building. Wrap a session with
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

## Branch Landing Policy

Branches, merges, and the PR message. **`project-docs:finalize-branch` resolves
this section by name** — the heading text is the contract, so do not rename it.

**Run this before deciding a strategy:**

```bash
bun scripts/land-check.ts <base> <branch>
```

**Exit `0` = squash-safe · `1` = named merge required · `2` = no verdict**
(empty range — a stale base or an already-merged branch; **not** a green).
**Exit 0 PERMITS squashing; it does not require it** — fast-forward keeps the
branch's commits and is usually the better choice when their messages carry
reasoning.

> **⚠ Other plugin skills may still default to squash** — e.g.
> `superpowers:finishing-a-development-branch`. **This section wins.** Plugin
> skills supply the _trigger_; this file supplies the _content_ — the same split
> as `gate` in `.anthill/config.json`, which has no default on purpose.
>
> _Narrowed 2026-08-07 by its own repeal criterion. This used to override
> `finalize-branch` too; as of project-docs 3.1.0 that skill **asks** instead of
> defaulting, so there is nothing left to override there. The criterion
> deliberately scoped to the override framing and **not** to the policy — when
> the plugin defers, this section becomes the content it resolves, so it is
> needed more rather than less. (Sprint 01's G5 is why that distinction was
> written down: it said "repealed the moment the harness does it for you," one
> harness did, and the rule repealed itself while three suites were still
> broken.)_

**Flow:** feature branch off `develop` → **named merge** into `develop` → push →
PR `develop` → `main` → merge → pull `main`, merge into `develop`, push.

### Do NOT squash a feature branch. Merge it, and name the merge.

**Squashing is only correct when BOTH are true:**

1. **Nothing cites a sha from the branch** — not in `docs/`, not in `.anthill/`,
   not in a commit body. **⚠ The check greps THIS REPO ONLY** — a sha cited in
   an external knowledge base or a GitHub issue is invisible to it, and you must
   supply that yourself.
2. **There is one author** — no `Anthill-Seat:` trailers to destroy. **⚠ This
   fails open**: without trailers it counts _git_ authors, and git records the
   human as author of every seat's commit, so a four-agent branch reports 1.

**Neither holds for agent-team work, and the numbers are not marginal.** Sprint
02 of spell-hardening: **10 of 60 shas cited in live documents**, four seats'
trailers. Squashing would have broken all **10 references to the anti-drift
mechanism this project deliberately adopted** — plans pin `file:line` claims to
shas precisely because line numbers rot.

**The full procedure is the `land` skill** (`.claude/skills/land/`) — invoke it
at the moment you merge. It carries the merge-message construction, the PR
message, the back-merge, and the traps. **Prefer what `land-check` printed over
anything retyped here.**

> **⛔ Build the merge message as ONE file and pass `-F`.** Not
> `-m "<subject>" -m "<body>"`, and never `-m "<subject>" -F <body>` — git
> concatenates with no blank line, so the whole first paragraph becomes the
> subject. That shipped a **251-character subject** here once already.

### Reading history — two queries, two questions

```bash
# what FEATURES landed          (~22 entries)
git log --merges --format='%h %ci %s' | grep -v "Merge pull request"

# what RELEASES shipped         (main's spine)
git log --first-parent main --format='%h %ci %s'
```

> **⚠ `--first-parent develop` does NOT work here and is a trap.** The
> `develop`→`main` PR merge is created **on main**, so its first parent is main
> and its second is develop. The back-merge then **fast-forwards** develop onto
> that commit — so develop adopts **main's** spine and every named feature merge
> drops to a second parent, invisible to `--first-parent`.

### The PR message is written by a FRESH agent, from the tree

**Not by the lead of the session that did the work.** The lead knows what was
_interesting_ (the falsifications, the instrument failures — that is the
**retro**); it does not reliably know what was _delivered_.

**And the reconstruction is the point:** a fresh agent reading the tree is doing
exactly what a future reader will do. **If it cannot write a good message from
the artifacts, that is a finding about the docs, not about the agent** — and you
want that at merge time. _Same rule as the cold reviewer: give it the tree, not
the wire._

**Dispatch it with the branch and the base and nothing else.** No session log,
no summary. It reads `git log`, the diff, and the project docs, then writes:

- **subject** — what shipped, in the USER's terms. ✅
  `bounty close --help no longer closes the board` ❌ `P0c parser conversion`
- **body** — what it was for · what was delivered · decisions a reader needs ·
  **what it deliberately does NOT reach.** Short. Not a changelog.

```bash
gh pr create --base main --head develop --title "<subject>" --body-file <file>
```

**⛔ The agent CREATES the PR. Cole MERGES it.** `gh pr merge` lands on `main`
and triggers release-please — that is the release, and the release is Cole's.
**When merging, pass the subject** so the release spine is named rather than
`Merge pull request #NN`:

```bash
gh pr merge --merge --subject "<subject>" --body-file <file>
```

## Where the canon lives

- **The documentation structure** — [`docs/README.md`](./docs/README.md), with
  [`docs/AGENTS.md`](./docs/AGENTS.md) as the agent-facing tour (it loads
  automatically once you are working in `docs/`). **`docs/` is a structured
  system with a lifecycle, not a folder of loose files** — read one of those two
  before filing anything, because where a document goes is a decision the
  structure has already made. **For what happened recently, start with
  [`docs/memories/`](./docs/memories/).**
- **What a spell is, and why** —
  [`docs/PROJECT_MANIFESTO.md`](./docs/PROJECT_MANIFESTO.md) (agent-as-runtime,
  surface-fit, co-presence, the craft loop).
- **House style** — [`grimoire/house-style.md`](./grimoire/house-style.md): the
  operational conventions, each an imperative + boundary + repeal criterion.
- **Current state** — [`docs/PROJECT-SUMMARY.md`](./docs/PROJECT-SUMMARY.md).
- **The authoring rituals** — `inscribe` (grow a spell) and `ward` (pre-merge
  consistency checklist), owned by the grimoire seat.
