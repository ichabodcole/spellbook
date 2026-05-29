<!--
IMPORTANT: If you haven't read the README.md in this directory, please read it first for context on when to
create specifications and what to include.

USING THIS TEMPLATE:

Domain specifications describe a single functional area of the application — one entity, one subsystem, or one
cohesive set of behaviors. Keep the scope focused: if a spec file grows beyond ~500 lines, consider splitting
it into multiple files or a subdirectory.

Remember: specifications are technology-agnostic. Describe WHAT the application does, not HOW it's coded.
No framework names, no library names, no language-specific syntax.
-->

# [Domain Name] Specification

## Overview

[1-3 sentences describing what this domain is and why it exists in the
application. What role does it play?]

## Data Model

### [Entity Name]

| Property | Type | Constraints | Default | Description |
| -------- | ---- | ----------- | ------- | ----------- |
|          |      |             |         |             |

<!--
Type conventions:
  string, number, boolean, enum, datetime, array, object
  Use "type or null" for nullable fields
  Use "type (optional)" for fields that may be omitted entirely
  List enum values in the Constraints column
-->

## Operations

### [Operation Name]

**Inputs:** [What data is required]

**Process:**

1. [Step-by-step description of what happens]
2. [Use numbered steps for sequential logic]

**Outputs:** [What is produced or returned]

**Side Effects:** [Changes to stored data, notifications sent, etc.]

## Business Rules

### [Rule Category]

- [Rule description — be specific about values and constraints]
- [Another rule]

<!--
For algorithms or calculations, use generic pseudocode:

function calculateSomething(inputA, inputB):
    result = inputA * inputB
    if result > THRESHOLD:
        return cap(result, MAX_VALUE)
    return result
-->

## State Machine

<!--
Include this section for any entity with a lifecycle (states + transitions).
Use ASCII art for the diagram and a table for transition details.
-->

```
[State A] --> [State B] --> [State C]
                  |
                  v
             [State D]
```

| From | Event | To  | Side Effects |
| ---- | ----- | --- | ------------ |
|      |       |     |              |

## User Interactions

### [Screen or Interaction Name]

**Purpose:** [What this screen or interaction accomplishes]

**Elements:**

- [Describe what the user sees and can interact with, by function]

**Actions:**

- [What the user can do and what happens in response]

<!--
Describe UI by function, not by component:
  Good: "a toggle that enables or disables notifications"
  Bad: "a React Switch component with onChange handler"
-->

## Edge Cases

| Scenario | Expected Behavior |
| -------- | ----------------- |
|          |                   |

## Related Specifications

- [Link to related spec files within this set]
