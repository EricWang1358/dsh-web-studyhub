import { META_DOT } from '../format.js';
import { ui, uiFormat } from '../i18n.js';
import { ROLES } from './model.js';

/* 备考补习, the words of the create form: the role names, the reason a suggestion carries, the counting sentences and the default name.
   The reason codes are those of lib/exam-prep-roles.js (plus two of the form's own: other-course, chosen). */

/** The name of a role as a control shows it. */
export const roleName = role => ({ lecture: ui('课件'), 'past-paper': ui('样卷'), syllabus: ui('大纲'), none: ui('不用') })[role] ?? '';

/** The options of a role control, in the order a learner reads them: the three uses, then 不用. */
export const roleOptions = () => [...ROLES, 'none'].map(value => ({ value, label: roleName(value) }));

/** Why a document has the role it has, in a few words. `reason` is { code, word? }; a role the learner changed says so. */
export function reasonWords(reason) {
  switch (reason?.code) {
    case 'default-lecture': return ui('默认当作课件');
    case 'slides': return ui('PowerPoint，当作课件');
    case 'name-paper': case 'name-syllabus': return uiFormat('文件名含「{0}」', [reason.word]);
    case 'course-guidance': return ui('课程设置里把它标为了考试说明');
    case 'too-big': return ui('页数很多，默认不用');
    case 'not-text': return ui('不是文字资料，不能用来列考点');
    case 'auto-off': return ui('已关闭自动识别，默认当作课件');
    case 'other-course': return ui('其它课程的资料，默认不用');
    case 'chosen': return ui('按你的选择');
    default: return '';
  }
}

/** The action under a document whose name only looks like a sample paper (the hint `maybe-paper`). */
export const maybePaperWords = () => ui('名字像样卷？设为样卷');

const partOf = (role, count) => ({
  lecture: count === 1 ? ui('1 份课件') : uiFormat('{0} 份课件', [count]),
  'past-paper': count === 1 ? ui('1 份样卷') : uiFormat('{0} 份样卷', [count]),
  syllabus: count === 1 ? ui('1 份大纲') : uiFormat('{0} 份大纲', [count]),
})[role];

/** Above the table: 「6 份课件 · 2 份样卷」 (a syllabus joins when there is one; the papers are always counted, 0 included). */
export const countsLine = counts => ROLES.filter(role => role !== 'syllabus' || counts[role] > 0).map(role => partOf(role, counts[role])).join(META_DOT);

/** Said when no document is a sample paper: what the list will and will not tell. */
export const noPaperWords = () => ui('没有样卷：所有考点都是补充，不会标出样卷考过的点');

/** The name a list gets when the learner types none: the course (else the first slides) and 考点清单, with the date when the course already has that name. */
export function defaultTitleWords(name, date) {
  const base = name ? uiFormat('{0} 考点清单', [name]) : ui('考点清单');
  return date ? `${base}${META_DOT}${date}` : base;
}
