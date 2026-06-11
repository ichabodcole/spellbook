# Architecture Documentation

This directory contains architecture documentation for the systems and
components that make up the application. These documents help developers
understand how systems work, how they interact, and the reasoning behind key
design decisions.

## Purpose

Architecture documents serve as the authoritative reference for understanding
the design and implementation of complex systems. They describe what systems
exist, what they do, where their boundaries are, and how the major pieces fit
together.

Think of architecture docs as **maps of the landscape** - they show the major
landmarks, system boundaries, and how components relate to each other. They help
developers build a mental model of a system without having to read all the code.

### Why Document Architecture?

- **Understand system boundaries** - Know where one system ends and another
  begins
- **Build mental models** - Help developers understand how major pieces fit
  together
- **Enable confident changes** - Make updates knowing what the system does and
  how it's structured
- **Preserve design rationale** - Capture why decisions were made, not just what
  was built
- **Facilitate onboarding** - Help new developers (human and AI) orient to
  complex systems
- **Complement playbooks** - Playbooks show how to augment systems; architecture
  docs explain what those systems are

### What to Document

Architecture docs capture:

- System design decisions and their rationale
- Component interactions and data flows
- Integration points and system boundaries
- Technical constraints and trade-offs
- Important gotchas or things to keep in mind

**Appropriate level of detail:** Focus on high to mid-level - the major pieces
and how they fit together. Don't document all the code; developers can read
code. Document the landscape so someone can understand what exists and how to
navigate it.

**Avoid exhaustive detail:** If your doc feels exhausting to read, you've gone
too deep. Keep it useful, not comprehensive.

## When to Create Architecture Documents

Create architecture documentation for:

- **Core system flows** - End-to-end features involving multiple components
- **Complex subsystems** - Background processing, authentication, caching
  strategies
- **Major integrations** - Third-party services, APIs, databases, message queues
- **Cross-cutting concerns** - Logging, error handling, security patterns

**Don't create architecture docs for:**

- Simple utilities or helpers
- Individual UI components (unless part of a larger system architecture)
- Standard CRUD operations with no special design
- Code fully explained by inline comments and types

## File Naming and Organization

- **Single files** for focused systems: `system-name-architecture.md` or
  `feature-name-flow.md`
- **Subdirectories** for complex systems with multiple related documents
- **Index files** (`README.md`) in subdirectories to provide navigation

Examples:

- `authentication-architecture.md`
- `payment-processing-flow.md`
- `job-queue/README.md` (for complex systems with multiple docs)

## Template

A ready-to-use template is available: **[TEMPLATE.md](./TEMPLATE.md)**

Copy this template when documenting existing systems. Architecture docs explain
"how things work" - they're written after implementation, not before.

### Key Sections

The template includes:

- **Metadata** (Created, Last Updated, Last Reviewed, Status) - Track
  documentation currency and accuracy
- **Overview** - Purpose and high-level description
- **Purpose & Responsibilities** - What the system does
- **Architecture** - High-level design with diagrams
- **Key Components** - Building blocks with code references
- **Data Flow** - How information moves through the system
- **Key Patterns** - Important conventions used
- **Integration Points** - Connections to other systems
- **Error Handling** - How errors are managed
- **Testing** - Test strategy and coverage
- **Known Issues & Limitations** - Current constraints
- **Future Enhancements** - Planned improvements

Adapt the structure to fit your system - not all sections may be relevant.

## Tips

### Writing Architecture Docs

- **Map the landscape, don't document the code** - Focus on major pieces, how
  they fit together, and system boundaries. Developers can read code for
  details.
- **Start with the "why"** - Explain what problem the system solves and why it
  exists
- **Define boundaries clearly** - Where does this system start and end? What's
  it responsible for?
- **Show relationships** - How do components communicate? Where are the
  integration points?
- **Call out gotchas** - Important things to keep in mind when working with this
  system
- **Include diagrams when helpful** - Visual representations clarify complex
  flows (ASCII art or Mermaid)
- **Reference actual code** - Link to specific files (use `path/to/file.ts:123`
  format for precision)
- **Document trade-offs** - Explain alternatives considered and why they were
  rejected

### Keeping It Useful, Not Exhaustive

- **Avoid over-documentation** - If readers would rather look at code than
  finish your doc, it's too detailed
- **Skip obvious sections** - Not every system needs Performance Considerations
  or Security sections
- **Write for orientation** - Help someone understand "what is this and how does
  it work" not "every detail of implementation"
- **Update as systems evolve** - Keep docs current when architecture changes
  significantly
- **Review periodically** - Check "Last Reviewed" dates and verify accuracy

## Relationship to Other Documentation

- **Proposals** capture ideas for future features; architecture docs describe
  what exists
- **Plans** outline implementation roadmaps; architecture docs explain the
  result
- **Playbooks** describe how to execute recurring tasks; architecture docs
  explain the systems involved
- **Sessions** document what happened during work; architecture docs provide the
  context for understanding that work
