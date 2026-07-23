import { StdioMcpClient } from "./stdio-client.mjs";

export class McpManager {
  constructor(serverConfigs = {}) {
    this.serverConfigs = serverConfigs;
    this.clients = new Map();
    this.statuses = new Map();
  }

  async connectAll(registry) {
    await Promise.all(
      Object.entries(this.serverConfigs).map(async ([name, config]) => {
        if (config.enabled === false) {
          this.statuses.set(name, { state: "disabled" });
          return;
        }
        if ((config.transport ?? "stdio") !== "stdio") {
          this.statuses.set(name, { state: "error", error: "Only stdio transport is supported in v0.1" });
          return;
        }

        const client = new StdioMcpClient(name, config, {
          requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
        });
        try {
          await client.start();
          const tools = await client.listTools();
          this.clients.set(name, client);
          for (const tool of tools) {
            registry.register({
              nameParts: ["mcp", name, tool.name],
              displayName: `${name}: ${tool.name}`,
              source: `mcp:${name}`,
              description: tool.description ?? `MCP tool ${tool.name} from ${name}`,
              inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
              readOnly: tool.annotations?.readOnlyHint === true,
              destructive: tool.annotations?.destructiveHint === true,
              execute: (argumentsValue) => client.callTool(tool.name, argumentsValue),
            });
          }
          this.statuses.set(name, {
            state: "connected",
            serverInfo: client.serverInfo,
            toolCount: tools.length,
          });
        } catch (error) {
          await client.stop().catch(() => {});
          this.statuses.set(name, { state: "error", error: error.message });
        }
      }),
    );
  }

  snapshot() {
    return Object.fromEntries(this.statuses.entries());
  }

  async close() {
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }
}
