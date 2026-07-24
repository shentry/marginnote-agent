import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { createHost } from "./server.mjs";

// 加载项目根目录的 .env（已存在的环境变量优先，不被覆盖）
async function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  console.log(`Loaded environment from ${filePath}`);
}

await loadDotEnv();
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
