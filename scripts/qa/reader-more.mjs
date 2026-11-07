/* The reader's toolbar keeps 目录, AI 出题, 错题, 思维导图 and 更多; the views, 在文中查找, 翻译…, 显示设置…, 学习工具 and the rest are items of 更多
   (ui/document-preview/reader/more-items.js, the menu is reader/ReaderMore.jsx). A QA journey presses what a learner presses: open 更多, then the item
   that holds the words. tests/helpers/reader-more.mjs is the same journey for the browser tests. */

/** Open 更多 and press the item that holds `text` (a view, 在文中查找, 学习工具, 显示设置 …). */
export async function chooseMore(page, text, { viewer = page.locator(".study-document-viewer") } = {}) {
  await viewer.locator(".reader-more__button").first().click();
  await page.locator('.sh-menu [role^="menuitem"]', { hasText: text }).first().click();
}
