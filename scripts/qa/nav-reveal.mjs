/* A sidebar row on screen, the way a learner gets to it (#654, #657): in a workspace too narrow for the sidebar it is in a drawer behind the top
   bar's menu button, and a page the main list does not hold is folded into 「更多」. Browser tests and QA walks call this before they click a row,
   so they press what a learner presses instead of reaching into a closed fold. */

/** Open the drawer (when the sidebar is one) and 「更多」 (when the row is folded in it); returns the row's locator. */
export async function revealNavRow(page, id, { timeout = 30000 } = {}) {
  await page.locator('.sidebar, .nav-menu-toggle').first().waitFor({ timeout });
  if (!await page.locator('.sidebar').count()) {
    await page.locator('.nav-menu-toggle').first().click();
    await page.locator('.nav-drawer .sidebar').waitFor({ timeout });
  }
  const row = page.locator(`[data-tour="nav-${id}"]`).first();
  await row.waitFor({ state: 'attached', timeout });
  const folded = await row.evaluate((element) => { const fold = element.closest('details'); return !!fold && !fold.open; });
  if (folded) {
    await page.locator('[data-tour="nav-more"]').first().click();
    await row.waitFor({ state: 'visible', timeout });
  }
  return row;
}
