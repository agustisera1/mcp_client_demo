import { chatLoop, MCPClient } from "./client.js";
import { getAllowedDir } from "./rlinterface.js";

const absolute = process.env.ALLOWED_DIR_ABSOLUTE === "true";
const allowedDir = getAllowedDir(absolute);

const FILESYSTEM_COMMAND = "npx";
const FILESYSTEM_ARGS = [
  "-y",
  "@modelcontextprotocol/server-filesystem",
  allowedDir,
];

async function main() {
  const filemanagerClient = new MCPClient("file_manager", "1.0.0", {
    filesystemRootHint: allowedDir,
  });
  try {
    await filemanagerClient.start(FILESYSTEM_COMMAND, FILESYSTEM_ARGS);
    await chatLoop(filemanagerClient);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await filemanagerClient.stop();
  }
}

main();
