function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function argumentsToString(value) {
  if (typeof value === "string") return value || "{}";
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

function toChatTools(tools) {
  return (tools ?? []).map((tool) => {
    if (tool.function) return tool;
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      },
    };
  });
}

function toChatMessages(input, instructions) {
  const messages = [];
  if (String(instructions ?? "").trim()) {
    messages.push({ role: "system", content: String(instructions) });
  }

  let pendingAssistant = null;
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    if (!pendingAssistant.tool_calls?.length) {
      delete pendingAssistant.tool_calls;
      if (pendingAssistant.content === null) pendingAssistant.content = "";
    }
    messages.push(pendingAssistant);
    pendingAssistant = null;
  };

  for (const item of input ?? []) {
    if (!item || item.type === "reasoning") continue;

    if (item.type === "function_call") {
      if (!pendingAssistant) {
        pendingAssistant = { role: "assistant", content: null, tool_calls: [] };
      }
      pendingAssistant.tool_calls ??= [];
      pendingAssistant.tool_calls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: {
          name: item.name,
          arguments: argumentsToString(item.arguments),
        },
      });
      continue;
    }

    if (item.type === "function_call_output") {
      flushAssistant();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
      continue;
    }

    if (item.type === "message" || item.role) {
      const role = item.role ?? "assistant";
      const content = contentToText(item.content);
      if (role === "assistant") {
        flushAssistant();
        pendingAssistant = { role: "assistant", content: content || null };
      } else {
        flushAssistant();
        messages.push({ role, content });
      }
    }
  }

  flushAssistant();
  return messages;
}

function normalizeResponse(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) throw new Error("OpenAI Chat Completions API returned no message");

  const output = [];
  const text = contentToText(message.content).trim();
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }

  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    if (call.type && call.type !== "function") continue;
    output.push({
      type: "function_call",
      id: call.id ?? `${payload.id ?? "chat_completion"}_${index + 1}`,
      call_id: call.id ?? `${payload.id ?? "chat_completion"}_${index + 1}`,
      name: call.function?.name,
      arguments: argumentsToString(call.function?.arguments),
    });
  }

  return { ...payload, output, output_text: text };
}

export class OpenAIChatCompletionsProvider {
  constructor(config) {
    this.config = config;
  }

  status() {
    const apiKeyEnv = this.config.apiKeyEnv ?? "OPENAI_API_KEY";
    return {
      type: "openai-chat-completions",
      model: this.config.model,
      apiKeyEnv,
      apiKeyConfigured: Boolean(process.env[apiKeyEnv]),
    };
  }

  async createResponse({ input, tools, instructions }) {
    const apiKeyEnv = this.config.apiKeyEnv ?? "OPENAI_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`Missing API key environment variable: ${apiKeyEnv}`);
    if (!String(this.config.model ?? "").trim()) throw new Error("Missing provider model");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120_000);
    const chatTools = toChatTools(tools);
    const body = {
      model: this.config.model,
      messages: toChatMessages(input, instructions),
      stream: false,
    };
    if (chatTools.length > 0) {
      body.tools = chatTools;
      body.tool_choice = "auto";
    }

    try {
      const response = await fetch(
        `${String(this.config.baseUrl).replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) {
        const message = payload?.error?.message ?? payload.raw ?? `HTTP ${response.status}`;
        throw new Error(`OpenAI Chat Completions API error: ${message}`);
      }
      return normalizeResponse(payload);
    } finally {
      clearTimeout(timer);
    }
  }
}
