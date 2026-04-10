# mcp_client_demo

Un cliente MCP minimalista que conecta un LLM (vía API OpenAI-compatible, por defecto Ollama local) con el **MCP Filesystem Server** oficial, para que el modelo pueda leer/escribir archivos dentro de un directorio acotado mediante llamadas a herramientas.

## Requisitos

- **Node.js** ≥ 20
- **Ollama** corriendo en `http://localhost:11434` con el modelo de `src/constants.ts` descargado (`ollama pull llama3.2:3b`), **o** cualquier endpoint compatible con OpenAI Chat Completions.
- `npx` disponible (lo usa el servidor MCP de filesystem).

## Setup

```bash
npm install
```

Creá un `.env` en la raíz:

```ini
ALLOWED_DIR=src/workdir
ALLOWED_DIR_ABSOLUTE=false

# Opcional: múltiples directorios (prioridad sobre ALLOWED_DIR). Separados por ;
# ALLOWED_DIRS=C:/Users/me/Desktop;C:/Users/me/Documents/Workspace

# Opcional: usar otro endpoint OpenAI-compatible
# OPENAI_BASE_URL=http://localhost:11434/v1
# OPENAI_API_KEY=ollama

# Opcional: logs detallados de tool calls
# MCP_DEBUG=true
```

El valor `src/workdir` es **relativo al cwd donde arrancás el proceso** (la raíz del proyecto). El directorio ya existe en el repo.

## Ejecución

```bash
npm start        # tsx directo sobre src/
npm run build    # tsc -> build/ + ejecuta
```

Una vez levantado, interactuás por la terminal:

```
>: listá los archivos del directorio permitido
>: reset          # limpia el historial conversacional
>: exit           # sale
```

## Arquitectura

```
┌────────────┐    stdin/stdout    ┌──────────┐    HTTP    ┌────────────┐
│  rlinter-  │ ──────────────────▶│  MCP-    │───────────▶│  Ollama /  │
│  face.ts   │                    │  Client  │            │  OpenAI    │
│  (REPL)    │◀───────────────────│ (chat    │◀───────────│            │
└────────────┘                    │  loop)   │            └────────────┘
                                  └────┬─────┘
                                       │ stdio (JSON-RPC)
                                       ▼
                            ┌────────────────────────┐
                            │ @modelcontextprotocol/ │
                            │ server-filesystem      │
                            │ (subproceso npx)       │
                            └────────────────────────┘
```

### Archivos

| Archivo | Rol |
|---|---|
| `src/index.ts` | Entrypoint: resuelve directorios permitidos, arma `MCPClient`, arranca el chat loop. |
| `src/client.ts` | `MCPClient` + `chatLoop`. Es el corazón del demo. |
| `src/rlinterface.ts` | Readline REPL + resolución de `ALLOWED_DIR` / `ALLOWED_DIRS` desde `.env`. |
| `src/constants.ts` | Config del modelo y endpoint OpenAI-compatible. |
| `src/workdir/` | Directorio sandbox por defecto para el filesystem server. |

## Cómo funciona el chat loop

El flujo es **un bucle de conversación con ejecución de herramientas intercalada**, implementado en `src/client.ts`.

### 1. Arranque (`MCPClient.start`)

1. Levanta un subproceso del MCP Filesystem Server vía `StdioClientTransport` (`npx -y @modelcontextprotocol/server-filesystem <dirs>`).
2. Llama `listTools()` sobre el cliente MCP y transforma cada tool en el formato de `ChatCompletionTool` de OpenAI (función con `name`, `description`, `parameters: inputSchema`).
3. Llama `list_allowed_directories` como primer tool call para obtener el banner de roots permitidos (fallback: `filesystemRootHint`).
4. **Instala el system prompt** en `messages[0]` con las reglas del sandbox y el banner de directorios. Este mensaje es el único `system` y nunca se borra.

### 2. REPL (`chatLoop`)

Bucle infinito sobre `ask()`:

- `exit` → sale.
- `reset` / `clear` → `client.resetConversation()` deja solo el system prompt.
- Cualquier otra cosa → `client.processQuery(input)`.

Los errores de un query **no matan la sesión**: se logean y se vuelve al prompt. Esto es intencional — un timeout puntual de Ollama o un tool call roto no debería forzar un restart.

### 3. Ejecución de un query (`processQuery`)

Este es el **tool-use loop** estándar de OpenAI Chat Completions, con un techo de `maxIterations` (por defecto 5):

```
push(user: query)
loop up to maxIterations:
  response = chat.completions.create({ messages, tools })
  push(assistant: response.message)            # con tool_calls si hay

  if no tool_calls:
      return message.content   # respuesta final
  
  for each tool_call:
      result = mcpClient.callTool(name, args)
      push(tool: { tool_call_id, content: result })
      # si callTool tira, el error va como tool message para que el modelo se recupere
```

Puntos clave:

- **`messages` es estado de instancia**, no global. Dos `MCPClient` no comparten historial.
- Cada iteración re-envía la historia completa al modelo (incluyendo tool results previos). Es la forma estándar de que el modelo "vea" lo que devolvieron las tools.
- **Solo se manejan function tools** (`isFunctionToolCall`). Si el modelo devolviera otro tipo (custom tools del SDK de OpenAI más nuevo), tira error — es protección contra estado corrupto.
- **`maxIterations`** existe para evitar loops infinitos en los que el modelo sigue llamando herramientas sin resolver. Si se agota, tira error y `chatLoop` lo captura.
- **Errores de tool calls** se convierten en tool messages con prefijo `Error: ...`. El modelo puede reintentar con otros argumentos en lugar de romper todo.

### 4. System prompt

El prompt en `FILESYSTEM_SYSTEM_PROMPT` le dice al modelo (en español):
- Los únicos directorios válidos son los listados (fuente de verdad: `list_allowed_directories`).
- Las rutas en tool calls deben ser **absolutas** y estar dentro del sandbox.
- No inventar rutas, no usar el cwd del proceso Node, no usar el repo.
- Para pedidos ambiguos ("acá", sin ruta), resolver bajo el primer directorio permitido o pedir aclaración.

Esto compensa la tendencia de los modelos chicos (llama3.2:3b, qwen2.5:7b) a alucinar rutas del entorno.

### 5. Directorios permitidos

`getAllowedDirs()` en `rlinterface.ts`:

- Si `ALLOWED_DIRS` está seteado → lista separada por `;` (paths absolutos).
- Si no → un único directorio desde `ALLOWED_DIR`:
  - Si `ALLOWED_DIR_ABSOLUTE=true`: se usa tal cual.
  - Si no: se resuelve con `path.resolve(process.cwd(), envDir)`. **Importante**: el path relativo es contra el cwd, no contra `__dirname` — así que el proceso se tiene que arrancar desde la raíz del proyecto.

## Debugging

- `MCP_DEBUG=true` en `.env` activa:
  - Log de argumentos de cada tool call (truncados a 800 chars).
  - Preview más largo de resultados de tool (1200 vs 400 chars).
- Los logs del loop (`[mcp] iteration X/Y: finish_reason=... tool_calls=...`) muestran exactamente qué hace el modelo en cada paso.

## Comandos del REPL

| Comando | Acción |
|---|---|
| `exit` | Cierra el cliente y sale |
| `reset` / `clear` | Limpia el historial conversacional (deja el system prompt) |
| *(cualquier otro texto)* | Se envía al modelo como mensaje de usuario |
