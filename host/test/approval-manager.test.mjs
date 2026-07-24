import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../src/approval-manager.mjs";
import { EventHub } from "../src/event-hub.mjs";

const writeTool = {
  name: "fixture__write",
  displayName: "Fixture: write",
  source: "test",
  destructive: false,
};

test("approval manager automatically approves tools without publishing an event", async () => {
  const eventHub = new EventHub();
  const approvals = new ApprovalManager({ eventHub });

  assert.equal(await approvals.request("session-auto", writeTool, { value: 1 }), true);
  assert.equal(approvals.pending.size, 0);
  assert.equal(eventHub.lastId("session-auto"), 0);
});

test("approval manager retains manual approval when auto approve is disabled", async () => {
  const eventHub = new EventHub();
  const approvals = new ApprovalManager({ eventHub, autoApprove: false, timeoutMs: 1_000 });

  const decision = approvals.request("session-manual", writeTool, { value: 1 });
  const [event] = eventHub.histories.get("session-manual");
  assert.equal(event.type, "approval.required");
  assert.equal(approvals.resolve("session-manual", event.approvalId, true), true);
  assert.equal(await decision, true);
});

test("enabling auto approval accepts pending tool requests", async () => {
  const eventHub = new EventHub();
  const approvals = new ApprovalManager({ eventHub, autoApprove: false, timeoutMs: 1_000 });

  const decision = approvals.request("session-pending", writeTool, { value: 1 });
  assert.equal(approvals.pending.size, 1);
  assert.equal(approvals.setAutoApprove(true), true);
  assert.equal(await decision, true);
  assert.equal(approvals.pending.size, 0);
});
