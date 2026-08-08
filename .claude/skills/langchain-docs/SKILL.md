---
name: langchain-docs
description: Provides URLs for the official LangChain documentation. When working on any LangChain development — agent design, feature implementation, API usage, concept understanding, or troubleshooting — always invoke this SKILL first to get information from the official documentation instead of searching the web.
---

## Usage

When you need LangChain information, use the `FetchURL` tool (or `WebFetch` in Claude Code) to fetch the documentation.

### URL Format

`https://docs.langchain.com/oss/{techname}/langchain/{tabname}`

- **techname**: `python` or `javascript`
- **tabname**: choose from the following list

### tabname List

**Get started:** overview, install, quickstart, philosophy

**Core components:** agents, models, messages, tools, short-term-memory, event-streaming, streaming, structured-output

**Middleware:** middleware/overview, middleware/built-in, middleware/custom

**Frontend:** frontend/overview, frontend/markdown-messages, frontend/tool-calling, frontend/human-in-the-loop, frontend/branching-chat, frontend/reasoning-tokens, frontend/structured-output, frontend/message-queues, frontend/join-rejoin, frontend/time-travel, frontend/generative-ui, frontend/integrations/overview, frontend/integrations/copilotkit, frontend/integrations/ai-elements, frontend/integrations/assistant-ui, frontend/integrations/openui

**Advanced:** guardrails, runtime, context-engineering, mcp, human-in-the-loop, multi-agent, multi-agent/subagents, multi-agent/handoffs, multi-agent/skills, multi-agent/router, multi-agent/custom-workflow, retrieval, long-term-memory

**Agent development:** studio, test, test/unit-testing, test/integration-testing, test/evals, ui

### Example

Project language is Python and you want to learn about Human-in-the-loop → fetch `https://docs.langchain.com/oss/python/langchain/human-in-the-loop`
