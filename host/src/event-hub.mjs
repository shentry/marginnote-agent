export class EventHub {
  constructor({ historyLimit = 300 } = {}) {
    this.historyLimit = historyLimit;
    this.sequences = new Map();
    this.histories = new Map();
    this.subscribers = new Map();
  }

  publish(sessionId, type, payload = {}) {
    const sequence = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, sequence);
    const event = {
      id: sequence,
      sessionId,
      type,
      timestamp: new Date().toISOString(),
      ...payload,
    };

    const history = this.histories.get(sessionId) ?? [];
    history.push(event);
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
    this.histories.set(sessionId, history);

    for (const response of this.subscribers.get(sessionId) ?? []) {
      this.#write(response, event);
    }
    return event;
  }

  subscribe(sessionId, response, afterId = 0) {
    const subscribers = this.subscribers.get(sessionId) ?? new Set();
    subscribers.add(response);
    this.subscribers.set(sessionId, subscribers);

    for (const event of this.histories.get(sessionId) ?? []) {
      if (event.id > afterId) this.#write(response, event);
    }

    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    const unsubscribe = () => {
      clearInterval(heartbeat);
      subscribers.delete(response);
      if (subscribers.size === 0) this.subscribers.delete(sessionId);
    };
    response.once("close", unsubscribe);
    response.once("error", unsubscribe);
    return unsubscribe;
  }

  #write(response, event) {
    response.write(`id: ${event.id}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
