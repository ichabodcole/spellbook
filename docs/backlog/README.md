# Backlog

This directory contains **backlog items** — small, self-contained work items
that don't warrant a full project folder. Bugs, minor refactors, papercuts, and
clear tasks that can be described and completed without a proposal.

## Purpose

The backlog provides a lightweight path for tracking work that would otherwise
go undocumented or be forced through the full proposal/plan pipeline. It bridges
the gap between "too small for a project" and "do it without any documentation."

### Why Use Backlog Items?

- **Low ceremony** - Create a short file, describe the task, do the work
- **Discoverable** - Small tasks are tracked rather than forgotten or scattered
  across commit messages
- **Archivable** - Completed items move to `_archive/` for history without
  cluttering the active list
- **Clear threshold** - If it needs a proposal, it's a project. If it doesn't,
  it's a backlog item.

## When to Create a Backlog Item

- **Known bug** with a clear fix
- **Minor refactor** - rename, restructure, clean up
- **Small feature** - add a field, update a label, tweak behavior
- **Papercut** - something annoying that just needs fixing
- **Chore** - dependency update, config change, tooling tweak

## When NOT to Create a Backlog Item

- **Needs a proposal** - If the work requires design decisions or option
  exploration, create a project
- **Will span multiple sessions** - If it's complex enough to need a plan, it's
  a project
- **Still investigating** - If you're unsure what to do, create an investigation
  first
- **Incomplete thought** - If it's just an observation or hunch, use a fragment

**Rule of thumb:** If you can describe the work in a few sentences and someone
could complete it without further discussion, it's a backlog item. If it needs
design, exploration, or scoping, it's a project.

## File Naming

- `YYYY-MM-DD-short-description.md`
- Examples:
  - `2026-02-09-fix-date-formatting.md`
  - `2026-02-10-rename-sync-endpoint.md`
  - `2026-02-15-add-missing-error-state.md`

## Template

A ready-to-use template is available: **[TEMPLATE.md](./TEMPLATE.md)**

Copy this template to create a new backlog item, replacing the filename with the
date and a short description.

## Lifecycle

1. **Create** - Describe the task in a new file
2. **Work** - Pick it up and complete it
3. **Archive** - Move the completed file to `backlog/_archive/`

Active backlog items reflect current work that needs doing. Completed items are
archived to keep the active list focused.

## Tips

- **Keep it brief** - A backlog item should be quick to write and quick to read
- **Include references** - If you know the relevant files, include them. It
  saves discovery time later.
- **Don't overthink acceptance criteria** - Include them if the "done" state
  isn't obvious. Skip them for clear tasks.
- **Remove when done** - Move to `_archive/`, don't leave completed items in the
  active backlog
