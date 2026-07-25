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
    const { onDelta, ...serializableRequest } = request;
    this.calls.push(structuredClone(serializableRequest));
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
    onDelta({ type: "reasoning", delta: "正在整理结果。" });
    onDelta({ type: "text", delta: "已读取" });
    onDelta({ type: "text", delta: "笔记 N1。" });
    return {
      reasoning_text: "正在整理结果。",
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

class ContextCompactingProvider {
  constructor() {
    this.calls = [];
  }

  async createResponse(request) {
    const { onDelta, ...serializableRequest } = request;
    this.calls.push(structuredClone(serializableRequest));
    if (request.instructions.includes("对话上下文压缩器")) {
      return {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "此前已完成资料整理，保留最新问题继续处理。" }],
          },
        ],
      };
    }
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "继续处理。" }],
        },
      ],
    };
  }
}

test("agent preserves response items, executes tools and returns the final message", async () => {
  const eventHub = new EventHub();
  const approvals = new ApprovalManager({ eventHub });
  const registry = new ToolRegistry();
  registry.register({
    name: "fixture__lookup",
    source: "test",
    description: "Lookup a fixture note",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    readOnly: false,
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

  const session = await engine.createSession();
  const output = await engine.sendMessage(session.id, "读取 N1");
  assert.equal(output, "已读取笔记 N1。");
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[1].input.some((item) => item.type === "reasoning"));
  assert.ok(provider.calls[1].input.some((item) => item.type === "function_call_output"));
  const snapshot = engine.snapshot(session.id);
  assert.equal(snapshot.messages.length, 3);
  assert.match(snapshot.messages[0].id, /^[0-9a-f-]{36}$/);
  const userEvent = (eventHub.histories.get(session.id) ?? []).find(
    (event) => event.type === "user.message",
  );
  assert.equal(userEvent.messageId, snapshot.messages[0].id);
  assert.equal(snapshot.messages[1].role, "tool");
  assert.equal(snapshot.messages[2].reasoning, "正在整理结果。");
  assert.equal(snapshot.messages[2].content, "已读取笔记 N1。");
  assert.equal(
    (eventHub.histories.get(session.id) ?? []).some((event) => event.type === "approval.required"),
    false,
  );
  assert.equal(engine.listSessions()[0].title, "读取 N1");
});

test("agent compacts completed history at the configured context window limit", async () => {
  const provider = new ContextCompactingProvider();
  const eventHub = new EventHub();
  const engine = new AgentEngine({
    provider,
    registry: new ToolRegistry(),
    eventHub,
    approvals: new ApprovalManager({ eventHub }),
    config: { contextWindowTokens: 2_000, instructions: "test" },
    sessions: [
      {
        id: "context-session",
        title: "已有对话",
        input: [
          { role: "user", content: "第一轮问题。".repeat(220) },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "第一轮回答。".repeat(220) }],
          },
          { role: "user", content: "第二轮问题。".repeat(220) },
        ],
        messages: [],
        running: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });

  await engine.sendMessage("context-session", "继续处理");

  const snapshot = engine.snapshot("context-session");
  assert.equal(snapshot.contextWindow.limitTokens, 2_000);
  assert.ok(snapshot.contextWindow.compactionCount >= 1);
  assert.ok(snapshot.contextWindow.usedTokens < snapshot.contextWindow.limitTokens);

  const compaction = provider.calls.find((call) => call.instructions.includes("对话上下文压缩器"));
  assert.ok(compaction);
  const request = provider.calls.find((call) => !call.instructions.includes("对话上下文压缩器"));
  assert.match(request.instructions, /此前已完成资料整理/);
  assert.ok(request.input.some((item) => item.role === "user" && item.content === "继续处理"));
});
