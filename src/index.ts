import { chatLoop, MCPClient } from "./client.js";
import { getAllowedDirs } from "./rlinterface.js";

const absolute = process.env.ALLOWED_DIR_ABSOLUTE === "true";
const allowedDirs = getAllowedDirs(absolute).filter((d) => d.length > 0);

const FILESYSTEM_COMMAND = "npx";
const FILESYSTEM_ARGS = [
  "-y",
  "@modelcontextprotocol/server-filesystem",
  ...allowedDirs,
];

async function main() {
  if (allowedDirs.length === 0) {
    console.error(
      "Configura ALLOWED_DIR o ALLOWED_DIRS en .env (rutas absolutas, varias separadas por ;).",
    );
    process.exitCode = 1;
    return;
  }

  const filemanagerClient = new MCPClient("file_manager", "1.0.0", {
    filesystemRootHint: allowedDirs.join(", "),
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
