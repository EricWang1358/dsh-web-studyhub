import { importExample } from "../lib/deck-format.js";

// The format example lives in lib/deck-format.js: the main session reads the same one (library.context area decks).
export { importExample };

const qualityInstructions = `出题质量要求（所有题型都必须遵守）：
1. 先规划考点和证据：每题只测一个明确、有学习价值的目标，定位资料中支持答案及其边界的段落，再写题。优先覆盖核心概念、易混区别和应用条件；同一题组不要把同一考点换个题型重复凑数。按要求分配题型、数量与难度，基础闪卡保持简洁。
2. 忠于资料：答案、关键区别与解析必须有资料依据，在 explanation 中写明真实的章节/段落或简短原文及其如何支持答案；不得虚构引用、页码、事实或精确区别。构造的教学场景需在解析中说明，并给足条件。资料不足时缩小考点或舍弃该题，不为满足数量编造；完全无法出题时返回 {"title":"资料不足，无法生成题组","cards":[]}，由导入校验拒绝空题组。
如同一份原始资料已在学习库中，可为每题加 citations: [{"quote":"从原始资料逐字摘录的至少12字","sourceTitle":"资料标题（可选）"}]。导入器只会关联与本地资料唯一匹配的原文；找不到时仍保留题目自身引用。不要编造引文。
3. 题干自足且不泄题：补齐必要背景、适用条件、单位和假设，不依赖未展示的图片、箭头、原始幻灯片或“上文”。prompt、topic、hint 不得给出被考结论或答案关键词；hint 只提供思路。避免模糊措辞、双重否定、无意义细节和仅靠猜测就能答对的题。
4. 选择题质量：单选在给定条件下恰有一个无争议的正确项；多选逐项独立判断，至少一个正确项且至少一个错误项。各选项应比较同一维度、处于相同抽象层次，长度和句式相近；干扰项来自真实误解或相近概念，不用荒谬选项、无关属性、“以上皆是”或“以上皆非”。避免正确项总是最长、措辞最专业、位置固定或多选正确项数量始终相同。answer 与 correct 标记必须一致，答案用选项内容表达，不只写字母编号。
5. 解析可核查：explanation 解释为什么成立和适用边界；每个选项的 explanation 说明它在本题为何对或错、对应哪个概念或误区，不只复述“正确/错误”。计算题写明公式、单位和必要中间步骤；misconception 指出具体误解。
6. 闪卡：一个聚焦问题配简短可回忆答案，避免整页摘要或多个无关子问。开放问答：明确任务与范围，answer 给出参考要点，rubric 写明各得分点、分值、部分得分条件及可接受的替代表述，评分标准与答案一致。
7. 填空：挖去有意义的关键概念，保留足够上下文；每个 {{id}} 与 cloze.answers 一一对应，value 明确，accept 只包含语义等价的合法答案；题干及提示不泄露填空值，不挖出可由语法机械猜出的空；{{id}} 只放在句子的文字里，不放进 $…$ 公式，填空值是学习者能直接打出来的词、名称或数字，不写成公式或 TeX。

输出前质量自检与修订：
逐题重新检查证据支持、自足性、泄题风险、答案正确性、选项质量、解析与评分标准、学习价值；发现问题先改写，再复核，仍无法修复则移除。复查整组考点重复、题型比例与难度覆盖，不能只修改 objective 字面措辞来伪装不同考点。
最后检查 JSON 可解析、必填字段非空、题干与目标不重复、选项 id 唯一、correct 为布尔值、正确项数量合法、填空标记匹配。只输出修订后的最终 JSON，不输出自检过程或额外审阅字段，也不要声称已通过独立审阅或保证绝对正确。`;

export function importPrompt(kind, label, language = "zh") {
  if (language === "en") return englishImportPrompt(kind, label);
  const typeInstruction = kind === "mixed"
    ? "在同一 cards 数组中混合 quiz（单选）、multi（多选）、flashcard（闪卡）、open（开放问答）、cloze（填空）。按我指定的题型及数量分配；未指定时默认共 10 题、每种 2 题。每题 kind 必须使用上述具体题型，不能写 mixed。只输出一个题组 JSON。"
    : `每题 kind 为 ${kind}。`;
  return `请根据我随后提供的资料生成${kind === "mixed" ? "混合题型" : label}题组，只输出合法 JSON，不加说明或 Markdown 围栏。\n顶层包含 title、可选 folder、cards（至少 1 道，无总数上限）；${typeInstruction}\n每题必须包含非空字符串 topic、objective、prompt、answer、hint、explanation、misconception；题干和学习目标不得重复，hint 不得直接给出答案。不要编造资料中没有的事实。\n单选 quiz 和多选 multi 必须有 3–6 个 options，每项包含唯一 id、text、布尔值 correct、逐项 explanation；单选恰好一个正确项，多选至少一个正确项且不能全选。开放问答 open 必须有 rubric 评分标准；填空 cloze 使用 {{空位id}} 并在 cloze.answers 中给出 id、value 和可选 accept 数组。flashcard 为问答闪卡。\n\n${qualityInstructions}\n\n格式示例（仅说明字段结构，正式出题应按上述质量要求重新规划内容，不照搬示例考点）：\n${importExample(kind)}\n\n我的资料和出题要求：\n`;
}

function englishImportPrompt(kind, label) {
  const types = kind === 'mixed' ? 'Mix quiz, multi, flashcard, open and cloze cards in one cards array. Follow my requested types and counts; otherwise create ten cards, two per type. Every card must use a concrete kind, never mixed.' : 'Every card must have kind: ' + kind + '.';
  return 'Create a ' + (kind === 'mixed' ? 'mixed question' : label) + ' deck from the sources I provide below. Return valid JSON only, without commentary or Markdown fences. Write new questions in English unless I explicitly request another content language. Preserve verbatim source quotations.\n' +
    'Top-level fields: title, optional folder, and cards (at least one, no overall count limit). ' + types + '\n' +
    'Every card needs nonempty topic, objective, prompt, answer, hint, explanation and misconception strings. Do not duplicate prompts or learning objectives. Do not invent unsupported facts.\n' +
    'quiz and multi require 3–6 options with unique id, text, boolean correct, and an explanation for each option. A quiz has exactly one correct option. A multi has at least one correct and one incorrect option. open needs a scoring rubric. cloze uses {{id}} markers and matching cloze.answers entries with id, value and optional accept arrays. flashcard is a short question and answer.\n\n' +
    'Quality requirements for every question type:\n' +
    '1. Plan evidence and learning targets before writing. Test one meaningful target per question; locate the supporting passage and its limits. Prioritise core concepts, likely confusions and application conditions. Do not pad the deck by testing the same objective with different question types. Follow the requested mix, count and difficulty.\n' +
    '2. Ground answers and distinctions in the sources. In explanation, identify the real section or a brief quotation and explain how it supports the answer. Do not invent citations, page numbers or precise distinctions. Clearly label constructed teaching scenarios and state their assumptions. Narrow or omit unsupported questions rather than inventing content to fill a quota. If no questions are supported, return {"title":"Insufficient source material","cards":[]} for import validation to reject. Optional citations are [{"quote":"at least 12 characters copied verbatim","sourceTitle":"optional source title"}]. Local citations link only when they uniquely match source text; otherwise the question keeps its own references.\n' +
    '3. Make each question self-contained. Supply context, conditions, units and assumptions; never depend on hidden images, arrows, slides or earlier text. prompt, topic and hint must not reveal the tested conclusion or answer keywords. Avoid ambiguous wording, double negatives and irrelevant details.\n' +
    '4. Compare options along the same dimension, at similar abstraction, length and grammatical form. Use plausible misconceptions as distractors. Avoid absurd alternatives, all/none of the above, a consistently longest correct answer, fixed correct positions or a fixed number of correct multi options. Express answer using option content rather than letters and keep it consistent with correct flags.\n' +
    '5. Explain why the answer holds and under which conditions. Explain each option’s specific correctness or error rather than restating its label. For calculations, show formulas, units and necessary intermediate steps. Name a concrete misconception.\n' +
    '6. Flashcards ask one focused question with a short retrievable answer, not a page summary. Open responses specify task and scope; answer lists key points, while rubric gives points, partial credit and acceptable alternatives consistent with the answer.\n' +
    '7. Cloze cards remove meaningful concepts while keeping sufficient context. Match every marker to one answer; accept contains only semantically equivalent valid answers. Do not leak the fill through prompts or hints, or make it guessable solely from grammar. Put every marker in the prose, never inside $…$ or another formula; each value is a word, name or number a learner can type, not a formula or TeX.\n\n' +
    'Before output, review and revise every question for source support, self-containment, leakage, correctness, option quality, explanations, rubrics and learning value. Remove anything still invalid after repair. Recheck duplicate objectives, type ratios and difficulty coverage; changing objective wording does not create a new target. Check JSON syntax, required fields, option IDs, booleans, correct-option counts and cloze markers. Return only the revised final JSON; do not include self-review fields or claim independent approval or guaranteed correctness.\n\n' +
    'Structure example only: plan original questions rather than copying its learning targets.\n' + importExample(kind,'en') + '\n\nMy sources and question requirements:\n';
}
