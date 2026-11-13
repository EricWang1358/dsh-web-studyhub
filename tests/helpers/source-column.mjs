/* The way back to the question from a reader opened by a link of the question (看这题的原文, 看原页): on a wide practice page the reader is the 对照栏
   beside the question (#1012), which has no 回到这道题 and is closed by its own 关闭资料栏 (Esc in it only gives the focus back to the question); on a narrow
   page it is the dialog over the question, whose way back is 回到这道题. Clicks whichever the page has, and returns which it was. */
export async function backToQuestion(page) {
  const column = page.locator('.source-column');
  if (await column.count()) {
    await column.getByRole('button', { name: '关闭资料栏' }).click();
    await column.waitFor({ state: 'detached' });
    return 'column';
  }
  await page.locator('.study-document-viewer').getByRole('button', { name: '回到这道题' }).click();
  return 'dialog';
}
