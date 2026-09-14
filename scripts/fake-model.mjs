/* Deterministic stand-in for the light coach route. Preview only
   (STUDY_FAKE_MODEL=1) and tests; it answers each coach prompt shape with
   valid JSON built from the request so validation paths are exercised. */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFakeModel({ latencyMs = 0, log = [] } = {}) {
  return async function fakeComplete(system, prompt) {
    log.push({ system, prompt });
    if (latencyMs) await delay(latencyMs);
    let data;
    try {
      data = JSON.parse(prompt);
    } catch {
      data = {};
    }
    const task = String(data.task || "");
    if (task.includes("刚答错")) {
      const topic = data.card?.topic || "这个概念";
      return JSON.stringify({
        point: `「${topic}」里谁负责什么${data.earlier?.length ? "（换个角度）" : ""}`,
        explain: `先分清职责再看选项：${String(data.card?.answer || "").slice(0, 40)}。比如保存历史的人不需要知道快照里装了什么。`,
        check: { q: "管理历史的对象需要读取快照内部吗？", options: ["需要", "不需要"], answer: 1, why: "它只保管不透明的快照。" },
      });
    }
    if (task.includes("仍然不懂")) return JSON.stringify({ explain: "把快照想成封好的信封：保管员只负责按顺序存放信封，只有写信的人能拆开。" });
    if (task.includes("反馈标签")) {
      const card = data.card || {};
      const patch = {};
      if (Array.isArray(card.options) && data.tags?.some((t) => /选项|解析/.test(t)))
        patch.options = card.options.map((o) => ({ id: o.id, explanation: `${o.correct ? "正确" : "错误"}：${o.why || o.text}（已按反馈写得更具体）` }));
      if (data.tags?.includes("题干太空")) patch.prompt = `${card.prompt}（请结合题目给出的职责划分作答）`;
      return JSON.stringify({ patch, summary: Object.keys(patch).length ? "补足了题干条件并逐项重写解析" : "核对原文后答案无误" });
    }
    if (task.includes("为每个 target")) {
      const text = data.evidence?.[0]?.text || "";
      const sourceId = data.evidence?.[0]?.sourceId;
      const quote = text.slice(0, Math.min(text.length, 60));
      return JSON.stringify({
        cards: (data.targets || []).map((t, i) => ({
          target: t.target,
          kind: t.kind,
          topic: t.card.topic,
          objective: `在具体场景中应用 ${t.card.topic}（变式 ${i + 1} · ${Date.now() % 100000}）`,
          prompt: `某团队在做编辑器撤销功能时（变式 ${i + 1}），应当让哪个角色保存历史而不读取快照内容？ #${Math.random().toString(36).slice(2, 7)}`,
          answer: "负责保管历史的角色",
          hint: "想想谁需要知道快照里有什么。",
          explanation: "保管历史与读取内容是两种职责，分开可以保持封装。",
          misconception: "以为保存历史就必须理解快照结构。",
          citations: sourceId ? [{ sourceId, quote }] : [],
          ...(t.kind === "flashcard"
            ? {}
            : {
                options: [
                  { id: "a", text: "历史保管者", correct: true, explanation: "它只存放快照，不读取内容。" },
                  { id: "b", text: "快照对象本身", correct: false, explanation: "快照是被保存的数据，不管理历史。" },
                  { id: "c", text: "界面渲染层", correct: false, explanation: "渲染层与状态保存无关。" },
                ],
              }),
        })),
      });
    }
    if (task.includes("本轮指标")) {
      const m = data.metrics || {};
      return JSON.stringify({
        headline: m.lowShare >= 70 ? "概念会了，别停在纸上谈兵" : "薄弱点就差临门一脚",
        why: `本轮 ${m.answered} 题里 ${m.lowShare}% 是概念题，正确率 ${m.accuracy}%。`,
        next: data.defaultNext,
        summary: `目标：${data.learner?.goal || "未设定"}；偏好快速刷题；概念辨析占比高，应用分析练得少。`,
      });
    }
    return "{}";
  };
}
