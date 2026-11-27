/* How the journey opens the sidebar drawer and navigates between pages (#657, #1088), apart from the journey itself so a unit test can run
   it without starting a browser. */

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const JOURNEY_NAV = {
  library: "学习库",
  sources: "资料",
  generate: "创建题组",
  wrongbook: "错题与待巩固",
  exam: "模拟考试",
  dashboard: "统计",
  skeleton: "知识骨架",
  workflows: "学习流",
  settings: "设置",
  audio: "音频转录",
  live: "课堂实录",
};

/** Drawer and sidebar navigation helpers shared by the QA journey and its unit tests. */
export function createJourneyNav({
  page,
  t,
  anchor = (id) => page.locator(`[data-tour="${id}"]`),
  settle = async () => {},
  wait = sleep,
}) {
  /** A narrow window (or a learner who put the sidebar away) shows the sidebar as a drawer behind 「打开导航」 in the top bar (#657, #1088): open it. */
  async function openDrawer() {
    const opener = page.getByRole("button", { name: t("打开导航"), exact: true }).first();
    if (!await opener.count() || !await opener.isVisible()) return;
    await opener.click();
    await page.locator('[data-tour="nav"]').first().waitFor({ state: "visible", timeout: 10000 });
    await wait(250);
  }

  /** Go to a page. The click is dispatched, not a real input event: Chromium drops layout shifts within 500 ms of real input
   *  (hadRecentInput), and data that arrives right after opening a page is exactly what the layout check must see (#208).
   *  Clicks on controls inside a page stay real input, so a result the learner asked for is not counted against the page. */
  async function nav(id) {
    await openDrawer();
    const entry = anchor(`nav-${id}`);
    const target = await entry.count() ? entry.first()
      : id === "settings" ? page.getByRole("button", { name: t(JOURNEY_NAV.settings), exact: true }).first()
        : page.locator("nav").getByRole("button", { name: new RegExp(`^\\s*${escapeRe(t(JOURNEY_NAV[id] || id))}`) }).first();
    if (!await target.count()) throw new Error(`the sidebar has no entry for "${id}" (no [data-tour="nav-${id}"] and no button named ${JOURNEY_NAV[id] || id}); was it moved or renamed?`);
    // An entry folded away in 「更多」 is in the page but hidden until the fold opens.
    if (!await target.isVisible()) {
      const fold = target.locator("xpath=ancestor::*[@data-nav-fold][1]").locator(".nav-fold__toggle").first();
      if (await fold.count() && await fold.getAttribute("aria-expanded") !== "true") await fold.click();
    }
    await target.waitFor({ state: "visible", timeout: 10000 })
      .catch(() => { throw new Error(`the sidebar entry "${id}" stays hidden after opening the drawer and the 「更多」 fold`); });
    await target.dispatchEvent("click");
    await settle();
  }

  return { openDrawer, nav };
}
