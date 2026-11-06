/* The reader's toolbar keeps 目录, AI 出题, 错题, 思维导图 and 更多; the views, find, display settings, the study tools and the rest are items of 更多
   (ui/document-preview/reader/more-items.js). Browser tests that used to press those toolbar buttons press the same thing a learner does. */

/** Open 更多 and press the item that holds `text` (a view, 在文中查找, 学习工具 …). */
export async function chooseMore(page, text, { viewer = page.locator('.study-document-viewer') } = {}) {
  await viewer.getByRole('button', { name: '更多', exact: true }).click();
  await page.locator('.sh-menu [role^="menuitem"]', { hasText: text }).first().click();
}
