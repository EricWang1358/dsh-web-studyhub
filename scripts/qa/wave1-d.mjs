/* node scripts/qa/wave1-d.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build first: node scripts/build.mjs)
   The surfaces the shared logic layer (UI wave 1, WP-D) touches: the audio settings key form, the Jev key form (experimental), the audio usage
   dashboard and the live class page. A temporary library and a temporary DSH home with test keys only; fake model; no network. */
/* global window */
import { join } from "node:path";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const options = parseQaArgs(process.argv.slice(2), "wave1-d", {});
// The preview server keeps its DSH home here (and points DSH_HOME at it), so the seeded keys and usage are the ones it reads.
process.env.DSH_HOME = join(options.out, "work", "home");
const { saveAudioSettings } = await import("../../lib/audio-settings.js");
const { keyId, recordAudioUsage } = await import("../../lib/audio-dashboard.js");

const api = (page, action, args = {}) => page.evaluate(async ([name, body]) => {
  const response = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-study-token": window.STUDY_TOKEN }, body: JSON.stringify({ action: name, args: body }) });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || name);
  return json.value;
}, [action, args]);

const summary = await runQa({
  name: "wave1-d", options,
  async seed() {
    // Test values only: shaped like keys, not keys of any account.
    const keys = { freeKey: "AIzaTestKeyForQaOnly0000000000000000", siliconflowKey: "sk-test-for-qa-only-0000000000000000" };
    await saveAudioSettings(keys);
    for (const [tier, count] of [["free", 4], ["siliconflow", 6]])
      for (let i = 0; i < count; i += 1)
        await recordAudioUsage({ type: "request", tier, keyId: keyId(keys[`${tier}Key`]), at: Date.now() - i * 3_600_000, model: "gemini-3.5-transcribe", status: 200, audioSeconds: 600, inputTokens: 1500, outputTokens: 120 });
  },
  async run({ page, t, step, check }) {
    const openSettings = async (category, ready) => {
      await page.getByRole("button", { name: t("设置", "Settings"), exact: true }).first().click();
      await page.waitForSelector(".settings-page");
      await page.locator(`[data-category="${category}"]`).click();
      await page.waitForSelector(ready, { timeout: 20000 });
      await page.locator(ready).first().scrollIntoViewIfNeeded();
    };
    await step("audio-settings-key-form", async () => { await openSettings("audio", ".audio-provider-card"); return await page.locator(".sh-secret").count(); });
    await check("audio-settings-one-key-form-per-card", async () => {
      const forms = await page.locator(".audio-provider-card .sh-secret").count();
      if (forms !== 3) throw new Error(`expected 3 key forms, found ${forms}`);
      const saved = await page.locator(".audio-provider-card.is-set .sh-secret__clear").count();
      return { forms, clearButtons: saved };
    });
    await check("audio-settings-no-overflow", async () => { const probe = await page.evaluate(overflowProbe); if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(JSON.stringify(probe)); return probe; });
    await step("jev-settings-key-form", async () => {
      await api(page, "experimental.set", { enabled: true });
      await page.reload();
      await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
      await openSettings("experimental", ".jev-settings");
      await page.locator(".jev-card").first().scrollIntoViewIfNeeded();
      return await page.locator(".jev-card .sh-secret").count();
    });
    await step("audio-dashboard", async () => {
      await page.locator('[data-nav-id="audio"]').first().click();
      await page.waitForSelector(".audio-usage-panel", { timeout: 20000 });
      await page.locator(".audio-usage-panel > summary").click();
      await page.waitForSelector(".audio-dashboard");
      await page.locator(".audio-dashboard").scrollIntoViewIfNeeded();
      return await page.locator(".audio-provider").count();
    });
    await step("live-class", async () => {
      await page.locator('[data-nav-id="live"]').first().click();
      await page.waitForSelector(".live-class:not([hidden])", { timeout: 20000 });
      await sleep(400);
      return await page.locator(".live-class h1").first().innerText();
    });
    await check("live-class-language", async () => {
      const text = await page.locator(".live-class").innerText();
      const han = /[㐀-鿿]/.test(text);
      if (options.lang === "en" && han) throw new Error(`Chinese on the English live page: ${text.match(/.*[㐀-鿿].*/)?.[0]}`);
      return { han };
    });
  },
});
finishCli("wave1-d", options, summary);
