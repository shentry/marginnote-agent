import { randomUUID } from "node:crypto";

function parseArguments(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object") return value;
  return JSON.parse(value);
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

function stringifyToolResult(result) {
  if (typeof result === "string") return result;
  if (result === undefined) return "null";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export class AgentEngine {
  constructor({ provider, registry, eventHub, approvals, config }) {
    this.provider = provider;
    this.registry = registry;
    this.eventHub = eventHub;
    this.approvals = approvals;
    this.config = config;
    this.sessions = new Map();
  }

  createSession() {
    const id = randomUUID();
    const session = { id, input: [], messages: [], running: false, createdAt: new Date().toISOString() };
    this.sessions.set(id, session);
    return this.snapshot(id);
  }

  snapshot(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      messages: session.messages,
      running: session.running,
      createdAt: session.createdAt,
    };
  }

  async sendMessage(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.running) throw new Error("Session is already running");
    const content = String(text ?? "").trim();
    if (!content) throw new Error("Message is empty");

    session.running = true;
    session.messages.push({ role: "user", content, timestamp: new Date().toISOString() });
    session.input.push({ role: "user", content });
    this.eventHub.publish(sessionId, "user.message", { content });

    try {
      const maxRounds = this.config.maxToolRounds ?? 12;
      for (let round = 0; round < maxRounds; round += 1) {
        this.eventHub.publish(sessionId, "agent.status", {
          state: "thinking",
          round: round + 1,
        });
        const response = await this.provider.createResponse({
          input: session.input,
          tools: this.registry.toOpenAITools(),
          instructions: this.config.instructions,
        });
        const output = Array.isArray(response.output) ? response.output : [];
        session.input.push(...output);
        const calls = output.filter((item) => item.type === "function_call");

        if (calls.length === 0) {
          const finalText = extractOutputText(response) || "模型没有返回可显示文本。";
          session.messages.push({
            role: "assistant",
            content: finalText,
            timestamp: new Date().toISOString(),
          });
          this.eventHub.publish(sessionId, "assistant.message", { content: finalText });
          return finalText;
        }

        for (const call of calls) {
          let argumentsValue;
          let result;
          let success = true;
          try {
            argumentsValue = parseArguments(call.arguments);
            const tool = this.registry.get(call.name);
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
          this.eventHub.publish(sessionId, "tool.completed", {
            callId: call.call_id,
            toolName: call.name,
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
      this.eventHub.publish(sessionId, "agent.status", { state: "idle" });
    }
  }
}
