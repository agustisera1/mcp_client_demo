import * as readline from "readline/promises";
import path from "path";

export function getAllowedDir(absolute?: boolean): string {
  const envDir = process.env.ALLOWED_DIR || "";
  const raw = absolute === true ? envDir : path.resolve(process.cwd(), envDir);
  return path.normalize(raw);
}

/**
 * Roots passed to `@modelcontextprotocol/server-filesystem` (multiple args supported).
 *
 * - If `ALLOWED_DIRS` is set and non-empty: semicolon-separated **absolute** paths,
 *   e.g. `C:/Users/me/Desktop;C:/Users/me/Documents/Workspace`
 * - Otherwise: a single path from `ALLOWED_DIR` via {@link getAllowedDir}
 */
export function getAllowedDirs(absolute?: boolean): string[] {
  const multi = process.env.ALLOWED_DIRS?.trim();
  if (multi) {
    return multi
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((p) => path.normalize(p));
  }
  return [getAllowedDir(absolute)];
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
