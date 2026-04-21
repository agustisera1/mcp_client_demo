import "dotenv/config";

// qwen2.5:7b handles OpenAI-style tool_calls correctly; smaller models (e.g. llama3.2:3b) tend to emit JSON as plain text instead.
export const MODEL = process.env.MODEL ?? "qwen2.5:7b";

export const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "ollama";
