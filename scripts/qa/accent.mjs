/* node scripts/qa/accent.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>] [--defaults-only true]   (build first: node scripts/build.mjs)
   强调色 (设置 › 界面, #63): each preset reaches the app root (data-accent), really recolours the primary action, the progress, the focus ring and the selected row on the
   settings, library, dashboard and review pages, and leaves no cinnabar behind (every computed colour in the app is compared with the cinnabar family). Cinnabar itself is the
   default and is only photographed. --defaults-only takes the cinnabar pictures alone, to compare two builds pixel by pixel. Seeded temporary library, fake model, no network. */
/* global document, localStorage, getComputedStyle, window */
import { seedLibrary } from "./perf-seed.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const ACCENTS = [["jade", "青玉", "Jade"], ["ochre", "赭石", "Ochre"], ["graphite", "墨灰", "Graphite"], ["plum", "梅紫", "Plum"]];
/** The reds of the cinnabar desk, dark and light, soft, text and the card stock's darker one. */
const CINNABAR = [[201, 61, 34], [192, 58, 31], [236, 106, 74], [212, 79, 46], [173, 64, 37], [179, 54, 28], [171, 52, 28]];

/** Every computed colour in the app that is (nearly) one of the cinnabar reds, with where it sits. Runs in the page. */
const cinnabarRemnants = (family) => {
  const read = (text) => [...text.matchAll(/rgba?\(([^)]+)\)|color\(srgb ([^)/]+)/g)].map((match) => match[1]
    ? match[1].split(",").slice(0, 3).map(Number) : match[2].trim().split(/\s+/).map((value) => Math.round(Number(value) * 255)));
  const near = (rgb) => family.some((red) => red.every((value, i) => Math.abs(value - rgb[i]) <= 4));
  const found = [];
  for (const element of document.querySelectorAll(".study-app *")) {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const style = getComputedStyle(element);
    for (const property of ["color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "outlineColor", "boxShadow", "fill", "stroke", "caretColor"]) {
      const value = style[property];
      if (!value || value === "none") continue;
      if (read(value).some(near)) found.push(`${element.tagName.toLowerCase()}.${String(element.className?.baseVal ?? element.className).split(" ")[0]} ${property} ${value.slice(0, 60)}`);
    }
  }
  return found;
};

export async function runAccentQa(options) {
  const defaultsOnly = options.defaultsOnly === "true";
  return runQa({
    name: "accent", options,
    seed: (root) => seedLibrary(root, { sources: 30, decks: 4, cardsPerDeck: 10, runs: 4, attempts: 100, courses: 3, largeSources: 1, largeSourceChars: 6000 }),
    async run({ page, t, step, check }) {
      const root = (attribute) => page.locator(".study-app").first().getAttribute(attribute);
      const token = (name) => page.locator(".study-app").first().evaluate((element, key) => getComputedStyle(element).getPropertyValue(key).trim(), name);
      const nav = async (id) => { await page.locator(`[data-nav-id="${id}"]`).first().click(); await sleep(700); };
      const api = (action, args = {}) => page.evaluate(async ([name, body]) => {
        const response = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-study-token": window.STUDY_TOKEN }, body: JSON.stringify({ action: name, args: body }) });
        const json = await response.json();
        if (!json.ok) throw new Error(json.error || name);
        return json.value;
      }, [action, args]);
      const openSettings = async () => {
        await page.getByRole("button", { name: t("设置", "Settings"), exact: true }).first().click();
        await page.waitForSelector(".settings-nav", { timeout: 15000 });
        if (!(await page.locator(".appearance-settings").first().isVisible().catch(() => false))) await page.locator('[data-category="appearance"]').click();
        await page.locator(".appearance-settings").waitFor({ state: "visible", timeout: 15000 });
      };
      /** Look at a page with the keyboard focus on its first control (a focus ring on screen), then no cinnabar may be left unless this is the default. */
      const look = async (accent, label) => {
        await page.keyboard.press("Tab"); await sleep(150);
        const probe = await page.evaluate(overflowProbe);
        if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow on ${label}: ${JSON.stringify(probe)}`);
        const left = await page.evaluate(cinnabarRemnants, CINNABAR);
        if (accent === "cinnabar") return { accent: await root("data-accent"), token: await token("--accent"), cinnabarColours: left.length }; // the detector sees the default's reds
        if (left.length) throw new Error(`${left.length} cinnabar colours on ${label}, e.g. ${left.slice(0, 3).join(" | ")}`);
        return { accent: await root("data-accent"), token: await token("--accent") };
      };
      const visit = async (accent, label) => {
        await step(`${accent}-settings`, async () => { await openSettings(); return look(accent, `${label} settings`); });
        await step(`${accent}-library`, async () => { await nav("library"); return look(accent, `${label} library`); });
        await step(`${accent}-dashboard`, async () => { await nav("dashboard"); return look(accent, `${label} dashboard`); });
        await step(`${accent}-review`, async () => {
          const deck = (await api("snapshot", {})).decks[0];
          await api("review.start", { mode: "flashcard", deckId: deck.id });
          await page.reload(); await sleep(1200);
          // The run opens from the card's primary action; the card in front of the learner (question, options, progress rule) is what is looked at.
          await page.locator(".today-card button").first().click();
          await page.locator(".question-area, .flip-face").first().waitFor({ timeout: 15000 });
          return look(accent, `${label} review`);
        });
      };

      await visit("cinnabar", "cinnabar");
      if (defaultsOnly) return;
      for (const [accent, zh, en] of ACCENTS) {
        await step(`choose-${accent}`, async () => {
          await openSettings();
          await page.getByRole("button", { name: t(zh, en), exact: true }).first().click(); await sleep(300);
          if ((await root("data-accent")) !== accent) throw new Error("the choice did not reach the app root");
          return look(accent, `${accent} choice`);
        });
        await visit(accent, accent);
      }
      await check("remembered-after-reload", async () => {
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("study-interface")));
        if (stored.accent !== "plum") throw new Error(`stored ${JSON.stringify(stored)}`);
        await page.reload(); await sleep(1200);
        if ((await root("data-accent")) !== "plum") throw new Error("not restored after a reload");
        return stored;
      });
      await step("back-to-cinnabar", async () => {
        await openSettings();
        await page.getByRole("button", { name: t("朱砂", "Cinnabar"), exact: true }).first().click(); await sleep(300);
        const wanted = options.theme === "light" ? "#c03a1f" : "#c93d22";
        if ((await root("data-accent")) !== "cinnabar" || (await token("--accent")) !== wanted) throw new Error(`cinnabar did not come back: ${await token("--accent")}`);
        return { accent: await root("data-accent"), token: await token("--accent") };
      });
    },
  });
}

if (process.argv[1]?.endsWith("accent.mjs")) {
  const options = parseQaArgs(process.argv.slice(2), "accent", { "defaults-only": "false" });
  options.defaultsOnly = options["defaults-only"];
  finishCli("Accent colours", options, await runAccentQa(options));
}
