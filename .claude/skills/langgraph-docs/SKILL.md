---
name: langgraph-docs
description: Provides URLs for the official LangGraph documentation. When working on any LangGraph development — graph structure design, state management, checkpoints, persistence, streaming output, subgraphs, human-in-the-loop, or troubleshooting — always invoke this SKILL first to get information from the official documentation instead of searching the web.
---

## Usage

When you need LangGraph information, use the `FetchURL` tool (or `WebFetch` in Claude Code) to fetch the documentation.

### URL Format

`https://docs.langgraph.com/oss/{techname}/langgraph/{tabname}`

- **techname**: `python` or `javascript`
- **tabname**: choose from the following list

### tabname List

**Get started:** overview, install, quickstart, local-server, thinking-in-langgraph, workflows-agents

**Capabilities:** persistence, fault-tolerance, event-streaming, streaming, interrupts, use-time-travel, add-memory, use-subgraphs

**Production:** application-structure, test, backward-compatibility, studio, ui, deploy, observability

**Frontend:** frontend/overview, frontend/graph-execution

**LangGraph APIs:** choosing-apis, graph-api, use-graph-api, functional-api, use-functional-api, pregel

### Example

Project language is Python and you want to learn about Time-travel → fetch `https://docs.langgraph.com/oss/python/langgraph/use-time-travel`
