/* The generation run the journey creates through the API for a step that runs without the earlier ones, apart from the journey itself so a unit test can run
   it without starting a browser. */
import { DEFAULT_LEVEL, autoCompleteOf } from "../../lib/coverage-strength.js";

/** What 创建题组 would send for these materials and 4 questions of one's own: the form always sends its 覆盖强度 and whether the run goes on by itself. A request
 *  without them is a plain run, which can end 「补题」: its card then stands on the first-run line and the steps that wait for 发布并开始练 or 检查草稿 find neither. */
export function seedGeneration(lang, sourceIds) {
  return { sourceIds, count: 4, kind: "quiz", title: "QA seed", language: lang === "en" ? "English" : "中文",
    coverageLevel: DEFAULT_LEVEL, autoComplete: autoCompleteOf(DEFAULT_LEVEL) };
}
