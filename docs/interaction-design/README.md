# Interaction Design Documentation

This directory contains interaction design documentation that captures how users
interact with different parts of your application. These documents focus on UX
flows, user journeys, and the design thinking behind interaction patterns -
helping developers and designers understand how features work from the user's
perspective.

## Purpose

Interaction design documents serve as the authoritative reference for
understanding **how users experience specific features and flows** in your
application. They describe user journeys, decision points, interaction patterns,
and the design rationale behind them.

Think of interaction design docs as **maps of user journeys** - they show the
path users take through features, where they make decisions, what they see and
do at each step, and why the experience is structured the way it is.

**This is NOT a design systems directory.** We're not documenting design tokens,
component libraries, or visual language here. This directory is specifically for
documenting **how users interact with features and flows** - the interaction
layer that sits alongside your technical architecture.

## Primary Use Case: Feature Flows & Interaction Patterns

The purpose of this directory is to document **how specific parts of your
application work from the user's perspective**:

- **Creation flows** - How users create or add new things
- **Update/edit flows** - How users modify existing items
- **Settings systems** - How configuration works and how it affects other
  features
- **Onboarding sequences** - First-time user experiences
- **Complex multi-step processes** - Checkout, wizard flows, multi-stage forms
- **Feature subsystems** - Discrete parts of your app with their own interaction
  logic

These documents answer: "What does the user experience when they interact with
this part of the app, and why is it designed this way?"

## Why Document Interaction Design?

- **Preserve design rationale** - Capture _why_ interaction decisions were made,
  not just what was built
- **Prevent unintentional changes** - Help developers understand design intent
  before making modifications
- **Build shared understanding** - Create common vocabulary between designers,
  developers, and stakeholders
- **Enable confident iteration** - Make updates knowing what users experience
  and why it matters
- **Facilitate onboarding** - Help new team members understand how features work
  from the user's perspective
- **Bridge design and code** - Complement technical architecture docs with
  user-centric perspective
- **Document decision points** - Capture where and why users make choices in
  flows

## What to Document

Interaction design docs capture:

- **User flows and journeys** - Step-by-step experiences through features
- **Decision points and branching** - Where users make choices and how it
  affects their path
- **Design rationale** - Why interaction patterns exist, what problems they
  solve, what alternatives were considered
- **UI component choices** - When it matters _why_ a specific component or
  pattern was selected
- **Error states and edge cases** - How the experience changes in different
  situations
- **Interactions between features** - How flows connect to or affect other parts
  of the app
- **Accessibility patterns** - How users with different needs navigate the
  experience

**Appropriate level of detail:** Focus on the user journey and design thinking.
Document what users see and do at each step, why it's structured that way, and
what decisions they make. Don't document exact pixel specs, design tokens, or
exhaustive UI details - that lives in design files, component libraries, and
code.

**Avoid exhaustive detail:** If your doc feels like a UI specification document,
you've gone too deep. Keep it focused on experience and rationale.

## When to Create Interaction Design Documents

Create interaction design documentation for:

- **Complex user flows** - Multi-step processes where users make meaningful
  decisions
- **Feature subsystems** - Distinct parts of your app with their own interaction
  logic
- **Settings or configuration** - Especially when settings affect experiences
  elsewhere
- **Onboarding or setup** - First-time user experiences
- **Core user journeys** - Critical paths through your application
- **Interaction patterns with important rationale** - When knowing _why_ a
  pattern exists matters

**Don't create interaction design docs for:**

- Simple CRUD operations with standard patterns
- Individual UI components without meaningful flow context
- Standard interactions fully documented in design files
- Every page in your app - focus on flows and subsystems, not exhaustive
  coverage
- Design tokens, color systems, typography scales - those belong in design
  system documentation, not here

## File Naming and Organization

- **Feature flows:** `[feature]-flow.md` or `[action]-flow.md`
  - Examples: `creation-flow.md`, `checkout-flow.md`, `settings-flow.md`
- **Complex subsystems with multiple flows:** Create subdirectories with
  `README.md`
  - Example: `onboarding/README.md` with multiple flow documents inside

## Template

A ready-to-use template is available: **[TEMPLATE.md](./TEMPLATE.md)**

The template is optimized for documenting **user flows and interaction
patterns** within specific features.

### Key Sections

The template includes:

- **Purpose & User Goals** - What users are trying to accomplish
- **User Flow** - Step-by-step journey with rationale for each step
- **Decision Points & Branching** - Where users make choices
- **Key Design Decisions** - Important patterns and why they exist
- **UI Components & Patterns** - Only when component choice matters to the
  experience
- **States & Edge Cases** - How the experience changes in different situations
- **Interactions Between Systems** - How this flow connects to other parts of
  the app
- **Design Rationale & Trade-offs** - Why this approach, alternatives considered
- **Accessibility Considerations** - How different users navigate the experience

Adapt the structure to fit your flow - not all sections may be relevant. Skip
sections that don't add value.

## Tips

### Writing Interaction Design Docs

- **Focus on the journey, not the pixels** - Document what users experience and
  why, not exact UI specs
- **Start with user goals** - Explain what users are trying to accomplish and
  what problems the design solves
- **Document the "why"** - For each major step or pattern, explain why it exists
  and what alternatives were considered
- **Capture decision points** - Where do users make meaningful choices? How does
  it affect their experience?
- **Think flows and subsystems, not pages** - Document user journeys through
  features, not every individual screen
- **Call out design rationale** - Help developers understand _why_ something is
  designed a certain way so they don't change it on a whim
- **Show connections** - How does this flow relate to other parts of the app?
- **Include visuals sparingly** - Screenshots or flow diagrams when they
  clarify, but don't over-document
- **Reference implementation** - Link to code and design files, but don't
  duplicate what's there
- **Document for developers** - These docs help devs understand the full picture
  before making changes

### Common Patterns to Document

- **Why we chose this UI component over alternatives** - When it matters to the
  experience
- **Why steps are ordered this way** - Rationale behind flow sequence
- **Why we ask for information at this point** - Design thinking behind data
  collection
- **Why this pattern solves a specific user problem** - Connect design to user
  needs
- **How error states guide users to recovery** - Not just what errors look like,
  but how they help
- **How settings in one place affect experiences elsewhere** - Feature
  interactions

### Keeping It Useful, Not Exhaustive

- **Avoid over-documentation** - If readers would rather look at Figma or code
  than finish your doc, it's too detailed
- **Skip obvious sections** - Not every flow needs Responsive Behavior or
  Micro-interactions sections
- **Write for understanding** - Help someone grasp "what's the user experience
  and why is it this way"
- **Update as flows evolve** - Keep docs current when design changes
  significantly
- **Review periodically** - Check "Last Reviewed" dates and verify accuracy

### Interaction Design vs. Architecture Docs

- **Interaction Design docs** - Focus on user experience, design rationale, user
  flows
  - "What does the user see and do in the creation flow, and why is it designed
    this way?"
- **Architecture docs** - Focus on technical implementation, code structure,
  system design
  - "How is the creation feature implemented technically, what are the major
    components?"

Both are valuable and complement each other. A developer working on a feature
should look at:

1. The **interaction design doc** to understand the user experience and design
   intent
2. The **architecture doc** to understand the technical implementation
3. The **code** to see the actual implementation details

## Relationship to Other Documentation

- **Proposals** capture ideas for future features; interaction design docs
  describe existing user experiences
- **Plans** outline implementation roadmaps; interaction design docs explain the
  resulting user flows
- **Architecture** docs explain technical systems; interaction design docs
  explain user interaction patterns
- **Playbooks** describe how to execute recurring tasks; interaction design docs
  explain the interaction patterns involved
- **Sessions** document what happened during work; interaction design docs
  provide UX context for understanding that work
