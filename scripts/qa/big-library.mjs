/* node scripts/qa/big-library.mjs [--lang zh|en] [--theme dark|light] [--width 1440|420]
                                    [--steps a,b] [--out output/qa/wp14] [--port 4290]
   WP14: screenshots of a library shaped like the owner's, only bigger — 60
   courses (6 courses × 8 long "Course / Chapter" names, 11 ordinary courses
   and one near-duplicate), ~180 materials in one chapter, an old text-only
   lecture transcript and a PDF. Without --lang /
   --theme / --width it runs every combination (zh/en × dark/light × 1440/420).
   Runs the real preview server with the fake model on a fresh library under
   the output directory, in Chromium, with key/token/base-url variables removed.
   Needs `npm run build` first (dist/app.js). */
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { StudyService } from "../../lib/service.js";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { samplePdfHtml } from "./fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const CNSD = "Cloud Native Solution Design";
export const PARENTS = [CNSD, "Distributed Systems Engineering", "Machine Learning Systems in Production", "软件架构与设计模式", "Information Security Management", "数据密集型应用设计"];
export const CHAPTERS = ["01 云计算概览与参考架构", "02 容器与镜像", "03 微服务拆分与边界", "04 服务网格与流量治理", "05 Kubernetes：对象、运行机制与故障诊断",
  "06 可观测性：日志、指标与追踪", "07 安全、合规与成本", "08 迁移策略与案例复盘"];
export const BIG_COURSE = `${CNSD} / 05 Kubernetes：对象、运行机制与故障诊断`;
export const DUPLICATE = `${CNSD}/01 云计算概览与参考架构`;
const PLAIN = ["Databases", "Operating Systems", "数据结构与算法", "计算机网络", "Machine Learning", "编译原理", "软件工程", "TCP/IP Basics", "信息安全导论",
  "Human-Computer Interaction", "Statistics for Data Science"];
export const TRANSCRIPT_TITLE = "第 5 讲 · Kubernetes 故障诊断 · 中英对照逐字稿";

/** The 60 course names: 6 × 8 chapters, the unspaced duplicate of one chapter and eleven ordinary courses. */
export const courseNames = () => [...PARENTS.flatMap((parent) => CHAPTERS.map((chapter) => `${parent} / ${chapter}`)), DUPLICATE, ...PLAIN];

const TOPICS = ["Pod 生命周期", "Deployment 滚动更新", "Service 与 kube-proxy", "Ingress 路由", "ConfigMap 与 Secret", "调度器与亲和性", "探针与自愈",
  "HPA 自动扩缩容", "etcd 与控制平面", "CrashLoopBackOff 排查", "网络策略", "持久卷与存储类"];

const transcriptText = () => Array.from({ length: 24 }, (_, index) => [
  `【第 ${index + 1} 段】`,
  `Today we look at why a pod keeps restarting. When the container exits, the kubelet restarts it with an exponential back-off, which is what you see as CrashLoopBackOff in kubectl get pods; the first thing to check is kubectl describe pod and the last state of the container.`,
  `今天我们看为什么一个 Pod 会不停重启。容器退出后，kubelet 会按指数退避重新拉起它，这就是 kubectl get pods 里看到的 CrashLoopBackOff；第一步先看 kubectl describe pod 和容器的上一次状态，再看日志里的退出码。`,
].join("\n")).join("\n\n");

async function seedBeforeServer(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call("snapshot");
  const createdAt = new Date(Date.now() + 60_000).toISOString();
  // An old text-only audio transcript: no retained original, `audio` metadata only.
  await service.store.update((state) => {
    state.sources.push({ id: "legacy-transcript-05", title: TRANSCRIPT_TITLE, text: transcriptText(), createdAt, courses: [BIG_COURSE],
      audio: { provider: "gemini", filename: "lecture-05.m4a", durationSeconds: 5400, importedAt: createdAt } });
  });
}

async function seedThroughServer(server, browser) {
  const call = (action, args) => previewCall(server, action, args);
  const names = courseNames();
  for (const [index, name] of names.entries()) {
    const count = name === BIG_COURSE ? 0 : 1 + (index % 2);
    for (let n = 1; n <= count; n++)
      await call("source.add", { title: `${name.split(" / ").pop()} · 讲义 ${n}`, text: `${name} 第 ${n} 份讲义。${TOPICS[(index + n) % TOPICS.length]} 的要点与例子。`, courses: [name] });
  }
  for (let n = 1; n <= 178; n++) {
    const topic = TOPICS[n % TOPICS.length];
    await call("source.add", { title: `K8s ${String(n).padStart(3, "0")} · ${topic}`, text: `${topic}：第 ${n} 份笔记。kubectl describe、事件与日志是排查的起点。`, courses: [BIG_COURSE] });
  }
  const page = await browser.newPage();
  await page.setContent(samplePdfHtml("zh"), { waitUntil: "load" });
  const pdf = await page.pdf({ format: "A5", printBackground: true });
  await page.close();
  await call("materials.document.import", { dataBase64: Buffer.from(pdf).toString("base64"), filename: "05-kubernetes-故障诊断.pdf", courses: [BIG_COURSE] });
  await call("focus.set", { course: BIG_COURSE });
}

/* ---------- steps ---------- */

export const STEPS = [
  { name: "settings-courses", run: async (j) => {
    await j.nav("settings");
    const list = j.page.locator(".course-list");
    await list.scrollIntoViewIfNeeded();
    await j.settle();
    await j.shot("collapsed", list);
    await list.locator(".course-list__toggle").first().click();
    await j.settle(300);
    await j.shot("open", list);
    await list.getByPlaceholder(j.t("筛选课程…")).fill("kubernetes");
    await j.settle(300);
    await j.shot("filtered", list);
    await list.getByPlaceholder(j.t("筛选课程…")).fill("");
    await list.getByRole("button", { name: j.t("合并到这里") }).first().click();
    await j.page.locator("dialog[open]").waitFor({ timeout: 10000 });
    await j.settle(500);
    await j.shot("merge-confirm");
    await j.page.keyboard.press("Escape");
    await j.settle(300);
  } },
  { name: "course-field", run: async (j) => {
    await j.nav("sources");
    await j.page.getByRole("button", { name: j.t("添加资料") }).first().click();
    const dialog = j.page.locator("dialog[open]");
    await dialog.waitFor({ timeout: 10000 });
    const field = dialog.locator(".course-field").first();
    await j.settle(300);
    await j.shot("chips", field);
    await field.locator(".course-field__more").click();
    await j.settle(300);
    await j.shot("panel", field);
    await field.locator("input").fill("安全");
    await j.settle(300);
    await j.shot("panel-filtered", field);
    await field.locator("input").press("ArrowDown");
    await field.locator("input").press("ArrowDown");
    await j.settle(200);
    await j.shot("panel-keyboard", field);
    await field.locator("input").press("Escape");
    await j.settle(300);
    if (!await j.page.locator("dialog[open]").count()) throw new Error("Escape in the course list closed the whole dialog");
    await field.getByRole("button", { name: j.t("清空课程") }).click();
    await j.settle(300);
    await j.shot("cleared", field);
    await field.locator(".course-field__pick--group").first().click();
    await j.settle(300);
    await j.shot("group-open", field);
    await j.page.keyboard.press("Escape");
    await j.settle(300);
  } },
  { name: "source-picker", run: async (j) => {
    await j.nav("generate");
    await j.clickIfPresent(j.page.locator('[data-tour="generate-from-sources"]'));
    const picker = j.page.locator(".source-picker").first();
    await picker.waitFor({ timeout: 10000 });
    await picker.scrollIntoViewIfNeeded();
    await j.settle();
    await j.shot("list", picker);
    await picker.getByPlaceholder(j.t("筛选资料…")).fill("探针");
    await j.settle(300);
    await j.shot("filtered", picker);
  } },
  { name: "viewer-transcript", run: async (j) => {
    await j.nav("sources");
    await j.page.locator(".source-main", { hasText: "Kubernetes 故障诊断" }).first().click();
    await j.page.locator(".study-document-viewer").waitFor({ timeout: 10000 });
    await j.settle(800);
    await j.shot();
    await j.page.keyboard.press("Escape");
    await j.settle(300);
  } },
  { name: "viewer-pdf", run: async (j) => {
    await j.nav("sources");
    await j.page.locator(".source-main", { hasText: "05-kubernetes" }).first().click();
    await j.page.locator(".study-document-viewer").waitFor({ timeout: 10000 });
    await j.settle(1200);
    await j.shot("original");
    await j.page.locator(".study-document-preview-mode button").nth(1).click();
    await j.settle(500);
    await j.shot("text");
    await j.page.keyboard.press("Escape");
    await j.settle(300);
  } },
  { name: "sidebar", run: async (j) => {
    await j.nav("library");
    const bottom = j.page.locator(".sidebar-bottom");
    await j.settle();
    await j.shot("", j.page.locator("aside.sidebar"));
    if (await bottom.count()) await j.shot("bottom", bottom);
  } },
];

/* ---------- runner ---------- */

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unexpected argument ${argv[i]}`);
    values[match[1]] = match[2] ?? argv[++i];
  }
  const list = (value, all) => value ? value.split(",") : all;
  return { langs: list(values.lang, ["zh", "en"]), themes: list(values.theme, ["dark", "light"]), widths: list(values.width, ["1440", "420"]).map(Number),
    steps: list(values.steps, STEPS.map((step) => step.name)), out: resolve(values.out || resolve(repoRoot, "output/qa/wp14")), port: Number(values.port || 4290) };
}

export async function runBigLibrary(options) {
  const removed = scrubProcessEnv();
  await access(resolve(repoRoot, "dist/app.js")).catch(() => { throw new Error("dist/app.js is missing: run `npm run build` first"); });
  const work = join(options.out, "work");
  await rm(work, { recursive: true, force: true });
  await seedBeforeServer(join(work, "library"));
  const server = await createPreviewServer({ libraryRoot: join(work, "library"), home: join(work, "home"), port: options.port, model: createFakeModel({ latencyMs: 50 }) });
  const browser = await launchChromium();
  const summary = { scrubbedEnv: removed, shots: [], failures: [], pageErrors: [] };
  try {
    await seedThroughServer(server, browser);
    const english = options.langs.includes("en") ? await englishStrings() : {};
    for (const lang of options.langs) for (const theme of options.themes) for (const width of options.widths) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
      await context.addInitScript(([language, mode]) => {
        try { localStorage.setItem("study-ui-language", language); localStorage.setItem("study-theme", mode); } catch { /* storage blocked */ }
      }, [lang, theme]);
      const page = await context.newPage();
      page.on("pageerror", (error) => summary.pageErrors.push(`${lang}-${theme}-${width}: ${error.message}`));
      await page.goto(server.url);
      await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
      const dir = join(options.out, `${lang}-${theme}-${width}`);
      await mkdir(dir, { recursive: true });
      const j = context_(page, dir, lang, english, summary);
      for (const step of STEPS.filter((item) => options.steps.includes(item.name))) {
        j.step = step.name;
        try { await step.run(j); console.log(`ok   ${lang}-${theme}-${width} ${step.name}`); }
        catch (error) {
          summary.failures.push(`${lang}-${theme}-${width} ${step.name}: ${String(error?.message || error).split("\n")[0]}`);
          console.log(`FAIL ${lang}-${theme}-${width} ${step.name} — ${String(error?.message || error).split("\n")[0]}`);
          await page.screenshot({ path: join(dir, `${step.name}-failed.png`) }).catch(() => {});
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
      await context.close();
    }
  } finally {
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
  return summary;
}

async function englishStrings() {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = resolve(repoRoot, "ui/locales");
  const files = (await readdir(dir)).filter((name) => /^en(\..+)?\.json$/.test(name)).sort();
  return Object.assign({}, ...await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")))));
}

function context_(page, dir, lang, english, summary) {
  const t = (zh) => lang === "en" && Object.hasOwn(english, zh) ? english[zh] : zh;
  const NAV = { library: "学习库", sources: "资料", generate: "创建题组", settings: "设置" };
  const j = {
    page, t, step: "",
    async settle(ms = 500) {
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(ms);
    },
    async clickIfPresent(locator) {
      if (await locator.count() && await locator.first().isVisible()) { await locator.first().click(); await j.settle(300); return true; }
      return false;
    },
    async nav(id) {
      await page.keyboard.press("Escape").catch(() => {});
      const anchor = page.locator(`[data-tour="nav-${id}"]`);
      if (await anchor.count()) await anchor.first().click();
      else await page.getByRole("button", { name: t(NAV[id]), exact: true }).first().click();
      await j.settle();
    },
    /** A screenshot of the viewport, or of one element (with a margin) when given. */
    async shot(suffix = "", locator = null) {
      const name = `${j.step}${suffix ? `-${suffix}` : ""}.png`;
      if (locator) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        const box = await locator.boundingBox();
        const view = page.viewportSize();
        if (box) {
          const x = Math.max(0, box.x - 16), y = Math.max(0, box.y - 16);
          await page.screenshot({ path: join(dir, name), clip: { x, y, width: Math.min(view.width - x, box.width + 32), height: Math.min(view.height - y, box.height + 32) } });
        } else await page.screenshot({ path: join(dir, name) });
      } else await page.screenshot({ path: join(dir, name) });
      summary.shots.push(join(dir, name));
      return name;
    },
  };
  return j;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const summary = await runBigLibrary(parseArgs(process.argv.slice(2)));
    console.log(`${summary.failures.length ? "FAILED" : "done"}: ${summary.shots.length} shots, ${summary.failures.length} failures, ${summary.pageErrors.length} page errors`);
    process.exitCode = summary.failures.length || summary.pageErrors.length ? 1 : 0;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 2;
  }
}
