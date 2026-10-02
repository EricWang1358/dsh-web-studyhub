/* node scripts/qa/original-shots.mjs [--lang zh|en] [--theme dark|light] [--width 1440|420] [--out <dir>]
   补全原文件 in the browser preview, on an isolated library with generated PDFs (no network, no model, no real files):
   a legacy PDF document (text only) opened in the reader, the new notice, the dialog (choose, verify, mode, attach by
   reference), the 原始 PDF tab working, the file moved (the plain message and 重新指定), the file edited (copy instead),
   a copy attached, a mismatch needing confirmation, and the 资料 row menu. Every key/token/base-url variable is removed. */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { Store } from "../../lib/store.js";
import { StudyService } from "../../lib/service.js";
import { makeTextPdf, LECTURE_PAGES } from "../../tests/helpers/text-pdf.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const lang = flag("lang", "zh"), theme = flag("theme", "dark"), width = Number(flag("width", "1440")), out = resolve(flag("out", join(repoRoot, "output/qa/original")));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const NETWORKS = [
  ["Network layers", "The transport layer moves segments between processes on two hosts."],
  ["Routing", "A router forwards packets by looking up the longest matching prefix in its table."],
];

async function main() {
  scrubProcessEnv();
  const base = join(out, `${width}-${lang}-${theme}`);
  await rm(base, { recursive: true, force: true });
  const files = join(base, "my-files", "courses", "databases", "week3");
  await mkdir(files, { recursive: true });
  const library = join(base, "library");
  const lecture = join(files, "Database System Concepts.pdf"), networks = join(files, "Networks.pdf"), wrong = join(files, "Compilers.pdf");
  await writeFile(lecture, await makeTextPdf(LECTURE_PAGES));
  await writeFile(networks, await makeTextPdf(NETWORKS));
  await writeFile(wrong, await makeTextPdf([["Lexers turn characters into tokens for the parser."], ["Code generation maps trees onto target instructions."], ["Optimisation passes rewrite the intermediate representation."]]));
  // Seed: two PDFs imported the way old versions did (text only, no original).
  const service = new StudyService(library);
  for (const [path, , course] of [[lecture, "Database System Concepts.pdf", "数据库"], [networks, "Networks.pdf", "数据库"]])
    await service.call("materials.document.import", { path, courses: [course] });
  await new Store(library).update((state) => {
    state.documents = [];
    for (const source of state.sources) { delete source.document.materialId; delete source.document.materialRevision; delete source.document.format; }
  });
  await rm(join(library, "attachments"), { recursive: true, force: true });

  const server = await createPreviewServer({ libraryRoot: library, home: join(base, "home"), port: 4470 + (width === 420 ? 1 : 0) + (lang === "en" ? 2 : 0) + (theme === "light" ? 4 : 0),
    model: createFakeModel({ latencyMs: 100 }) });
  const browser = await launchChromium();
  const shots = [];
  try {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
    await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const settle = async (ms = 400) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
    const shot = async (label) => { const path = join(base, `${label}.png`); await page.screenshot({ path }); shots.push(path); };
    const T = (zh, en) => (lang === "en" ? en : zh);
    await page.goto(server.url); await page.locator("aside, nav").first().waitFor({ timeout: 30000 }); await settle(800);
    await page.locator('[data-tour="nav-sources"]').first().click(); await settle();

    // 1. The legacy document in the reader: the notice.
    await page.locator(".source-main", { hasText: "Database System Concepts" }).first().click(); await settle(800);
    await page.locator(".study-document-viewer").waitFor({ timeout: 15000 });
    await shot("1-notice");

    // 2. The dialog: choose.
    await page.getByRole("button", { name: T("补全原文件…", "Add the original file…") }).first().click(); await settle(400);
    await shot("2-dialog-choose");

    // 3. A pasted path, verified.
    const field = page.getByLabel(T("原文件的完整路径", "Full path of the original file"));
    await field.fill(`"${lecture}"`);
    await page.locator("dialog[open]").getByRole("button", { name: T("核对", "Check"), exact: true }).click();
    await page.locator("dialog[open] fieldset.original-modes").waitFor({ timeout: 30000 }); await settle(300);
    await shot("3-verified");

    // 4. Attach by reference; the dialog says so.
    await page.locator("dialog[open]").getByRole("button", { name: T("附上原文件", "Attach the file") }).click();
    await page.locator("dialog[open] .original-status", { hasText: T("已附上原文件", "Original file attached") }).waitFor({ timeout: 30000 }); await settle(300);
    await shot("4-attached");
    await page.locator("dialog[open] .sh-dialog__footer").getByRole("button", { name: T("完成", "Finish") }).click(); await settle(900);

    // 5. The 原始 PDF tab works now.
    await page.locator(".study-document-preview-mode").getByRole("button", { name: T("原始 PDF", "Original PDF") }).click(); await settle(1200);
    await shot("5-original-pdf");
    await page.locator(".study-document-preview-mode").getByRole("button", { name: T("阅读", "Read") }).click(); await settle(300);
    await page.keyboard.press("Escape"); await settle(400);

    // 6. The 资料 row menu shows where the original is.
    await page.locator(".source-row", { hasText: "Database System Concepts" }).locator("summary").first().click(); await sleep(250);
    await shot("6-row-menu");
    await page.keyboard.press("Escape"); await page.locator(".source-row", { hasText: "Database System Concepts" }).locator("summary").first().click(); await sleep(150);

    // 7. The file moved: the reader says so plainly.
    await rename(lecture, join(files, "moved.pdf"));
    await page.locator(".source-main", { hasText: "Database System Concepts" }).first().click(); await settle(900);
    await page.locator(".original-notice.is-warning").waitFor({ timeout: 15000 });
    await shot("7-missing");
    await page.locator(".study-document-preview-mode").getByRole("button", { name: T("原始 PDF", "Original PDF") }).click(); await settle(500);
    await shot("8-missing-dialog");
    await page.keyboard.press("Escape"); await settle(300);

    // 8. The file edited in place: changed, with the copy option.
    await rename(join(files, "moved.pdf"), lecture);
    const bytes = Buffer.from(await makeTextPdf(LECTURE_PAGES)); bytes[bytes.length - 40] ^= 1;
    await writeFile(lecture, bytes);
    await page.keyboard.press("Escape"); await settle(300);
    await page.locator(".source-main", { hasText: "Database System Concepts" }).first().click(); await settle(900);
    await shot("9-changed");
    await page.getByRole("button", { name: T("改为复制到资料库", "Copy into the library instead") }).first().click(); await settle(900);
    await shot("10-copy-instead");
    await page.locator("dialog[open]").getByRole("button", { name: T("附上原文件", "Attach the file") }).click(); await settle(900);
    await shot("11-copy-attached");
    await page.keyboard.press("Escape"); await settle(300);
    await page.keyboard.press("Escape"); await settle(300);

    // 9. A file that is not the same document needs a confirmation.
    await page.locator(".source-row", { hasText: "Networks" }).locator("summary").first().click(); await sleep(250);
    await page.locator(".source-row", { hasText: "Networks" }).getByRole("button", { name: T("补全原文件…", "Add the original file…") }).click(); await settle(400);
    await page.getByLabel(T("原文件的完整路径", "Full path of the original file")).fill(wrong);
    await page.locator("dialog[open]").getByRole("button", { name: T("核对", "Check"), exact: true }).click();
    await page.locator("dialog[open] fieldset.original-modes").waitFor({ timeout: 30000 }); await settle(300);
    await shot("12-mismatch");

    // 10. A file chosen in the browser has no path: only the copy is possible.
    await page.locator("dialog[open] input[type=file]").setInputFiles(networks); await settle(1200);
    await page.locator("dialog[open] fieldset.original-modes").waitFor({ timeout: 30000 });
    await shot("13-browser-file-copy-only");
    await page.locator("dialog[open]").getByRole("button", { name: T("附上原文件", "Attach the file") }).click(); await settle(1000);
    await shot("14-browser-file-attached");

    console.log(shots.join("\n"));
    if (errors.length) { console.error("page errors:\n" + errors.join("\n")); process.exitCode = 1; }
  } finally {
    await browser.close();
    await server.close();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
