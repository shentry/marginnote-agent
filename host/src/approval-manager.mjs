import { randomUUID } from "node:crypto";

export class ApprovalManager {
  constructor({ eventHub, timeoutMs = 300_000, autoApprove = false }) {
    this.eventHub = eventHub;
    this.timeoutMs = timeoutMs;
    this.autoApprove = autoApprove;
    this.pending = new Map();
  }

  async request(sessionId, tool, argumentsValue) {
    if (this.autoApprove) return true;

    const approvalId = randomUUID();
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(approvalId, { sessionId, resolve, timer });
    });

    this.eventHub.publish(sessionId, "approval.required", {
      approvalId,
      tool: {
        name: tool.name,
        displayName: tool.displayName,
        source: tool.source,
        destructive: Boolean(tool.destructive),
      },
      arguments: argumentsValue,
    });

    return promise;
  }

  resolve(sessionId, approvalId, approved) {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.sessionId !== sessionId) return false;
    clearTimeout(pending.timer);
    this.pending.delete(approvalId);
    pending.resolve(Boolean(approved));
    this.eventHub.publish(sessionId, "approval.resolved", {
      approvalId,
      approved: Boolean(approved),
    });
    return true;
  }
}
