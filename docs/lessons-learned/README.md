# Lessons Learned

This directory contains lessons learned from issues encountered during
development. Each lesson captures a specific problem, its context, and the
solution pattern, making it easier to recognize and resolve similar issues in
the future.

## Purpose

The main purpose of lessons learned is to **preserve hard-won knowledge** - the
diamonds found through making mistakes, wrestling with problems, and discovering
non-obvious solutions. These are actionable, concrete insights that aren't
easily Googled or obvious in hindsight.

Lessons learned can be:

- **Specific bugs/issues** - Non-obvious problems with tools, dependencies, or
  configurations
- **Code patterns** - "Don't do X, do Y" guidance based on repeated encounters
  or painful discovery
- **Synthesis from sessions** - Patterns that emerge across multiple debugging
  sessions

### Why Document Lessons?

- **Avoid repeating mistakes** - Future you (or teammates) won't waste hours on
  the same issue
- **Capture non-obvious knowledge** - Things that aren't in docs, are buried in
  GitHub issues, or require specific context
- **Enable quick reference** - When you encounter similar issues, find the
  solution fast
- **Share hard-won insights** - Make your struggle valuable for others
- **Build institutional memory** - Preserve knowledge even as dependencies and
  team members change

Lessons learned differ from other documentation:

- **Sessions** document what happened during work (the journey)
- **Playbooks** provide repeatable workflows for common tasks
- **Lessons learned** capture specific problems/patterns and their solutions
  (the diamonds)

## When to Create a Lesson

Create a lesson learned when:

- **Hard-won discovery** - You spent significant time figuring something out
  that wasn't obvious
- **Non-obvious solution** - The fix wasn't easily found in docs or by Googling
- **Pattern emerges** - You've hit the same issue multiple times and want to
  document the solution
- **Configuration gotcha** - Specific tool/version behavior that's easy to get
  wrong
- **Code pattern lesson** - "Don't do X, do Y" guidance based on painful
  experience

**Key test:** Does this feel like a hard-won insight? If someone told you this
upfront, would it have saved you meaningful time?

**Don't create lessons for:**

- Obvious mistakes (typos, syntax errors, things you "should have known")
- Well-documented behavior easily found in official docs
- Trivial issues resolved in minutes
- One-off flukes unlikely to recur

## File Naming

- `short-descriptive-topic.md`
- Examples:
  - `nuxt-image-optimization-memory-leak.md`
  - `vitest-esm-import-resolution.md`
  - `postgres-connection-pool-exhaustion.md`

## Template

A ready-to-use template is available: **[TEMPLATE.md](./TEMPLATE.md)**

The template is flexible to accommodate different types of lessons:

- **Bug/issue lessons** - Use Problem/Environment/Root Cause/Solution structure
- **Pattern lessons** - Focus on Don't/Do/Why format with examples

### Core Sections

- **The Lesson** - Clear, actionable takeaway (what should people know?)
- **Context** - When/why this matters, what prompted the discovery
- **The Fix/Pattern** - Concrete solution with code examples if relevant
- **Why This Works** - Explain the reasoning, not just the what

### Optional Sections (Use as Needed)

- **Environment** - Only if specific to OS/runtime/versions
- **How We Discovered This** - The journey if it adds value
- **Related Resources** - Links to docs, issues, similar lessons

**Keep it concise and actionable** - aim for quick reference, not exhaustive
explanation.

## Tips

### Writing Lessons

- **Lead with the takeaway** - Don't bury the lesson in backstory; make it
  immediately actionable
- **Show, don't just tell** - Include minimal code examples demonstrating the
  wrong→right pattern
- **Explain the "why"** - Help people understand the reasoning, not just
  memorize the fix
- **Be specific when relevant** - Version numbers and environment details when
  they matter for recognizing stale lessons
- **Keep it concise** - These are quick reference docs, not deep-dive articles

### Maintenance

- **Tag clearly** - Use tags to make lessons searchable (e.g., `#toolname`,
  `#framework`, `#platform`)
- **Link generously** - Connect to GitHub issues, Stack Overflow, official docs,
  related lessons
- **Update or archive** - When dependencies change and a lesson no longer
  applies, mark it as outdated
- **Extract to playbooks** - If a lesson becomes a repeatable pattern, consider
  creating a playbook

### Synthesis from Sessions

- **Watch for patterns** - If you hit the same issue across multiple sessions,
  create a lesson
- **Reference sessions** - Link back to the session(s) where you encountered
  this
- **Generalize appropriately** - Abstract the lesson enough to be useful beyond
  the specific instance
