import * as readline from "readline/promises";
import path from "path";
import { fileURLToPath } from "url";

// Si usás ES Modules (import/export)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function getAllowedDir(absolute?: boolean): string {
  const envDir = process.env.ALLOWED_DIR || "";
  const raw =
    absolute === true ? envDir : path.join(__dirname, envDir);
  return path.normalize(raw);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export async function ask(): Promise<string> {
  return (await rl.question(`>: `)).trim();
}

export function close(): void {
  rl.close();
}
