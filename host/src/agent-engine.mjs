import { randomUUID } from "node:crypto";

function parseArguments(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object") return value;
  return JSON.parse(value);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
    .filter(Boolean)
    .join("\n");
}

function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if ((content.type === "output_text" || content.type === "text") && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractReasoningText(response) {
  if (typeof response.reasoning_text === "string" && response.reasoning_text) {
    return response.reasoning_text;
  }
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type !== "reasoning") continue;
    if (typeof item.text === "string") parts.push(item.text);
    for (const part of [...(item.summary ?? []), ...(item.content ?? [])]) {
      const text = typeof part === "string" ? part : part?.text;
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function stringifyToolResult(result) {
  if (typeof result === "string") return result;
  if (result === undefined) return "null";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function now() {
  return new Date().toISOString();
}

function titleFromMessage(content) {
  const compact = String(content).replace(/\s+/g, " ").trim();
  return compact.length > 36 ? `${compact.slice(0, 36)}…` : compact;
}

function restoreSession(value) {
  if (!value || typeof value !== "object" || !String(value.id ?? "").trim()) return null;
  const createdAt = value.createdAt || now();
  return {
    id: String(value.id),
    title: String(value.title || "新对话"),
    input: Array.isArray(value.input) ? value.input : [],
    messages: Array.isArray(value.messages) ? value.messages : [],
    running: false,
    createdAt,
    updatedAt: value.updatedAt || createdAt,
  };
}

const NOOP_STORE = {
  async save() {},
};

export class AgentEngine {
  constructor({ provider, registry, eventHub, approvals, config, sessionStore, sessions = [] }) {
    this.provider = provider;
    this.registry = registry;
    this.eventHub = eventHub;
    this.approvals = approvals;
    this.config = config;
    this.sessionStore = sessionStore ?? NOOP_STORE;
    this.sessions = new Map();
    for (const value of sessions) {
      const session = restoreSession(value);
      if (session) this.sessions.set(session.id, session);
    }
  }

  summary(session) {
    return {
      id: session.id,
      title: session.title,
      running: session.running,
      messageCount: session.messages.length,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  listSessions() {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => this.summary(session));
  }

  async persist() {
    await this.sessionStore.save([...this.sessions.values()]);
  }

  async createSession() {
    const timestamp = now();
    const session = {
      id: randomUUID(),
      title: "新对话",
      input: [],
      messages: [],
      running: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.sessions.set(session.id, session);
    await this.persist();
    return this.snapshot(session.id);
  }

  snapshot(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      ...this.summary(session),
      messages: structuredClone(session.messages),
      lastEventId: this.eventHub.lastId(sessionId),
    };
  }

  publishSessionUpdate(session) {
    this.eventHub.publish(session.id, "session.updated", { session: this.summary(session) });
  }

  completeAssistantStream(session, stream, { incomplete = false } = {}) {
    if (!stream.started) return null;
    const message = {
      id: stream.messageId,
      role: "assistant",
      content: stream.content,
      reasoning: stream.reasoning,
      incomplete,
      timestamp: now(),
    };
    session.messages.push(message);
    session.updatedAt = message.timestamp;
    this.eventHub.publish(session.id, "assistant.stream.completed", {
      messageId: stream.messageId,
      content: stream.content,
      reasoning: stream.reasoning,
      incomplete,
    });
    return message;
  }

  async sendMessage(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.running) throw new Error("Session is already running");
    const content = String(text ?? "").trim();
    if (!content) throw new Error("Message is empty");

    const timestamp = now();
    session.running = true;
    if (session.messages.length === 0) session.title = titleFromMessage(content);
    session.updatedAt = timestamp;
    const userMessage = { id: randomUUID(), role: "user", content, timestamp };
    session.messages.push(userMessage);
    session.input.push({ role: "user", content });
    await this.persist();
    this.eventHub.publish(sessionId, "user.message", {
      messageId: userMessage.id,
      content,
      timestamp,
    });
    this.publishSessionUpdate(session);

    try {
      const maxRounds = this.config.maxToolRounds ?? 12;
      for (let round = 0; round < maxRounds; round += 1) {
        this.eventHub.publish(sessionId, "agent.status", {
          state: "thinking",
          round: round + 1,
        });

        const stream = {
          messageId: randomUUID(),
          started: false,
          content: "",
          reasoning: "",
        };
        const appendDelta = ({ type, delta }) => {
          const value = String(delta ?? "");
          if (!value || (type !== "text" && type !== "reasoning")) return;
          if (!stream.started) {
            stream.started = true;
            this.eventHub.publish(sessionId, "assistant.stream.started", {
              messageId: stream.messageId,
              round: round + 1,
            });
          }
          if (type === "reasoning") stream.reasoning += value;
          else stream.content += value;
          this.eventHub.publish(
            sessionId,
            type === "reasoning" ? "assistant.reasoning.delta" : "assistant.text.delta",
            { messageId: stream.messageId, delta: value },
          );
        };

        let response;
        try {
          response = await this.provider.createResponse({
            input: session.input,
            tools: this.registry.toOpenAITools(),
            instructions: this.config.instructions,
            onDelta: appendDelta,
          });
        } catch (error) {
          if (this.completeAssistantStream(session, stream, { incomplete: true })) {
            await this.persist();
          }
          throw error;
        }

        const output = Array.isArray(response.output) ? response.output : [];
        session.input.push(...output);
        const calls = output.filter((item) => item.type === "function_call");
        const responseText = extractOutputText(response);
        const reasoningText = extractReasoningText(response);

        if (reasoningText && reasoningText !== stream.reasoning) {
          appendDelta({
            type: "reasoning",
            delta: reasoningText.startsWith(stream.reasoning)
              ? reasoningText.slice(stream.reasoning.length)
              : stream.reasoning
                ? ""
                : reasoningText,
          });
        }
        if (responseText && responseText !== stream.content) {
          appendDelta({
            type: "text",
            delta: responseText.startsWith(stream.content)
              ? responseText.slice(stream.content.length)
              : stream.content
                ? ""
                : responseText,
          });
        }

        if (calls.length === 0 && !stream.content) {
          appendDelta({ type: "text", delta: "模型没有返回可显示文本。" });
        }
        if (this.completeAssistantStream(session, stream)) await this.persist();

        if (calls.length === 0) return stream.content;

        for (const call of calls) {
          let argumentsValue;
          let result;
          let tool;
          let success = true;
          try {
            argumentsValue = parseArguments(call.arguments);
            tool = this.registry.get(call.name);
            if (!tool) throw new Error(`Unknown tool: ${call.name}`);

            this.eventHub.publish(sessionId, "tool.started", {
              callId: call.call_id,
              tool: { name: tool.name, displayName: tool.displayName, source: tool.source },
              arguments: argumentsValue,
            });

            if (!tool.readOnly) {
              const approved = await this.approvals.request(sessionId, tool, argumentsValue);
              if (!approved) throw new Error("Tool call was denied by the user");
            }
            result = await tool.execute(argumentsValue, { sessionId });
          } catch (error) {
            success = false;
            result = { error: error.message };
          }

          const outputText = stringifyToolResult(result);
          session.input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: outputText,
          });
          const toolMessage = {
            id: call.call_id,
            role: "tool",
            toolName: call.name,
            displayName: tool?.displayName ?? call.name,
            success,
            timestamp: now(),
          };
          session.messages.push(toolMessage);
          session.updatedAt = toolMessage.timestamp;
          await this.persist();
          this.eventHub.publish(sessionId, "tool.completed", {
            callId: call.call_id,
            toolName: call.name,
            displayName: toolMessage.displayName,
            success,
            result,
          });
        }
      }
      throw new Error(`Agent exceeded ${this.config.maxToolRounds ?? 12} tool rounds`);
    } catch (error) {
      this.eventHub.publish(sessionId, "agent.error", { message: error.message });
      throw error;
    } finally {
      session.running = false;
      session.updatedAt = now();
      await this.persist();
      this.publishSessionUpdate(session);
      this.eventHub.publish(sessionId, "agent.status", { state: "idle" });
    }
  }
}
