<!--
IMPORTANT: If you haven't read the README.md in this directory, please read it first for context on when to
create lessons learned and what makes a good lesson.

USING THIS TEMPLATE:

This template is flexible - adapt to the type of lesson you're capturing.

For CODE PATTERN lessons (e.g., "don't use X, use Y"):
- Focus on: The Lesson, Context, The Pattern (wrong→right), Why This Works

For BUG/ISSUE lessons (e.g., "Vitest fails with ESM imports"):
- Use: The Lesson, Context, Environment (if relevant), The Fix, Why This Works

Keep it concise and actionable. Lead with the takeaway - don't bury the lesson in backstory.
-->

# [Brief Lesson Title]

**Date:** YYYY-MM-DD **Tags:** `#tag1` `#tag2` `#tag3` **Type:** [Pattern |
Bug/Issue | Configuration | Integration]

---

## The Lesson

[Lead with the actionable takeaway - what should people know?

Examples:

- "Never use the `checked` property on components - always use `v-model` or
  `modelValue`/`update:modelValue`"
- "Vitest ESM imports fail when X - configure Y in vite.config.ts"
- "IPC listeners must be removed in cleanup or they accumulate on hot reload" ]

## Context

[When/why does this matter? What prompted this discovery?

- What problem were you solving when you discovered this?
- How did you encounter this issue (one session? repeated occurrences?)
- Who else might run into this? ]

## The Fix / Pattern

[Show the concrete solution with examples]

### Don't Do This:

```typescript
// Wrong approach
```

### Do This Instead:

```typescript
// Correct approach
```

## Why This Works

[Explain the reasoning - help people understand, not just memorize]

---

## Environment (Optional)

[Only include if specific to OS/runtime/versions. Skip if not relevant.]

- **Dependencies:** [Relevant package versions if version-specific]
- **Configuration:** [Specific config that matters]

## How We Discovered This (Optional)

[The journey if it adds value - how you wrestled with this, variations you
tried, etc.

This section can be useful context but isn't required if the lesson is
self-evident.]

## Related Resources

- [Related lesson learned](./other-lesson.md)
- [Session where this was encountered](../projects/project-name/sessions/session-name.md)
- [GitHub issue](URL)
- [Official docs](URL)
- [Stack Overflow answer](URL)
