import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  listen: {
    host: "127.0.0.1",
    port: 42117,
  },
  provider: {
    type: "openai-chat-completions",
    baseUrl: "http://143.198.115.0:18317/v1",
    apiKeyEnv: "MN_AGENT_API_KEY",
    model: "grok-4.5",
    timeoutMs: 120_000,
  },
  agent: {
    maxToolRounds: 12,
    autoApprove: true,
    approvalTimeoutMs: 300_000,
    instructions:
      "你是 MarginNote 内的研究与学习助手。需要了解当前材料时，先调用 MarginNote 或 MCP 工具获取事实。用户询问当前 PDF 时调用 read_pdf，询问选中内容时调用 get_selection。只在完成任务所必需时调用写工具；不要删除笔记。工具失败时说明真实错误，不编造结果。",
  },
  sessions: {
    filePath: path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "MarginNote Agent",
      "sessions.json",
    ),
  },
  marginNote: {
    toolTimeoutMs: 60_000,
    offlineAfterMs: 3_000,
  },
  mcpServers: {},
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function merge(base, override) {
  if (!isPlainObject(override)) return structuredClone(base);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = merge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export async function loadConfig(explicitPath = process.env.MN_AGENT_CONFIG) {
  let userConfig = {};
  let configPath = explicitPath;

  if (!configPath) {
    const candidate = path.resolve(process.cwd(), "config.json");
    try {
      userConfig = JSON.parse(await readFile(candidate, "utf8"));
      configPath = candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } else {
    configPath = path.resolve(configPath);
    userConfig = JSON.parse(await readFile(configPath, "utf8"));
  }

  const config = merge(DEFAULT_CONFIG, userConfig);

  if (process.env.MN_AGENT_HOST) config.listen.host = process.env.MN_AGENT_HOST;
  if (process.env.MN_AGENT_PORT) config.listen.port = Number(process.env.MN_AGENT_PORT);
  if (process.env.MN_AGENT_MODEL) config.provider.model = process.env.MN_AGENT_MODEL;
  if (process.env.MN_AGENT_SESSION_FILE) {
    config.sessions.filePath = path.resolve(process.env.MN_AGENT_SESSION_FILE);
  }

  if (!Number.isInteger(config.listen.port) || config.listen.port < 1 || config.listen.port > 65_535) {
    throw new Error(`Invalid listen.port: ${config.listen.port}`);
  }

  return { config, configPath: configPath ?? null };
}
