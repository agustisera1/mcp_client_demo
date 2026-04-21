import { chatLoop, MCPClient } from "./client.js";

const MOVIES_SERVER_BUILD_PATH = process.env.MOVIES_SERVER_BUILD_PATH;
const MOVIES_SERVER_COMMAND = "node";
const MOVIES_SERVER_ARGS = MOVIES_SERVER_BUILD_PATH
  ? [MOVIES_SERVER_BUILD_PATH]
  : [];

async function main() {
  const moviesClient = new MCPClient("tmbd_movies_recommendation", "1.0.0");
  try {
    await moviesClient.start(MOVIES_SERVER_COMMAND, MOVIES_SERVER_ARGS);
    await chatLoop(moviesClient);
  } catch (err) {
    console.error(err);
    process.exit(0);
  } finally {
    await moviesClient.stop();
  }
}

main();
