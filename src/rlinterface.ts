import * as readline from "node:readline/promises";
// import { stdin as input, stdout as output } from "node:process";

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
