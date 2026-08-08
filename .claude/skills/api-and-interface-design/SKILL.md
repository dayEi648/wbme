---
name: api-and-interface-design
description: Guides stable API and interface design. Use when designing APIs, module boundaries, or any public interface — creating REST or GraphQL endpoints, defining type contracts between modules, or establishing boundaries between frontend and backend.
---

# API and Interface Design

## Overview

Design stable, well-documented interfaces that are hard to misuse and easy to extend. Applies to REST APIs, GraphQL schemas, module boundaries, component props, and any surface where one piece of code talks to another.

## Core Principles

### Hyrum's Law

> With a sufficient number of users of an API, all observable behaviors of your system will be depended on by somebody, regardless of what you promise in the contract.

Every public behavior — undocumented quirks, error message text, timing, ordering — becomes a de facto contract. Implications:

- **Be intentional about what you expose.** Every observable behavior is a potential commitment.
- **Don't leak implementation details.** If users can observe it, they will depend on it.
- **Plan for deprecation at design time.** Define how the API will be retired before it ships — include migration paths, deprecation windows, and sunset dates in the contract.
- **Tests are not enough.** Hyrum's Law means "safe" changes can break real users who depend on undocumented behavior.

### The One-Version Rule

Avoid forcing consumers to choose between multiple versions of the same dependency or API. Design for a world where only one version exists — extend rather than fork.

### 1. Contract First

Define the interface before implementing it:

```typescript
interface TaskAPI {
  createTask(input: CreateTaskInput): Promise<Task>;
  listTasks(params: ListTasksParams): Promise<PaginatedResult<Task>>;
  getTask(id: string): Promise<Task>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;
  deleteTask(id: string): Promise<void>;  // Idempotent
}
```

### 2. Consistent Error Semantics

Pick one error strategy for the entire API:

```typescript
// Every error response follows this shape
interface APIError {
  error: {
    code: string;        // Machine-readable: "VALIDATION_ERROR"
    message: string;     // Human-readable: "Email is required"
    details?: unknown;   // Additional context when helpful
  };
}

// Status code mapping
// 400 → Invalid data  401 → Not authenticated  403 → Not authorized
// 404 → Not found     409 → Conflict           422 → Validation failed
// 500 → Server error (never expose internals)
```

**Don't mix patterns.** Some endpoints throw, others return null, others return `{ error }` → consumer can't predict behavior.

### 3. Validate at Boundaries

Trust internal code. Validate at system edges where external input enters. Validation belongs at: API route handlers, form submissions, external service response parsing (third-party data is untrusted), environment variable loading. Validation does NOT belong between internal functions sharing type contracts, or data from your own database.

```typescript
app.post('/api/tasks', async (req, res) => {
  const result = CreateTaskSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(422).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid task data', details: result.error.flatten() },
    });
  }
  const task = await taskService.create(result.data);
  return res.status(201).json(task);
});
```

### 4. Prefer Addition Over Modification

Extend interfaces without breaking existing consumers — add optional fields, never change existing field types or remove fields.

### 5. Predictable Naming

| Pattern | Convention | Example |
|---------|-----------|---------|
| REST endpoints | Plural nouns, no verbs | `GET /api/tasks`, `POST /api/tasks` |
| Query params | camelCase | `?sortBy=createdAt&pageSize=20` |
| Response fields | camelCase | `{ createdAt, updatedAt, taskId }` |
| Boolean fields | is/has/can prefix | `isComplete`, `hasAttachments` |
| Enum values | UPPER_SNAKE | `"IN_PROGRESS"`, `"COMPLETED"` |

## REST API Patterns

```
GET    /api/tasks              → List (paginated, filterable)
POST   /api/tasks              → Create
GET    /api/tasks/:id          → Get single
PATCH  /api/tasks/:id          → Partial update
DELETE /api/tasks/:id          → Delete (idempotent)

GET    /api/tasks/:id/comments → Sub-resource list
POST   /api/tasks/:id/comments → Sub-resource create
```

### Pagination

Paginate every list endpoint from day one:

```
GET /api/tasks?page=1&pageSize=20&sortBy=createdAt&sortOrder=desc
→ { data: [...], pagination: { page, pageSize, totalItems, totalPages } }
```

### Partial Updates (PATCH)

Accept partial objects — only update what's provided. PUT requires the full object; PATCH is what clients actually want.

## TypeScript Interface Patterns

### Discriminated Unions for Variants

```typescript
type TaskStatus =
  | { type: 'pending' }
  | { type: 'in_progress'; assignee: string; startedAt: Date }
  | { type: 'completed'; completedAt: Date; completedBy: string }
  | { type: 'cancelled'; reason: string; cancelledAt: Date };
```

### Input/Output Separation

```typescript
interface CreateTaskInput { title: string; description?: string; }       // Caller provides
interface Task { id: string; title: string; createdAt: Date; /* ... */ }  // System returns
```

### Branded Types for IDs

```typescript
type TaskId = string & { readonly __brand: 'TaskId' };
type UserId = string & { readonly __brand: 'UserId' };
// Prevents accidentally passing UserId where TaskId is expected
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "We'll document the API later" | Types ARE the documentation. Define them first. |
| "We don't need pagination yet" | You will at 100+ items. Add it from the start. |
| "PATCH is complicated, let's use PUT" | PUT requires the full object. PATCH is what clients want. |
| "We'll version when we need to" | Breaking changes break consumers. Design for extension now. |
| "Nobody uses that undocumented behavior" | Hyrum's Law: if observable, somebody depends on it. |
| "Internal APIs don't need contracts" | Internal consumers are still consumers. Contracts prevent coupling. |
| "Third-party API responses are safe" | External data is untrusted. Validate shape and content before use. |

## Red Flags

- Endpoints returning different shapes depending on conditions
- Inconsistent error formats across endpoints
- Validation scattered in internal code instead of at boundaries
- Breaking changes to existing fields (type changes, removals)
- List endpoints without pagination
- Verbs in REST URLs (`/api/createTask`, `/api/getUsers`)
- Third-party API responses used without validation

## Verification

- [ ] Every endpoint has typed input and output schemas
- [ ] Error responses follow a single consistent format
- [ ] Validation happens at system boundaries only
- [ ] List endpoints support pagination
- [ ] New fields are additive and optional (backward compatible)
- [ ] Naming follows consistent conventions across all endpoints
- [ ] API documentation/types committed alongside implementation
