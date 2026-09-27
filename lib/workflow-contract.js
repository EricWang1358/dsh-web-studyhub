// Shared vocabulary only: components do not own deck, graph or scheduling state.
export const WORKFLOW_LIMIT = 5;
export const WORKFLOW_COMPONENTS = [
  { kind: "overview", title: "明确目标", description: "确定范围与这次想弄懂的问题", prompt: "学完这个主题，我希望能够解释或完成什么？" },
  { kind: "skeleton", title: "知识骨架", description: "定位概念、关系与前置知识", prompt: "沿骨架找到本次要学的概念，记录需要补上的前置知识。" },
  { kind: "lesson", title: "概念与例子", description: "读资料、理解机制、推演例子", prompt: "从一个具体例子出发，解释它如何工作，以及哪些条件决定结果。" },
  { kind: "recall", title: "主动复述", description: "合上资料，用自己的话讲清楚", prompt: "不看答案，用自己的话解释核心概念，举一个例子，并说明适用边界。" },
  { kind: "practice", title: "题目练习", description: "练习关联题，沿用原有复习机制", prompt: "先独立作答，再核对题解，记录为什么错以及下次如何判断。" },
  { kind: "reflection", title: "总结与下一步", description: "保存收获、疑问与后续安排", prompt: "这次学会了什么？还有什么不能独立完成？下一次准备解决哪一个问题？" },
];
export const defaultWorkflow = () => ({ title: "从理解到应用", description: "围绕一个主题，先理解结构，再复述、练习和回顾。",
  steps: WORKFLOW_COMPONENTS.map((c, i) => ({ id: `step-${i + 1}`, kind: c.kind, title: c.title,
    instructions: c.prompt, content: "", next: "$next", retry: "$stay", count: 10 })) });
