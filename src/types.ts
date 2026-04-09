export const MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};
