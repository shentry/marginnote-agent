const objectSchema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const MARGINNOTE_TOOL_DEFINITIONS = [
  {
    key: "get_context",
    description: "读取 MarginNote 当前窗口的笔记本、文档、焦点笔记和 PDF 选区。",
    inputSchema: objectSchema({}),
    readOnly: true,
  },
  {
    key: "get_selection",
    description: "读取当前文档选中的文本以及当前文档标识。",
    inputSchema: objectSchema({}),
    readOnly: true,
  },
  {
    key: "list_notebooks",
    description: "列出 MarginNote 中的笔记本，用于确定目标 topicId。",
    inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
    readOnly: true,
  },
  {
    key: "search_notes",
    description: "按文本搜索 MarginNote 笔记或页面。返回命中的笔记标识和摘要。",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        scope: { type: "string", enum: ["topic", "all", "page"] },
        topicId: { type: "string" },
        titleOnly: { type: "boolean" },
        beginsWith: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["query"],
    ),
    readOnly: true,
  },
  {
    key: "get_note",
    description: "按 noteId 读取一条 MarginNote 笔记，包括标题、摘录、评论和子笔记标识。",
    inputSchema: objectSchema(
      {
        noteId: { type: "string", minLength: 1 },
        includeChildren: { type: "boolean" },
      },
      ["noteId"],
    ),
    readOnly: true,
  },
  {
    key: "create_note",
    description: "在指定或当前笔记本中新建笔记，可选挂到父笔记下。该操作支持 MarginNote Undo。",
    inputSchema: objectSchema(
      {
        title: { type: "string", minLength: 1 },
        topicId: { type: "string" },
        parentNoteId: { type: "string" },
        comment: { type: "string" },
        commentFormat: { type: "string", enum: ["text", "markdown"] },
      },
      ["title"],
    ),
    readOnly: false,
  },
  {
    key: "update_note",
    description: "修改 MarginNote 笔记的标题、摘录或颜色。该操作支持 MarginNote Undo。",
    inputSchema: objectSchema(
      {
        noteId: { type: "string", minLength: 1 },
        title: { type: "string" },
        excerptText: { type: "string" },
        colorIndex: { type: "integer", minimum: 0, maximum: 15 },
      },
      ["noteId"],
    ),
    readOnly: false,
  },
  {
    key: "append_comment",
    description: "向 MarginNote 笔记追加文本或 Markdown 评论。该操作支持 MarginNote Undo。",
    inputSchema: objectSchema(
      {
        noteId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        format: { type: "string", enum: ["text", "markdown"] },
      },
      ["noteId", "text"],
    ),
    readOnly: false,
  },
  {
    key: "focus_note",
    description: "在 MarginNote 脑图或文档中定位并高亮指定笔记。",
    inputSchema: objectSchema(
      {
        noteId: { type: "string", minLength: 1 },
        target: { type: "string", enum: ["mindmap", "document"] },
      },
      ["noteId"],
    ),
    readOnly: true,
  },
];

export function registerMarginNoteTools(registry, bridge) {
  return MARGINNOTE_TOOL_DEFINITIONS.map((definition) =>
    registry.register({
      nameParts: ["marginnote", definition.key],
      displayName: `MarginNote: ${definition.key}`,
      source: "marginnote",
      description: definition.description,
      inputSchema: definition.inputSchema,
      readOnly: definition.readOnly,
      destructive: false,
      execute: (argumentsValue) => bridge.call(definition.key, argumentsValue),
    }),
  );
}
