import { ui } from '../i18n.js';

/** Opens the 帮我弄懂 assist panel pre-selected on the requested chip without auto-firing a paid model call. */
export function openAssistPanel(root, choice = 'plain') {
  if (!root?.querySelector) return false;
  const selectChoice = () => {
    const form = root.querySelector('.assist-form');
    if (!form) return false;
    const label = choice === 'plain' ? ui('通俗详解') : '';
    if (label) {
      const chips = [...form.querySelectorAll('.assist-quick-choices button')];
      const chip = chips.find((btn) => (btn.textContent || '').trim() === label);
      if (chip && chip.getAttribute?.('aria-pressed') !== 'true') chip.click?.();
    }
    const input = form.querySelector('.assist-form__input');
    if (input?.focus) input.focus({ preventScroll: true });
    return true;
  };
  if (selectChoice()) return true;
  const helpBtn = root.querySelector('[data-tour="review-help"]');
  if (!helpBtn) return false;
  if (helpBtn.getAttribute?.('aria-expanded') !== 'true') helpBtn.click?.();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => selectChoice());
  else selectChoice();
  return true;
}
