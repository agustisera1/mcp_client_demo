import "dotenv/config";

/**
 * Model id as understood by the OpenAI-compatible server (e.g. `ollama list`).
 * @see https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
// llama3.2:3b is too small to do OpenAI-style tool calling reliably — it tends
// to emit JSON describing the calls as plain text instead of using the
// structured `tool_calls` channel. qwen2.5:7b handles tools correctly.
export const MODEL = "qwen2.5:7b";
// export const MODEL = "llama3.2:3b";

/** Chat Completions base URL (Ollama: `http://localhost:11434/v1`). */
export const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1";

/**
 * `apiKey` for the OpenAI client. Ollama ignores it; OpenAI/OpenRouter need a real key.
 */
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "ollama";
