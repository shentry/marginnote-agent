const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const conversationButton = document.querySelector("#conversationButton");
const conversationTitle = document.querySelector("#conversationTitle");
const newConversationButton = document.querySelector("#newConversationButton");
const drawerNewConversationButton = document.querySelector("#drawerNewConversationButton");
const conversationDrawer = document.querySelector("#conversationDrawer");
const conversationList = document.querySelector("#conversationList");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const scrollBottomButton = document.querySelector("#scrollBottomButton");
const settingsMenuContainer = document.querySelector("#settingsMenuContainer");
const settingsMenuButton = document.querySelector("#settingsMenuButton");
const settingsMenu = document.querySelector("#settingsMenu");
const autoApproveButton = document.querySelector("#autoApproveButton");

let sessionId;
let eventSource;
let running = false;
let sessions = [];
let stickToBottom = true;
let autoApprove = true;
let sessionSyncTimer = null;
let sessionSyncInFlight = false;
const pendingUserMessages = [];
const renderedMessageIds = new Set();
const assistantNodes = new Map();
const toolCards = new Map();
const approvalCards = new Map();
let thinkingNode = null;

// ---------- Markdown 渲染(marked + DOMPurify,双库缺失时退回纯文本) ----------

const canRenderMarkdown = typeof window.marked !== "undefined" && typeof window.DOMPurify !== "undefined";
if (canRenderMarkdown) {
  window.marked.setOptions({ gfm: true, breaks: true });
}

function renderMarkdown(target, text) {
  if (!canRenderMarkdown) {
    target.textContent = text;
    return;
  }
  target.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text || ""), {
    ADD_ATTR: ["target"],
  });
  for (const link of target.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}

// ---------- 滚动:仅在用户位于底部时跟随 ----------

function isNearBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
}

function scrollToBottom(force = false) {
  if (!force && !stickToBottom) return;
  const apply = () => {
    if (force || stickToBottom) messages.scrollTop = messages.scrollHeight;
  };
  apply();
  requestAnimationFrame(apply);
}

messages.addEventListener("scroll", () => {
  stickToBottom = isNearBottom();
  scrollBottomButton.hidden = stickToBottom;
});

scrollBottomButton.addEventListener("click", () => {
  stickToBottom = true;
  scrollBottomButton.hidden = true;
  scrollToBottom(true);
});

// ---------- 消息渲染 ----------

function appendMessage(role, content, messageId) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  if (messageId) {
    const normalizedId = String(messageId);
    node.dataset.messageId = normalizedId;
    renderedMessageIds.add(normalizedId);
  }
  messages.append(node);
  scrollToBottom();
  return node;
}

function appendOptimisticUserMessage(content) {
  document.querySelector(".empty-state")?.remove();
  const node = appendMessage("user", content);
  pendingUserMessages.push({ content, node });
  showThinking();
  return node;
}

function acknowledgeUserMessage(event) {
  const messageId = event.messageId ? String(event.messageId) : null;
  if (messageId && renderedMessageIds.has(messageId)) return true;

  const index = pendingUserMessages.findIndex((pending) => pending.content === event.content);
  if (index < 0) return false;
  const [pending] = pendingUserMessages.splice(index, 1);
  if (messageId) {
    pending.node.dataset.messageId = messageId;
    renderedMessageIds.add(messageId);
  }
  return true;
}

function appendEvent(text, className = "") {
  const node = document.createElement("div");
  node.className = `event-card ${className}`.trim();
  node.textContent = text;
  messages.append(node);
  scrollToBottom();
  return node;
}

function showThinking() {
  if (thinkingNode) return;
  thinkingNode = document.createElement("div");
  thinkingNode.className = "thinking";
  thinkingNode.innerHTML = "<span></span><span></span><span></span>";
  messages.append(thinkingNode);
  scrollToBottom();
}

function hideThinking() {
  thinkingNode?.remove();
  thinkingNode = null;
}

function createAssistantNode(messageId) {
  hideThinking();
  const node = document.createElement("div");
  node.className = "message assistant streaming";
  node.dataset.messageId = messageId;

  const reasoning = document.createElement("details");
  reasoning.className = "reasoning";
  reasoning.hidden = true;
  const reasoningTitle = document.createElement("summary");
  reasoningTitle.textContent = "思考过程";
  const reasoningContent = document.createElement("div");
  reasoningContent.className = "reasoning-content";
  reasoning.append(reasoningTitle, reasoningContent);

  const content = document.createElement("div");
  content.className = "assistant-content";
  node.append(reasoning, content);
  messages.append(node);

  const parts = { node, reasoning, reasoningContent, content, rawText: "", rawReasoning: "", renderQueued: false };
  assistantNodes.set(messageId, parts);
  scrollToBottom();
  return parts;
}

function ensureAssistantNode(messageId) {
  return assistantNodes.get(messageId) ?? createAssistantNode(messageId);
}

function appendAssistantDelta(messageId, type, delta) {
  const parts = ensureAssistantNode(messageId);
  if (type === "reasoning") {
    parts.reasoning.hidden = false;
    parts.reasoning.open = true;
    parts.rawReasoning += delta;
    parts.reasoningContent.textContent = parts.rawReasoning;
  } else {
    parts.rawText += delta;
    if (!parts.renderQueued) {
      parts.renderQueued = true;
      requestAnimationFrame(() => {
        parts.renderQueued = false;
        renderMarkdown(parts.content, parts.rawText);
        scrollToBottom();
      });
    }
  }
  scrollToBottom();
}

function completeAssistantMessage(message) {
  const messageId = message.messageId || message.id;
  const parts = ensureAssistantNode(messageId);
  parts.node.classList.remove("streaming");
  parts.node.classList.toggle("incomplete", Boolean(message.incomplete));
  parts.rawText = message.content || "";
  parts.rawReasoning = message.reasoning || "";
  renderMarkdown(parts.content, parts.rawText);
  parts.reasoningContent.textContent = parts.rawReasoning;
  parts.reasoning.hidden = !message.reasoning;
  if (message.reasoning) parts.reasoning.open = false;
  scrollToBottom();
}

// ---------- 工具卡片:调用中 → 完成/失败,同一张卡片原地更新 ----------

function createToolCard(callId, displayName) {
  hideThinking();
  const card = document.createElement("div");
  card.className = "event-card tool running";
  const status = document.createElement("span");
  status.className = "tool-status";
  const label = document.createElement("span");
  label.textContent = displayName;
  card.append(status, label);
  messages.append(card);
  if (callId) toolCards.set(callId, card);
  scrollToBottom();
  return card;
}

function completeToolCard(message) {
  const label = message.displayName || message.toolName;
  let card = message.callId ? toolCards.get(message.callId) : null;
  if (!card) card = createToolCard(message.callId, label);
  card.classList.remove("running");
  card.classList.toggle("error", !message.success);
  card.replaceChildren();
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = message.success ? "✓" : "✕";
  const text = document.createElement("span");
  text.textContent = `${label}${message.success ? "" : " · 失败"}`;
  card.append(status, text);
  scrollToBottom();
}

function renderSnapshot(snapshot) {
  messages.replaceChildren();
  assistantNodes.clear();
  toolCards.clear();
  approvalCards.clear();
  pendingUserMessages.length = 0;
  renderedMessageIds.clear();
  thinkingNode = null;
  const list = snapshot.messages ?? [];
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "开始新对话:询问当前文档、搜索笔记,或让 Agent 调用 MCP 工具。";
    messages.append(empty);
  }
  for (const message of list) {
    if (message.role === "user") appendMessage("user", message.content, message.id);
    else if (message.role === "assistant") completeAssistantMessage(message);
    else if (message.role === "tool")
      completeToolCard({ ...message, callId: message.id });
  }
  stickToBottom = true;
  scrollBottomButton.hidden = true;
  scrollToBottom(true);
  if (snapshot.running) showThinking();
}

// ---------- 运行状态 ----------

function setRunning(value) {
  running = value;
  sendButton.disabled = value;
  sendButton.textContent = value ? "思考中…" : "发送";
  newConversationButton.disabled = value;
  drawerNewConversationButton.disabled = value;
  if (!value) {
    hideThinking();
    stopSessionMonitor();
  }
  renderConversationList();
}

// ---------- 对话列表抽屉 ----------

function setDrawerOpen(open) {
  conversationDrawer.hidden = !open;
  drawerBackdrop.hidden = !open;
  conversationButton.setAttribute("aria-expanded", String(open));
}

function formatUpdatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderConversationList() {
  conversationList.replaceChildren();
  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.classList.toggle("active", session.id === sessionId);
    button.disabled = running && session.id !== sessionId;

    const title = document.createElement("strong");
    title.textContent = session.title || "新对话";
    const meta = document.createElement("span");
    meta.textContent = formatUpdatedAt(session.updatedAt);
    button.append(title, meta);
    button.onclick = () => selectSession(session.id).catch(showError);
    conversationList.append(button);
  }
}

function updateCurrentTitle() {
  const current = sessions.find((session) => session.id === sessionId);
  conversationTitle.textContent = current?.title || "新对话";
}

async function refreshSessions() {
  const response = await fetch("/api/sessions");
  if (!response.ok) throw new Error("无法读取对话列表");
  sessions = (await response.json()).sessions ?? [];
  updateCurrentTitle();
  renderConversationList();
  return sessions;
}

// ---------- 设置 ----------

function renderAutoApprove(value) {
  autoApprove = Boolean(value);
  autoApproveButton.setAttribute("aria-checked", String(autoApprove));
}

function setSettingsMenuOpen(open) {
  settingsMenu.hidden = !open;
  settingsMenuButton.setAttribute("aria-expanded", String(open));
}

async function refreshSettings() {
  const response = await fetch("/api/settings");
  if (!response.ok) throw new Error("无法读取 Agent 设置");
  const settings = await response.json();
  renderAutoApprove(settings.autoApprove);
  return settings;
}

async function updateAutoApprove(value) {
  autoApproveButton.disabled = true;
  try {
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoApprove: value }),
    });
    const settings = await response.json();
    if (!response.ok) throw new Error(settings.error || "无法更新 Agent 设置");
    renderAutoApprove(settings.autoApprove);
  } finally {
    autoApproveButton.disabled = false;
  }
}

// ---------- 审批 ----------

async function resolveApproval(approvalId, approved, card) {
  const buttons = card.querySelectorAll("button");
  buttons.forEach((button) => (button.disabled = true));
  try {
    const response = await fetch(`/api/sessions/${sessionId}/approvals/${approvalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "审批提交失败");
    markApprovalResolved(approvalId, approved, card);
  } catch (error) {
    buttons.forEach((button) => (button.disabled = false));
    throw error;
  }
}

function markApprovalResolved(approvalId, approved, card = approvalCards.get(approvalId)) {
  if (!card) return;
  const actions = card.querySelector(".approval-actions");
  if (!actions) return;
  const result = document.createElement("span");
  result.className = `approval-result ${approved ? "approved" : "denied"}`;
  result.textContent = approved ? "已允许" : "已拒绝";
  actions.replaceChildren(result);
  card.querySelectorAll("button").forEach((button) => (button.disabled = true));
  card.classList.add("resolved");
  approvalCards.delete(approvalId);
}

function renderApproval(event) {
  hideThinking();
  const card = document.createElement("div");
  card.className = "event-card approval";
  const title = document.createElement("strong");
  title.textContent = `工具请求:${event.tool.displayName}`;
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
  approvalCards.set(event.approvalId, card);
  messages.append(card);
  scrollToBottom();
}

function showError(error) {
  appendEvent(error.message || String(error), "error");
}

// ---------- SSE ----------

function connectEvents(afterId = 0) {
  if (eventSource) eventSource.close();
  const source = new EventSource(`/api/sessions/${sessionId}/events?after=${afterId}`);
  eventSource = source;
  source.addEventListener("user.message", (raw) => {
    const event = JSON.parse(raw.data);
    if (!acknowledgeUserMessage(event)) {
      document.querySelector(".empty-state")?.remove();
      appendMessage("user", event.content, event.messageId);
    }
    showThinking();
  });
  source.addEventListener("assistant.stream.started", (raw) => {
    const event = JSON.parse(raw.data);
    ensureAssistantNode(event.messageId);
  });
  source.addEventListener("assistant.text.delta", (raw) => {
    const event = JSON.parse(raw.data);
    appendAssistantDelta(event.messageId, "text", event.delta);
  });
  source.addEventListener("assistant.reasoning.delta", (raw) => {
    const event = JSON.parse(raw.data);
    appendAssistantDelta(event.messageId, "reasoning", event.delta);
  });
  source.addEventListener("assistant.stream.completed", (raw) => {
    const event = JSON.parse(raw.data);
    completeAssistantMessage(event);
  });
  source.addEventListener("tool.started", (raw) => {
    const event = JSON.parse(raw.data);
    createToolCard(event.callId, event.tool.displayName);
  });
  source.addEventListener("tool.completed", (raw) => completeToolCard(JSON.parse(raw.data)));
  source.addEventListener("approval.required", (raw) => renderApproval(JSON.parse(raw.data)));
  source.addEventListener("approval.resolved", (raw) => {
    const event = JSON.parse(raw.data);
    markApprovalResolved(event.approvalId, event.approved);
  });
  source.addEventListener("agent.error", (raw) => {
    const event = JSON.parse(raw.data);
    hideThinking();
    appendEvent(event.message, "error");
  });
  source.addEventListener("session.updated", (raw) => {
    const event = JSON.parse(raw.data);
    const index = sessions.findIndex((session) => session.id === event.session.id);
    if (index >= 0) sessions[index] = event.session;
    else sessions.unshift(event.session);
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    updateCurrentTitle();
    renderConversationList();
  });
  source.addEventListener("agent.status", (raw) => {
    const event = JSON.parse(raw.data);
    const isRunning = event.state !== "idle";
    setRunning(isRunning);
    if (isRunning) startSessionMonitor();
    else {
      stopSessionMonitor();
      syncCurrentSession(true).catch(() => {});
      refreshSessions().catch(() => {});
    }
  });
  source.onopen = () => refreshStatus();
  source.onerror = () => {
    if (source !== eventSource) return;
    statusText.textContent = "事件连接正在重试…";
    statusDot.classList.remove("online");
  };
}

// ---------- 会话 ----------

function stopSessionMonitor() {
  if (sessionSyncTimer) {
    clearInterval(sessionSyncTimer);
    sessionSyncTimer = null;
  }
}

function startSessionMonitor() {
  if (sessionSyncTimer || !sessionId) return;
  sessionSyncTimer = setInterval(() => {
    syncCurrentSession().catch(() => {});
  }, 1_000);
}

async function syncCurrentSession(force = false) {
  if (!sessionId || (!running && !force) || sessionSyncInFlight) return null;
  sessionSyncInFlight = true;
  try {
    const response = await fetch(`/api/sessions/${sessionId}`);
    if (!response.ok) return null;
    const snapshot = await response.json();
    if (snapshot.id !== sessionId) return null;
    if (force || !snapshot.running) {
      renderSnapshot(snapshot);
      setRunning(Boolean(snapshot.running));
      updateCurrentTitle();
      renderConversationList();
    }
    if (!snapshot.running) stopSessionMonitor();
    return snapshot;
  } finally {
    sessionSyncInFlight = false;
  }
}

async function selectSession(nextSessionId) {
  if (running && nextSessionId !== sessionId) return;
  stopSessionMonitor();
  const response = await fetch(`/api/sessions/${nextSessionId}`);
  if (!response.ok) throw new Error((await response.json()).error || "无法打开对话");
  const snapshot = await response.json();
  sessionId = snapshot.id;
  localStorage.setItem("mn-agent-active-session", sessionId);
  renderSnapshot(snapshot);
  setRunning(Boolean(snapshot.running));
  updateCurrentTitle();
  renderConversationList();
  setDrawerOpen(false);
  connectEvents(snapshot.lastEventId ?? 0);
  if (snapshot.running) startSessionMonitor();
  input.focus();
}

async function createSession() {
  if (running) return null;
  const response = await fetch("/api/sessions", { method: "POST" });
  if (!response.ok) throw new Error("无法创建 Agent 对话");
  const session = await response.json();
  await refreshSessions();
  await selectSession(session.id);
  return session;
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
      appendEvent("Host 已重启,已自动创建新对话");
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
    statusText.textContent = `Host 连接失败:${error.message}`;
    statusDot.classList.remove("online");
  }
}

// ---------- 输入区 ----------

function autoResizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

input.addEventListener("input", autoResizeInput);

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content || running) return;
  input.value = "";
  autoResizeInput();
  appendOptimisticUserMessage(content);
  setRunning(true);
  stickToBottom = true;
  startSessionMonitor();
  try {
    await sendMessage(content);
    startSessionMonitor();
  } catch (error) {
    setRunning(false);
    input.value = content;
    autoResizeInput();
    input.focus();
    showError(error);
  }
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

conversationButton.addEventListener("click", () => {
  setSettingsMenuOpen(false);
  setDrawerOpen(conversationDrawer.hidden);
});
drawerBackdrop.addEventListener("click", () => setDrawerOpen(false));
newConversationButton.addEventListener("click", () => createSession().catch(showError));
drawerNewConversationButton.addEventListener("click", () => createSession().catch(showError));
settingsMenuButton.addEventListener("click", () => {
  const open = settingsMenu.hidden;
  setDrawerOpen(false);
  setSettingsMenuOpen(open);
});
autoApproveButton.addEventListener("click", () => {
  updateAutoApprove(!autoApprove)
    .then(() => setSettingsMenuOpen(false))
    .catch(showError);
});
document.addEventListener("click", (event) => {
  if (!settingsMenu.hidden && !settingsMenuContainer.contains(event.target)) {
    setSettingsMenuOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setDrawerOpen(false);
    setSettingsMenuOpen(false);
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshStatus();
    refreshSettings().catch(() => {});
  }
});

async function boot() {
  await refreshSessions();
  const remembered = localStorage.getItem("mn-agent-active-session");
  const initial = sessions.some((session) => session.id === remembered) ? remembered : sessions[0]?.id;
  if (initial) await selectSession(initial);
  else await createSession();
  await refreshSettings();
  await refreshStatus();
  setInterval(refreshStatus, 5000);
  input.focus();
}

boot().catch(showError);
