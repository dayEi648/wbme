# Project Guidelines

## Constitution

### Principles for Work

1. Thinking and Communication
    - When encountering doubts, uncertainties, or information gaps, you must ask user questions.
    - If there are multiple solutions to a problem, all of them should be presented to the user for him to choose from.
2. Scope and Decisions
    - Before proposing a repair solution, you should send a sub-agent to evaluate whether this solution is the best option, whether it can truly solve the problem, and ensure that it does not introduce regression issues.
    - Every operation you perform must be traceable back to the user's explicit instruction.
3. Work Habits
    - You should often use web search tools to assist your work. Are you not sure about the latest version of a certain dependency? Search for the latest information. Need a good page design? Search for the design styles of other products.
    - You must use the appropriate SKILL to assist you in completing the task, even if a certain SKILL has only a 1% correlation with the current task.
    - The network environment is the Chinese mainland. This means that all package managers must use the domestic mirror registry.

---

### Coding Guidelines

1. Code style
    - Write explicit code. Do not hide implicit behavior or intent.
    - Prefers simple rather than complex code structure.
    - If there is a reliable dependency that can reduce 200 lines of code to just a few lines, use it first.
    - docstring comments: specify "why/what is required/notes".
    - Name files, variables, and functions with full names that contain an intent, such as "isEligibleForDiscount" is better than "check."
2. Change Discipline
    - Modify only what is required.
    - Clean up imports, variables, or functions made useless by your change.
3. Error Handling
    - If you find any issues that previously exist, inform the user.
4. Maintainability
    - Extract duplicate code into common methods, but do not abstract code used only once.
    - Hardcoding magic numbers and AI prompts is prohibited; extract them into maintainable forms (constants, config, environment variables).
5. Security
    - Pay attention to the impact your code has on memory, network, threads, and other resources; security is extremely important.
6. Testing
    - Run the relevant tests after development is complete to ensure the changes do not break existing functionality.
    - Clean temporary data (databases, caches, files) after tests.

---

## 1. Project Overview

Project introduction, tech stack, and directory structure: see [README.md](./README.md).

---

## 2. Context Retrieval Index

Access project resources on demand according to the current task:

| Resource | Path | Purpose | When to Use |
| --- | --- | --- | --- |
| PRD | `docs/prds/` | Requirement documents | The PRD of this project |
| Task Plans | `.agents/plans/` | Task lists, plans and schedules | Store complex, long-term, or temporarily deferred plans and planning documents in this directory |
| Frontend References | `docs/for-frontend/` | Frontend design guidance | Check this folder when you need frontend guidance such as frontend development standards, styles and design |
| Backend References | `docs/for-backend/` | Backend implementation guidance | Check this folder when you need backend implementation guidance |
| Temporary Images | `.agents/pngs/` | Storage and cleanup of temporary image resources | Store temporary image resources in `.agents/pngs/`, and clean up unused images after work is done |
| API Documentations | `docs/api-documentations/` | API documents | Handwritten or automatically generated OpenAPI contract documents |

---

## 3. Project Constraints

### 3.1 Local dev dependencies

PostgreSQL 18 and Redis 8 are required. To locate them on any machine, check in order:
1. Docker: `docker compose ps` (both services defined in `docker-compose.yml`).
2. Local service: `pg_isready` / `redis-cli ping`.
3. Fallback: connection strings in root `.env` (`DATABASE_URL`, `REDIS_URL`).

### 3.2 Front-end view validation

Every time you finish developing the front-end page/component/button and other view-related code, you must use Playwright to verify the front-end view effect. If you find that the effect is not as expected, you should make timely adjustments.

### 3.3 Document maintenance

- If the project structure changes, update the Project Structure section in `README.md`
- If the requirements expressed in user's message conflict with the PRD or are not documented in the PRD, then you need to update the prd. (Before making the modification, you should first ask user for confirmation whether to modify the PRD.)
- When writing or modifying any document content or code comments, do not leave any traces. Do not write "After being approved by the user ……" "It was originally xxx ……" I do not need them. You can just write down the information that is relevant and useful for the present, and delete the outdated and useless information.

### 3.4 Git Guidelines

- Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.
- Commit titles are written in bilingual Chinese and English conveying the same meaning, with Chinese and English separated by `/`.
- Format example:
  ```
  docs: 更新 README.md 中的项目目录结构 / Update the project structure in README.md
  ```
- Before executing `git commit` or `git push`, it is necessary to obtain the explicit consent of the user. Unauthorized submission or pushing is strictly prohibited.

---