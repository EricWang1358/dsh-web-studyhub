import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apply as applyWorkbench } from "../lib/index.js";
import { contractOf, libraryContracts, studyToolDescription, studyUsagePrompt } from "../lib/study-contracts.js";
import { discoveryTool, domainTool } from "../lib/runtime/tools.js";
import { StudyService } from "../lib/service.js";

const DOMAIN_IDS = ["bank", "materials", "generation", "study", "audio"];

function registeredToolSpecs() {
  const core = { resolveWorkspace: async () => null, requestServices: async () => ({}), contextIds: () => [] };
  const workspace = {
    name: "study_workspace",
    description: studyToolDescription,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        payload_json: { type: "string", description: "JSON object of action arguments; omit for read actions" },
      },
      required: ["action"],
    },
    output: { schema: { type: "object", additionalProperties: true } },
  };
  return [workspace, ...DOMAIN_IDS.map((id) => domainTool(id, core)), discoveryTool(core)];
}

const serializedSpecLength = (tool) => JSON.stringify({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  output: { schema: tool.output.schema },
}).length;

test("actual registered Study prompts are short, discoverable and retain authorization boundaries", async (t) => {
  const registeredTools = [];
  const promptSections = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        registeredTools.push(definition);
        return () => {};
      },
    },
    sessions: {},
    systemPrompt: {
      section(section) {
        promptSections.push(section);
        return () => {};
      },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    },
    inject(deps, cb) {
      if (deps.every((dep) => dep in ctx)) cb(ctx);
      return { dispose() {} };
    },
  };
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
  });
  await applyWorkbench(ctx);

  const workspaceTool = registeredTools.find((tool) => tool.name === "study_workspace");
  assert.ok(workspaceTool, "apply(ctx) registers study_workspace tool");
  assert.equal(workspaceTool.description, studyToolDescription);

  const usageSection = promptSections.find((sec) => sec.name === "daily-flashcard:usage");
  assert.ok(usageSection, "apply(ctx) registers daily-flashcard:usage systemPrompt section");
  assert.equal(usageSection.order, 70);
  assert.equal(usageSection.text, studyUsagePrompt);
  // #891: resident studyToolDescription cut from 4,707 to ~1,998 chars; lock tight growth ceilings.
  assert.ok(studyToolDescription.length <= 2_200, `studyToolDescription (${studyToolDescription.length}) must stay <= 2,200 chars`);
  assert.ok(studyToolDescription.length + studyUsagePrompt.length <= 2_900, `resident prompt + usage (${studyToolDescription.length + studyUsagePrompt.length}) must stay <= 2,900 chars`);
  assert.match(studyToolDescription, /library\.context \{area:"index"\}/);
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
    /Never fabricate grades/, /API keys/, /AI course\/merge suggestions need confirmation/, /never broaden empty results/,
    // 学习模式 has file tools since 3.5.7 and the library lives in the workspace
    /StudyHub's own data \(\.dsh-study\/, \.dsh-study-binding\.json, a workspace's study-workspace\.json and the library folders beside it\) changes only through study_\* tools; never read, edit, move or delete it with shell or file tools/])
    assert.match(studyToolDescription, boundary);
  assert.doesNotMatch(studyToolDescription + studyUsagePrompt, /\{\{[^}]+\}\}/);
});

test("resident registered StudyHub tool specs stay within strict total character budget (#891)", () => {
  const tools = registeredToolSpecs();
  assert.deepEqual(tools.map((t) => t.name), [
    "study_workspace",
    "study_bank",
    "study_materials",
    "study_generate_selection",
    "study_practice",
    "study_audio",
    "study_capabilities",
  ]);
  const totalDescriptions = tools.reduce((sum, tool) => sum + tool.description.length, 0);
  const totalSpecsJson = tools.reduce((sum, tool) => sum + serializedSpecLength(tool), 0);
  // Pre-#891 baseline: totalDescriptions = 6,348 chars, totalSpecsJson = 11,791 chars (+ 939 usage = 12,730 chars).
  assert.ok(totalDescriptions <= 3_200, `resident tool descriptions (${totalDescriptions}) must stay <= 3,200 chars`);
  assert.ok(totalSpecsJson <= 8_800, `resident tool specs JSON (${totalSpecsJson}) must stay <= 8,800 chars`);
  assert.ok(totalSpecsJson + studyUsagePrompt.length <= 9_600, `resident tool specs + usage (${totalSpecsJson + studyUsagePrompt.length}) must stay <= 9,600 chars`);
});

test('library.context { area: "index" } serves the complete action directory on demand (#891)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-tool-prompt-index-"));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });

  const indexed = await service.call("library.context", { area: "index" });
  assert.equal(indexed.area, "index");
  assert.equal(indexed.areas[0], "index");
  assert.equal(indexed.contract, contractOf("index"));
  assert.equal(indexed.contract, libraryContracts.index);
  assert.ok(indexed.contract.length < 6_000, `index contract (${indexed.contract.length}) stays bounded`);

  const expanded = new Set(indexed.contract.match(/[a-z][a-zA-Z]*(?:\.[a-z][a-zA-Z]*)+(?:\/[a-z][a-zA-Z.]*)*/g)?.flatMap((token) => {
    const slash = token.indexOf("/");
    if (slash < 0) return [token];
    const head = token.slice(0, slash);
    const dot = head.lastIndexOf(".");
    const prefix = dot > 0 ? `${head.slice(0, dot)}.` : "";
    return [head, ...token.slice(slash + 1).split("/").map((part) => `${prefix}${part}`)];
  }) || []);

  for (const action of [
    "source.list", "search.content", "card.search", "card.convert", "card.grade", "case.drills",
    "supplement", "generate", "deck.import", "ingest", "mineru.import", "audio.import", "live.start",
    "review.start", "study.session.start", "course.plan", "course.custom.preview", "book.toc",
    "book.crunch", "note.list", "board.get", "skeleton.diagram.attach", "generation.companion.build",
    "job.control", "workflow.list",
  ]) {
    assert.ok(indexed.contract.includes(action) || expanded.has(action), `index contract lists ${action}`);
  }
});

test("Study tool description and SDK declarations render without introducing prompt variables", async (t) => {
  const local = createRequire(import.meta.url);
  let toolsPath;
  try { toolsPath = local.resolve("@deepseek-ai/dsh-tools"); }
  catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    t.skip("Optional DSH host SDK is not installed");
    return;
  }
  const host = createRequire(toolsPath);
  const { renderToolsSdk } = await import(pathToFileURL(toolsPath).href);
  const { renderPrompt } = await import(pathToFileURL(host.resolve("@deepseek-ai/dsh-system-prompt")).href);
  const text = studyToolDescription;
  const sdkText = renderToolsSdk(registeredToolSpecs().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: tool.output.schema,
  })));
  assert.ok(sdkText.length + studyUsagePrompt.length <= 10_000, `rendered SDK + usage (${sdkText.length + studyUsagePrompt.length}) must stay <= 10,000 chars`);
  const variables = { provider: "test", model: "test", cwd: "." };
  assert.throws(() => renderPrompt({ sections: [{ name: "tools:sdk", text: "{{id}}" }], variables }), /unknown prompt variable/);
  assert.equal(renderPrompt({ sections: [{ name: "tools:sdk", text }], variables }), text);
  assert.equal(renderPrompt({ sections: [{ name: "tools:sdk", text: sdkText }], variables }), sdkText);
  assert.equal(renderPrompt({ sections: [{ name: "daily-flashcard:usage", text: studyUsagePrompt }], variables }), studyUsagePrompt);
});
