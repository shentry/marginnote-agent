# 架构

```text
MarginNote Addon (JavaScriptCore + UIWebView)
  ├─ 加载 Host 提供的聊天页面
  ├─ 轮询待执行的 MarginNote 工具请求
  └─ Database / SearchManager / StudyController / UndoManager
                         ↕ HTTP JSON
MarginNote Agent Host (Node.js)
  ├─ AgentEngine
  ├─ ApprovalManager
  ├─ MarginNoteBridge
  ├─ ToolRegistry
  ├─ OpenAI Chat Completions / Responses Provider
  └─ McpManager
       ├─ stdio MCP A
       └─ stdio MCP B
```

## 工具路由

1. 启动时，Host 注册固定的 MarginNote 工具。
2. `McpManager` 连接配置中的 MCP Server，调用 `tools/list` 并注册返回工具。
3. `ToolRegistry` 为所有工具生成符合模型函数命名限制的唯一名称。
4. Provider 将模型工具调用统一为内部 `function_call`，`AgentEngine` 根据名称查找工具。
5. 非只读工具先等待聊天 UI 审批。
6. MCP 工具直接通过 stdio 调用；MarginNote 工具进入 `MarginNoteBridge` 队列。
7. Addon 取出请求，在 MarginNote 主线程执行并回传结果。
8. Host 将 `function_call_output` 交给 Provider；Chat Completions Provider 会转换为 `role: "tool"` 消息后发起下一轮请求。

## 安全边界

- Host 只绑定 `127.0.0.1`。
- 浏览器请求只允许本机同源 Origin；MarginNote 原生请求不带 Origin。
- API Key 不发送到插件或聊天页面。
- MarginNote 写操作默认需要逐次批准。
- 删除笔记不在首版工具集中。
