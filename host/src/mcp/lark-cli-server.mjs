import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import readline from "node:readline";

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND = "/opt/homebrew/bin/lark-cli";
const DEFAULT_TIMEOUT_MS = 120_000;
const ALLOWED_ROOTS = new Set([
  "api",
  "apps",
  "approval",
  "attendance",
  "base",
  "calendar",
  "contact",
  "docs",
  "drive",
  "event",
  "im",
  "mail",
  "markdown",
  "mindnotes",
  "minutes",
  "note",
  "okr",
  "sheets",
  "slides",
  "task",
  "vc",
  "whiteboard",
  "wiki",
]);

const tools = [
  {
    name: "lark_whoami",
    description: "查看当前 lark-cli 生效的飞书身份与认证状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "lark_help",
    description:
      "查看 lark-cli 命令帮助。path 是命令路径，例如 ['calendar'] 或 ['docs', '+get']。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "lark_schema",
    description: "查看飞书 OpenAPI 方法的参数、权限和风险信息，例如 docs.document.get。",
    inputSchema: {
      type: "object",
      properties: { method: { type: "string" } },
      required: ["method"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "lark_call",
    description:
      "调用 lark-cli 的飞书业务命令。argv 为参数数组，例如 ['calendar', '+agenda']。禁止认证、配置和 --yes；高风险写操作不会自动确认。",
    inputSchema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 40 },
      },
      required: ["argv"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

function validateStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error(`${label} must be an array of strings`);
  }
  return values;
}

export function validateCallArguments(argv) {
  validateStrings(argv, "argv");
  if (argv.length === 0) throw new Error("argv must not be empty");
  if (!ALLOWED_ROOTS.has(argv[0])) throw new Error(`Unsupported lark-cli domain: ${argv[0]}`);
  if (argv.includes("--yes")) throw new Error("--yes is not allowed through MCP");
  return argv;
}

export function parseCliOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return { text: "", value: null };
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    return { text, value: text };
  }
}

async function runCli(args) {
  const command = process.env.LARK_CLI_COMMAND || DEFAULT_COMMAND;
  const timeout = Number(process.env.LARK_CLI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    return parseCliOutput(stdout);
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || error).trim();
    throw new Error(detail || "lark-cli call failed");
  }
}

function toolResult(result) {
  return {
    content: [{ type: "text", text: result.text || JSON.stringify(result.value) }],
    structuredContent: { result: result.value },
  };
}

async function callTool(name, input = {}) {
  if (name === "lark_whoami") return toolResult(await runCli(["whoami"]));
  if (name === "lark_help") {
    const path = validateStrings(input.path ?? [], "path");
    return toolResult(await runCli([...path, "--help"]));
  }
  if (name === "lark_schema") {
    const method = String(input.method ?? "").trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(method)) throw new Error("Invalid schema method");
    return toolResult(await runCli(["schema", method, "--format", "json"]));
  }
  if (name === "lark_call") {
    return toolResult(await runCli(validateCallArguments(input.argv)));
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!Object.hasOwn(message, "id")) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "lark-cli-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: error.message || String(error) },
      });
    }
    return;
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Method not found: ${message.method}` },
  });
}

function startServer() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      void handle(JSON.parse(text));
    } catch (error) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
