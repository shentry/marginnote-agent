import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIChatCompletionsProvider } from "../src/openai-chat-completions-provider.mjs";

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("chat completions provider converts tools, calls and tool results", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: await readJson(request),
    });
    response.setHeader("Content-Type", "application/json");

    if (requests.length === 1) {
      response.end(
        JSON.stringify({
          id: "completion_1",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "fixture__lookup", arguments: '{"id":"N1"}' },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }

    response.end(
      JSON.stringify({
        id: "completion_2",
        choices: [{ message: { role: "assistant", content: "已读取笔记 N1。" } }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const apiKeyEnv = "MN_AGENT_TEST_API_KEY";
  process.env[apiKeyEnv] = "test-key";
  t.after(() => delete process.env[apiKeyEnv]);

  const address = server.address();
  const provider = new OpenAIChatCompletionsProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKeyEnv,
    model: "test-model",
    timeoutMs: 1_000,
  });
  const tools = [
    {
      type: "function",
      name: "fixture__lookup",
      description: "Lookup a note",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  ];
  const input = [{ role: "user", content: "读取 N1" }];

  const first = await provider.createResponse({ input, tools, instructions: "test instructions" });
  assert.deepEqual(first.output, [
    {
      type: "function_call",
      id: "call_1",
      call_id: "call_1",
      name: "fixture__lookup",
      arguments: '{"id":"N1"}',
    },
  ]);

  const second = await provider.createResponse({
    input: [
      ...input,
      ...first.output,
      { type: "function_call_output", call_id: "call_1", output: '{"title":"Fixture"}' },
    ],
    tools,
    instructions: "test instructions",
  });

  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer test-key");
  assert.deepEqual(requests[0].body.tools[0], {
    type: "function",
    function: {
      name: "fixture__lookup",
      description: "Lookup a note",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  });
  assert.deepEqual(requests[1].body.messages, [
    { role: "system", content: "test instructions" },
    { role: "user", content: "读取 N1" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "fixture__lookup", arguments: '{"id":"N1"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"title":"Fixture"}' },
  ]);
  assert.equal(second.output_text, "已读取笔记 N1。");
  assert.equal(second.output[0].content[0].text, "已读取笔记 N1。");
  assert.deepEqual(provider.status(), {
    type: "openai-chat-completions",
    model: "test-model",
    apiKeyEnv,
    apiKeyConfigured: true,
  });
});
