/* Browser tests and QA scripts: a row's ▶ without an open run, and S / 回到题目 with nothing to resume, ask before they start (ui/app/AppModalHost.jsx
   StartConfirm). These press 开始练习 in that dialog. */
const DIALOG = 'dialog.confirm-start';
const CONFIRM = `${DIALOG} .sh-dialog__footer .sh-btn--primary`;

/** The press that starts a new round: wait for the question and say yes. A page that does not ask fails here. */
export async function confirmStart(page, { timeout = 30000 } = {}) {
  await page.locator(CONFIRM).click({ timeout });
  await page.locator(DIALOG).waitFor({ state: 'detached', timeout });
}

/** A press that starts or resumes, as the library happens to be: answers the question when it is asked. `arrived` is what the page shows once the round is open. Returns whether it asked. */
export async function confirmStartIfAsked(page, arrived, { timeout = 30000 } = {}) {
  await page.locator(DIALOG).or(arrived).first().waitFor({ timeout });
  if (!await page.locator(DIALOG).count()) return false;
  await confirmStart(page, { timeout });
  return true;
}
