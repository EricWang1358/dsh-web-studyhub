/* node scripts/report/shots.mjs <deck.html> --out <dir> [--theme light|dark|both]
   Opens a built deck in Chromium at 1280x720 and 390x800 and saves one screenshot per slide (the whole slide, not just the first screen).
   Fails (exit 1) when a page scrolls sideways, when text sticks out of the screen outside a box that scrolls on its own,
   or when the text of a diagram leaves its picture. Look at the images too: the checks cannot see an ugly slide. Not part of the test suite. */
/* global document, getComputedStyle -- page.evaluate callbacks run in the browser */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChromium } from "../qa/browser.mjs";

const SIZES = [["desktop", 1280, 720], ["phone", 390, 800]];

function parseArgs(argv) {
  const args = { deck: null, out: null, theme: "both" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--theme") args.theme = argv[++i];
    else if (!args.deck) args.deck = argv[i];
  }
  return args;
}

/** Runs in the page: problems found on the current slide layout. */
function probe() {
  const problems = [];
  const page = document.documentElement;
  if (page.scrollWidth > page.clientWidth + 1) problems.push(`the page scrolls sideways (${page.scrollWidth} > ${page.clientWidth})`);
  const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") return true; } return false; };
  const view = page.clientWidth;
  for (const el of document.querySelectorAll(".dk-inner :is(h1,h2,h3,h4,p,li,td,th,summary,figcaption,.dk-stat__num,.dk-stat__label)")) {
    if (scrolls(el)) continue;
    const box = el.getBoundingClientRect();
    if (box.width && (box.right > view + 1 || box.left < -1)) problems.push(`"${el.textContent.trim().slice(0, 30)}" sticks out of the screen (${Math.round(box.left)}..${Math.round(box.right)} of ${view})`);
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible") problems.push(`"${el.textContent.trim().slice(0, 30)}" is cut off inside its box`);
  }
  for (const svg of document.querySelectorAll("svg.rk-seq")) {
    const [, , w, h] = svg.getAttribute("viewBox").split(" ").map(Number);
    for (const text of svg.querySelectorAll("text")) {
      const b = text.getBBox();
      if (b.x < -0.5 || b.y < -0.5 || b.x + b.width > w + 0.5 || b.y + b.height > h + 0.5) problems.push(`diagram text "${text.textContent.slice(0, 20)}" leaves the picture`);
    }
    // a step's text must stay between the lifelines it belongs to
    for (const step of svg.querySelectorAll(".rk-step")) {
      const t = step.querySelector(".rk-t"), line = step.querySelector(".rk-line");
      if (!t || !line) continue;
      const tb = t.getBBox(), lb = line.getBBox();
      if (!step.querySelector(".rk-head") || step.querySelector(".rk-line").getAttribute("d").includes("V")) continue; // self loops put the text beside the loop
      if (tb.x < lb.x - 1 || tb.x + tb.width > lb.x + lb.width + 10) problems.push(`step text "${t.textContent.slice(0, 20)}" is wider than its arrow`);
    }
  }
  return problems;
}

export async function takeShots({ deck, out, theme = "both" }) {
  await mkdir(out, { recursive: true });
  const browser = await launchChromium();
  const failures = [];
  try {
    for (const scheme of theme === "both" ? ["light", "dark"] : [theme]) {
      for (const [name, width, height] of SIZES) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce" });
        const page = await context.newPage();
        await page.goto(pathToFileURL(resolve(deck)).href);
        const slides = await page.locator(".dk-slide").count();
        for (let i = 0; i < slides; i++) {
          const slide = page.locator(".dk-slide").nth(i);
          const base = join(out, `${name}-${scheme}-${String(i + 1).padStart(2, "0")}`);
          await slide.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${base}-view.png` });
          // the whole slide, without the bars that float over it
          await page.addStyleTag({ content: ".dk-bar,.dk-progress{visibility:hidden}" });
          await slide.screenshot({ path: `${base}.png` });
          await page.evaluate(() => { document.head.lastElementChild.remove(); });
        }
        for (const problem of await page.evaluate(probe)) failures.push(`${name}/${scheme}: ${problem}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { deck, out, theme } = parseArgs(process.argv.slice(2));
  if (!deck || !out) { console.error("usage: node scripts/report/shots.mjs <deck.html> --out <dir> [--theme light|dark|both]"); process.exit(2); }
  const failures = await takeShots({ deck, out, theme });
  for (const line of failures) console.error(`PROBLEM ${line}`);
  console.log(failures.length ? `${failures.length} problem(s); screenshots in ${out}` : `no problems found; screenshots in ${out}`);
  process.exit(failures.length ? 1 : 0);
}
