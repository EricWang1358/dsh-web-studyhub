/* global document, KeyboardEvent */
import assert from 'node:assert/strict';

// Drive the mounted panel's real key handler while a host layer owns Escape.
export async function dismissAfterOverlay(page, panel, { externalInput = false } = {}) {
  const overlay = await page.evaluateHandle(() => {
    const element = document.createElement('div');
    element.setAttribute('role', 'dialog');
    element.textContent = 'Host dialog';
    document.body.append(element);
    return element;
  });
  try {
    await page.keyboard.press('Escape');
    assert.ok(await panel.isVisible(), 'the visible host dialog keeps Escape');
    await overlay.evaluate(element => { element.hidden = true; });
    for (const mode of ['composing', 'handled']) {
      await panel.evaluate((element, kind) => {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: kind === 'composing' });
        if (kind === 'handled') event.preventDefault();
        element.dispatchEvent(event);
      }, mode);
      assert.ok(await panel.isVisible(), `the panel ignores an Escape that is ${mode}`);
    }
    if (externalInput) {
      await panel.evaluate(() => {
        const field = document.createElement('textarea');
        document.body.append(field);
        try { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }
        finally { field.remove(); }
      });
      assert.ok(await panel.isVisible(), 'Escape in another editor leaves the feedback tray open');
    }
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
  } finally {
    await overlay.evaluate(element => element.remove());
    await overlay.dispose();
  }
}
