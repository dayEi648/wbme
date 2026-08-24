# WBME Enterprise Management Platform

A unified internal management platform covering asset, HR, finance, engineering maintenance, and other subsystems. Subsystems can be developed and iterated independently while sharing a unified entry, authentication/permission system, and common capabilities such as Agent chat, DingTalk integration, operation logs, and data backup.

## Tech Stack

TypeScript (frontend + business backend) + Python (AI services).

| Layer | Stack |
| --- | --- |
| Frontend | React 19 · Vite 8 · Ant Design 6.5 · Vercel AI SDK 7 |
| Testing | Vitest 4.1 · Playwright 1.62 |
| Business Backend | NestJS 11.1 · Prisma 7.9 |
| AI Backend | FastAPI 0.141 · LangChain 1.3 · LangGraph 1.2 |
| Data & Storage | PostgreSQL 18 · Redis 8.8 · Alibaba Cloud OSS |
| Deployment | Ubuntu + Docker + Nginx |

## Project Structure

Update this section when the directory structure changes.

```
wbme/
├── apps/                       # Deployment units + frontend
│   ├── platform-core/          # base + backstage backend (auth, permissions, infrastructure)
│   ├── asset/                  # asset ledger/inventory/borrow-return/approval/QR code
│   ├── hr/                     # organization/overtime/approval/account lifecycle
│   ├── fin/                    # contracts/profit analysis/Excel import-export
│   ├── web/                    # frontend (Vite + React + Ant Design)
│   ├── worker/                 # BullMQ worker (outbox scheduling, background tasks)
│   ├── recovery-executor/      # database recovery executor
│   └── migration-runner/       # unified migrations for dev/release
├── packages/                   # @wbme shared packages
│   ├── contracts/              # error codes/DTOs/enums/permission catalog
│   ├── server/                 # NestJS shared infrastructure
│   ├── approval/               # unified approval engine
│   ├── logging/                # operation log templates
│   ├── tasks/                  # background task interfaces (Outbox SQL)
│   └── files/                  # file storage/OSS conventions
├── docs/                       # PRDs, API docs, DB design, frontend refs, references
├── scripts/                    # engineering scripts (one-click startup, E2E seeding)
│   └── db-views/               # read-only view scripts
├── deploy/                     # production deployment
├── .agents/                    # internal working directory (plans, temp images)
│   └── plans/
└── .github/                    # CI workflows
```
