export function importExample(kind) {
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

const qualityInstructions = `出题质量要求（所有题型都必须遵守）：
1. 先规划考点和证据：每题只测一个明确、有学习价值的目标，定位资料中支持答案及其边界的段落，再写题。优先覆盖核心概念、易混区别和应用条件；同一题组不要把同一考点换个题型重复凑数。按要求分配题型、数量与难度，基础闪卡保持简洁。
2. 忠于资料：答案、关键区别与解析必须有资料依据，在 explanation 中写明真实的章节/段落或简短原文及其如何支持答案；不得虚构引用、页码、事实或精确区别。构造的教学场景需在解析中说明，并给足条件。资料不足时缩小考点或舍弃该题，不为满足数量编造；完全无法出题时返回 {"title":"资料不足，无法生成题组","cards":[]}，由导入校验拒绝空题组。
3. 题干自足且不泄题：补齐必要背景、适用条件、单位和假设，不依赖未展示的图片、箭头、原始幻灯片或“上文”。prompt、topic、hint 不得给出被考结论或答案关键词；hint 只提供思路。避免模糊措辞、双重否定、无意义细节和仅靠猜测就能答对的题。
4. 选择题质量：单选在给定条件下恰有一个无争议的正确项；多选逐项独立判断，至少一个正确项且至少一个错误项。各选项应比较同一维度、处于相同抽象层次，长度和句式相近；干扰项来自真实误解或相近概念，不用荒谬选项、无关属性、“以上皆是”或“以上皆非”。避免正确项总是最长、措辞最专业、位置固定或多选正确项数量始终相同。answer 与 correct 标记必须一致，答案用选项内容表达，不只写字母编号。
5. 解析可核查：explanation 解释为什么成立和适用边界；每个选项的 explanation 说明它在本题为何对或错、对应哪个概念或误区，不只复述“正确/错误”。计算题写明公式、单位和必要中间步骤；misconception 指出具体误解。
6. 闪卡：一个聚焦问题配简短可回忆答案，避免整页摘要或多个无关子问。开放问答：明确任务与范围，answer 给出参考要点，rubric 写明各得分点、分值、部分得分条件及可接受的替代表述，评分标准与答案一致。
7. 填空：挖去有意义的关键概念，保留足够上下文；每个 {{id}} 与 cloze.answers 一一对应，value 明确，accept 只包含语义等价的合法答案；题干及提示不泄露填空值，不挖出可由语法机械猜出的空。

输出前质量自检与修订：
逐题重新检查证据支持、自足性、泄题风险、答案正确性、选项质量、解析与评分标准、学习价值；发现问题先改写，再复核，仍无法修复则移除。复查整组考点重复、题型比例与难度覆盖，不能只修改 objective 字面措辞来伪装不同考点。
最后检查 JSON 可解析、必填字段非空、题干与目标不重复、选项 id 唯一、correct 为布尔值、正确项数量合法、填空标记匹配。只输出修订后的最终 JSON，不输出自检过程或额外审阅字段，也不要声称已通过独立审阅或保证绝对正确。`;

export function importPrompt(kind, label) {
  const typeInstruction = kind === "mixed"
    ? "在同一 cards 数组中混合 quiz（单选）、multi（多选）、flashcard（闪卡）、open（开放问答）、cloze（填空）。按我指定的题型及数量分配；未指定时默认共 10 题、每种 2 题。每题 kind 必须使用上述具体题型，不能写 mixed。只输出一个题组 JSON。"
    : `每题 kind 为 ${kind}。`;
  return `请根据我随后提供的资料生成${kind === "mixed" ? "混合题型" : label}题组，只输出合法 JSON，不加说明或 Markdown 围栏。\n顶层包含 title、可选 folder、cards（1–100 道）；${typeInstruction}\n每题必须包含非空字符串 topic、objective、prompt、answer、hint、explanation、misconception；题干和学习目标不得重复，hint 不得直接给出答案。不要编造资料中没有的事实。\n单选 quiz 和多选 multi 必须有 3–6 个 options，每项包含唯一 id、text、布尔值 correct、逐项 explanation；单选恰好一个正确项，多选至少一个正确项且不能全选。开放问答 open 必须有 rubric 评分标准；填空 cloze 使用 {{空位id}} 并在 cloze.answers 中给出 id、value 和可选 accept 数组。flashcard 为问答闪卡。\n\n${qualityInstructions}\n\n格式示例（仅说明字段结构，正式出题应按上述质量要求重新规划内容，不照搬示例考点）：\n${importExample(kind)}\n\n我的资料和出题要求：\n`;
}
