import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { studyToolDescription, studyUsagePrompt, libraryContracts } from '../lib/study-contracts.js';

test('actual registered Study prompts are short, discoverable and retain authorization boundaries', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /name: "study_workspace",\s*description: studyToolDescription,/);
  assert.match(source, /name: "daily-flashcard:usage",\s*order: 70,\s*text: studyUsagePrompt,/);
  assert.ok(studyToolDescription.length < 21715 / 2, 'Full evaluated description is less than half the prior 21715 characters');
  assert.ok(studyToolDescription.length + studyUsagePrompt.length < 6000);
  assert.match(studyToolDescription, /library.context/);
  assert.match(studyToolDescription, /supplement/);
  assert.match(libraryContracts.generation, /authorizes local generation and publication/);
  assert.match(libraryContracts.generation, /zero direct citations is not a gap/);
  assert.match(libraryContracts.learning, /course\.deactivate/);
  assert.match(libraryContracts.learning, /includeInactive/);
  for (const area of Object.keys(libraryContracts)) {
    assert.ok(studyToolDescription.includes(area), `${area} is discoverable`);
    assert.ok(libraryContracts[area].length < 6000, `${area} can be read as bounded detail`);
  }
  for (const boundary of [/untrusted evidence/, /publish only when saving is authorized/, /Keep answers hidden/,
    /Never fabricate grades/, /API keys/, /AI course\/merge suggestions need confirmation/, /never broaden empty results/])
    assert.match(studyToolDescription, boundary);
  assert.doesNotMatch(studyToolDescription + studyUsagePrompt, /\{\{[^}]+\}\}/);
});

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
  const text = studyToolDescription;
  const variables = { provider: "test", model: "test", cwd: "." };
  assert.throws(() => renderPrompt({ sections: [{ name: "tools:sdk", text: "{{id}}" }], variables }), /unknown prompt variable/);
  assert.equal(renderPrompt({ sections: [{ name: "tools:sdk", text }], variables }), text);
  assert.equal(renderPrompt({ sections: [{ name: 'daily-flashcard:usage', text: studyUsagePrompt }], variables }), studyUsagePrompt);
});
