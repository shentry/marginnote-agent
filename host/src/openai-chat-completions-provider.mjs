function isReasoningPart(part) {
  const type = String(part?.type ?? "").toLowerCase();
  return type.includes("reasoning") || type.includes("thinking");
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isReasoningPart(part)) return "";
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function reasoningToText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(reasoningToText).filter(Boolean).join("");
  }
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return reasoningToText(value.content);
  return "";
}

function contentReasoning(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && isReasoningPart(part))
    .map(reasoningToText)
    .filter(Boolean)
    .join("");
}

function messageReasoning(message) {
  return [
    reasoningToText(message?.reasoning_content),
    reasoningToText(message?.reasoning),
    reasoningToText(message?.thinking),
    contentReasoning(message?.content),
  ]
    .filter(Boolean)
    .join("");
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

function normalizedOutput({ id, text, reasoning, toolCalls, source = {} }) {
  const output = [];
  if (reasoning) {
    output.push({
      type: "reasoning",
      id: `${id ?? "chat_completion"}_reasoning`,
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  for (const [index, call] of toolCalls.entries()) {
    const callId = call.id || `${id ?? "chat_completion"}_${index + 1}`;
    output.push({
      type: "function_call",
      id: callId,
      call_id: callId,
      name: call.name,
      arguments: argumentsToString(call.arguments),
    });
  }
  return { ...source, id, output, output_text: text, reasoning_text: reasoning };
}

function normalizeResponse(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) throw new Error("OpenAI Chat Completions API returned no message");
  const text = contentToText(message.content).trim();
  const reasoning = messageReasoning(message).trim();
  const toolCalls = (message.tool_calls ?? [])
    .filter((call) => !call.type || call.type === "function")
    .map((call) => ({
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments,
    }));
  return normalizedOutput({ id: payload.id, text, reasoning, toolCalls, source: payload });
}

async function readEventStream(response, onPayload) {
  if (!response.body) throw new Error("OpenAI Chat Completions API returned no stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length === 0) return false;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return true;
    onPayload(JSON.parse(data));
    return false;
  };

  let done = false;
  while (!done) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) {
        if (dispatch()) {
          done = true;
          break;
        }
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (chunk.done) {
      if (buffer.trim()) {
        const line = buffer.trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      dispatch();
      break;
    }
  }
}

async function normalizeStream(response, onDelta) {
  let id = null;
  let text = "";
  let reasoning = "";
  const toolCalls = new Map();

  await readEventStream(response, (payload) => {
    id = payload.id ?? id;
    for (const choice of payload.choices ?? []) {
      const delta = choice.delta ?? {};
      const textDelta = contentToText(delta.content);
      const reasoningDelta = [
        reasoningToText(delta.reasoning_content),
        reasoningToText(delta.reasoning),
        reasoningToText(delta.thinking),
        contentReasoning(delta.content),
      ]
        .filter(Boolean)
        .join("");
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        onDelta?.({ type: "reasoning", delta: reasoningDelta });
      }
      if (textDelta) {
        text += textDelta;
        onDelta?.({ type: "text", delta: textDelta });
      }

      for (const [fallbackIndex, call] of (delta.tool_calls ?? []).entries()) {
        const index = call.index ?? fallbackIndex;
        const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        toolCalls.set(index, current);
      }
    }
  });

  return normalizedOutput({
    id,
    text: text.trim(),
    reasoning: reasoning.trim(),
    toolCalls: [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call),
  });
}

function errorMessage(payload, status) {
  return payload?.error?.message ?? payload?.raw ?? `HTTP ${status}`;
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
      streaming: true,
      apiKeyEnv,
      apiKeyConfigured: Boolean(process.env[apiKeyEnv]),
    };
  }

  async createResponse({ input, tools, instructions, onDelta }) {
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
      stream: true,
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
      if (!response.ok) {
        const text = await response.text();
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = { raw: text };
        }
        throw new Error(`OpenAI Chat Completions API error: ${errorMessage(payload, response.status)}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) return await normalizeStream(response, onDelta);

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      return normalizeResponse(payload);
    } finally {
      clearTimeout(timer);
    }
  }
}
