import { OpenRouter } from "@openrouter/sdk";
import { ask, close } from "./rlinterface.js";
import { MODEL, type ChatMessage } from "./types.js";

import dotenv from "dotenv";
dotenv.config();

const client = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

const messages: ChatMessage[] = [];

async function main() {
  try {
    while (true) {
      const input = await ask();
      if (!input) continue;
      if (input === "exit") break;

      messages.push({ role: "user", content: input });
      console.info("Thinking...");

      const stream = await client.chat.send({
        chatRequest: {
          model: MODEL,
          messages: messages,
          stream: true,
        },
      });

      let response = "";

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          response += content;
          process.stdout.write(content);
        }
      }

      messages.push({ role: "assistant", content: response });
      console.info("\n");
    }
  } catch (error) {
    throw error;
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
