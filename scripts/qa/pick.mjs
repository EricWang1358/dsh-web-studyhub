/* Choosing in a Select or Combobox from a QA script or a browser test. The popup is Base UI's (ui/components/Select.jsx, Combobox.jsx): options are
   role="option" rows without a value attribute, so they are picked by their visible text, the way a learner does. `selectOption` no longer applies. */

/** The open popup (a Select keeps its closed popup in the page, hidden, so only the open one counts). */
export const openPopup = (page) => page.locator('.sh-pop__popup:not([data-closed])').last();

async function open(page, trigger) {
  const target = typeof trigger === 'string' ? page.locator(trigger).first() : trigger;
  if ((await target.getAttribute('aria-expanded')) !== 'true') await target.click();
  const popup = openPopup(page);
  await popup.waitFor();
  return { target, popup };
}

async function finish(page, target, popup) {
  await popup.waitFor({ state: 'hidden' });
  // Focus returns to the trigger once the popup has finished closing.
  await page.waitForFunction((element) => document.activeElement === element, await target.elementHandle(), { timeout: 3000 }).catch(() => {});
}

/** Open `trigger` (a locator or selector) and choose the option whose text contains `label` (`exact`: equals it). A Combobox is searched first. */
export async function pick(page, trigger, label, { exact = false } = {}) {
  const { target, popup } = await open(page, trigger);
  const search = popup.locator('.sh-combobox__input');
  if (typeof label === 'string' && await search.count()) await search.fill(label);
  await popup.getByRole('option', { name: label, exact }).first().click();
  await finish(page, target, popup);
}

/** Open `trigger` and choose the option at `index` (0 is the first option of the list; a placeholder is not an option). */
export async function pickNth(page, trigger, index = 0) {
  const { target, popup } = await open(page, trigger);
  await popup.getByRole('option').nth(index).click();
  await finish(page, target, popup);
}

/** The visible text of the options of an open or closed trigger's popup, closing it again. */
export async function optionTexts(page, trigger) {
  const { target, popup } = await open(page, trigger);
  const texts = (await popup.getByRole('option').allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim());
  await page.keyboard.press('Escape');
  await finish(page, target, popup);
  return texts;
}
