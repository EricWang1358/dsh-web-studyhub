/* The question-deck JSON format example: the import page shows it, the copy-out prompt (ui/json-prompts.js) embeds it and the main session reads
   it in library.context area decks (lib/study-contracts.js). One example, so the three never disagree. Pure data: safe to bundle into the browser. */

export function importExample(kind, language = "zh") {
  if (language === "en") return JSON.stringify(englishExample(JSON.parse(importExample(kind))), null, 2);
  if (kind === "mixed") {
    const cards = ["quiz", "multi", "flashcard", "open", "cloze"].map((type) => JSON.parse(importExample(type)).cards[0]);
    const objectives = ["识别可直接二分查找的序列", "辨别二分查找支持的排序方向", "回忆二分查找的输入条件", "解释无序输入为何不能排除半区", "补全二分查找的前提条件"];
    cards.forEach((card, i) => { card.objective = objectives[i]; });
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
  if (kind === "quiz" || kind === "multi") {
    card.prompt = kind === "quiz" ? "哪种序列可以直接用于二分查找？" : "哪些序列可以直接用于二分查找？";
    card.answer = kind === "quiz" ? "升序序列" : "升序序列、降序序列（比较方向需相应调整）";
    card.options = [
      { id: "a", text: "升序序列", correct: true, explanation: "升序关系允许排除一半搜索范围。" },
      { id: "b", text: kind === "quiz" ? "随机乱序序列" : "降序序列", correct: kind === "multi", explanation: kind === "quiz" ? "乱序无法根据中间值排除半区。" : "调整比较方向后，降序关系同样允许排除半区。" },
      { id: "c", text: "没有顺序保证的序列", correct: false, explanation: "没有顺序保证就不能确定目标所在半区。" },
    ];
  }
  if (kind === "open") card.rubric = "指出有序得 1 分；解释根据中间值排除半区得 1 分。";
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
};
function englishExample(value) {
  if (typeof value === 'string') return exampleCopy[value] || value;
  if (Array.isArray(value)) return value.map(englishExample);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,englishExample(item)]));
  return value;
}
