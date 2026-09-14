import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

test("Study tool description renders without introducing prompt variables", async (t) => {
  const local = createRequire(import.meta.url);
  let toolsPath;
  try { toolsPath = local.resolve("@deepseek-ai/dsh-tools"); }
  catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    t.skip("Optional DSH host SDK is not installed");
    return;
  }
  const host = createRequire(toolsPath);
  const { renderPrompt } = await import(pathToFileURL(host.resolve("@deepseek-ai/dsh-system-prompt")).href);
  const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const match = source.match(/name: "study_workspace",\s*description:\s*("(?:[^"\\]|\\.)*")/);
  assert.ok(match, "Find the registered Study tool description");
  const text = JSON.parse(match[1]);
  const variables = { provider: "test", model: "test", cwd: "." };
  assert.throws(() => renderPrompt({ sections: [{ name: "tools:sdk", text: "{{id}}" }], variables }), /unknown prompt variable/);
  assert.equal(renderPrompt({ sections: [{ name: "tools:sdk", text }], variables }), text);
});
