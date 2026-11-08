/* The question-deck JSON format example: the import page shows it, the copy-out prompt (ui/json-prompts.js) embeds it and the main session reads
   it in library.context area decks (lib/study-contracts.js). One example, so the three never disagree. Pure data: safe to bundle into the browser. */
import { CARD_KIND_IDS, fixedOptionsOf, hasOptions, oneAnswer } from './card-kinds.js';

export function importExample(kind, language = "zh") {
  if (language === "en") return JSON.stringify(englishExample(JSON.parse(importExample(kind))), null, 2);
  if (kind === "mixed") {
    const cards = CARD_KIND_IDS.map((type) => JSON.parse(importExample(type)).cards[0]);
    const objectives = { quiz: "识别可直接二分查找的序列", multi: "辨别二分查找支持的排序方向", truefalse: "判断关于二分查找输入的说法",
      flashcard: "回忆二分查找的输入条件", open: "解释无序输入为何不能排除半区", cloze: "补全二分查找的前提条件",
      task: "动手写出有序序列二分查找的区间收缩实现或推导步骤" };
    cards.forEach((card) => { card.objective = objectives[card.kind]; });
    const open = cards.find((card) => card.kind === "open");
    open.prompt = "为什么不能直接对无序序列进行二分查找？请解释原因。";
    open.answer = "无序序列中，中间值与目标的大小关系无法确定目标位于哪一半，因此不能安全排除半区。";
    return JSON.stringify({ title: "二分查找混合练习", folder: "算法", cards }, null, 2);
  }
  const card = {
    kind, topic: "二分查找", objective: "解释二分查找的输入条件",
    prompt: "二分查找对输入序列有什么要求？", answer: "序列需要有序。",
    hint: "考虑每次排除一半范围的依据。", explanation: "只有有序序列才能通过比较中间值排除一半搜索范围。",
    misconception: "误以为任意序列都能直接二分查找。",
  };
  if (fixedOptionsOf(kind)) {
    // 判断题: the prompt is the statement judged; a false one says the true statement in its answer and explanation.
    card.prompt = "二分查找可以直接用于任意无序序列。";
    card.answer = "错。正确说法：二分查找要求序列有序。";
    card.explanation = "只有有序序列才能通过比较中间值排除一半搜索范围，所以这个说法是错的；正确说法是：二分查找要求序列有序。";
    card.options = [
      { id: "true", text: "对", correct: false, explanation: "无序序列中，中间值与目标的大小关系无法说明目标在哪一半。" },
      { id: "false", text: "错", correct: true, explanation: "二分查找依靠有序关系排除一半范围，序列必须有序。" },
    ];
  } else if (hasOptions(kind)) {
    const one = oneAnswer(kind);
    card.prompt = one ? "哪种序列可以直接用于二分查找？" : "哪些序列可以直接用于二分查找？";
    card.answer = one ? "升序序列" : "升序序列、降序序列（比较方向需相应调整）";
    card.options = [
      { id: "a", text: "升序序列", correct: true, explanation: "升序关系允许排除一半搜索范围。" },
      { id: "b", text: one ? "随机乱序序列" : "降序序列", correct: !one, explanation: one ? "乱序无法根据中间值排除半区。" : "调整比较方向后，降序关系同样允许排除半区。" },
      { id: "c", text: "没有顺序保证的序列", correct: false, explanation: "没有顺序保证就不能确定目标所在半区。" },
    ];
  }
  if (kind === "open") card.rubric = "指出有序得 1 分；解释根据中间值排除半区得 1 分。";
  if (kind === "task") {
    card.objective = "动手写出有序序列二分查找的区间收缩实现或推导步骤";
    card.prompt = "动手写出有序升序序列二分查找的核心步骤（代码、伪代码或数学区间推导均可），保证空序列与未命中时安全返回且不死循环。";
    card.answer = "维护闭区间 [lo, hi]（初始 0 与 n - 1）：当 lo <= hi 时取 mid = lo + Math.floor((hi - lo) / 2)；若 a[mid] === target 返回 mid，若 a[mid] < target 令 lo = mid + 1，否则令 hi = mid - 1；循环结束返回 -1。";
    card.hint = "先明确区间开闭不变量，再检查每次比较后边界是否严格收缩。";
    card.explanation = "闭区间 [lo, hi] 在每次未命中后排除 mid 本身（lo = mid + 1 或 hi = mid - 1），区间长度严格减小，空序列时 lo > hi 直接跳过循环返回 -1。";
    card.misconception = "未排除 mid（写成 hi = mid）导致两元素区间死循环，或未处理空序列。";
    card.marks = 3;
    card.rubric = "1. 区间不变量（1 分）：明确搜索区间的开闭定义与初始边界。\n2. 单调收缩不死循环（1 分）：未命中分支严格推进边界，不会卡在原区间。\n3. 空序列与未命中兜底（1 分）：空输入与目标不存在时安全返回约定结果。";
    card.rubricCriteria = [
      { id: "c1", label: "区间不变量", marks: 1, descriptor: "明确搜索区间的开闭定义与初始边界。" },
      { id: "c2", label: "单调收缩不死循环", marks: 1, descriptor: "未命中分支严格推进边界，不会卡在原区间。" },
      { id: "c3", label: "空序列与未命中兜底", marks: 1, descriptor: "空输入与目标不存在时安全返回约定结果。" },
    ];
  }
  if (kind === "cloze") {
    card.prompt = "二分查找要求序列{{order}}。";
    card.cloze = { text: card.prompt, answers: [{ id: "order", value: "有序", accept: ["已排序"] }] };
  }
  return JSON.stringify({ title: "二分查找练习", folder: "算法", cards: [card] }, null, 2);
}

// These are application-owned examples, never imported learner content.
const exampleCopy = {
  '二分查找混合练习':'Binary search: mixed practice','算法':'Algorithms','二分查找练习':'Binary search practice','二分查找':'Binary search',
  '识别可直接二分查找的序列':'Identify sequences suitable for binary search','辨别二分查找支持的排序方向':'Distinguish supported sort directions','回忆二分查找的输入条件':'Recall the input requirement','解释无序输入为何不能排除半区':'Explain why unordered input prevents eliminating half','补全二分查找的前提条件':'Complete the prerequisite for binary search',
  '为什么不能直接对无序序列进行二分查找？请解释原因。':'Why does binary search not work directly on an unordered sequence? Explain.',
  '无序序列中，中间值与目标的大小关系无法确定目标位于哪一半，因此不能安全排除半区。':'Without ordering, comparing the middle value with the target cannot determine which half contains the target, so neither half can safely be discarded.',
  '解释二分查找的输入条件':'Explain the input requirement for binary search','二分查找对输入序列有什么要求？':'What does binary search require of the input sequence?','序列需要有序。':'The sequence must be sorted.',
  '考虑每次排除一半范围的依据。':'Consider what justifies eliminating half of the search range.','只有有序序列才能通过比较中间值排除一半搜索范围。':'Ordering allows comparison with the middle value to eliminate half of the search range.','误以为任意序列都能直接二分查找。':'Assuming binary search works directly on any sequence.',
  '哪种序列可以直接用于二分查找？':'Which sequence can be used directly for binary search?','哪些序列可以直接用于二分查找？':'Which sequences support binary search?','升序序列':'An ascending sequence','升序序列、降序序列（比较方向需相应调整）':'Ascending and descending sequences (with the comparison direction adjusted)',
  '升序关系允许排除一半搜索范围。':'Ascending order allows half of the search range to be discarded.','随机乱序序列':'A randomly shuffled sequence','降序序列':'A descending sequence','乱序无法根据中间值排除半区。':'Shuffled data cannot eliminate half based on the middle value.','调整比较方向后，降序关系同样允许排除半区。':'With the comparison reversed, descending order also allows eliminating half.',
  '没有顺序保证的序列':'A sequence with no ordering guarantee','没有顺序保证就不能确定目标所在半区。':'Without ordering, the correct half cannot be determined.','指出有序得 1 分；解释根据中间值排除半区得 1 分。':'1 point for identifying ordering; 1 point for explaining elimination based on the middle value.',
  '二分查找要求序列{{order}}。':'Binary search requires a {{order}} sequence.','有序':'sorted','已排序':'ordered',
  '判断关于二分查找输入的说法':'Judge a statement about the input of binary search','二分查找可以直接用于任意无序序列。':'Binary search works directly on any unordered sequence.',
  '错。正确说法：二分查找要求序列有序。':'False. The true statement: binary search requires a sorted sequence.',
  '只有有序序列才能通过比较中间值排除一半搜索范围，所以这个说法是错的；正确说法是：二分查找要求序列有序。':'Only ordering lets a comparison with the middle value discard half of the range, so the statement is false; the true statement is that binary search requires a sorted sequence.',
  '对':'True','错':'False','无序序列中，中间值与目标的大小关系无法说明目标在哪一半。':'In an unordered sequence, comparing the middle value with the target does not show which half holds it.',
  '二分查找依靠有序关系排除一半范围，序列必须有序。':'Binary search relies on ordering to discard half of the range, so the sequence must be sorted.',
  '动手写出有序序列二分查找的区间收缩实现或推导步骤':'Implement or derive the interval-shrinking steps of binary search on a sorted sequence',
  '动手写出有序升序序列二分查找的核心步骤（代码、伪代码或数学区间推导均可），保证空序列与未命中时安全返回且不死循环。':'Write the core steps of binary search on an ascending sequence (code, pseudocode or mathematical interval derivation), ensuring empty inputs and misses return safely without an infinite loop.',
  '维护闭区间 [lo, hi]（初始 0 与 n - 1）：当 lo <= hi 时取 mid = lo + Math.floor((hi - lo) / 2)；若 a[mid] === target 返回 mid，若 a[mid] < target 令 lo = mid + 1，否则令 hi = mid - 1；循环结束返回 -1。':'Maintain a closed interval [lo, hi] initialized to 0 and n - 1: while lo <= hi, set mid = lo + Math.floor((hi - lo) / 2); return mid if a[mid] === target, set lo = mid + 1 if a[mid] < target, otherwise set hi = mid - 1; return -1 after the loop.',
  '先明确区间开闭不变量，再检查每次比较后边界是否严格收缩。':'Define the open/closed interval invariant first, then verify each comparison strictly shrinks the bounds.',
  '闭区间 [lo, hi] 在每次未命中后排除 mid 本身（lo = mid + 1 或 hi = mid - 1），区间长度严格减小，空序列时 lo > hi 直接跳过循环返回 -1。':'On a closed interval [lo, hi], excluding mid on every miss (lo = mid + 1 or hi = mid - 1) strictly shrinks the interval, and an empty input starts with lo > hi and immediately returns -1.',
  '未排除 mid（写成 hi = mid）导致两元素区间死循环，或未处理空序列。':'Keeping mid in the interval (e.g. hi = mid) so a two-element range loops forever, or overlooking an empty sequence.',
  '1. 区间不变量（1 分）：明确搜索区间的开闭定义与初始边界。\n2. 单调收缩不死循环（1 分）：未命中分支严格推进边界，不会卡在原区间。\n3. 空序列与未命中兜底（1 分）：空输入与目标不存在时安全返回约定结果。':'1. Interval invariant (1 mark): States the open/closed search interval and initial bounds.\n2. Monotonic progress without infinite loops (1 mark): Advances bounds strictly on misses so the interval always shrinks.\n3. Empty input and miss handling (1 mark): Returns the agreed sentinel safely on empty input and absent targets.',
  '区间不变量':'Interval invariant',
  '明确搜索区间的开闭定义与初始边界。':'States the open/closed search interval and initial bounds.',
  '单调收缩不死循环':'Monotonic progress without infinite loops',
  '未命中分支严格推进边界，不会卡在原区间。':'Advances bounds strictly on misses so the interval always shrinks.',
  '空序列与未命中兜底':'Empty input and miss handling',
  '空输入与目标不存在时安全返回约定结果。':'Returns the agreed sentinel safely on empty input and absent targets.',
};
function englishExample(value) {
  if (typeof value === 'string') return exampleCopy[value] || value;
  if (Array.isArray(value)) return value.map(englishExample);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,englishExample(item)]));
  return value;
}
