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

/** Set MCP_DEBUG=true in .env for argument snippets and longer tool result previews. */
const MCP_DEBUG =
  process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true";

/** Default cap on model<->tool iterations per user query. */
const DEFAULT_MAX_ITERATIONS = 5;

const SYSTEM_PROMPT = `Sos un asistente experto en recomendaciones de películas y series. Usás herramientas MCP para buscar información actualizada de TMDB y brindar recomendaciones personalizadas.

Reglas:
- Usá siempre las herramientas disponibles para obtener datos reales antes de responder.
- Si el usuario pide recomendaciones, buscá opciones relevantes y justificá cada sugerencia brevemente.
- Respondé siempre en el idioma en que el usuario te habla.`;

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
  /** Max model<->tool iterations per user query. Defaults to 5. */
  maxIterations?: number;
};

export class MCPClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private tools: ChatCompletionTool[] = [];
  private readonly maxIterations: number;
  /**
   * Conversation history for the Chat Completions endpoint.
   *
   * Index 0 is always the `system` message (installed during {@link start}).
   * Subsequent entries alternate between `user`, `assistant`, and `tool` roles
   * as the chat progresses. Scoped to the instance so multiple clients do not
   * share history.
   */
  private messages: ChatCompletionMessageParam[] = [];

  constructor(name: string, version: string, options?: MCPClientOptions) {
    this.client = new Client({ name, version });
    this.maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  async start(command: string, args: string[]): Promise<void> {
    try {
      if (!command || !args) {
        throw new Error(
          `Server arguments are incomplete: command=${command} args=${JSON.stringify(args)}`,
        );
      }

      this.transport = new StdioClientTransport({ command, args, env: process.env as Record<string, string> });
      await this.client.connect(this.transport);

      const { tools: availableTools } = await this.client.listTools();
      this.tools = availableTools.map(mcpToolToOpenAITool);

      this.messages = [{ role: "system", content: SYSTEM_PROMPT }];

      console.info(
        `Available tools: ${availableTools.map((tool) => tool.name).join(", ")}`,
      );
    } catch (e) {
      console.error("Failed to start MCP client");
      throw e;
    }
  }

  /** Drop all conversation history except the system prompt. */
  resetConversation(): void {
    const system = this.messages[0];
    this.messages = system && system.role === "system" ? [system] : [];
  }

  async processQuery(query: string): Promise<string> {
    this.messages.push({ role: "user", content: query });

    console.info(
      `[mcp] processQuery start model=${MODEL} maxIterations=${this.maxIterations} debug=${MCP_DEBUG}`,
    );

    for (let iter = 0; iter < this.maxIterations; iter++) {
      const response = await openaiClient.chat.completions.create({
        model: MODEL,
        messages: this.messages,
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
          `[mcp] iteration ${iter + 1}/${this.maxIterations}: empty message (no choice content)`,
        );
        return "";
      }

      const functionToolCalls =
        message.tool_calls?.filter(isFunctionToolCall) ?? [];

      console.info(
        `[mcp] iteration ${iter + 1}/${this.maxIterations}: finish_reason=${finishReason || "(none)"} tool_calls=${message.tool_calls?.length ?? 0} (function=${functionToolCalls.length})`,
      );

      this.messages.push({
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

        let text: string;
        try {
          const result = await this.client.callTool({
            name: toolCall.function.name,
            arguments: args,
          });
          text = formatMcpToolResult(result);
        } catch (err) {
          // Surface the error back to the model as a tool message so it can
          // recover (e.g. retry with different arguments) instead of crashing
          // the whole chat loop.
          text = `Error: ${err instanceof Error ? err.message : String(err)}`;
          console.warn(
            `[mcp]   callTool ${toolCall.function.name} threw: ${text}`,
          );
        }

        const previewLen = MCP_DEBUG ? 1200 : 400;
        console.info(
          `[mcp]   tool result ${toolCall.function.name}: length=${text.length} preview=${truncForLog(text, previewLen)}`,
        );

        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: text,
        });
      }
    }

    console.error(
      `[mcp] exhausted ${this.maxIterations} iterations without a final assistant message. Increase maxIterations or inspect logs above.`,
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
      if (input === "reset" || input === "clear") {
        client.resetConversation();
        console.info("[mcp] conversation history cleared.");
        continue;
      }

      console.info("Answering...");
      try {
        const reply = await client.processQuery(input);
        console.info(reply);
        console.info("\n");
      } catch (err) {
        // One failed query should not kill the whole session.
        console.error(
          `[mcp] query failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    closeInterface();
  }
}
