import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCliOutput,
  validateCallArguments,
} from "../src/mcp/lark-cli-server.mjs";

test("lark MCP adapter validates allowed business commands", () => {
  assert.deepEqual(validateCallArguments(["calendar", "+agenda"]), ["calendar", "+agenda"]);
  assert.throws(() => validateCallArguments(["auth", "logout"]), /Unsupported/);
  assert.throws(() => validateCallArguments(["drive", "+delete", "--yes"]), /--yes/);
});

test("lark MCP adapter parses JSON and text output", () => {
  assert.deepEqual(parseCliOutput('{"ok":true}').value, { ok: true });
  assert.equal(parseCliOutput("plain text").value, "plain text");
});
