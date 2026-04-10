import path from "node:path";

import { MODEL, OPENAI_API_KEY, OPENAI_BASE_URL } from "./constants.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";

import { ask, close as closeInterface } from "./rlinterface.js";

const openaiClient = new OpenAI({
  baseURL: OPENAI_BASE_URL,
  apiKey: OPENAI_API_KEY,
});

const messages: ChatCompletionMessageParam[] = [];

/** Set MCP_DEBUG=true in .env for argument snippets and longer tool result previews. */
const MCP_DEBUG =
  process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true";

function isFunctionToolCall(
  tc: ChatCompletionMessageToolCall,
): tc is Extract<ChatCompletionMessageToolCall, { type: "function" }> {
  return tc.type === "function";
}

function mcpToolToOpenAITool(tool: Tool): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description != null ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  };
}

function truncForLog(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function formatMcpToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  if (result && typeof result === "object" && "content" in result) {
    const r = result as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = r.content
      .map((c) =>
        c.type === "text" && c.text != null ? c.text : JSON.stringify(c),
      )
      .join("\n");
    return r.isError ? `Error: ${text}` : text;
  }
  return JSON.stringify(result);
}

export type MCPClientOptions = {
  /** Same path passed to the filesystem MCP server; used if listing roots fails. */
  filesystemRootHint?: string;
};

const FILESYSTEM_SYSTEM_PROMPT = `Sos un asistente que usa herramientas MCP de archivos en un entorno acotado.

Reglas obligatorias:
- Solo podés leer, crear o mover archivos bajo los directorios permitidos que figuran abajo (o que devuelva la herramienta list_allowed_directories).
- Las rutas que pases a las herramientas deben ser absolutas y quedar dentro de esos directorios.
- No asumas el "directorio del proyecto" ni el cwd de Node: si no está en la lista, no es válido.
- Si el usuario pide algo "aquí" o sin ruta, resolvelo dentro del primer directorio permitido o pedí aclaración.
- Antes de crear carpetas o mover muchos archivos, conviene listar el directorio destino o usar search_files con rutas bajo un directorio permitido.

Directorios permitidos (referencia):`;

export class MCPClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private tools: ChatCompletionTool[] = [];
  private readonly filesystemRootHint?: string;
  private allowedFilesystemBanner = "";

  constructor(name: string, version: string, options?: MCPClientOptions) {
    this.client = new Client({ name, version });
    this.filesystemRootHint = options?.filesystemRootHint;
  }

  async start(command: string, args: string[]): Promise<void> {
    try {
      const serverParams = {
        command,
        args,
      } as const;

      if (!serverParams.command || !serverParams.args) {
        throw new Error(
          `Server arguments are incomplete, missing: ${JSON.stringify(serverParams)}`,
        );
      }

      this.transport = new StdioClientTransport({
        command: serverParams.command,
        args: serverParams.args,
      });
      await this.client.connect(this.transport);

      const { tools: availableTools } = await this.client.listTools();
      this.tools = availableTools.map(mcpToolToOpenAITool);

      try {
        const rootsResult = await this.client.callTool({
          name: "list_allowed_directories",
          arguments: {},
        });
        this.allowedFilesystemBanner = formatMcpToolResult(rootsResult);
      } catch (e) {
        console.warn(
          "[mcp] list_allowed_directories failed; using filesystemRootHint if set:",
          e,
        );
        this.allowedFilesystemBanner =
          this.filesystemRootHint != null && this.filesystemRootHint !== ""
            ? path.normalize(this.filesystemRootHint)
            : "(desconocido)";
      }

      console.info(
        `Available tools: ${availableTools.map((tool) => tool.name).join(", ")}`,
      );
      console.info(`Allowed filesystem roots: ${this.allowedFilesystemBanner}`);
    } catch (e) {
      console.error("Failed to start MCP client");
      throw e;
    }
  }

  async processQuery(query: string): Promise<string> {
    if (messages.length === 0) {
      messages.push({
        role: "system",
        content: `${FILESYSTEM_SYSTEM_PROMPT}\n${this.allowedFilesystemBanner}`,
      });
    }

    messages.push({ role: "user", content: query });

    const maxIterations = 5;
    console.info(
      `[mcp] processQuery start model=${MODEL} maxIterations=${maxIterations} debug=${MCP_DEBUG}`,
    );

    for (let iter = 0; iter < maxIterations; iter++) {
      const response = await openaiClient.chat.completions.create({
        model: MODEL,
        messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
      });

      const choice = response.choices[0];
      const finishReason =
        choice && typeof choice === "object" && "finish_reason" in choice
          ? String((choice as { finish_reason?: unknown }).finish_reason ?? "")
          : "";
      const message = choice?.message;
      if (!message) {
        console.warn(
          `[mcp] iteration ${iter + 1}/${maxIterations}: empty message (no choice content)`,
        );
        return "";
      }

      const functionToolCalls =
        message.tool_calls?.filter(isFunctionToolCall) ?? [];

      console.info(
        `[mcp] iteration ${iter + 1}/${maxIterations}: finish_reason=${finishReason || "(none)"} tool_calls=${message.tool_calls?.length ?? 0} (function=${functionToolCalls.length})`,
      );

      messages.push({
        role: "assistant",
        content: message.content,
        refusal: message.refusal,
        ...(message.tool_calls != null && message.tool_calls.length > 0
          ? { tool_calls: message.tool_calls }
          : {}),
      });

      if (!message.tool_calls?.length) {
        if (typeof message.content === "string") {
          console.info(
            `[mcp] final answer (text) length=${message.content.length}`,
          );
          return message.content;
        }
        console.warn(
          `[mcp] final answer without tool calls but content is not a string: ${typeof message.content}`,
        );
        return "";
      }

      if (functionToolCalls.length === 0) {
        throw new Error(
          "The model returned tool_calls that are not supported (only function tools are handled).",
        );
      }

      const toolNames = functionToolCalls.map((tc) => tc.function.name);
      console.info(`[mcp] tool calls: ${toolNames.join(", ")}`);

      for (const toolCall of functionToolCalls) {
        let args: Record<string, unknown> = {};
        let argsParseFailed = false;
        try {
          const parsed = JSON.parse(
            toolCall.function.arguments || "{}",
          ) as unknown;
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = {};
          argsParseFailed = true;
        }
        if (argsParseFailed) {
          console.warn(
            `[mcp] failed to JSON.parse arguments for ${toolCall.function.name} (call id ${toolCall.id}); using {}`,
          );
        }
        if (MCP_DEBUG) {
          console.info(
            `[mcp]   callTool ${toolCall.function.name} id=${toolCall.id} args=${truncForLog(JSON.stringify(args), 800)}`,
          );
        }

        const result = await this.client.callTool({
          name: toolCall.function.name,
          arguments: args,
        });

        const text = formatMcpToolResult(result);
        const previewLen = MCP_DEBUG ? 1200 : 400;
        console.info(
          `[mcp]   tool result ${toolCall.function.name}: length=${text.length} preview=${truncForLog(text, previewLen)}`,
        );

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: text,
        });
      }
    }

    console.error(
      `[mcp] exhausted ${maxIterations} iterations without a final assistant message. Increase maxIterations or inspect logs above.`,
    );
    throw new Error("The model did not return a final answer in time.");
  }

  async stop(): Promise<void> {
    await this.client.close();
    this.transport = null;
  }
}

export async function chatLoop(client: MCPClient): Promise<void> {
  try {
    while (true) {
      const input = await ask();
      if (!input) continue;
      if (input === "exit") break;

      console.info("Answering...");
      const reply = await client.processQuery(input);
      console.info(reply);
      console.info("\n");
    }
  } catch (error) {
    throw error;
  } finally {
    closeInterface();
  }
}
