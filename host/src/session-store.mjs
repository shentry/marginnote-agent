import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return structuredClone(value ?? []);
}

export class MemorySessionStore {
  constructor(initialSessions = []) {
    this.sessions = clone(initialSessions);
  }

  async load() {
    return clone(this.sessions);
  }

  async save(sessions) {
    this.sessions = clone(sessions);
  }

  async flush() {}
}

export class FileSessionStore {
  constructor({ filePath }) {
    if (!String(filePath ?? "").trim()) throw new Error("Missing session store file path");
    this.filePath = path.resolve(filePath);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const payload = JSON.parse(await readFile(this.filePath, "utf8"));
      return clone(Array.isArray(payload) ? payload : payload.sessions);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error(`Failed to load sessions: ${error.message}`);
    }
  }

  async save(sessions) {
    const body = `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`;
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    await this.writeQueue;
  }

  async flush() {
    await this.writeQueue;
  }
}
