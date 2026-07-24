import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FileSessionStore } from "../src/session-store.mjs";

test("file session store persists sessions atomically with private permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mn-agent-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "nested", "sessions.json");
  const store = new FileSessionStore({ filePath });
  const sessions = [
    {
      id: "session-1",
      title: "测试对话",
      input: [{ role: "user", content: "hello" }],
      messages: [{ role: "user", content: "hello" }],
      running: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  assert.deepEqual(await store.load(), []);
  await store.save(sessions);
  await store.flush();
  assert.deepEqual(await store.load(), sessions);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).version, 1);
});
