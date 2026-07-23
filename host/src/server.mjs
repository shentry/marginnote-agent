import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EventHub } from "./event-hub.mjs";
import { ApprovalManager } from "./approval-manager.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { MarginNoteBridge } from "./marginnote/bridge.mjs";
import { registerMarginNoteTools } from "./marginnote/tools.mjs";
import { McpManager } from "./mcp/manager.mjs";
import { OpenAIResponsesProvider } from "./openai-responses-provider.mjs";
import { OpenAIChatCompletionsProvider } from "./openai-chat-completions-provider.mjs";
import { AgentEngine } from "./agent-engine.mjs";

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const STATIC_FILES = new Map([
  ["/", ["app.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function readJson(request, limit = 1_048_576) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isAllowedOrigin(request, config) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const allowed = new Set([
    `http://${config.listen.host}:${config.listen.port}`,
    `http://127.0.0.1:${config.listen.port}`,
    `http://localhost:${config.listen.port}`,
  ]);
  return allowed.has(origin);
}

export function createProvider(config) {
  switch (config.type) {
    case "openai-chat-completions":
      return new OpenAIChatCompletionsProvider(config);
    case "openai-responses":
      return new OpenAIResponsesProvider(config);
    default:
      throw new Error(`Unsupported provider.type: ${config.type}`);
  }
}

export async function createHost({ config, provider: providerOverride, autoApprove = false }) {
  const eventHub = new EventHub();
  const bridge = new MarginNoteBridge(config.marginNote);
  const registry = new ToolRegistry();
  registerMarginNoteTools(registry, bridge);

  const mcpManager = new McpManager(config.mcpServers);
  await mcpManager.connectAll(registry);

  const provider = providerOverride ?? createProvider(config.provider);
  const approvals = new ApprovalManager({
    eventHub,
    timeoutMs: config.agent.approvalTimeoutMs,
    autoApprove,
  });
  const agent = new AgentEngine({
    provider,
    registry,
    eventHub,
    approvals,
    config: config.agent,
  });

  const server = http.createServer(async (request, response) => {
    try {
      if (!isAllowedOrigin(request, config)) {
        sendError(response, 403, "Origin is not allowed");
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

      if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
        const [fileName, contentType] = STATIC_FILES.get(url.pathname);
        const body = await readFile(path.join(WEB_ROOT, fileName));
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        response.end(body);
        return;
      }

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/status")) {
        sendJson(response, 200, {
          ok: true,
          provider: typeof provider.status === "function" ? provider.status() : { type: "custom" },
          marginNote: bridge.status(),
          mcpServers: mcpManager.snapshot(),
          toolCount: registry.list().length,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tools") {
        sendJson(
          response,
          200,
          registry.list().map((tool) => ({
            name: tool.name,
            displayName: tool.displayName,
            source: tool.source,
            description: tool.description,
            readOnly: tool.readOnly,
            destructive: tool.destructive,
          })),
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const session = agent.createSession();
        sendJson(response, 201, session);
        return;
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const session = agent.snapshot(sessionMatch[1]);
        if (!session) sendError(response, 404, "Session not found");
        else sendJson(response, 200, session);
        return;
      }

      const eventMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (request.method === "GET" && eventMatch) {
        if (!agent.snapshot(eventMatch[1])) {
          sendError(response, 404, "Session not found");
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write("retry: 1000\n\n");
        const afterId = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
        eventHub.subscribe(eventMatch[1], response, Number.isFinite(afterId) ? afterId : 0);
        return;
      }

      const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (request.method === "POST" && messageMatch) {
        if (!agent.snapshot(messageMatch[1])) {
          sendError(response, 404, "Session not found");
          return;
        }
        const body = await readJson(request);
        if (!String(body.content ?? "").trim()) {
          sendError(response, 400, "content is required");
          return;
        }
        void agent.sendMessage(messageMatch[1], body.content).catch(() => {});
        sendJson(response, 202, { accepted: true });
        return;
      }

      const approvalMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/,
      );
      if (request.method === "POST" && approvalMatch) {
        const body = await readJson(request);
        const resolved = approvals.resolve(approvalMatch[1], approvalMatch[2], body.approved);
        if (!resolved) sendError(response, 404, "Approval not found");
        else sendJson(response, 200, { resolved: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/marginnote/connect") {
        const body = await readJson(request);
        const clientId = String(body.clientId ?? "").trim();
        if (!clientId) {
          sendError(response, 400, "clientId is required");
          return;
        }
        bridge.touchClient(clientId, body.metadata ?? {});
        sendJson(response, 200, { connected: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/marginnote/next") {
        const clientId = String(url.searchParams.get("clientId") ?? "").trim();
        if (!clientId) {
          sendError(response, 400, "clientId is required");
          return;
        }
        const next = bridge.takeNext(clientId, { version: url.searchParams.get("version") ?? null });
        sendJson(response, 200, { request: next });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/marginnote/result") {
        const body = await readJson(request);
        const resolved = bridge.resolve(body.requestId, body);
        if (!resolved) sendError(response, 404, "Tool request not found");
        else sendJson(response, 200, { resolved: true });
        return;
      }

      sendError(response, 404, "Not found");
    } catch (error) {
      sendError(response, 500, error.message);
    }
  });

  return {
    config,
    server,
    agent,
    approvals,
    bridge,
    registry,
    mcpManager,
    provider,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.listen.port, config.listen.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      await mcpManager.close();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
