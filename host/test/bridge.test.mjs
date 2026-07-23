import test from "node:test";
import assert from "node:assert/strict";
import { MarginNoteBridge } from "../src/marginnote/bridge.mjs";

test("MarginNote bridge queues and resolves native tool calls", async () => {
  const bridge = new MarginNoteBridge({ timeoutMs: 1_000, offlineAfterMs: 1_000 });
  bridge.touchClient("test-client", { version: "test" });

  const resultPromise = bridge.call("get_context", {});
  const request = bridge.takeNext("test-client");
  assert.equal(request.tool, "get_context");
  assert.equal(bridge.resolve(request.requestId, { success: true, result: { ok: true } }), true);
  assert.deepEqual(await resultPromise, { ok: true });
});

test("MarginNote bridge fails fast when the addon is offline", async () => {
  const bridge = new MarginNoteBridge({ timeoutMs: 50, offlineAfterMs: 10 });
  await assert.rejects(() => bridge.call("get_context", {}), /未连接/);
});
