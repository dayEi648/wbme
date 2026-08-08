---
name: code-review-and-quality
description: Conducts multi-axis code review. Use before merging any change — reviewing code written by yourself, another agent, or a human, when you need to assess code quality across multiple dimensions before it enters the main branch.
---

# Code Review and Quality

## Overview

Multi-dimensional code review with quality gates. Every change gets reviewed before merge across five axes: correctness, readability, architecture, security, and performance.

**The approval standard:** Approve when a change definitely improves overall code health, even if imperfect. Don't block because it isn't exactly how you'd write it — if it improves the codebase and follows conventions, approve it.

## The Five-Axis Review

### 1. Correctness

Does the code do what it claims to do?

- Does it match the spec or task requirements?
- Are edge cases handled (null, empty, boundary values)?
- Are error paths handled (not just the happy path)?
- Do tests pass and actually test the right things?
- Are there off-by-one errors, race conditions, or state inconsistencies?

### 2. Readability & Simplicity

Can another engineer understand this without explanation?

- Names descriptive and consistent with project conventions? (No `temp`, `data`, `result` without context)
- Control flow straightforward (avoid nested ternaries, deep callbacks)?
- **Could this be done in fewer lines?** (1000 lines where 100 suffice is a failure)
- **Are abstractions earning their complexity?** (Don't generalize until third use case)
- Any "clever" tricks that should be simplified?
- Dead code artifacts: no-op variables, backwards-compat shims, `// removed` comments?

### 3. Architecture

Does the change fit the system's design?

- Follows existing patterns or justifies new ones?
- Clean module boundaries, no circular dependencies?
- Code duplication that should be shared?
- Abstraction level appropriate (not over-engineered, not too coupled)?

### 4. Security

For detailed guidance, see the `security-and-hardening` skill. Key checks:

- User input validated and sanitized?
- Secrets kept out of code, logs, and version control?
- Authentication/authorization checked where needed?
- SQL parameterized (no string concatenation)?
- Outputs encoded to prevent XSS?
- External data (APIs, user content, config) treated as untrusted?

### 5. Performance

Key checks (see also `references/performance-checklist.md`):

- Any N+1 query patterns?
- Unbounded loops or unconstrained data fetching?
- Synchronous operations that should be async?
- Unnecessary re-renders in UI components?
- Missing pagination on list endpoints?

## Change Sizing

```
~100 lines changed   → Good. Reviewable in one sitting.
~300 lines changed   → Acceptable for a single logical change.
~1000 lines changed  → Too large. Split it.
```

**Splitting strategies:**

| Strategy | How | When |
|----------|-----|------|
| **Stack** | Submit small change, start next based on it | Sequential dependencies |
| **By file group** | Separate changes for groups needing different reviewers | Cross-cutting concerns |
| **Horizontal** | Shared code/stubs first, then consumers | Layered architecture |
| **Vertical** | Smaller full-stack slices of the feature | Feature work |

**Separate refactoring from feature work.** A change that both refactors and adds behavior is two changes.

## Change Descriptions

**First line:** Short, imperative, standalone. "Delete the FizzBuzz RPC" not "Deleting the FizzBuzz RPC." Informative enough to understand without reading the diff.

**Body:** What and why. Include context, decisions, reasoning not visible in code. Link to bugs, benchmarks, design docs. Acknowledge approach shortcomings.

**Anti-patterns:** "Fix bug," "Fix build," "Add patch," "Phase 1," "Add convenience functions."

## Review Process

### Step 1: Understand Context
What is this change trying to accomplish? What spec does it implement?

### Step 2: Review Tests First
Tests reveal intent. Do they exist? Test behavior (not implementation)? Cover edge cases? Would they catch a regression?

### Step 3: Review Implementation
Walk through each file with the five axes.

### Step 4: Categorize Findings

| Prefix | Meaning | Author Action |
|--------|---------|---------------|
| *(no prefix)* | Required change | Must address before merge |
| **Critical:** | Blocks merge | Security, data loss, broken functionality |
| **Nit:** | Minor, optional | Author may ignore |
| **Optional:** / **Consider:** | Suggestion | Worth considering, not required |
| **FYI** | Informational | No action needed |

### Step 5: Verify the Verification
What tests were run? Did the build pass? Manual testing done? Screenshots for UI changes?

## Dead Code Hygiene

After refactoring, identify orphaned code. **Ask before deleting:** "Should I remove these now-unused elements: [list]?" Don't leave dead code — it confuses future readers. Don't silently delete things you're unsure about.

## Review Speed

- **Respond within one business day** — maximum, not target
- **Ideal:** respond shortly after request arrives. A typical change should complete multiple review rounds in a single day
- **Large changes:** Ask author to split rather than reviewing one massive changeset

## Handling Disagreements

1. **Technical facts and data** override opinions
2. **Style guides** are authority on style matters
3. **Software design** evaluated on engineering principles, not preference
4. **Codebase consistency** acceptable if it doesn't degrade overall health

**Don't accept "I'll clean it up later."** Require cleanup before submission unless genuine emergency. If surrounding issues can't be addressed, require filing a bug with self-assignment.

## Honesty in Review

- **Don't rubber-stamp.** "LGTM" without evidence helps no one.
- **Don't soften real issues.** Call bugs what they are.
- **Quantify problems.** "This N+1 adds ~50ms per item" beats "this could be slow."
- **Push back on problematic approaches.** Sycophancy is a review failure mode.
- **Accept override gracefully.** If author has full context and disagrees, defer. Comment on code, not people.

## Dependency Discipline

**Before adding any dependency:**
1. Does the existing stack solve this?
2. How large is it? (Bundle impact)
3. Actively maintained? (Last commit, open issues)
4. Known vulnerabilities? (`npm audit`)
5. Compatible license?

**Rule:** Prefer standard library and existing utilities over new dependencies. Every dependency is a liability.

## The Review Checklist

```markdown
## Review: [PR/Change title]

### Context
- [ ] I understand what this change does and why

### Correctness
- [ ] Change matches spec/task requirements
- [ ] Edge cases and error paths handled
- [ ] Tests cover the change adequately

### Readability
- [ ] Names clear and consistent
- [ ] Logic straightforward, no unnecessary complexity

### Architecture
- [ ] Follows existing patterns
- [ ] No unnecessary coupling or dependencies

### Security
- [ ] No secrets in code
- [ ] Input validated at boundaries
- [ ] No injection vulnerabilities
- [ ] Auth checks in place
- [ ] External data treated as untrusted

### Performance
- [ ] No N+1 patterns
- [ ] No unbounded operations
- [ ] Pagination on list endpoints

### Verification
- [ ] Tests pass, build succeeds
- [ ] Manual verification done (if applicable)

### Verdict
- [ ] **Approve** — Ready to merge
- [ ] **Request changes** — Issues must be addressed
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It works, that's good enough" | Working but unreadable/insecure code creates compounding debt. |
| "I wrote it, so I know it's correct" | Authors are blind to their own assumptions. Every change benefits from review. |
| "We'll clean it up later" | Later never comes. Require cleanup before merge. |
| "AI-generated code is probably fine" | AI code needs more scrutiny — confident and plausible even when wrong. |
| "The tests pass, so it's good" | Tests don't catch architecture, security, or readability problems. |

## Red Flags

- PRs merged without any review
- Review that only checks if tests pass
- "LGTM" without evidence of actual review
- Security-sensitive changes without security-focused review
- Large PRs "too big to review properly" (split them)
- No regression tests with bug fix PRs
- Review comments without severity labels
- Accepting "I'll fix it later"

## Verification

- [ ] All Critical issues resolved
- [ ] Tests pass, build succeeds
- [ ] Verification story documented (what changed, how verified)
