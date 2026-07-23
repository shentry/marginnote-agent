import test from "node:test";
import assert from "node:assert/strict";
import { EventHub } from "../src/event-hub.mjs";
import { ApprovalManager } from "../src/approval-manager.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";
import { AgentEngine } from "../src/agent-engine.mjs";

class FakeProvider {
  constructor() {
    this.calls = [];
  }

  status() {
    return { type: "fake", model: "fake" };
  }

  async createResponse(request) {
    this.calls.push(structuredClone(request));
    if (this.calls.length === 1) {
      return {
        output: [
          { type: "reasoning", id: "reasoning_1", summary: [] },
          {
            type: "function_call",
            id: "function_1",
            call_id: "call_1",
            name: "fixture__lookup",
            arguments: '{"id":"N1"}',
          },
        ],
      };
    }
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "已读取笔记 N1。" }],
        },
      ],
    };
  }
}

test("agent preserves response items, executes tools and returns the final message", async () => {
  const eventHub = new EventHub();
  const approvals = new ApprovalManager({ eventHub, autoApprove: true });
  const registry = new ToolRegistry();
  registry.register({
    name: "fixture__lookup",
    source: "test",
    description: "Lookup a fixture note",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    readOnly: true,
    execute: async ({ id }) => ({ id, title: "Fixture" }),
  });
  const provider = new FakeProvider();
  const engine = new AgentEngine({
    provider,
    registry,
    eventHub,
    approvals,
    config: { maxToolRounds: 4, instructions: "test" },
  });

  const session = engine.createSession();
  const output = await engine.sendMessage(session.id, "读取 N1");
  assert.equal(output, "已读取笔记 N1。");
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[1].input.some((item) => item.type === "reasoning"));
  assert.ok(provider.calls[1].input.some((item) => item.type === "function_call_output"));
  assert.equal(engine.snapshot(session.id).messages.length, 2);
});
