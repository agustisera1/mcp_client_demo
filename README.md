# mcp_client_demo

Un cliente MCP minimalista que conecta un LLM (vía API OpenAI-compatible, por defecto Ollama local) con un **servidor MCP de recomendaciones de películas y series** (TMDB), para que el modelo pueda consultar información actualizada mediante llamadas a herramientas.

## Requisitos

- **Node.js** ≥ 20
- **Ollama** corriendo en `http://localhost:11434` con `qwen2.5:7b` descargado (`ollama pull qwen2.5:7b`), **o** cualquier endpoint compatible con OpenAI Chat Completions.
- El servidor MCP [`mcp_server_demo`](../mcp_server_demo) compilado (`npm run build` en ese repo).

## Setup

```bash
npm install
```

Creá un `.env` en la raíz:

```ini
MOVIES_SERVER_BUILD_PATH=C:/ruta/a/mcp_server_demo/build/index.js

# Opcional: usar otro endpoint OpenAI-compatible
# OPENAI_BASE_URL=http://localhost:11434/v1
# OPENAI_API_KEY=ollama

# Opcional: logs detallados de tool calls
# MCP_DEBUG=true
```

## Ejecución

```bash
npm start        # tsx directo sobre src/
npm run build    # tsc -> build/
```

Una vez levantado, interactuás por la terminal:

```
>: recomendame una película de ciencia ficción de los 90s
>: reset          # limpia el historial conversacional
>: exit           # sale
```

## Arquitectura

```
┌────────────┐    stdin/stdout    ┌──────────────┐    HTTP    ┌────────────┐
│  rlinter-  │ ──────────────────▶│  MCPClient   │───────────▶│  Ollama /  │
│  face.ts   │                    │  + chatLoop  │            │  OpenAI    │
│  (REPL)    │◀───────────────────│  (client.ts) │◀───────────│            │
└────────────┘                    └──────┬───────┘            └────────────┘
                                         │ stdio (JSON-RPC)
                                         ▼
                              ┌──────────────────────┐
                              │   mcp_server_demo    │
                              │   (subproceso node)  │
                              └──────────────────────┘
```

### Archivos

| Archivo | Rol |
|---|---|
| `src/index.ts` | Entrypoint: configura el servidor MCP, instancia `MCPClient` y arranca el chat loop. |
| `src/client.ts` | `MCPClient` + `chatLoop`. Núcleo del demo. |
| `src/rlinterface.ts` | Wrapper de readline para el REPL (prompt, close). |
| `src/constants.ts` | Modelo y endpoint OpenAI-compatible. |

## Cómo funciona el chat loop

El flujo es **un bucle de conversación con ejecución de herramientas intercalada**, implementado en `src/client.ts`.

### 1. Arranque (`MCPClient.start`)

1. Levanta el servidor MCP como subproceso vía `StdioClientTransport`.
2. Llama `listTools()` y convierte cada herramienta al formato `ChatCompletionTool` de OpenAI.
3. Instala el **system prompt** en `messages[0]`. Es el único mensaje `system` y nunca se borra.

### 2. REPL (`chatLoop`)

Bucle infinito sobre `ask()`:

- `exit` → sale.
- `reset` / `clear` → `client.resetConversation()` deja solo el system prompt.
- Cualquier otra cosa → `client.processQuery(input)`.

Los errores de un query **no matan la sesión**: se logean y se vuelve al prompt.

### 3. Ejecución de un query (`processQuery`)

Tool-use loop estándar de OpenAI Chat Completions, con techo de `maxIterations` (default 5):

```
push(user: query)
loop hasta maxIterations:
  response = chat.completions.create({ messages, tools })
  push(assistant: response.message)

  if no tool_calls:
      return message.content   # respuesta final

  for each tool_call:
      result = mcpClient.callTool(name, args)
      push(tool: { tool_call_id, content: result })
      # si callTool falla, el error va como tool message para que el modelo se recupere
```

Puntos clave:

- **`messages` es estado de instancia** — dos `MCPClient` no comparten historial.
- Cada iteración re-envía el historial completo (incluyendo tool results previos).
- **`maxIterations`** evita loops infinitos si el modelo sigue llamando herramientas sin resolver.
- **Errores de tool calls** se convierten en tool messages con prefijo `Error: ...`, permitiendo al modelo reintentar con otros argumentos.

## Comandos del REPL

| Comando | Acción |
|---|---|
| `exit` | Cierra el cliente y sale |
| `reset` / `clear` | Limpia el historial conversacional (preserva el system prompt) |
| *(cualquier otro texto)* | Se envía al modelo como mensaje de usuario |

## Debugging

- `MCP_DEBUG=true` en `.env` activa logs con argumentos de cada tool call (hasta 800 chars) y previews más largos de resultados (1200 vs 400 chars).
- Los logs `[mcp] iteration X/Y: finish_reason=... tool_calls=...` muestran el comportamiento del modelo en cada paso.
