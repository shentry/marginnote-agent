# MarginNote Agent

MarginNote 4 macOS 插件与本地 Agent Host。Host 可以连接多个 stdio MCP Server，并把 MarginNote 原生能力作为同一套函数工具交给模型调用。

## 当前能力

- MarginNote 内嵌聊天面板。
- OpenAI 兼容的 Chat Completions Agent 循环，默认请求 `/v1/chat/completions`；模型可在配置或环境变量中覆盖。
- 多个 stdio MCP Server 的 `initialize`、`tools/list` 与 `tools/call`。
- MarginNote 工具：
  - `get_context`
  - `get_selection`
  - `list_notebooks`
  - `search_notes`
  - `get_note`
  - `create_note`
  - `update_note`
  - `append_comment`
  - `focus_note`
- 数据写工具在聊天面板中逐次审批，并通过 MarginNote `UndoManager` 执行。

## 运行

要求：macOS、MarginNote 4、Node.js 20 或更高版本。

```bash
cd /Users/zxy/agentchaos/marginnote-agent
cp config.example.json config.json
export MN_AGENT_API_KEY="你的 API Key"
export MN_AGENT_MODEL="服务端支持的模型名"
npm start
```

Host 默认监听 `http://127.0.0.1:42117`，模型服务使用 `http://143.198.115.0:18317/v1/chat/completions`。API Key 只存在于 Host 进程环境中，不会进入配置文件、`.mnaddon` 或 WebView。

## 配置 MCP

在 `config.json` 的 `mcpServers` 中添加 stdio Server：

```json
{
  "mcpServers": {
    "my-server": {
      "transport": "stdio",
      "command": "/absolute/path/to/server",
      "args": ["--stdio"],
      "env": {
        "EXAMPLE_TOKEN": "通过本地安全方式填写"
      }
    }
  }
}
```

首版只实现 stdio transport。某个 MCP 启动失败不会阻止 Host 启动，错误会出现在 `/api/status`。

## 构建并安装插件

```bash
npm run build:addon
npm run verify:addon
```

生成文件：`dist/marginnote-agent.mnaddon`。在 MarginNote 中安装并启用后，工具栏会出现 Agent 图标。Host 必须保持运行。

## 验证

```bash
npm run verify
```

验证内容包括：Agent 工具循环、stdio MCP 握手与调用、MarginNote RPC 队列、Host HTTP 接口和 `.mnaddon` 包结构。

## 目录

```text
addon/       MarginNote JavaScriptCore 插件
host/src/    Agent、MCP Client、本地 HTTP 服务和聊天页面
host/test/   无外部服务依赖的自动化测试
scripts/     插件打包与校验
```

## 当前边界

- 仅支持 MarginNote 4 macOS。
- 模型响应暂不做逐 token 流式展示；工具状态和最终消息通过 SSE 实时更新。
- MCP 暂不支持 Streamable HTTP、OAuth、resources、prompts、sampling 和 elicitation。
- 插件没有删除笔记工具。
