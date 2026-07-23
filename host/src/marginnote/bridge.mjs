import { randomUUID } from "node:crypto";

export class MarginNoteBridge {
  constructor({ timeoutMs = 60_000, offlineAfterMs = 3_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.offlineAfterMs = offlineAfterMs;
    this.queue = [];
    this.pending = new Map();
    this.clients = new Map();
  }

  touchClient(clientId, metadata = {}) {
    this.clients.set(clientId, {
      clientId,
      metadata,
      lastSeenAt: Date.now(),
    });
  }

  status() {
    const now = Date.now();
    const clients = [...this.clients.values()].map((client) => ({
      ...client,
      online: now - client.lastSeenAt <= this.offlineAfterMs,
    }));
    return {
      online: clients.some((client) => client.online),
      clients,
      queuedCalls: this.queue.length,
      pendingCalls: this.pending.size,
    };
  }

  async call(tool, argumentsValue) {
    if (!this.status().online) {
      throw new Error("MarginNote 插件未连接。请确认 MarginNote 已打开并启用插件。");
    }

    const requestId = randomUUID();
    const request = {
      requestId,
      tool,
      arguments: argumentsValue ?? {},
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
    };
    this.queue.push(request);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.queue = this.queue.filter((item) => item.requestId !== requestId);
        reject(new Error(`MarginNote tool timed out: ${tool}`));
      }, this.timeoutMs);
      this.pending.set(requestId, { request, resolve, reject, timer });
    });
  }

  takeNext(clientId, metadata = {}) {
    this.touchClient(clientId, metadata);
    const now = Date.now();
    const request = this.queue.find(
      (item) => item.dispatchedAt === null || now - item.dispatchedAt > 10_000,
    );
    if (!request) return null;
    request.dispatchedAt = now;
    request.clientId = clientId;
    return {
      requestId: request.requestId,
      tool: request.tool,
      arguments: request.arguments,
    };
  }

  resolve(requestId, { success, result, error }) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    this.queue = this.queue.filter((item) => item.requestId !== requestId);
    if (success) pending.resolve(result);
    else pending.reject(new Error(error || `MarginNote tool failed: ${pending.request.tool}`));
    return true;
  }
}
