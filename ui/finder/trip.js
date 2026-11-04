/* 找功能: what 「带我去」 does, decided apart from the DOM (ui/finder/use-finder.js does the moving). Pure.

   planTrip     where to stand: an entry that is on the page already needs no navigation, a control behind something the finder cannot do for the learner
                (an open document, a round of practice, a draft) is reached from the page named by its `prepare`, and a settings anchor is a settings link
                (that is what selects its category).
   tripNotice   the toast that says where the control is, when it cannot simply be lit: the path, then what is left to do. Nothing when the control was
                found where the entry says it is. */
import { ui, uiFormat } from '../i18n.js';
import { PREPARE_STEPS } from './entries.js';

/** `{ here, land, settings }` for an entry and the page the learner is on. `here`: look on this page first; `land`: the page to go to otherwise (null: stay); `settings`: the anchor to open Settings at. */
export function planTrip(entry, { page }) {
  const here = entry.page === null || entry.page === page;
  const land = PREPARE_STEPS[entry.prepare]?.land ?? entry.page;
  return { here, land: here ? null : land, settings: entry.page === 'settings' ? entry.anchors[0] ?? null : null };
}

/** The path as the learner reads it: 「资料 › 打开一份资料 › 工具栏 › 翻译」. */
export const pathText = (entry) => entry.path.map((crumb) => ui(crumb)).join(' › ');

/**
 * The toast for a trip, or null. `found` is the index in `entry.anchors` of the anchor that was lit, or -1 for none. The words of what is left to do
 * (`prepare`) are said when nothing was found, when only the page's gateway was (the last of several anchors: the list a document is opened from), and
 * always for a step that ends behind a menu (`after`).
 */
export function tripNotice(entry, found) {
  const step = PREPARE_STEPS[entry.prepare];
  const gateway = found >= 0 && entry.anchors.length > 1 && found === entry.anchors.length - 1;
  const say = found < 0 || (step && (gateway || step.after));
  if (!say) return null;
  const where = uiFormat('在「{0}」里。', [pathText(entry)]);
  return { text: step ? `${where}${ui(step.text)}` : where, tone: 'info' };
}
