import { ui, uiFormat } from './i18n.js';
import { formatDateTime } from './format.js';

/* The words of 考前对齐 (#882) shared by the Settings switch and the course settings: what a pass moved, and an exam date as
   the learner reads it. */

/** 「已把 3 道题提前到考试前；2 道题恢复了原来的日期」 for a pass's `{ pulled, restored }`; '' when nothing moved. */
export function alignmentReceipt(result) {
  const pulled = Number(result?.pulled) || 0, restored = Number(result?.restored) || 0;
  return [pulled ? uiFormat('已把 {0} 道题提前到考试前', [pulled]) : '', restored ? uiFormat('{0} 道题恢复了原来的日期', [restored]) : '']
    .filter(Boolean).join(ui('；'));
}

/** A YYYY-MM-DD exam date on the learner's calendar (never read as UTC midnight), in `shape` of ui/format.js. */
export function examDateText(date, shape = 'day') {
  const [year, month, day] = String(date || '').split('-').map(Number);
  return year && month && day ? formatDateTime(new Date(year, month - 1, day), shape) : '';
}
