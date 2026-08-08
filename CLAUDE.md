# Project Guidelines

## Constitution

### Principles for Work

1. Thinking and Communication
    - When encountering doubts, uncertainties, or information gaps, you must ask user questions.
    - When encountering ambiguity: immediately pause, mark the problem and ask questions.
    - If a problem has multiple solutions, all of them should be presented to the user - do not silently select one of them.
2. Scope and Decisions
    - Before proposing a repair solution, assess whether this solution is the best option, whether it can truly solve the problem, and ensure that it does not introduce regression issues.
    - Every operation you perform must be traceable back to the user's explicit instruction.
3. Work Habits
    - Try frequently using websearch tool to obtain the latest information from internet, such as the latest features of a certain dependency.
    - You must use the appropriate SKILL to assist you in completing the task, even if a certain SKILL has only a 1% correlation with the current task.
    - The network environment is the Chinese mainland. This means that all package managers must use the domestic mirror registry.
4. Git 操作纪律
    - 执行 `git commit` 或 `git push` 之前，必须先征得用户明确同意，不得擅自提交或推送。

---

### Coding Guidelines

1. Code style
    - Write explicit code. Do not hide implicit behavior or intent.
    - Prefers simple rather than complex code structure.
    - Favor flat structures over deep nesting; sparse code over dense code.
    - If there is a reliable dependency that can reduce 200 lines of code to just a few lines, use it first.
    - Explainability is the litmus test: if you cannot describe the implementation in simple terms, rewrite it.
    - Add standard docstring comments: function purpose, input parameters, return values, and exception handling.
    - Use proper encapsulation, namespaces, and modular boundaries.
2. Change Discipline
    - Modify only what is strictly required.
    - Do not "optimize," reformat, or refactor adjacent untouched code without a user request.
    - Clean up imports, variables, or functions made useless by your change.
3. Error Handling
    - If you find any issues that previously exist, inform the user instead of fix them yourself.
    - Never silently swallow or ignore errors; handle real failures explicitly.
4. Maintainability
    - Extract duplicate code into common methods, but do not abstract code used only once.
    - Do not weaken functionality for the sake of reducing code.
    - Hardcoding magic numbers and AI prompts is prohibited; extract them into maintainable forms (constants, config, environment variables).
5. Security
    - Pay attention to the impact your code has on memory, network, threads, and other resources; security is extremely important.
    - Prohibit hard-coding of sensitive information (API keys, passwords, tokens) in the code.
6. Testing
    - Run the relevant tests after development is complete to ensure the changes do not break existing functionality.
    - Clean temporary data (databases, caches, files) after tests.

---

## 1. Project Charter

### 1.1 Basic Information

- **Project Name**: WBME Enterprise Management Platform
- **Subsystems**: Asset system, HR system, Finance system, etc.
- **Project Description**: A unified management platform for internal company employees, aiming to develop the multiple subsystems required by the company, including those needed for logistics and engineering maintenance, covering asset, HR, finance, engineering maintenance, etc. Each subsystem can be advanced in parallel and iterated independently, sharing a unified entry, login authentication and permission system, as well as common capabilities such as Agent intelligent dialogue, DingTalk integration, operation logs, and data backup.

### 1.2 Tech Stack

The business stack is built entirely on TypeScript (frontend + business backend), and Python handles complex AI services.

| Layer | Component | Version/Status |
| --- | --- | --- |
| Full-stack Language | TypeScript | 6.0 |
| Frontend Framework | React | 19.2 |
| Frontend Build Tool | Vite | 8.2 |
| UI Component Library | Ant Design | 6.5 |
| AI SDK | Vercel AI SDK | 7.0 |
| Frontend Testing | Vitest | 4.1 |
| E2E Testing | Playwright | 1.62 |
| Business Backend Framework | NestJS | 11.1 |
| ORM | Prisma | 7.9 |
| AI Backend Framework | FastAPI | 0.141 |
| AI Orchestration | LangChain | 1.3 |
| AI Graph Framework | LangGraph | 1.2 |
| In-memory Storage | Redis | 8.8 |
| Database | PostgreSQL | 18 |
| Deployment | Ubuntu + Docker + Nginx | - |
| Object Storage | Alibaba Cloud OSS | - |

---

## 2. Context Retrieval Index

Access project resources on demand according to the current task:

| Resource | Path | Purpose | When to Use |
| --- | --- | --- | --- |
| PRD | `docs/prds/` | Requirement documents | The PRD of this project |
| Task Plans | `.agents/plans/` | Task lists, plans and schedules | Store complex, long-term, or temporarily deferred plans and planning documents in this directory |
| Directory Structure | `docs/directory.md` | Project directory structure | Check this document when you need to understand the project directory structure. If the project structure changes, update `directory.md` |
| Frontend References | `docs/for-frontend/` | Frontend design guidance | Check this folder when you need frontend guidance such as frontend development standards, styles and design |
| Temporary Images | `.agents/pngs/` | Storage and cleanup of temporary image resources | Store temporary image resources in `.agents/pngs/`, and clean up unused images after work is done |
| API Documentations | `docs/api-documentations/` | API documents | Write API documents in this directory; check this directory when you need to understand the API documents |

---

## 3. Git Commit Guidelines

- Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.
- Commit titles are written in bilingual Chinese and English conveying the same meaning, with Chinese and English separated by `/`.
- Format example:
  ```
  docs: 完善 AGENTS.md 并初始化 directory.md / Update AGENTS.md and initialize directory.md
  ```

---

## 4. Project Constraints

### 4.1 Local dev dependencies (local services, no Docker)

- **PostgreSQL 18**: Running as a system service (listening on 5432). Dev database `wbme-dev` (connection string in root `.env` → `DATABASE_URL`).
- **Redis**: running as a Homebrew service (`brew services list` shows `redis started`), listening on 6379.
- To check availability, connect directly using the `.env` connection string (`psql ... -c "SELECT 1"`, `redis-cli ping`) instead of relying on `which` / `brew list`.

