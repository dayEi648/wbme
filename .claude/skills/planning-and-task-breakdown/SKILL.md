---
name: planning-and-task-breakdown
description: Breaks work into ordered, implementable tasks with clear acceptance criteria. Use when you have a spec or clear requirements and need to break work into implementable tasks — when a task feels too large to start, when you need to estimate scope, or when parallel work is possible.
---

# Planning and Task Breakdown

## Overview

Decompose work into small, verifiable tasks with explicit acceptance criteria. Good breakdown is the difference between an agent that completes work reliably and one that produces a tangled mess. Every task should be small enough to implement, test, and verify in one focused session.

## The Planning Process

### Step 1: Enter Plan Mode

Before writing code, operate read-only: read specs and relevant code, identify existing patterns and conventions, map dependencies, note risks and unknowns. **Output is a plan document, not implementation.**

### Step 2: Identify Dependencies

Map what depends on what:

```
Database schema → API models/types → API endpoints → Frontend API client → UI components
                                   └→ Validation logic
                  └→ Seed data / migrations
```

Implementation order follows the dependency graph bottom-up.

### Step 3: Slice Vertically

Build one complete feature path at a time, not entire layers:

**Bad (horizontal):** Build all DB → all API → all UI → connect
**Good (vertical):** Register flow (DB+API+UI) → Login flow → Create task → View list

Each slice delivers working, testable functionality.

### Step 4: Write Tasks

```markdown
## Task [N]: [Short descriptive title]

**Description:** One paragraph explaining what this accomplishes.

**Acceptance criteria:**
- [ ] [Specific, testable condition]

**Verification:**
- [ ] Tests pass: `npm test -- --grep "feature-name"`
- [ ] Build succeeds: `npm run build`
- [ ] Manual check: [what to verify]

**Dependencies:** [Task numbers or "None"]
**Files likely touched:** `src/path/file.ts`, `tests/path/test.ts`
**Estimated scope:** [Small: 1-2 | Medium: 3-5 | Large: 5+ files]
```

### Step 5: Order and Checkpoint

Arrange tasks so: dependencies satisfied, each leaves system working, checkpoints every 2-3 tasks, high-risk tasks early (fail fast).

```markdown
## Checkpoint: After Tasks 1-3
- [ ] All tests pass
- [ ] Application builds without errors
- [ ] Core user flow works end-to-end
- [ ] Review with human before proceeding
```

## Task Sizing

| Size | Files | Scope | Example |
|------|-------|-------|---------|
| **XS** | 1 | Single function/config | Add a validation rule |
| **S** | 1-2 | One component/endpoint | Add an API endpoint |
| **M** | 3-5 | One feature slice | Registration flow |
| **L** | 5-8 | Multi-component feature | Search with filtering |
| **XL** | 8+ | **Too large — break down** | — |

**Break down when:** >2 hours of agent work, >3 acceptance criteria bullet points, touches ≥2 independent subsystems, or "and" in the task title.

## Plan Document Template

```markdown
# Implementation Plan: [Feature/Project Name]

## Overview
[One paragraph summary]

## Architecture Decisions
- [Key decision and rationale]

## Task List

### Phase 1: Foundation
- [ ] Task 1: ...
- [ ] Task 2: ...

### Checkpoint: Foundation
- [ ] Tests pass, builds clean

### Phase 2: Core Features
- [ ] Task 3: ...
- [ ] Task 4: ...

### Checkpoint: Complete
- [ ] All acceptance criteria met, ready for review

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|

## Open Questions
- [Question needing human input]
```

## Parallelization

- **Safe to parallelize:** Independent feature slices, tests for existing features, documentation
- **Must be sequential:** Database migrations, shared state changes, dependency chains
- **Needs coordination:** Features sharing an API contract (define contract first, then parallelize)

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll figure it out as I go" | That's how you get tangled messes. 10 min planning saves hours. |
| "The tasks are obvious" | Write them down. Explicit tasks surface hidden dependencies. |
| "Planning is overhead" | Planning IS the task. Implementation without a plan is just typing. |
| "I can hold it all in my head" | Written plans survive session boundaries and context compaction. |

## Red Flags

- Starting implementation without a written task list
- Tasks saying "implement the feature" without acceptance criteria
- No verification steps in the plan
- All tasks are XL-sized
- No checkpoints between tasks
- Dependency order not considered

## Verification

- [ ] Every task has acceptance criteria and a verification step
- [ ] Task dependencies identified and ordered correctly
- [ ] No task touches more than ~5 files
- [ ] Checkpoints exist between major phases
- [ ] Human has reviewed and approved the plan
