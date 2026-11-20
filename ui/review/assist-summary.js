import { ui, uiMessage } from "../i18n.js";
import { PLAIN_HELP_REQUEST } from "../../lib/assist-contract.js";
import { HELP_CHOICES } from "../agent-prompts/card.js";

const ASSIST_PROMPT_CLAUSES = Object.freeze([
  [PLAIN_HELP_REQUEST, "plain"],
  ["换一种解释角度，指出关键概念之间的关系", "angle"],
  ["给一个贴近该题的具体例子", "example"],
  ["从题目条件逐步推到答案，说明每一步的依据", "steps"],
  ["判断缺少哪些前置知识；优先关联已有前置题，必要时创建新题", "prerequisite"],
  ["结合学习者的实际选择和判分，分析错误原因", "mistake"],
]);

const clipAssistSummary = (text, max = 96) => {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
};

/** Summarize an in-flight assist request into selected chip labels plus user note (never raw prompt instructions). */
export function formatAssistTaskSummary(task) {
  if (Array.isArray(task?.terms) && task.terms.length > 0) {
    return clipAssistSummary(task.terms.join(ui("、")));
  }
  const labelFor = (id) => {
    const choice = HELP_CHOICES.find((item) => item.id === id);
    return choice ? ui(choice.label) : "";
  };
  if (Array.isArray(task?.choices) && task.choices.length > 0) {
    const labels = task.choices.map(labelFor).filter(Boolean);
    const question = String(task.question || "").replace(/\s+/g, " ").trim();
    const combined = [...labels, question].filter(Boolean).join(" · ");
    if (combined) return clipAssistSummary(combined);
  }
  const raw = String(task?.text || "").trim();
  if (!raw) return "";
  const mapped = raw.split(/\s*[；;]\s*|\n{2,}/).map((part) => {
    const clean = part.replace(/\s+/g, " ").trim();
    if (!clean) return "";
    for (const [clause, id] of ASSIST_PROMPT_CLAUSES) {
      if (clean === clause || clean === uiMessage(clause)) return labelFor(id);
    }
    return clean;
  }).filter(Boolean);
  return clipAssistSummary(mapped.join(" · ") || raw);
}
