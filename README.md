# MarginNote Agent

MarginNote 4 macOS 插件与本地 Agent Host。Host 可以连接多个 stdio MCP Server，并把 MarginNote 原生能力作为同一套函数工具交给模型调用。

## 当前能力

- MarginNote 右侧停靠聊天侧栏，显示时同步缩窄文档区域。
- 本地持久化多对话，可在面板顶部新建和切换，Host 重启后仍保留。
- Chat Completions 文本流式输出；服务端返回思考字段时显示可折叠的思考过程。
- OpenAI 兼容的 Chat Completions Agent 循环，默认请求 `/v1/chat/completions`；模型可在配置或环境变量中覆盖。
- 多个 stdio MCP Server 的 `initialize`、`tools/list` 与 `tools/call`。
- MarginNote 工具：
  - `get_context`
  - `get_selection`
  - `read_pdf`
  - `list_notebooks`
  - `search_notes`
  - `get_note`
  - `create_note`
  - `update_note`
  - `append_comment`
  - `focus_note`
- 工具调用默认自动执行，不弹出审批；MarginNote 写操作仍通过 `UndoManager` 执行。

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

### 随 MarginNote 自动启停

执行一次下面的命令，会安装当前 macOS 用户的 `launchd` 启动项：

```bash
npm run install:launch-agent
```

启动项会持续观察 MarginNote 4 进程：打开 MarginNote 后自动启动 Host，关闭 MarginNote 后只向它自己启动的 Host 发送 `SIGTERM`。它不会关闭占用 `42117` 的其他进程，也不会把 API Key 写入启动项；Host 仍从项目根目录的 `.env` 读取密钥。日志位于 `~/Library/Logs/MarginNote Agent/`。

`agent.autoApprove` 默认为 `true`，所有工具调用会直接执行。设为 `false` 可恢复聊天面板中的逐次审批。

对话默认保存在 `~/Library/Application Support/MarginNote Agent/sessions.json`，可用 `MN_AGENT_SESSION_FILE` 覆盖路径。文件权限为仅当前用户可读写；其中包含聊天内容和 Agent 已读取的工具上下文，不包含 API Key。

侧栏顶部会显示按请求内容估算的上下文窗口用量。达到 `agent.contextWindowTokens`（默认 `500000`）时，Host 会自动压缩最早的完整对话轮次；可见聊天记录保留不变，压缩摘要继续作为后续模型请求的背景上下文。

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
- 思考内容只显示兼容接口实际返回的 `reasoning_content`、`reasoning` 或 `thinking`，接口不返回时不显示。
- PDF 工具按页读取文本层或 MarginNote 已缓存的 OCR 文本，不主动执行新的 OCR。
- MCP 暂不支持 Streamable HTTP、OAuth、resources、prompts、sampling 和 elicitation。
- 插件没有删除笔记工具。
