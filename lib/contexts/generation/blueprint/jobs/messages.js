import { BLUEPRINT_LIMITS } from '../../../../exam-blueprint-material.js';
import { TIER_LABEL } from '../../../../exam-point-list.js';

/* The wording of a 考点清单 build (the feature the learner sees is 备考补习), in the language the learner asked it in. Chinese is the source text; English sits
   beside it, so no entry is needed in lib/application-messages-en.js. The words blueprint / 蓝图 are code names and never appear here.
   This is the only file of the folder that holds such text. */
const say = (language, zh, en) => language === 'en' ? en : zh;

export const BLUEPRINT_TITLE = '考点清单';

/** The pages of a window as a learner reads them. */
const range = pages => pages.length > 1 ? `${pages[0]}–${pages.at(-1)}` : `${pages[0]}`;
export const PAGES = (language, pages) => !pages?.length ? '' : say(language, `第 ${range(pages)} 页`, `page${pages.length > 1 ? 's' : ''} ${range(pages)}`);

/** What a list that skipped windows of slides says of them (the windows are `{ number, pages }`). */
export function skippedText(language, windows) {
  if (!windows.length) return '';
  const pages = windows.map(item => PAGES(language, item.pages)).filter(Boolean);
  return say(language, `课件${pages.join('、') || `有 ${windows.length} 段`}没读出来，清单不完整`,
    `${pages.join(', ') || `${windows.length} part(s) of the slides`} could not be read; the list is not complete`);
}

export function stageText(language, stage, state) {
  const paper = `${Math.min(state.papers.done + 1, state.papers.total)}/${state.papers.total}`;
  const window = `${Math.min(state.windows.done + 1, state.windows.total)}/${state.windows.total}`;
  const saved = say(language, `考点清单已保存：${state.points} 个考点`, `Exam point list saved: ${state.points} exam points`);
  return {
    queued: say(language, '等待开始', 'Waiting to start'),
    checking: say(language, '正在检查资料', 'Checking the materials'),
    paper: say(language, `正在读样卷 ${paper}：每道题考哪些考点`, `Reading sample paper ${paper}: what each question tests`),
    merge: say(language, '正在合并几份样卷的考点', 'Uniting the exam points of the sample papers'),
    mergeExtra: say(language, '正在合并课件里找到的补充考点', 'Uniting the extra exam points found in the slides'),
    slides: say(language, `正在到课件里找出处 ${window}`, `Finding the places in the slides ${window}`),
    saving: say(language, '正在检查出处并保存', 'Checking the places and saving'),
    complete: state.skippedWindows.length ? `${saved}${say(language, '；', '; ')}${skippedText(language, state.skippedWindows)}` : saved,
    cancelled: say(language, '已取消，没有保存考点清单', 'Cancelled; no exam point list was saved'),
    paused: say(language, '已暂停，点「继续」接着做', 'Paused; resume to go on'),
  }[stage] ?? '';
}

export const FAILURES = Object.freeze({
  unreadable: (language, where) => say(language,
    `${where}的内容读不出来（模型两次都没有给出可用的答案），没有保存考点清单；可以重试`,
    `The ${where} could not be read (the model gave no usable answer twice); no exam point list was saved. You can retry`),
  noPoints: language => say(language, '没有一个考点能找到出处，没有保存考点清单',
    'Not one exam point could be traced to the materials; no exam point list was saved'),
  saveInvalid: language => say(language,
    '考点清单没能保存：生成的内容没有通过检查。没有保存任何内容；可以重试，已读出的部分会沿用，不会重新请求模型',
    'The exam point list could not be saved: what was made did not pass the checks. Nothing was saved. You can retry; what was read is kept and the model is not asked again'),
  saveFailed: language => say(language,
    '考点清单没能保存到资料库。没有保存任何内容；可以重试，已读出的部分会沿用，不会重新请求模型',
    'The exam point list could not be saved to the library. Nothing was saved. You can retry; what was read is kept and the model is not asked again'),
});

/** Where a failure happened, said both ways. */
export const WHERE = Object.freeze({
  slides: (language, pages) => say(language, `课件${pages ? `（${pages}）` : ''}`, `slides${pages ? ` (${pages})` : ''}`),
  paper: language => say(language, '样卷', 'sample paper'),
});

const { titleChars, inputSources } = BLUEPRINT_LIMITS;
export const REFUSALS = Object.freeze({
  'blueprint-disabled': language => say(language, '备考补习还没有开放', 'Exam preparation is not available yet'),
  'blueprint-title-required': language => say(language, '请给考点清单起个名字', 'Give the exam point list a name'),
  'blueprint-title-too-long': language => say(language, `考点清单的名字最多 ${titleChars} 个字`,
    `The name of the exam point list can have at most ${titleChars} characters`),
  'blueprint-scope-too-long': language => say(language, `范围的说明最多 ${titleChars} 个字`,
    `The description of the scope can have at most ${titleChars} characters`),
  'blueprint-reading-invalid': language => say(language,
    '推荐阅读的信息有误：要有书名，网址要以 http:// 或 https:// 开头，各项也不能太长',
    'The recommended reading is not valid: it needs a title, a web address must start with http:// or https://, and no part may be too long'),
  'blueprint-input-too-large': language => say(language, `一份资料最多 ${inputSources} 页（份）；请少选一些，或分几次来做`,
    `One material can have at most ${inputSources} pages or files; choose fewer, or do it in several steps`),
  'blueprint-input-invalid': language => say(language, '资料的选择有误：每份资料都要有用途，而且考点清单不能当作资料',
    'The choice of materials is not valid: every material needs a role, and an exam point list cannot be used as a material'),
  'blueprint-needs-primary-input': language => say(language, '请选择课件（或考试大纲）：考点要从它们里列出来',
    'Choose lecture slides (or a syllabus): the exam points are listed from them'),
  'blueprint-supersedes-invalid': language => say(language, '要替换的考点清单不存在，或不是考点清单',
    'The exam point list to replace does not exist or is not an exam point list'),
  'blueprint-input-missing': language => say(language, '所选的某份资料不在资料库里', 'A chosen material is not in the library'),
  'blueprint-no-readable-text': language => say(language, '所选资料里没有可读的文字（只有图片？）', 'The chosen materials have no readable text (pictures only?)'),
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能建考点清单',
    'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});

/** Stand-ins of a typical size for the candidates and points of the later calls, so the estimate prices a realistic prompt. */
export const STANDIN = Object.freeze({ title: '考点名称'.repeat(2), parent: '大考点名称' });

/** The description of the build call in the contract (what a tool or a person reads about it). */
export const BUILD_DESCRIPTION = [
  `Build an exam point list (${BLUEPRINT_TITLE}, the result of 备考补习) from sample papers and lecture slides, as one background job. `,
  'Bottom-up: each chosen sample paper is read for the exam points its questions test (two levels, 大考点 and 小考点), ',
  'the points of several papers (or several chunks of one paper) are united, then the slides are read in windows ',
  'for where each point is taught and for what the papers did not reach; the extra points of the windows are united too. ',
  `A point a sample paper reached is ${TIER_LABEL.must} (must) and says how many of the chosen papers tested it; `,
  `a point only the slides teach is ${TIER_LABEL.extra} (extra); with no sample paper every point is ${TIER_LABEL.extra}. `,
  'Inputs name a role (lecture, syllabus, past-paper, textbook, answer-key) and the materials (documentId or sourceIds); ',
  'lecture slides or a syllabus are required, any number of past-paper inputs is allowed, a textbook is never a source of points, ',
  'an exam point list is not a valid input. Refusals carry a code (blueprint-disabled, blueprint-needs-primary-input, ',
  'blueprint-input-missing, blueprint-input-invalid, blueprint-input-too-large, blueprint-no-readable-text, blueprint-title-required, ',
  'blueprint-title-too-long, blueprint-scope-too-long, blueprint-reading-invalid) and cost nothing. ',
  'estimate:true prices the build without starting it. The list is one material saved at the end; a stop or a failure saves nothing. ',
  'A window of slides that cannot be read after two answers is skipped and the list is saved marked partial.',
].join('');
