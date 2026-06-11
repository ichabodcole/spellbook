# Briefs

This directory contains project briefs — lightweight documents that capture the
identity and direction of an idea before any implementation decisions are made.

---

## Purpose

A brief answers: **"What is this idea and why is it interesting?"** — without
getting into how to build it. Briefs are the output of a workshop session where
a rough spark gets developed into something concrete enough to act on.

Briefs predate projects. They sit at the very beginning of the documentation
lifecycle:

```
Fragment (or fresh spark) → Workshop → Brief → Investigation / Project / Manifesto
```

### Why Document Briefs?

- **Capture the "why" before the "how"** — Ideas lose their original context
  quickly. The brief preserves the spark, the influences, and the vision.
- **Prevent premature commitment** — Creating a project folder implies
  commitment to build. A brief lets you explore the idea first.
- **Enable multiple outcomes** — A single brief might spawn investigations, a
  project, a manifesto, or nothing at all. The brief doesn't assume the path.
- **Revisit later** — Parked briefs are captured ideas waiting for the right
  moment.

---

## When to Create a Brief

Create a brief when:

- **You have a rough idea** — "I want to build something that does X" but
  haven't scoped it yet
- **A fragment needs development** — An observation or hunch is interesting
  enough to explore
- **Starting a new project from scratch** — Before jumping into proposals, step
  back and workshop the idea
- **Feature spark for existing project** — A feature idea that needs shaping
  before it becomes a proposal
- **You want to capture inspiration** — Apps, experiences, or concepts that are
  influencing your thinking

## When NOT to Create a Brief

- **You already know what to build** — Go straight to a project with a proposal
- **You have a specific question** — Create an investigation instead
- **It's a small task** — Use a backlog item
- **You're documenting something that happened** — Use a session or lesson
  learned

---

## File Naming

- `YYYY-MM-DD-<name>.md`
- Use kebab-case for the name
- Examples:
  - `2026-02-21-generative-art-explorer.md`
  - `2026-02-21-photo-story-booth.md`
  - `2026-03-05-collaborative-writing-tool.md`

---

## Template

A ready-to-use template is available:
**[BRIEF.template.md](./TEMPLATES/BRIEF.template.md)**

Copy this template to start a new brief. The template includes all recommended
sections with guidance on what to include.

---

## Brief Statuses

- **Draft** — Workshop in progress, still being shaped
- **Active** — Workshop complete, next steps identified but not yet started
- **Spawned** — Has produced investigations, projects, or a manifesto. Update
  the Suggested Next Steps section with links to what was created.
- **Parked** — Captured but not ready to act on yet. May be revisited later.

---

## After the Brief

A brief's Suggested Next Steps section identifies what comes next. Common paths:

### Path: New Project

The brief becomes the seed for a project proposal. Create a project folder and
reference the brief as the origin.

### Path: Investigations Needed

Open questions in the brief need research before proposing. Create
investigations for each, linking back to the brief.

### Path: Manifesto First

For greenfield projects, the brief's vision and boundaries may be substantial
enough to warrant writing a project manifesto before creating a project folder.

### Path: Park It

The idea is captured but the timing isn't right. Set status to Parked and
revisit when ready.

---

## Relationship to Other Documentation

- **Fragments** capture stray observations; briefs develop them into concrete
  ideas
- **Investigations** explore specific questions; briefs identify which questions
  need investigating
- **Proposals** define what to build; briefs define what the idea is before
  proposing how
- **Manifesto** defines project identity; briefs capture that identity before
  the project exists
