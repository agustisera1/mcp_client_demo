# Roadmap de Mejoras Arquitectónicas — MCP Client

El MCP Client es funcional pero mínimo (~300 LOC, 4 archivos fuente). Todas las sesiones empiezan desde cero, el historial crece sin control, la terminal ofrece cero feedback visual, y la configuración está hardcodeada en el código. El objetivo es evolucionar el cliente hacia algo más robusto y usable sin agregar dependencias externas innecesarias.

---

## Área 1: Interacción por Terminal (UX del CLI)

### 1.1 Prompt visual con estado
**Qué resuelve:** El prompt `>: ` no muestra ninguna información. El usuario no sabe cuántos mensajes tiene en contexto.  
**Implementación:** `ask(prompt?: string)` en `rlinterface.ts` acepta prompt dinámico. En `chatLoop()`, calcular `[N msgs] > ` usando un nuevo getter `client.getMessageCount()`.  
**Complejidad:** Baja.

### 1.2 Sistema de comandos extensible
**Qué resuelve:** Los comandos `exit/reset/clear` son invisibles y están hardcodeados como `if` inline. No hay forma de listar herramientas disponibles ni el estado del cliente.  
**Implementación:** Reemplazar los `if` por un `Map<string, () => void>` de handlers en `chatLoop()`. Nuevos comandos: `help`, `tools` (lista herramientas MCP activas), `status` (modelo, URL, tokens en contexto).  
**Complejidad:** Baja.

### 1.3 Separar stdout (respuestas) de stderr (logs internos)
**Qué resuelve:** Las respuestas del modelo y la telemetría interna (`[mcp] iteration...`) van al mismo stream. No se puede hacer `2>/dev/null` para ver solo respuestas.  
**Implementación:** Todos los `console.info/warn/error` con prefijo `[mcp]` pasan a `process.stderr`. Las respuestas al usuario usan `process.stdout.write()`.  
**Complejidad:** Baja.

### 1.4 Spinner durante procesamiento
**Qué resuelve:** Entre que el usuario envía una query y llega la respuesta hay silencio total, que puede durar varios segundos con múltiples tool calls.  
**Implementación:** `setInterval` con frames rotatorios (`\r`) en `chatLoop()` antes de `await processQuery()`, limpiado al resolver. Sin dependencias externas.  
**Complejidad:** Baja.

---

## Área 2: Gestión de Mensajes

### 2.1 Estimación de tokens con límite configurable
**Qué resuelve:** `this.messages` crece sin límite. En sesiones largas con respuestas TMDB verbosas se puede superar el context window del modelo sin aviso.  
**Implementación:** Función privada `estimateTokens(messages)` (~4 chars/token heurística). Nueva opción `maxContextTokens` en `MCPClientOptions`. Warning cuando se supera el 90%.  
**Env var:** `MAX_CONTEXT_TOKENS=6000` (default para qwen2.5:7b con margen).  
**Complejidad:** Baja.

### 2.2 Compresión del historial — estrategia en dos capas
**Qué resuelve:** Qué hacer cuando se supera `maxContextTokens`.  
**Implementación recomendada:**
- **Capa 1 — Comprimir tool results:** Los mensajes `role: "tool"` son los más verbosos (JSON de TMDB). Truncar su `content` a N chars cuando el total supere el límite. Preserva todo el diálogo user/assistant.
- **Capa 2 — Sliding window:** Si la capa 1 no alcanza, eliminar pares `assistant+tool` desde el inicio del historial (respetando la estructura: nunca borrar un `tool` sin su `assistant` correspondiente).

**Complejidad:** Media (la capa 2 requiere cuidado con los pares de mensajes).

### 2.3 Configuración via `.env`
**Qué resuelve:** `MODEL`, `DEFAULT_MAX_ITERATIONS` y el futuro `MAX_CONTEXT_TOKENS` están hardcodeados.  
**Implementación:** En `src/constants.ts`:
```typescript
export const MODEL = process.env.MODEL ?? "qwen2.5:7b";
export const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS ?? "5", 10);
export const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS ?? "6000", 10);
```
**Complejidad:** Baja.

### 2.4 System prompt desde archivo externo
**Qué resuelve:** `SYSTEM_PROMPT` hardcodeado en `client.ts` requiere editar código para experimentar con prompts.  
**Implementación:** En `start()`, leer desde `SYSTEM_PROMPT_PATH` (env var, default `./prompts/system.txt`) con fallback al prompt embebido. Permite versionar prompts separados del código.  
**Complejidad:** Baja.

---

## Área 3: Resumabilidad de Conversaciones

### 3.1 Guardado automático de sesión
**Qué resuelve:** Toda la conversación se pierde al salir.  
**Implementación:** Nuevo archivo `src/session.ts`. Estructura:
```typescript
interface Session { id: string; createdAt: string; updatedAt: string; model: string; messages: ChatCompletionMessageParam[]; }
```
Guardar como `sessions/{id}.json` después de cada respuesta exitosa y en `SIGINT`/`SIGTERM`. Directorio configurable via `SESSION_DIR=./sessions`.  
**Complejidad:** Media.

### 3.2 Carga de sesión con `--resume`
**Qué resuelve:** Sin mecanismo para cargar sesiones anteriores al iniciar.  
**Implementación:** En `src/index.ts`, parsear `--resume=<id|latest>`. Nuevo método `MCPClient.loadMessages(messages)` para restaurar el historial. `--resume=latest` carga la sesión con `updatedAt` más reciente.  
**Depende de:** 3.1.  
**Complejidad:** Media.

### 3.3 Comandos `save`, `load`, `sessions` en el chat loop
**Qué resuelve:** No se puede nombrar sesiones ni cambiar de sesión sin reiniciar.  
**Implementación:** Integrar en el sistema de comandos (1.2): `save [nombre]`, `load <id|nombre>`, `sessions` (lista con fecha y conteo de mensajes).  
**Depende de:** 3.1, 1.2.  
**Complejidad:** Media.

### 3.4 Export a Markdown
**Qué resuelve:** Las sesiones JSON no son legibles para compartir o revisar.  
**Implementación:** Función `exportSession(session, 'markdown')` en `session.ts`. Omitir mensajes `tool`/`assistant` con `tool_calls` (son telemetría). Comando `export [markdown]` en el chat loop.  
**Complejidad:** Baja.

---

## Área 4: Arquitectura Interna

### 4.1 Logger estructurado con niveles
**Qué resuelve:** `console.info/warn/error` sin timestamps ni niveles configurables en runtime. `MCP_DEBUG` es un boolean transversal que no escala.  
**Implementación:** Nuevo `src/logger.ts` minimal. `LOG_LEVEL=debug|info|warn|error` env var. `MCP_DEBUG=true` se mapea a `LOG_LEVEL=debug`. Reemplaza todos los `console.*` de `client.ts`.  
**Complejidad:** Baja.

### 4.2 Mover `chatLoop` a `src/chat.ts`
**Qué resuelve:** `client.ts` tiene dos responsabilidades: lógica MCP y loop de terminal. Esto impide testear `MCPClient` sin stdin.  
**Implementación:** Mover `chatLoop()` a `src/chat.ts`. `src/client.ts` queda solo con `MCPClient`. `src/index.ts` importa desde `chat.ts`. Cambio puramente mecánico, sin cambio de comportamiento.  
**Complejidad:** Baja (refactor mecánico).

### 4.3 Modo batch (input desde archivo o pipe)
**Qué resuelve:** No hay forma de procesar queries de forma no interactiva.  
**Implementación:** En `src/index.ts`, detectar `--batch=archivo.txt` o `!process.stdin.isTTY`. Leer líneas, ejecutar `processQuery()` por cada una, escribir respuestas a stdout y salir.  
**Depende de:** 4.2.  
**Complejidad:** Baja.

### 4.4 Reconexión automática al servidor MCP
**Qué resuelve:** Si el subprocess del servidor MCP cae, el cliente continúa con un transporte muerto y todas las queries subsecuentes fallan silenciosamente.  
**Implementación:** En el catch de `callTool()`, detectar errores de transporte y llamar a un método privado `reconnect()` que recrea `StdioClientTransport` y vuelve a listar herramientas. El historial de mensajes se preserva.  
**Complejidad:** Media.

---

## `.env` completo resultante

```
MOVIES_SERVER_BUILD_PATH=C:\...\mcp_server_demo\build\index.js
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
MODEL=qwen2.5:7b
MAX_ITERATIONS=5
MAX_CONTEXT_TOKENS=6000
LOG_LEVEL=info
SYSTEM_PROMPT_PATH=./prompts/system.txt
SESSION_DIR=./sessions
```

---

## Archivos afectados

| Archivo | Mejoras |
|---|---|
| `src/client.ts` | 1.1, 2.1, 2.2, 2.3, 2.4, 4.1, 4.4 |
| `src/index.ts` | 3.2, 4.3, SIGINT handler |
| `src/rlinterface.ts` | 1.1 |
| `src/constants.ts` | 2.3 |
| `.env` | 2.3, 2.4, 3.1, 4.1 |
| `src/session.ts` *(nuevo)* | 3.1, 3.2, 3.3, 3.4 |
| `src/chat.ts` *(nuevo)* | 4.2, 1.2, 1.3, 1.4, 3.3 |
| `src/logger.ts` *(nuevo)* | 4.1 |
| `prompts/system.txt` *(nuevo)* | 2.4 |

## Dependencias entre mejoras

- **2.1 → 2.2**: La compresión necesita la estimación de tokens.
- **3.1 → 3.2 → 3.3**: La persistencia es prerequisito de carga y comandos.
- **4.2 → 4.3**: Separar chatLoop facilita el modo batch.
- **1.2 + 3.3**: Conviene implementarlos juntos para no duplicar el parser de comandos.
