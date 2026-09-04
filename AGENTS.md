# Project Guidelines

## Constitution

### Principles for Work

1. Thinking and Communication
    - When encountering doubts, uncertainties, or information gaps, you must ask user questions.
    - If there are multiple solutions to a problem, all of them should be presented to the user for him to choose from.
    - If you find any bugs that previously exist, inform the user.
2. Work Habits
    - Every operation you perform must be traceable back to the user's explicit instruction.
    - You should often use web search tools to assist your work. Are you not sure about the latest version of a certain dependency? Search for the latest information. Need a good page design? Search for the design styles of other products.
    - The network environment is the Chinese mainland. This means that all package managers must use the domestic mirror registry.

---

### Coding Guidelines

1. Code style
    - implicit programming.
    - Prefers simple rather than complex code structure.
    - If there is a reliable dependency that can reduce 200 lines of code to just a few lines, use it first.
    - Write code annotation above the functions to explain "Why is this done?"
    - Name files, variables, and functions with full names that contain an intent, such as "isEligibleForDiscount".
    - Clean up imports, variables, or functions made useless by your change.
    - Every time you fix a bug, you should realize that similar functions or pages might also have similar bugs, and you should fix them as well.
2. Front-end design
    - Keep the UI simple and compact. Use a small number of ICONS and text for the UI to reduce the information density on the UI while maintaining a compact layout.
    - Make the interaction of the UI simple and the visual experience intuitive, thereby reducing the learning curve for users.
    - Adhere to the "elegant" design concept. That is to say, in the UI aspect, it is required that in scenarios such as program errors, operation failures, or functional abnormalities, elegant prompts should be achieved; in the logical aspect, it is required that when functions fail, they should gracefully downgrade; when transactions fail, they should gracefully roll back and retry, etc.
    - UI components can be reused multiple times, but they should only be used in appropriate situations. Do not force their application to inappropriate functions, as this may lead to interaction difficulties or other problems.
    - Every time you finish developing the front-end page/component/button and other view-related code, you must use Playwright or any other ways to verify the front-end view effect. If you find that the effect is not as expected, you should make timely adjustments.
3. Maintainability
    - Extract duplicate code into common methods.
    - Extract constants, enumerations, runtime parameters, sensitive information, AI prompts, etc. into a maintainable format.
4. Testing
    - Run tests after development is complete to ensure the changes do not break existing functionality.
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

### 3.2 Document maintenance

- If the project structure changes, update the Project Structure section in `README.md`
- If the requirements expressed in user's message conflict with the PRD or are not documented in the PRD, then you need to update the prd.

### 3.3 Git Guidelines

- Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.
- Commit titles are written in bilingual Chinese and English conveying the same meaning, with Chinese and English separated by `/`.
- Format example:
  ```
  docs: 更新 README.md 中的项目目录结构 / Update the project structure in README.md
  ```
- Before executing `git commit` or `git push`, it is necessary to obtain the explicit consent of the user. Unauthorized submission or pushing is strictly prohibited.

---
