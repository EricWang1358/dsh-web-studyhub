import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubSecrets, secretEnvNames } from "../scripts/qa/env.mjs";
import { findChromium } from "../scripts/qa/browser.mjs";
import { parseJourneyArgs, JOURNEY_STEPS } from "../scripts/qa/journey.mjs";
import { dshPatch } from "../scripts/qa/dsh-e2e.mjs";
import { createFakeOpenAI, FAKE_OPENAI_MODEL } from "../scripts/qa/fake-openai.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));

test("scrubSecrets removes every key, token, secret and base-url variable and keeps the rest", () => {
  const secrets = ["DEEPSEEK_API_KEY", "VISION_API_KEY", "KIMI_CODING_API_KEY", "OPENCODE_GO_API_KEY", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_MESSAGING_TOKEN", "GITHUB_TOKEN", "OPENAI_BASE_URL", "openai_api_key", "GROQ_API_KEY", "GEMINI_FREE_API_KEY",
    "GEMINI_PAID_API_KEY", "STUDY_API_KEY", "STUDY_BASE_URL", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "HF_TOKEN", "ANTHROPIC_AUTH_TOKEN",
    "SILICONFLOW_API_KEY", "AZURE_OPENAI_APIKEY", "DB_PASSWORD", "GOOGLE_APPLICATION_CREDENTIALS", "npm_config__auth"];
  const keep = { PATH: "C:/bin", Path: "C:/bin", SystemRoot: "C:/Windows", LOCALAPPDATA: "C:/l", APPDATA: "C:/a", TEMP: "C:/t",
    USERPROFILE: "C:/u", ComSpec: "cmd.exe", PATHEXT: ".EXE", NODE_OPTIONS: "", DSH_HOME: "C:/h", SSH_TTY: "audit", LANG: "C" };
  const env = { ...keep, ...Object.fromEntries(secrets.map((name) => [name, "secret-value"])) };
  const clean = scrubSecrets(env);
  assert.deepEqual(clean, keep);
  assert.deepEqual(secretEnvNames(env).sort(), [...secrets].sort());
  assert.equal(env.DEEPSEEK_API_KEY, "secret-value", "the input is not modified");
});

test("findChromium prefers PLAYWRIGHT_CHROMIUM, then the newest installed Playwright Chromium", async (t) => {
  const base = join(repo, "output", "test-wp0");
  await mkdir(base, { recursive: true });
  const local = await mkdtemp(join(base, "browsers-"));
  t.after(() => rm(local, { recursive: true, force: true }));
  for (const build of ["chromium-1091", "chromium-1234"]) {
    await mkdir(join(local, "ms-playwright", build, "chrome-win64"), { recursive: true });
    await writeFile(join(local, "ms-playwright", build, "chrome-win64", "chrome.exe"), "");
  }
  await mkdir(join(local, "ms-playwright", "chromium-1300"), { recursive: true }); // incomplete download
  await mkdir(join(local, "ms-playwright", "chromium_headless_shell-1400", "chrome-win64"), { recursive: true });
  assert.equal(await findChromium({ LOCALAPPDATA: local }), join(local, "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe"));
  const custom = join(local, "ms-playwright", "chromium-1091", "chrome-win64", "chrome.exe");
  assert.equal(await findChromium({ LOCALAPPDATA: local, PLAYWRIGHT_CHROMIUM: custom }), custom);
  assert.equal(await findChromium({ LOCALAPPDATA: join(local, "missing") }), null);
});

test("journey options: language, theme, width, steps and output folder", () => {
  // The core loop comes first, in order; work packages append their own step sets (WP6: audio).
  assert.deepEqual(JOURNEY_STEPS.map((step) => step.name).slice(0, 11), ["empty-home", "add-material", "import-files", "sources", "generate",
    "job-progress", "draft", "publish", "practice", "wrongbook", "settings"]);
  for (const name of ["audio-gate", "audio-settings", "audio-import", "audio-long", "live-gate"]) assert.ok(JOURNEY_STEPS.some((step) => step.name === name), name);
  assert.ok(JOURNEY_STEPS.every((step) => typeof step.run === "function"));
  const defaults = parseJourneyArgs([]);
  assert.equal(defaults.lang, "zh");
  assert.equal(defaults.theme, "dark");
  assert.equal(defaults.width, 1440);
  assert.deepEqual(defaults.steps, JOURNEY_STEPS.map((step) => step.name));
  assert.equal(defaults.out, resolve(repo, "output/qa/journey/zh-dark-1440"));
  assert.equal(defaults.port, 0);
  const custom = parseJourneyArgs(["--lang", "en", "--theme=light", "--width", "420", "--steps", "empty-home,settings", "--out", "output/qa/x", "--port", "4192"]);
  assert.deepEqual({ ...custom, out: undefined }, { lang: "en", theme: "light", width: 420, height: 900, steps: ["empty-home", "settings"], out: undefined, keep: false, port: 4192 });
  assert.equal(custom.out, resolve("output/qa/x"));
  assert.throws(() => parseJourneyArgs(["--steps", "empty-home,nope"]), /Unknown step "nope".*empty-home/s);
  assert.throws(() => parseJourneyArgs(["--lang", "fr"]), /--lang/);
  assert.throws(() => parseJourneyArgs(["--theme", "blue"]), /--theme/);
});

test("the fake OpenAI-compatible server answers study prompts like the fake model and streams chat turns", async (t) => {
  const server = await createFakeOpenAI({ port: 0 });
  t.after(() => server.close());
  const models = await (await fetch(server.url + "/models")).json();
  assert.equal(models.data[0].id, FAKE_OPENAI_MODEL);
  const post = (body) => fetch(server.url + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const oral = await (await post({ model: FAKE_OPENAI_MODEL, messages: [
    { role: "system", content: "You are a technical interviewer. Ask one concise follow-up question in Chinese." },
    { role: "user", content: JSON.stringify({ question: "q", candidateAnswer: "a", topic: "索引" }) }] })).json();
  assert.match(oral.choices[0].message.content, /索引.*？$/);
  const stream = await (await post({ model: FAKE_OPENAI_MODEL, stream: true, messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: [{ type: "text", text: "<system-reminder>internal</system-reminder>你好" }] }] })).text();
  assert.match(stream, /data: \[DONE\]/);
  const text = stream.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)).choices[0].delta.content || "").join("");
  assert.match(text, /收到：你好$/);
  assert.equal(server.log.length, 2);
});

test("the DSH e2e patch routes the default model to the local fake and keeps documents inside output/qa", () => {
  const documents = resolve(repo, "output/qa/dsh-documents");
  const patch = dshPatch({ fakeModelUrl: "http://127.0.0.1:3191/v1", documentsDirectory: documents, keyEnv: "STUDYHUB_QA_FAKE_KEY" });
  const rows = Object.fromEntries(patch.map((row) => [row.id, row.config]));
  assert.equal(rows["workspace-controller"].documentsDirectory, documents);
  assert.deepEqual(rows["agent-default-model"], { provider: "studyhub-qa-fake", model: "fake-tutor" });
  const provider = rows["llm-pi-ai"].providers["studyhub-qa-fake"];
  assert.equal(provider.baseURL, "http://127.0.0.1:3191/v1");
  assert.equal(provider.apiKeyEnv, "STUDYHUB_QA_FAKE_KEY");
  assert.doesNotMatch(provider.apiKeyEnv, /_API_KEY|_TOKEN|BASE_URL/, "the fake key survives the secret scrub");
});
