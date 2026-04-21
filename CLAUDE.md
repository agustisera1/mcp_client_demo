# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run in development (no build step needed)
npm start

# Type-check and compile to build/
npm run build
```

There is no test suite configured.

## Architecture

This is an **MCP (Model Context Protocol) client** for a movie recommendations demo. It connects to an external MCP server over stdio, then runs an interactive chat loop where the user's queries are answered by an LLM that can invoke MCP tools.

### Data flow

```
User (stdin) → chatLoop → MCPClient.processQuery → OpenAI-compatible API (Ollama by default)
                                                          ↕ tool_calls
                                               MCPClient.client (MCP SDK) → MCP server (stdio subprocess)
```

### Key files

- **`src/client.ts`** — Core logic. `MCPClient` wraps the MCP SDK `Client` and an OpenAI-compatible HTTP client. On `start()`, it spawns the MCP server subprocess, lists available tools, and installs a system prompt. `processQuery()` runs the agentic loop (up to `maxIterations`, default 5): calls the LLM, dispatches any `tool_calls` to the MCP server, feeds results back, and repeats until the model returns a final text response. `chatLoop()` is the REPL driving `processQuery` per line of input. Special commands: `exit` to quit, `reset`/`clear` to wipe conversation history.

- **`src/index.ts`** — Entry point. Reads env vars, constructs `MCPClient`, calls `start()` pointing at the MCP server binary, then runs `chatLoop()`.

- **`src/constants.ts`** — Centralises `MODEL`, `OPENAI_BASE_URL`, and `OPENAI_API_KEY`. Default model is `qwen2.5:7b` via Ollama; `llama3.2:3b` is commented out because it does not reliably use the structured `tool_calls` channel.

- **`src/rlinterface.ts`** — Thin wrapper around Node's `readline/promises` for stdin interaction.

### External dependency: MCP server

The client connects to a sibling project (`mcp_server_demo`) that exposes the TMDB movie recommendations tools. The server must be built separately before running this client. Its compiled entry point is configured via `SERVER_BUILD_PATH` in `.env`.

## Environment variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_BUILD_PATH` | — | Absolute path to the compiled MCP server entry point |
| `OPENAI_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible API base URL (Ollama default) |
| `OPENAI_API_KEY` | `ollama` | API key (ignored by Ollama; required by OpenAI/OpenRouter) |
| `MCP_DEBUG` | — | Set to `1` or `true` for verbose tool call logging |
