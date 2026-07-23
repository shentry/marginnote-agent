import { loadConfig } from "./config.mjs";
import { createHost } from "./server.mjs";

const { config, configPath } = await loadConfig();
const host = await createHost({ config });
const address = await host.listen();

console.log(`MarginNote Agent Host listening on http://${address.address}:${address.port}`);
console.log(`Config: ${configPath ?? "built-in defaults"}`);
console.log(`Model: ${config.provider.model}`);
console.log(`MCP servers: ${Object.keys(config.mcpServers).length}`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Shutting down (${signal})...`);
  await host.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
