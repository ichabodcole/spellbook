<!--
IMPORTANT: If you haven't read the README.md in this directory, please read it first for context on when to
create architecture docs and what to include.

USING THIS TEMPLATE:

Architecture docs map the landscape - they explain what a system is, what it does, where its boundaries are,
and how major pieces fit together. Focus on high to mid-level; don't document all the code.

Think: "What do I need to understand to confidently work with this system?"
Not: "Every detail of how this system is implemented"

Use sections that help explain the system. Skip sections that don't add value.
If your doc feels exhausting to read, you've gone too deep - developers can read code for details.
-->

# [System/Component Name]

**Created:** YYYY-MM-DD **Last Updated:** YYYY-MM-DD **Last Reviewed:**
YYYY-MM-DD **Status:** Current | Deprecated

---

## Overview

[1-2 paragraph description of what this system is, why it exists, and its role
in the application]

## Purpose & Responsibilities

What does this system do? What are its boundaries - what is it responsible for
and what is it NOT responsible for?

**Responsibilities:**

- [What this system does]
- [What this system manages]

**Boundaries:**

- [What this system does NOT do - where other systems take over]

## Architecture

### High-Level Design

[Describe the overall architecture - you can include diagrams (via text or
mermaid), ASCII art, or just text descriptions]

```
┌─────────────┐
│  Component  │
│      A      │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Component  │
│      B      │
└─────────────┘
```

### Key Components

[Describe the major pieces of this system and their roles]

#### [Component Name]

**Location:** `src/path/to/component.ts` **Purpose:** [What it does] **Key
APIs/Functions:** [Important functions or entry points]

[Add more components as needed - focus on major pieces, not every file]

## Data Flow

How data moves through the system

1. [Step 1: Data enters from X]
2. [Step 2: Processed by Y]
3. [Step 3: Output to Z]

[Consider using a simple diagram if it helps clarify the flow]

## Key Patterns (Optional)

Important patterns or conventions used in this system

### [Pattern Name]

**When to use:** [Scenario] **Example:** [Code example or description]
**Rationale:** [Why we use this pattern]

[Add more patterns if relevant to understanding the system]

## Integration Points

How this system connects to other parts of the application (system boundaries)

- **[System/Component Name]:** [How they interact, what's exchanged]
- **[External Service/API]:** [How they interact, what's exchanged]

[Focus on boundaries and communication patterns - where does this system touch
other systems?]

## Important Gotchas & Considerations

Things to keep in mind when working with this system

- [Gotcha or important consideration 1]
- [Gotcha or important consideration 2]
- [Common mistakes or things that aren't obvious]

[If there are specific gotchas around performance, security, state management,
or error handling, call them out here]

## Testing (Optional)

[Only include if there's something specific worth noting about testing this
system]

- **Test location:** `tests/path/to/tests.spec.ts`
- **Key scenarios to test:** [Important test cases]
- **Testing gotchas:** [Anything tricky about testing this system]

## Known Issues & Limitations (Optional)

[Current constraints or limitations worth documenting]

- [Issue or limitation]
- [Workaround or mitigation if available]

## Related Documentation

- [Playbook for augmenting this system](../playbooks/playbook-name.md) (if
  applicable)
- [Related architecture doc](./other-doc.md)
- [Project that introduced this](../projects/project-name/proposal.md)
- [External documentation](URL)

---

## Revision History

Track major architectural changes

- **YYYY-MM-DD** - Initial documentation
- **YYYY-MM-DD** - [Major change description]
- **YYYY-MM-DD** - [Major change description]
