import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "../src/mcp/stdio-client.mjs";

const fixture = fileURLToPath(new URL("./fixture-mcp-server.mjs", import.meta.url));

test("stdio MCP client initializes, lists tools and calls a tool", async (t) => {
  const client = new StdioMcpClient("fixture", {
    command: process.execPath,
    args: [fixture],
  });
  t.after(() => client.stop());

  const initialized = await client.start();
  assert.equal(initialized.serverInfo.name, "fixture-mcp");

  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "echo.value");

  const result = await client.callTool("echo.value", { value: "hello" });
  assert.deepEqual(result.structuredContent, { echoed: "hello" });
});
