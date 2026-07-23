const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");

let sessionId;
let eventSource;
let running = false;

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function appendMessage(role, content) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  messages.append(node);
  scrollToBottom();
}

function appendEvent(text, className = "") {
  const node = document.createElement("div");
  node.className = `event-card ${className}`.trim();
  node.textContent = text;
  messages.append(node);
  scrollToBottom();
  return node;
}

function setRunning(value) {
  running = value;
  sendButton.disabled = value;
  input.disabled = value;
}

async function resolveApproval(approvalId, approved, card) {
  const response = await fetch(`/api/sessions/${sessionId}/approvals/${approvalId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  if (!response.ok) throw new Error((await response.json()).error || "审批提交失败");
  card.querySelectorAll("button").forEach((button) => (button.disabled = true));
}

function renderApproval(event) {
  const card = document.createElement("div");
  card.className = "event-card approval";
  const title = document.createElement("strong");
  title.textContent = `工具请求：${event.tool.displayName}`;
  const args = document.createElement("pre");
  args.textContent = JSON.stringify(event.arguments, null, 2);
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approve = document.createElement("button");
  approve.className = "approve";
  approve.textContent = "允许";
  const deny = document.createElement("button");
  deny.className = "deny";
  deny.textContent = "拒绝";
  approve.onclick = () => resolveApproval(event.approvalId, true, card).catch(showError);
  deny.onclick = () => resolveApproval(event.approvalId, false, card).catch(showError);
  actions.append(approve, deny);
  card.append(title, args, actions);
  messages.append(card);
  scrollToBottom();
}

function showError(error) {
  appendEvent(error.message || String(error), "error");
}

function connectEvents() {
  if (eventSource) eventSource.close();
  const source = new EventSource(`/api/sessions/${sessionId}/events`);
  eventSource = source;
  source.addEventListener("user.message", (raw) => {
    const event = JSON.parse(raw.data);
    appendMessage("user", event.content);
  });
  source.addEventListener("assistant.message", (raw) => {
    const event = JSON.parse(raw.data);
    appendMessage("assistant", event.content);
  });
  source.addEventListener("tool.started", (raw) => {
    const event = JSON.parse(raw.data);
    appendEvent(`调用工具：${event.tool.displayName}`);
  });
  source.addEventListener("tool.completed", (raw) => {
    const event = JSON.parse(raw.data);
    appendEvent(`${event.success ? "工具完成" : "工具失败"}：${event.toolName}`);
  });
  source.addEventListener("approval.required", (raw) => renderApproval(JSON.parse(raw.data)));
  source.addEventListener("agent.error", (raw) => {
    const event = JSON.parse(raw.data);
    appendEvent(event.message, "error");
  });
  source.addEventListener("agent.status", (raw) => {
    const event = JSON.parse(raw.data);
    setRunning(event.state !== "idle");
  });
  source.onerror = () => {
    if (source !== eventSource) return;
    statusText.textContent = "事件连接正在重试…";
  };
}

async function createSession() {
  const response = await fetch("/api/sessions", { method: "POST" });
  if (!response.ok) throw new Error("无法创建 Agent 会话");
  sessionId = (await response.json()).id;
  connectEvents();
}

async function sendMessage(content) {
  const send = () =>
    fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

  let response = await send();
  if (response.status === 404) {
    const payload = await response.json();
    if (payload.error === "Session not found") {
      await createSession();
      appendEvent("Host 已重启，已自动创建新会话");
      response = await send();
    } else {
      throw new Error(payload.error || "发送失败");
    }
  }
  if (!response.ok) throw new Error((await response.json()).error || "发送失败");
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    const model = status.provider?.model || status.provider?.type || "unknown";
    const mn = status.marginNote?.online ? "MarginNote 已连接" : "等待 MarginNote 插件";
    const mcpCount = Object.values(status.mcpServers || {}).filter(
      (server) => server.state === "connected",
    ).length;
    statusText.textContent = `${model} · ${mn} · ${mcpCount} 个 MCP 已连接`;
    statusDot.classList.toggle("online", Boolean(status.ok));
  } catch (error) {
    statusText.textContent = `Host 连接失败：${error.message}`;
    statusDot.classList.remove("online");
  }
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content || running) return;
  input.value = "";
  setRunning(true);
  try {
    await sendMessage(content);
  } catch (error) {
    setRunning(false);
    showError(error);
  }
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

async function boot() {
  await createSession();
  await refreshStatus();
  setInterval(refreshStatus, 3000);
  input.focus();
}

boot().catch(showError);
