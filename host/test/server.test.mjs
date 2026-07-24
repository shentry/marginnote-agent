import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { createHost, createProvider } from "../src/server.mjs";
import { MemorySessionStore } from "../src/session-store.mjs";

class FinalOnlyProvider {
  status() {
    return { type: "fake", model: "test-model" };
  }

  async createResponse() {
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
    };
  }
}

class MarginNoteToolProvider {
  constructor() {
    this.callCount = 0;
  }

  status() {
    return { type: "fake", model: "margin-note-tool-test" };
  }

  async createResponse() {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        output: [
          {
            type: "function_call",
            id: "function_context",
            call_id: "call_context",
            name: "marginnote__get_context",
            arguments: "{}",
          },
        ],
      };
    }
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "已读取当前 MarginNote 上下文。" }],
        },
      ],
    };
  }
}

async function waitFor(callback, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

test("provider factory selects the configured API protocol", () => {
  const chat = createProvider({
    type: "openai-chat-completions",
    baseUrl: "http://127.0.0.1/v1",
    model: "test-model",
  });
  assert.equal(chat.status().type, "openai-chat-completions");

  const responses = createProvider({
    type: "openai-responses",
    baseUrl: "http://127.0.0.1/v1",
    model: "test-model",
  });
  assert.equal(responses.status().type, "openai-responses");
  assert.throws(() => createProvider({ type: "unknown" }), /Unsupported provider\.type/);
});

test("host exposes health, sessions and message execution", async (t) => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.listen.port = 0;
  const host = await createHost({
    config,
    provider: new FinalOnlyProvider(),
    sessionStore: new MemorySessionStore(),
  });
  t.after(() => host.close());
  const address = await host.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.provider.model, "test-model");
  assert.equal(host.approvals.autoApprove, true);

  const settings = await fetch(`${baseUrl}/api/settings`).then((response) => response.json());
  assert.deepEqual(settings, { autoApprove: true });

  const updatedSettings = await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoApprove: false }),
  }).then((response) => response.json());
  assert.deepEqual(updatedSettings, { autoApprove: false });
  assert.equal(host.approvals.autoApprove, false);

  const invalidSettings = await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoApprove: "yes" }),
  });
  assert.equal(invalidSettings.status, 400);
  assert.equal(host.approvals.autoApprove, false);

  const session = await fetch(`${baseUrl}/api/sessions`, { method: "POST" }).then((response) =>
    response.json(),
  );
  const sent = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "hello" }),
  });
  assert.equal(sent.status, 202);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = await fetch(`${baseUrl}/api/sessions/${session.id}`).then((response) =>
    response.json(),
  );
  assert.equal(snapshot.messages.at(-1).content, "ok");
  const sessionList = await fetch(`${baseUrl}/api/sessions`).then((response) => response.json());
  assert.equal(sessionList.sessions[0].id, session.id);
  assert.equal(sessionList.sessions[0].title, "hello");
});

test("host routes a model tool call through the MarginNote addon bridge", async (t) => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.listen.port = 0;
  const host = await createHost({
    config,
    provider: new MarginNoteToolProvider(),
    sessionStore: new MemorySessionStore(),
  });
  t.after(() => host.close());
  const address = await host.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await fetch(`${baseUrl}/api/marginnote/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "integration-addon" }),
  });
  const session = await fetch(`${baseUrl}/api/sessions`, { method: "POST" }).then((response) =>
    response.json(),
  );
  await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "读取当前上下文" }),
  });

  const request = await waitFor(async () => {
    const payload = await fetch(
      `${baseUrl}/api/marginnote/next?clientId=integration-addon&version=test`,
    ).then((response) => response.json());
    return payload.request;
  });
  assert.equal(request.tool, "get_context");

  const resultResponse = await fetch(`${baseUrl}/api/marginnote/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: request.requestId,
      success: true,
      result: { notebook: { topicId: "T1", title: "Test" } },
    }),
  });
  assert.equal(resultResponse.status, 200);

  const snapshot = await waitFor(async () => {
    const current = await fetch(`${baseUrl}/api/sessions/${session.id}`).then((response) =>
      response.json(),
    );
    return current.messages.some((message) => message.role === "assistant") ? current : null;
  });
  assert.equal(snapshot.messages.at(-1).content, "已读取当前 MarginNote 上下文。");
});
