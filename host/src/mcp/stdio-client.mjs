import { spawn } from "node:child_process";

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";

export class StdioMcpClient {
  constructor(name, config, { requestTimeoutMs = 30_000 } = {}) {
    this.name = name;
    this.config = config;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.process = null;
    this.serverInfo = null;
  }

  async start() {
    if (!this.config.command) throw new Error(`MCP server ${this.name} has no command`);
    this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd || process.cwd(),
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.#onData(chunk));
    this.process.stderr.on("data", (chunk) => {
      if (this.config.logStderr) process.stderr.write(`[mcp:${this.name}] ${chunk}`);
    });
    this.process.on("error", (error) => this.#failAll(error));
    this.process.on("exit", (code, signal) => {
      this.#failAll(new Error(`MCP server ${this.name} exited (code=${code}, signal=${signal})`));
    });

    const initialized = await this.request("initialize", {
      protocolVersion: this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "marginnote-agent-host", version: "0.1.0" },
    });
    this.serverInfo = initialized.serverInfo ?? null;
    this.notify("notifications/initialized", {});
    return initialized;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name, argumentsValue = {}) {
    return this.request("tools/call", { name, arguments: argumentsValue });
  }

  request(method, params) {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error(`MCP server ${this.name} is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${this.name}.${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async stop() {
    if (!this.process || this.process.killed) return;
    this.process.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill("SIGKILL");
    }
  }

  #send(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.#onMessage(JSON.parse(line));
      } catch (error) {
        this.#failAll(new Error(`Invalid JSON from MCP server ${this.name}: ${error.message}`));
      }
    }
  }

  #onMessage(message) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "MCP request failed"));
      else pending.resolve(message.result ?? {});
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      if (message.method === "ping") {
        this.#send({ jsonrpc: "2.0", id: message.id, result: {} });
      } else {
        this.#send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported client method: ${message.method}` },
        });
      }
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
