import { TIER_LABEL } from '../../lib/exam-point-list.js';
import { ui, uiFormat } from '../i18n.js';

/* 备考补习: the sentences of the page. Chinese is the source text and English sits beside it (ui/locales/en.exam-prep.json).
   The learner-facing names are 备考补习 (the page) and 考点清单 (what it lists); the internal word for a list never appears in a string. */

/** The word of a tier is the library's own (lib/exam-point-list.js TIER_LABEL), so the page, the console and the data say the same thing. */
export const tierName = tier => ui(TIER_LABEL[tier === 'must' ? 'must' : 'extra']);

export const countsLine = ({ must, extra }) => `${tierName('must')} ${must} · ${tierName('extra')} ${extra}`;

/** How a point is backed: the record's own count, else the sample papers among its places. */
const backingOf = point => {
  const places = Array.isArray(point?.evidence) ? point.evidence : [];
  return point?.backing || { slides: new Set(places.filter(place => place.role === 'lecture' || place.role === 'syllabus').map(place => place.sourceId)).size,
    samplePapers: new Set(places.filter(place => place.role === 'past-paper').map(place => place.sourceId)).size };
};

/** The tier badge of a point: 样卷考过（N/M 份）, N the papers that tested it and M the papers the list rests on (the total is left out when the list does not say it); 补充 otherwise. */
export function tierWords(tier, point, basis) {
  if (tier !== 'must') return tierName('extra');
  const tested = Number(backingOf(point).samplePapers) || 0, total = basis?.samplePapers;
  return Number.isFinite(total) && tested > 0 ? uiFormat('{0}（{1}/{2} 份）', [tierName('must'), tested, total]) : tierName('must');
}

/** Said on a list whose materials changed after it was made (the snapshot's `stale`). */
export const staleNote = () => ui('资料已更新，建议重新生成');

const slidesPart = count => count === 1 ? ui('1 页课件') : uiFormat('{0} 页课件', [count]);
const papersPart = count => count === 1 ? ui('1 份样卷') : uiFormat('{0} 份样卷', [count]);

/** How a point is backed, in words: 「出现在 2 页课件 + 1 份样卷」. Counted from the record's backing, else from its places. */
export function backingLine(point) {
  const backing = backingOf(point);
  const slides = Number(backing.slides) || 0, papers = Number(backing.samplePapers) || 0;
  if (slides && papers) return uiFormat('出现在 {0}', [`${slidesPart(slides)} + ${papersPart(papers)}`]);
  if (slides) return uiFormat('出现在 {0}', [slidesPart(slides)]);
  return papers ? uiFormat('只出现在 {0}', [papersPart(papers)]) : '';
}

/** What the list rests on, in one line (the wording of the data's own `basis.label`, in the current language): how many sample papers, and what that cannot tell. */
export function basisLine(basis) {
  const papers = basis?.samplePapers;
  if (!Number.isFinite(papers)) return '';
  if (papers === 0) return ui('没有样卷，无法判断哪些考点样卷考过');
  if (papers === 1) return ui('依据 1 份样卷；样卷考过的范围可能不全');
  if (papers < 3) return uiFormat('依据 {0} 份样卷（取并集）；样卷考过的范围可能不全', [papers]);
  return uiFormat('依据 {0} 份样卷（取并集）；样本由学生选定，不是随机样本', [papers]);
}

/* The hover explanations: one plain sentence and at most one line of consequence, each reachable by hover and by keyboard focus (Tooltip). */
export const EXPLAIN = Object.freeze({
  'tier.must': ['样卷考过：你选的样卷里有题考到这个考点。', '只代表这几份样卷考过，不保证期末一定考。'],
  'tier.extra': ['补充：只在课件里讲到，样卷里没有题考它。', '它可能考也可能不考；没选样卷时，所有考点都是补充。'],
  'basis': ['样卷考过的范围是按你选的样卷划出来的。', '样卷少于 3 份时这个范围可能不全；没标样卷考过的也不等于不考。'],
  'peek': ['打开这条依据所在的那一页。', '会在阅读器里打开，关闭后回到这里。'],
  'peek.paper': ['打开这道样卷题所在的位置。', '会在阅读器里打开，关闭后回到这里。'],
  'noSlides': ['样卷里有题考到它，但你选的课件里找不到讲它的内容。', '可能是课件没导入全，或老师没讲过；先别当作已经学过。'],
  'regenerate': ['按现在选的资料重新列一份考点清单。', '会消耗模型额度；新清单取代旧清单，旧清单作为历史版本保留。'],
  'estimate': ['这是按你选的资料估出的范围，不是账单。', '实际用量取决于模型的回答和重试，可能有出入。'],
  'roles': ['每份资料有一个用途：课件和大纲用来列考点，样卷用来标出样卷考过的点，「不用」是这次不读它。', '用途是按文件名和篇幅猜好的，猜错了点一下就能改。'],
  'role.textbook': ['推荐教材：只记下书名，提醒你有这本书。', '它不是依据，不会被读取，也不会用来列考点。'],
  'delete': ['删除这份考点清单。', '删除后无法恢复。'],
  'restore': ['把这个旧版本放回考点清单。', '它会和新版本一起显示。'],
  'unmatched': ['这些样卷题在你选的课件里找不到对应的内容。', '它们没有变成考点；可以补导入资料后重新生成。'],
  'skipped': ['这些课件页只有图片，没有可读的文字。', '它们没有列进考点；可以导出成 PDF 再导入试试。'],
  'reading': ['老师推荐的书，这里只是一条备注。', '它不是依据，考点不是从它列出来的。'],
  'building': ['这份清单正在后台生成。', '进度在任务页；完成后这里会自动更新。'],
});

/** [sentence, consequence?] in the current language, or null for a name nobody explained. */
export function explain(key) {
  return Object.hasOwn(EXPLAIN, key) ? EXPLAIN[key].map(text => ui(text)) : null;
}

/**
 * A refusal of the build in plain words. The operation answers in the learner's language (a message per code, nothing was spent), and that message is shown as given;
 * these are the words for the same codes when none came with it.
 */
export function refusalWords(error) {
  const given = typeof error?.message === 'string' ? error.message.trim() : '';
  if (given) return given;
  switch (error?.code) {
    case 'blueprint-needs-primary-input': return ui('请选择课件（或考试大纲）：考点要从它们里列出来');
    case 'blueprint-no-readable-text': return ui('所选资料里没有可读的文字（只有图片？）');
    case 'blueprint-input-missing': return ui('所选的某份资料不在资料库里');
    case 'blueprint-input-invalid': return ui('资料的选择有误：每份资料都要有用途，而且考点清单不能当作资料');
    case 'blueprint-title-required': return ui('请给考点清单起个名字');
    case 'blueprint-disabled': return ui('备考补习还没有开放');
    case 'capability-unverified': return ui('共享的模型额度还没有验证，暂时不能建考点清单');
    case 'executor-unavailable': return ui('后台执行器暂时不可用，请稍后再试');
    case 'scope-unloaded': return ui('学习插件正在关闭，没有开始');
    default: return ui('没有完成，请再试一次。');
  }
}
