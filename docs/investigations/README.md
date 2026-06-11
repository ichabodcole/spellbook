# Investigations

This directory contains investigation documents for exploring questions,
gathering data, and determining whether action is needed before committing to a
formal proposal.

---

## Purpose

The main purpose of an investigation is to **explore uncertainty** and **gather
evidence** before deciding if action is warranted. Investigations help answer:

- "Should we refactor this code?"
- "Is this technology a good fit for our use case?"
- "Is there actually a performance problem here?"
- "What are the options for solving X?"

Investigations bridge the gap between an initial question and a formal proposal.
They're for when you're not yet sure if building something is the right move.

### Why Document Investigations?

- **Prevent re-investigation** - Avoid re-examining the same question months
  later
- **Share learning** - Make findings accessible to team members (human and AI)
- **Document "no" decisions** - Capture why we chose not to act, preventing
  future wheel-spinning
- **Build evidence-based culture** - Ground decisions in research, not
  assumptions

---

## When to Create an Investigation

Create an investigation when:

- **Uncertain if action is needed** - You have a question but don't know if it
  warrants a proposal
- **Need data before deciding** - Performance metrics, code analysis,
  feasibility checks
- **Evaluating alternatives** - Comparing technologies, approaches, or patterns
- **Code quality concerns** - "Should we refactor X?" requires analysis first
- **Exploring feasibility** - "Could we even build this?" before proposing it

**Complexity:** Investigations should be **lightweight to moderate
complexity** - focused research with clear boundaries. If the investigation
grows too complex, document progress and continue in a follow-up investigation.

**Signs an investigation is growing too complex:**

- Analyzing 10+ files across multiple systems
- Evaluation scope keeps expanding beyond initial boundaries
- Evaluating multiple competing approaches with deep analysis for each
- Uncovering new questions faster than answering the original one
- Needing input from multiple stakeholders to proceed

**Note:** Avoid time-boxing investigations. Use complexity indicators (scope,
file count, depth) rather than hour estimates, as AI agents and humans work at
different speeds.

---

## When NOT to Create an Investigation

- **Already certain action is needed** - Create a proposal instead
- **Trivial questions** - Quick code reads or minimal-complexity explorations
  don't need documentation
- **Historical record** - Use sessions to document what happened during work
- **Already have a proposal** - Don't investigate what's already decided; create
  a plan instead

---

## File Naming

- `YYYY-MM-DD-topic-investigation.md`
- Examples:
  - `2025-10-14-ai-composable-refactoring-investigation.md`
  - `2025-10-15-tauri-migration-feasibility.md`
  - `2025-10-20-document-search-performance-investigation.md`

---

## Template

A ready-to-use template is available:
**[YYYY-MM-DD-TEMPLATE-investigation.md](./YYYY-MM-DD-TEMPLATE-investigation.md)**

Copy this template to start a new investigation, replacing `YYYY-MM-DD` with the
current date and `TEMPLATE` with your topic. The template includes all
recommended sections with guidance on what to include.

### Key Sections

The template provides structure for:

- **Metadata** (Date, Investigator, Status, Outcome) - Consistent across all
  investigations
- **Question/Motivation** - What we're investigating and why
- **Current State Analysis** - Code references, metrics, observations
- **Investigation Findings** - Evidence, observations, options considered
- **Recommendation** - Clear outcome and next steps
- **Open Questions** - What needs further discussion
- **Next Steps** - Concrete actions

Feel free to adapt sections as needed - the template is a starting point, not a
rigid requirement.

---

## Tips

### Effective Investigation Practices

1. **Scope ruthlessly** - Keep investigations lightweight to moderate
   complexity. If scope grows too large, document progress and create a
   follow-up investigation
2. **Focus on evidence** - Code references, metrics, concrete examples over
   speculation
3. **Be objective** - Present findings neutrally; recommendation comes at the
   end
4. **Document "no" decisions** - Capturing why we didn't act is as valuable as
   capturing why we did
5. **Link generously** - Reference code files, existing docs, related issues

### Code Analysis

When analyzing code:

- Use specific file paths and line numbers:
  `src/renderer/composables/useAI.ts:42-67`
- Quote relevant code snippets (keep short - 5-10 lines max)
- Identify patterns (duplication, complexity, inconsistency)
- Note test coverage gaps if relevant

### Technology Evaluation

When evaluating a technology or approach:

- Test compatibility with current stack
- Estimate migration/integration effort
- Compare bundle size, performance, DX
- Check community support, maintenance status
- Consider learning curve for team

### Performance Investigation

When investigating performance concerns:

- Gather baseline metrics (current performance)
- Identify bottlenecks (profiling, timing)
- Estimate impact of potential fixes
- Consider whether it's worth optimizing

---

## Investigation Outcomes

### Outcome: Proposal Recommended

**Next Step:** Create a formal proposal

**What to include in proposal:**

- Link back to this investigation
- Use findings as "Current State" section
- Build on "Options Considered" for solution exploration
- Reference evidence gathered here

**Example:**

> Based on
> [Investigation: AI Composable Refactoring](../../investigations/2025-10-14-ai-composable-refactoring-investigation.md),
> we found 70% code duplication across AI workflows. This proposal outlines a
> composable factory pattern to reduce duplication.

### Outcome: No Action Needed

**What to document:**

- Why current state is acceptable
- What would trigger revisiting this (if anything)
- Any monitoring or metrics to watch

**Consider:** Write a brief "decision not to act" note in the investigation's
conclusion, or reference it in architecture docs if relevant.

### Outcome: Needs More Research

**What to document:**

- What questions remain unanswered
- What additional investigation is needed
- Timeline for follow-up

**Next Step:** Create a follow-up investigation or expand the current one.

### Outcome: Monitor

**What to document:**

- Specific metrics or signals to watch
- Threshold for taking action
- When to check back (e.g., "Review in 3 months")

---

## Example Investigations

### Example 1: Refactoring Investigation

**Scenario:** AI composables are growing complex

**Investigation found:**

- 70% code duplication across 4 composables
- Every new workflow requires 200+ lines boilerplate
- Inconsistent error handling led to 3 bugs

**Outcome:** Project created → `projects/ai-composable-factory/`

### Example 2: Technology Evaluation

**Scenario:** Should we switch from Electron to Tauri?

**Investigation found:**

- Bundle size would decrease 40MB
- Migration would take 3-4 weeks
- Tauri doesn't support libSQL main process patterns
- Major architecture changes required

**Outcome:** No Action Needed **Rationale:** Migration cost outweighs benefits;
Electron working well for our use case

### Example 3: Performance Analysis

**Scenario:** Document list feels slow

**Investigation found:**

- 100 documents load in 85ms (acceptable)
- Perceived slowness due to lack of loading indicator
- Actual bottleneck: initial app startup, not document loading

**Outcome:** Project created → `projects/loading-states-improvement/`

---

## Investigation → Project Flow

Investigations precede projects. When an investigation concludes with "yes,
build this":

1. **Create a project folder** in `projects/` with a descriptive kebab-case name
2. **Write the project's proposal** referencing this investigation
3. **Update the investigation's Outcome field** to point to the project (e.g.,
   `Project created → projects/oauth-upgrade/`)
4. **Update Related Documents** to link to the project's proposal

The investigation stays in `investigations/` — it never moves into the project
folder. This keeps the link stable and acknowledges that investigations can feed
multiple projects.

## Archival

Archive an investigation when:

- **Action was taken:** The resulting project work has been completed. The
  investigation's value is now captured in the project's documents.
- **No action needed:** The investigation concluded that no work is warranted.
  Archive it to document the decision.
- **Superseded:** A newer investigation covers the same ground.

**Don't archive** an investigation while its resulting project is still active —
the investigation provides context that may be referenced during implementation.

Move completed investigations to `investigations/_archive/`.

## Relationship to Other Documentation

- **Projects** contain proposals, plans, and sessions; investigations determine
  whether a project is warranted
- **Architecture** documents existing systems; investigations analyze if those
  systems need changes
- **Lessons Learned** capture specific problems solved; investigations explore
  potential problems
- **Reports** assess current state; both reports and investigations can trigger
  new projects

---

## Frequently Asked Questions

### How is an investigation different from a proposal?

**Investigation:** "Should we do something?" (uncertain outcome) **Proposal:**
"What should we build?" (committed to action)

Investigations can conclude with "no action needed." Proposals assume action is
warranted.

### Can an investigation conclude that no proposal is needed?

**Yes!** This is a valid and valuable outcome. Documenting why we investigated
and chose NOT to act prevents future wheel-spinning on the same question.

### How complex should an investigation be?

**Lightweight to moderate complexity** - focused analysis with clear boundaries.
If the investigation becomes too complex, you should either:

- Conclude with current findings
- Document progress and continue in a follow-up investigation
- Escalate to a discussion/meeting if it's too complex

### What if I'm not sure whether to create an investigation or proposal?

Ask yourself:

- **Am I certain action is needed?** → Proposal
- **Do I need to gather evidence first?** → Investigation
- **Am I exploring "should we?" vs. "what should we?"** → Investigation

### Should investigations be updated as we learn more?

**Yes**, while the investigation is **Active**. Once concluded, investigations
should generally not be updated. If new information emerges later, create a new
investigation or reference the old one in a new proposal.
