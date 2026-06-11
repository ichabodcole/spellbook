# Specifications

This directory contains technology-agnostic specification documents that
describe what the application is, what it does, and how it behaves.
Specifications serve as the definitive, living description of the application's
functionality — written in natural language, organized by domain.

## Purpose

Specifications capture the **what** and **why** of the application without
prescribing the **how**. They describe data models, business rules, user
interactions, and system behaviors in a way that is completely independent of
any programming language, framework, or platform.

Think of specifications as a **portable blueprint of the application's soul** —
if you handed these documents to a developer with no knowledge of the current
codebase, they could rebuild the application in any technology stack.

### Why Write Specifications?

- **Technology independence** - Describe behavior without coupling to a
  framework, enabling migration or multi-platform implementations
- **Shared understanding** - Give developers, designers, and stakeholders a
  common, readable description of what the application does
- **Living documentation** - Maintain an up-to-date representation of the
  application that evolves alongside the code
- **AI-friendly** - Provide clear, structured context that AI agents can use to
  understand, modify, or rebuild the application
- **Onboarding accelerator** - New team members understand the domain and
  application behavior before reading any code
- **Rebuild confidence** - If the technology needs to change, the specs provide
  a reliable foundation for reimplementation

### What Specifications Capture

- **Data models** - Entities, properties, types, constraints, defaults, and
  relationships
- **Business rules** - Validation logic, calculations, algorithms (as
  pseudocode)
- **State machines** - Lifecycle states and transitions for stateful entities
- **User interactions** - What the user sees and does, described by function
  rather than UI framework
- **Operations** - CRUD and domain-specific operations with inputs, outputs, and
  side effects
- **Edge cases** - Boundary conditions, error handling, and empty states

### What Specifications Avoid

- Framework or library names (React, Rails, Flutter, etc.)
- Language-specific syntax (no `=>`, `?.`, `async/await`)
- Platform-specific APIs (describe behavior generically)
- Implementation details (describe _what_ happens, not _how_ it's coded)
- UI component references (describe by function: "a toggle that controls X")

## When to Create Specifications

Create specification documents when:

- **Starting a new project** - Spec out the application before choosing
  technologies
- **Documenting an existing application** - Reverse-engineer specs from a
  working codebase to create a portable description
- **Planning a rewrite or migration** - Capture current behavior before changing
  the technology stack
- **Onboarding AI agents** - Provide structured context for AI-assisted
  development
- **Defining MVP scope** - Use specs to define what the first version includes

**Don't create specifications for:**

- Implementation details or technology choices (use an Implementation Blueprint
  for that)
- Architecture of the current codebase (use architecture docs)
- One-off tasks or processes (use playbooks)
- Ideas that haven't been validated (use investigations first, then create a
  project)

## File Naming and Organization

### Naming Convention

Files use a numbered prefix for reading order with lowercase kebab-case names:

- `NN-domain-name.md` (e.g., `01-overview.md`, `02-timers.md`, `03-sessions.md`)

The overview spec (`01-overview.md`) should always exist and serves as the entry
point.

### Choosing a Structure

**Flat structure** for simple applications (roughly 5-15 spec files):

```
specifications/
  01-overview.md
  02-users.md
  03-projects.md
  04-notifications.md
  05-settings.md
```

**Grouped structure** for complex applications or those with distinct
subsystems:

```
specifications/
  01-overview.md
  admin/
    01-overview.md
    02-user-management.md
    03-permissions.md
  storefront/
    01-overview.md
    02-catalog.md
    03-checkout.md
  shared/
    01-authentication.md
    02-notifications.md
```

**Rules of thumb:**

- Start flat. Only introduce subdirectories when the flat list becomes unwieldy
  or when clear subsystem boundaries exist.
- Each subdirectory should contain its own `01-overview.md`.
- The top-level `01-overview.md` should link to all subdirectory overviews.
- Shared or cross-cutting concerns belong in a `shared/` directory.

## Templates

Two templates are available:

- **[TEMPLATE-overview.md](./TEMPLATE-overview.md)** - For the `01-overview.md`
  entry point that every spec set should have
- **[TEMPLATE-domain.md](./TEMPLATE-domain.md)** - For individual domain
  specification files

Copy the appropriate template when starting a new specification document.

## Tips

### Writing Effective Specifications

- **Describe behavior, not implementation** - "The system sends a reminder
  notification 24 hours before the deadline" rather than "A cron job fires a
  Firebase push notification"
- **Use tables for structured data** - Entity properties, enum values, and edge
  cases are clearest as tables
- **Use pseudocode for algorithms** - Generic pseudocode with descriptive
  variable names, no language-specific syntax
- **Include state machines** - For any entity with a lifecycle, show states and
  transitions
- **Document the defaults** - Explicit default values prevent ambiguity during
  implementation
- **Be precise about constraints** - "1-100 characters" is better than "short
  text"
- **Call out nullable vs. optional** - These are different concepts; be explicit
  about which applies

### Technology-Agnostic Checklist

Before finalizing a specification, verify:

- [ ] No framework names (React, Vue, SwiftUI, Django, etc.)
- [ ] No library names (Dexie, Zustand, Tailwind, Alamofire, etc.)
- [ ] No language-specific syntax in pseudocode
- [ ] No platform-specific APIs referenced directly
- [ ] UI described by function, not component type
- [ ] Data storage described generically ("local database", "persisted storage")
- [ ] Time values in milliseconds with human-readable labels
- [ ] All constants have explicit values, not symbolic references

### Keeping Specifications Current

Specifications are living documents. They should evolve with the project:

- **Update alongside code changes** - When behavior changes, update the relevant
  spec in the same branch/PR
- **Validate periodically** - Cross-reference specs against the codebase to
  catch drift
- **Treat discrepancies as bugs** - If the spec and code disagree, investigate
  which is correct
- **Add new domains as the application grows** - New features may warrant new
  spec files

## Relationship to Other Documentation

- **Proposals** define what to build next; specifications describe what already
  exists (or what should exist)
- **Architecture docs** describe how the current codebase implements things;
  specifications describe what things do independent of implementation
- **Plans** outline implementation steps; specifications define what those steps
  should produce
- **Playbooks** describe recurring processes; specifications describe
  application behavior
- **Implementation Blueprints** map specifications to specific technology
  choices for building
