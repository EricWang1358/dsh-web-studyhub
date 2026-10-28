/* The words the home uses for its numbers, and what each one counts (docs/feature-tiers.md).

   The walkthrough found seven "mastery" numbers on a first look. They are not seven scores: they are counts of the same
   questions seen from different sides. This module gives each one a plain label and a one-line meaning for a hover, and
   invents no new score: the percentages still come from lib/mastery.js (new 0, weak 15%, learning 45%, familiar 75%,
   mastered 100%, averaged over the questions). Labels and hints are Chinese source text; callers pass them through ui(). */

export const TERMS = Object.freeze({
  due: { label: "到期", hint: "到了复习时间、该复习的题（含已逾期的）。复习本身不调用模型。" },
  learned: { label: "学过", hint: "至少答过一次的题。" },
  mastered: { label: "已掌握（间隔复习累积）", hint: "已掌握（间隔复习累积）：连续答对至少两次、复习间隔已累积到 3 周以上的题（设置的最长间隔更短时，到最长间隔即可），或你自评「轻松」的题。" },
  familiar: { label: "熟悉", hint: "熟悉：答对过，复习间隔已到 6 天以上（设置的最长间隔更短时，到最长间隔即可）。" },
  learning: { label: "学习中", hint: "学习中：答对过，但复习间隔还不到 6 天。" },
  weak: { label: "薄弱", hint: "最近一次答错、或自评没记住的题。" },
  new: { label: "未学", hint: "还没答过的题。" },
  mastery: { label: "掌握度", hint: "掌握度：把每道题按级别折算（未学 0、薄弱 15%、学习中 45%、熟悉 75%、已掌握 100%）再取平均，不是正确率。" },
});

/** The hint of each mastery level, for the legend. */
export const LEVEL_HINT = Object.freeze({ mastered: TERMS.mastered.hint, familiar: TERMS.familiar.hint, learning: TERMS.learning.hint, weak: TERMS.weak.hint, new: TERMS.new.hint });

/* ── The other words the interface assumes ─────────────────────────────────────────────────────────────────────────────────
   Not numbers but names: 主会话, 总纲, 覆盖强度, 前置题 and the two places everything lives in. The interface uses them as if
   everyone knew them; this table says what each one is, in the same shape as TERMS above (label + one-line hint) and in the one
   place whose job is naming things. The sidebar's 名词解释 entry shows the table on hover and on focus (ui/app/AppSidebar.jsx),
   so the words are explained where a learner meets them without hunting through Settings.

   The labels are the interface's own words (the same strings the buttons and headings use); the hints are Chinese source text,
   read through ui() like every other sentence. */
export const GLOSSARY = Object.freeze({
  mainChat: { label: '主会话', hint: 'DSH 里和你对话的那个窗口。练习、导入和出题，都可以回到那里说一声。' },
  outline: { label: '总纲', hint: '一门课的资料按章节排成的树，题放在它们指向的位置；复习全书按总纲来排。' },
  coverage: { label: '覆盖强度', hint: '出题时资料要覆盖到什么程度：精简、标准、完整。选得越完整，题越多，也花得越多。' },
  prerequisite: { label: '前置题', hint: '先补基础的题：按这道题用到的知识出一道更基础的题，练完可以回到原题。' },
  library: { label: '学习库', hint: '你电脑上的一个文件夹，资料、题组和复习记录都保存在里面。' },
  deck: { label: '题组', hint: '一组题。发布后可以反复练，复习进度和错题都按题组记。' },
});

/* ── Every "how well" number has its own name ────────────────────────────────────────────────────────────────────────────
   A learner meets five of them: the state of the questions (Home, 资料, the reader), the 30-day rates on the dashboard (three of
   them), and the counts of one round (the result page, the coach card). They measure different things, so they carry different
   names, said here and nowhere else:
     掌握度        the state of the questions NOW: each question's level averaged (TERMS.mastery above). The only number called this.
     达标率        of the last 30 days' answers, the share that scored 3 or more, by cognitive level or question type; auto-graded and self-rated together.
     客观题通过率   the same share for auto-graded answers only (choice, fill-in, exams).
     自评达标率     the same share for self-rated answers only (flashcards, open questions).
     客观题答对 / 自评达标   how many answers of this round (a count, not a rate), split the same two ways.
   A rate over fewer than MIN_ANSWERS answers is shown as 数据不足, never as a percentage that proves nothing. */
export const MIN_ANSWERS = 3;
export const THIN_DATA = "数据不足";

export const MEASURES = Object.freeze({
  mastery: TERMS.mastery,
  passRate: { label: "达标率" },
  gradedRate: { label: "客观题通过率", hint: "近 30 天单选、多选、填空及考试的自动判分，不含本轮队尾重练" },
  selfRate: { label: "自评达标率", hint: "近 30 天闪卡和开放问答的掌握程度自评，3 分及以上算达标" },
  roundGraded: { label: "客观题答对" },
  roundSelf: { label: "自评达标" },
});

/** Is a rate over `answers` answers worth showing as a number? */
export const enoughAnswers = (answers, minimum = MIN_ANSWERS) => Number.isFinite(answers) && answers >= minimum;
