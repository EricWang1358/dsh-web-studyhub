/* The words the home uses for its numbers, and what each one counts (docs/feature-tiers.md).

   The walkthrough found seven "mastery" numbers on a first look. They are not seven scores: they are counts of the same
   questions seen from different sides. This module gives each one a plain label and a one-line meaning for a hover, and
   invents no new score: the percentages still come from lib/mastery.js (new 0, weak 15%, learning 45%, familiar 75%,
   mastered 100%, averaged over the questions). Labels and hints are Chinese source text; callers pass them through ui(). */

export const TERMS = Object.freeze({
  due: { label: "到期", hint: "到了复习时间、该复习的题（含已逾期的）。复习本身不调用模型。" },
  learned: { label: "学过", hint: "至少答过一次的题。" },
  mastered: { label: "已掌握（间隔复习累积）", hint: "已掌握（间隔复习累积）：复习间隔已累积到 3 周以上，或你自评「轻松」的题。" },
  familiar: { label: "熟悉", hint: "熟悉：答对过，复习间隔已到 6 天以上。" },
  learning: { label: "学习中", hint: "学习中：答对过，但复习间隔还不到 6 天。" },
  weak: { label: "薄弱", hint: "最近一次答错、或自评没记住的题。" },
  new: { label: "未学", hint: "还没答过的题。" },
  mastery: { label: "掌握度", hint: "掌握度：把每道题按级别折算（未学 0、薄弱 15%、学习中 45%、熟悉 75%、已掌握 100%）再取平均，不是正确率。" },
});

/** The hint of each mastery level, for the legend. */
export const LEVEL_HINT = Object.freeze({ mastered: TERMS.mastered.hint, familiar: TERMS.familiar.hint, learning: TERMS.learning.hint, weak: TERMS.weak.hint, new: TERMS.new.hint });
