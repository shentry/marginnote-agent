export class OpenAIResponsesProvider {
  constructor(config) {
    this.config = config;
  }

  status() {
    const apiKeyEnv = this.config.apiKeyEnv ?? "OPENAI_API_KEY";
    return {
      type: "openai-responses",
      model: this.config.model,
      apiKeyEnv,
      apiKeyConfigured: Boolean(process.env[apiKeyEnv]),
    };
  }

  async createResponse({ input, tools, instructions }) {
    const apiKeyEnv = this.config.apiKeyEnv ?? "OPENAI_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`Missing API key environment variable: ${apiKeyEnv}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120_000);
    const body = {
      model: this.config.model,
      instructions,
      input,
      tools,
    };
    if (this.config.reasoningEffort) {
      body.reasoning = { effort: this.config.reasoningEffort };
    }

    try {
      const response = await fetch(`${String(this.config.baseUrl).replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) {
        const message = payload?.error?.message ?? payload.raw ?? `HTTP ${response.status}`;
        throw new Error(`OpenAI Responses API error: ${message}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}
