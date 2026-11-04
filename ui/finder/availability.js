/* 找功能: can this host take the learner to an entry? An entry that cannot is shown greyed with the reason and without 「带我去」: it is never hidden,
   because "this DSH does not have it" is also an answer. What decides it is what the registries already say: the page's host contexts and switch
   (ui/pages.js, ui/capabilities.js), and what the entry itself needs (a settings category's `needs`, a feature's `needs`). Pure. */
import { PAGES } from '../pages.js';
import { hasContext } from '../capabilities.js';
import { uiFormat } from '../i18n.js';

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** The reason (source text through ui()) this host cannot take the learner to `entry`, or '' when it can. A term has nowhere to go and is never unavailable. */
export function finderAvailability(entry, data) {
  if (!entry || entry.kind === 'term') return '';
  const page = entry.page ? PAGES[entry.page] : null, needs = entry.needs || {};
  const flag = needs.flag || page?.flag;
  if (flag && data?.features?.[flag] !== true) return uiFormat('这个 DSH 里没有开启{0}', [Object.values(PAGES).find((item) => item.flag === flag)?.label || flag]);
  const missing = [...new Set([...list(needs.capability), ...list(page?.needs)])].filter((context) => !hasContext(data, context));
  return missing.length ? uiFormat('这个 DSH 里没有启用它需要的组件：{0}', [missing.join('、')]) : '';
}

/** The entries with `unavailable` set to the reason (or ''), for the sheet. */
export const withAvailability = (entries, data) => entries.map((entry) => ({ ...entry, unavailable: finderAvailability(entry, data) }));
