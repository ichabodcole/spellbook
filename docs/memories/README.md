# Memories

Quick-reference summaries of recent work for agent and developer onboarding.
Read this folder at the start of a new session to understand what's been
happening lately.

---

## Purpose

Memories bridge the gap between git logs and full project documentation. They
answer "what have we been working on?" without requiring someone to scan commits
or explore file trees.

- **For agents:** Eliminates cold-start orientation work at the beginning of
  fresh sessions
- **For developers:** Quick catch-up after time away from the project

## When to Create a Memory

Create a memory when a scope of work is completed:

- A feature branch is finalized and merged
- A body of work reaches a natural stopping point
- A significant decision is made or direction changes

**Don't create memories for:** trivial changes, mid-work progress (use session
docs for that), or work that's already well-described by its commit messages
alone.

## File Naming

```
YYYY-MM-DD-short-description.md
```

Examples:

- `2026-02-09-documentation-restructuring.md`
- `2026-02-15-auth-provider-migration.md`
- `2026-03-01-performance-optimization.md`

## Template

A ready-to-use template is available: **[TEMPLATE.md](./TEMPLATE.md)**

Each memory should be short — a heading, a few sentences, key files, and a link
to deeper docs. If you're writing more than a short paragraph, the detail
probably belongs in a session doc or project folder instead.

## Pruning

Remove old memories when they're no longer relevant for onboarding context. A
good rule of thumb: keep roughly the last few weeks to a month of work. Move
stale memories to `memories/_archive/` or simply delete them — the information
lives on in project docs and git history.

## Tips

- **Keep it short** — A memory is a signpost, not a narrative
- **Link generously** — Point to project folders, architecture docs, or specific
  files for depth
- **One memory per scope of work** — Don't combine unrelated work into a single
  file
- **Write for a stranger** — Assume the reader has zero context about what
  happened
