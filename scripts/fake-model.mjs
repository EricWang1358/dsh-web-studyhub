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
    if (system.startsWith("Repair one draft card"))
      return JSON.stringify({ card: { ...data.card,
        prompt: "What do architectural principles guide during design and later evolution?",
        explanation: "The cited notes say these principles guide design and later evolution." } });
    if (system.startsWith("Act as a strict assessment editor"))
      return JSON.stringify({ issues: [], summary: "Preview fixture review", checks: (data.candidate?.cards || []).map((card) => ({
        cardId: card.id, selfContained: "pass", answerLeak: "pass",
        optionQuality: ["quiz", "multi"].includes(card.kind) ? "pass" : "na",
        learningValue: "pass", sourceSupport: "pass", explanationQuality: "pass",
        explanation: "Preview fixture accepted this card; no real model judgment was made.",
      })) });
    // Guided workflow (AI 带学): choose material, write a lesson, review it, read a retelling.
    if (system.startsWith("You choose study material"))
      return JSON.stringify({ keys: (data.topics || []).slice(0, 6).map((t) => t.key), title: String(data.goal || "").slice(0, 20) });
    if (system.startsWith("You are a careful Chinese tutor writing")) {
      const source = (data.evidence || [])[0];
      const quote = source ? String(source.text).slice(0, 36).trim() : "";
      const points = (data.cards || []).slice(0, 4).map((c) => `- **${c.topic || "要点"}**：${String(c.answer || c.explanation || "").slice(0, 80)}`).join("\n");
      const body = `## 从一个具体场景开始

预览用的演示讲解（未调用真实模型）。围绕「${data.topic}」，先想象一个团队要做决定的场景，再看每个概念解决什么问题。${"我们先说清它要解决的矛盾，再看它如何运作，最后检查适用条件和容易混淆的地方。".repeat(4)}

## 关键要点

${points}

## 一步一步推演

${"这是为说明机制构造的例子：先确认前提是否成立，再看中间每一步如何得到结果，最后对照结论检查是否遗漏条件。".repeat(4)}

## 边界与易错点

${"条件不满足时结论不成立；常见误区是只记结论不记前提。".repeat(3)}`;
      return JSON.stringify({ markdown: body, citations: quote.length >= 8 ? [{ sourceId: source.sourceId, quote }] : [] });
    }
    if (system.startsWith("Independently review this Chinese learning article"))
      return JSON.stringify({ grounded: true, coherent: true, explained: true, example: true, boundaries: true, issues: [] });
    if (system.includes("reading a learner's retelling")) {
      const short = String(data.retelling || "").length < 40;
      return JSON.stringify({ covered: ["说出了核心概念的作用"], missing: short ? ["没有说明它在什么条件下成立", "缺少一个具体例子"] : [],
        question: "如果前提不成立，结论还会一样吗？", suggestion: short ? "revisit" : "continue",
        note: short ? "方向是对的，再把条件和例子补上会更完整。" : "讲得很完整，可以继续。" });
    }
    if (system.startsWith("You design a knowledge skeleton")) {
      // One station per topic, its cards hanging below: enough to draw a spine.
      const topics = [...new Set((data.cards || []).map((c) => c.topic || "未分类"))].slice(0, 6);
      const nodes = topics.flatMap((topic, i) => {
        const cards = data.cards.filter((c) => (c.topic || "未分类") === topic).slice(0, 4);
        return [{ id: `t${i}`, term: topic, meaning: `预览用的演示骨架（未调用真实模型）：「${topic}」这一站。`, cards: cards.map((c) => c.cardId) },
          ...cards.map((c, j) => ({ id: `t${i}c${j}`, parent: `t${i}`, term: String(c.answer || c.prompt).slice(0, 30) || `要点 ${j + 1}`,
            meaning: String(c.explanation || c.answer || "").slice(0, 120) || "演示要点。", cards: [c.cardId] }))];
      });
      const relations = topics.slice(1).map((_, i) => ({ from: `t${i}`, to: `t${i + 1}`, type: "prerequisite" }));
      return JSON.stringify({ title: `${topics[0] || "本次范围"}的脉络`, overview: "预览用的演示骨架：按主题从基础到应用排成一条主线。", nodes, relations });
    }
    const task = String(data.task || "");
    if (system.includes("学习卡片的追问老师")) {
      return JSON.stringify(data.question
        ? { question: `关于${data.card.topic}：${data.question}`, answer: `结合本题：${data.card.explanation}\n\n补充说明：可以用一个具体场景检查自己是否理解。` }
        : { questions: [`${data.card.topic}可以用一个例子说明吗？`, "这个概念最容易和什么混淆？", "换一个场景时，应该怎样运用这个规则？"] });
    }
    if (task.includes("刚答错") || task.includes("掌握程度自评")) {
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
