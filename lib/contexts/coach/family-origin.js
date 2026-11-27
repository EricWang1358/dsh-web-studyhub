/* Where a coach task family came from, and what step 1 says the plan rests on. Both claim only what happened (#1642): the families the analysis writes
   itself are fixed rules with topic names filled in, so no sample paper and no model had a part in them. Pure, no imports. */

export const BUILT_IN_ORIGIN = "built-in-template";

/* The fixed rules of the built-in families, by id: the analysis writes them from here, and a saved family is known as built-in by them. The coach page
   offers no way to edit these (its rule editor changes the reasoning steps and the sample's rubric). A plan saved before #1642 is recognised only while
   its texts equal these: change a text here and keep the old one for that comparison. */
const BUILT_IN_RULES = new Map(Object.entries({
  "concept-discrimination": {
    keyConditions: ["给定具体前提约束条件", "区分易混概念适用边界"],
    distractorRules: [
      { id: "mis-boundary", code: "M1", label: "忽略适用前提", reason: "把仅在特定约束下成立的结论当成无条件成立" },
      { id: "mis-swap", code: "M2", label: "混淆相邻概念职责", reason: "记住了术语名称但把上下游或对偶概念的职责张冠李戴" },
    ],
  },
  "multi-step-derivation": {
    keyConditions: ["给出初始参数或中间状态变化", "要求按步骤写出推导依据与最终结果"],
    rubricPoints: [
      { id: "rub-setup", criterion: "正确列出关系式或状态转移条件", marks: 4, condition: "明确写出适用公式及对应前提变量" },
      { id: "rub-step", criterion: "完成中间步骤代入与边界检验", marks: 4, condition: "中间量计算无跳步，指明边界约束是否满足" },
      { id: "rub-final", criterion: "给出准确最终结果与结论解释", marks: 2, condition: "数值/符号与前序推导一致" },
    ],
  },
  "scenario-tradeoff-task": {
    keyConditions: ["存在相互冲突的资源/一致性/成本约束", "需结合材料证据给出取舍理由"],
    rubricPoints: [
      { id: "rub-diag", criterion: "准确定位核心矛盾或根因", marks: 5, condition: "引用题干给定约束指出关键瓶颈而非泛泛而谈" },
      { id: "rub-tradeoff", criterion: "结合约束对比至少两种方案的取舍", marks: 6, condition: "说明所选方案为何优于备选方案及其代价" },
      { id: "rub-verify", criterion: "提出可观测的验证或回滚条件", marks: 4, condition: "给出明确的检验指标或边界回退策略" },
    ],
  },
}));

export const builtInRules = (id) => structuredClone(BUILT_IN_RULES.get(id));

/* What the analysis saved its built-in families as before #1642, by whether a sample paper was selected or a keyword matched. */
const FORMER_BUILT_IN_ORIGINS = new Set(["source-fact", "reference-observed", "model-suggested"]);

const ruleTexts = ({ keyConditions = [], distractorRules = [], rubricPoints = [] }) => JSON.stringify([
  keyConditions,
  distractorRules.map((d) => [d.label, d.reason]),
  rubricPoints.map((r) => [r.criterion, r.condition]),
]);

/** The origin to show for a family stating `stated`: a built-in family saved under a former label is read as built-in. One whose rules were written anew
    (from a paper, by a model) is not, so it keeps what its writer stated. The origin is no part of the spec version, so reading it anew costs no confirmation. */
export function originOf(id, stated, rules) {
  const builtIn = BUILT_IN_RULES.get(id);
  return builtIn && FORMER_BUILT_IN_ORIGINS.has(stated) && ruleTexts(rules) === ruleTexts(builtIn) ? BUILT_IN_ORIGIN : stated;
}

const UNANALYZED_NOTE = "题型配额是建议初值；没在样卷里出现的章节仍需核对，请对照考纲确认。";

export function scopeNote(sampleCount, materialCount) {
  return sampleCount
    ? `纳入 ${sampleCount} 份参考样卷、${materialCount} 份课程资料。标「通用模板」的任务族，条件、步骤、错因、评分细则和样题是固定写法，只填入章节名或标题，没有从样卷里归纳；样卷在出题时作参考样题。题型配额是建议初值，请对照考纲确认。`
    : `纳入 ${materialCount} 份课程资料，暂无往年样卷。标「通用模板」的任务族，条件、步骤、错因、评分细则和样题是固定写法，只填入章节名或标题。题型配额是建议初值，请对照考纲确认。`;
}

/* The notes saved before #1642: the analysis said it had analyzed the paper and counted its question types. A note anyone else wrote is kept. */
const FORMER_NOTES = [
  [/^已分析 (\d+) 份参考样卷与 (\d+) 份课程资料：样卷题型频次仅代表样本观察，未覆盖章节仍需在规划中显式取舍。$/, ([, samples, materials]) => scopeNote(Number(samples), Number(materials))],
  [/^当前基于 (\d+) 份课程资料推导考察方式（暂无往年样卷输入，题型配额为建议初值，请结合考纲确认）。$/, ([, materials]) => scopeNote(0, Number(materials))],
  [/^历史样卷统计仅反映所给样本的观察频率，不等同真实考试必然分布；未出现在样卷中的教材章节仍需核对。$/, () => UNANALYZED_NOTE],
];

/** The note to show for a saved one ("" when none was saved). */
export function currentScopeNote(saved) {
  for (const [pattern, rewrite] of FORMER_NOTES) {
    const match = pattern.exec(saved);
    if (match) return rewrite(match);
  }
  return saved || UNANALYZED_NOTE;
}
