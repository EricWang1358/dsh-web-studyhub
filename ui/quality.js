const fields = {
  id: "题目编号", kind: "题型", topic: "主题", objective: "学习目标",
  prompt: "问题", answer: "答案", hint: "提示", explanation: "讲解",
  misconception: "易错点",
};

export function readableQualityIssue(issue) {
  const value = String(issue || "");
  const match = /^Card (\d+): (.*)$/.exec(value);
  if (!match) return value;
  const [, index, detail] = match;
  const required = /^(id|kind|topic|objective|prompt|answer|hint|explanation|misconception) is required$/.exec(detail);
  if (required) return `第 ${index} 题：${fields[required[1]]}不能为空`;
  const known = {
    "duplicate id": "题目编号重复",
    "duplicate learning objective": "学习目标与前面的题目重复",
    "duplicate prompt": "问题与前面的题目重复",
    "source citations required": "请添加原文引用",
    "unknown source": "引用的资料已不存在",
    "quote must match a source passage (at least 12 characters)": "引用须是资料中至少 12 字的原文",
    "open response needs a scoring rubric": "开放题需要评分标准",
    "need 3–6 options": "选择题需要 3 到 6 个选项",
    "invalid correct option count": "正确选项数量不符合题型要求",
    "duplicate option id": "选项编号重复",
    "duplicate option text": "选项内容重复",
    "each option requires id, text, correct and explanation": "每个选项都要有编号、内容、正误和解析",
    "hint reveals the answer": "提示直接泄露了答案",
  };
  return `第 ${index} 题：${known[detail] || detail}`;
}
