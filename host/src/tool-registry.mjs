import { createHash } from "node:crypto";

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
}

function compactName(value) {
  if (value.length <= 128) return value;
  const digest = createHash("sha1").update(value).digest("hex").slice(0, 10);
  return `${value.slice(0, 117)}_${digest}`;
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(definition) {
    const baseName = compactName(
      (definition.name ?? definition.nameParts?.map(sanitizeSegment).join("__") ?? "tool") || "tool",
    );
    let name = baseName;
    let suffix = 2;
    while (this.tools.has(name)) {
      name = compactName(`${baseName}_${suffix}`);
      suffix += 1;
    }

    const tool = {
      ...definition,
      name,
      displayName: definition.displayName ?? name,
      description: definition.description ?? "",
      inputSchema: definition.inputSchema ?? { type: "object", properties: {} },
      readOnly: definition.readOnly === true,
      destructive: definition.destructive === true,
    };
    if (typeof tool.execute !== "function") throw new Error(`Tool ${name} has no execute handler`);
    this.tools.set(name, tool);
    return tool;
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()];
  }

  toOpenAITools() {
    return this.list().map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }
}
