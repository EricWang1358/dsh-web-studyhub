import { lessons, sampleCards } from './content.js';
const lesson = `## 用编辑器的撤销功能理解 Memento

> 预置演示讲解。这里展示插件的讲解流程，没有调用模型，也没有分析你的个人资料。

假设我们正在做一个文本编辑器，用户希望修改文字以后还能撤销。一个直接的想法是让撤销按钮读取编辑器的所有字段，复制一份，然后在撤销时逐个写回。但这样按钮就必须知道编辑器内部如何保存光标、选区和文本；内部结构一改，撤销逻辑也要跟着改。

Memento（备忘录）模式把这个问题分为三个角色。**Originator（原发器）**是拥有状态的对象，这里就是编辑器。它知道哪些字段构成一份有效状态，因此由它创建快照，也由它把快照恢复为自己的状态。**Memento（备忘录）**是一份特定时刻的状态快照。**Caretaker（管理者）**管理历史列表，决定保存哪些快照、何时交回某份快照，但不检查快照里面的字段。

## 按顺序走一次

下面是为解释机制构造的例子。第一步，编辑器的文字是「你好」，修改之前由编辑器创建快照。第二步，历史管理者把这份快照放进列表。第三步，用户把文字改成「你好世界」。第四步，用户按撤销，历史管理者取出之前的快照交给编辑器。最后，由编辑器读取快照并恢复为「你好」。

请注意，历史管理者在整个过程中都无须理解文本、光标等内部字段。可以把快照想成一个封好的信封：保管员负责把信封按顺序存好，写信的人负责打开并解释其中内容。这个比喻只用于说明访问边界，不代表快照一定使用文件或加密技术。

## 为什么访问权限不同

「保存快照」与「恢复状态」所需的信息不同。管理者只需要持有并交回快照，所以使用窄接口；编辑器需要读取内部状态才能恢复，所以保留更完整的访问能力。这样，内部字段的变化集中在拥有这些字段的对象内，历史管理功能不必随着每次内部调整重写。

## 用 Bridge 理解另一个变化问题

再看资料里的报表例子。报表类型和渲染后端是两个独立变化的维度。如果每一种组合都创建一个子类，五种报表乘四种后端就有二十种组合。Bridge（桥接）把报表抽象与渲染实现分开，报表持有一个渲染实现，双方可以各自扩展。

它和 Memento 解决的问题不同：Memento 关注状态快照的封装与恢复；Bridge 关注两个维度的独立变化。看到「接口」或「对象组合」就把两种模式混为一谈，是常见误区。先明确题目中的变化是什么，再决定哪个模式相关。

## 检查理解

试着不看上文回答：谁管理历史？谁创建和恢复快照？为什么管理历史的人不需要读取快照内部？如果报表增加一个渲染后端，怎样避免为每种报表复制一套子类？接下来在复述步骤写出自己的理解，然后进入真实判分的练习。演示反馈是预置说明，不能作为你已经掌握的判断。`;

export async function demoModel(system, prompt) {
  const data = JSON.parse(prompt);
  const en = system.includes('Application language preference: English');
  const t = (english, chinese) => en ? english : chinese;
  const unsupported = () => { throw new Error(t('This AI action is not prerecorded. Use the built-in sample lesson, follow-up or practice; install the plugin for live AI.', '此 AI 操作没有预置示例。请体验内置讲解、追问或练习；安装插件可使用真实 AI。')); };
  if (system.startsWith('Act as a strict assessment editor')) {
    const cards = data.candidate?.cards || [];
    if (!cards.length || cards.some(c => !sampleCards.some(sample => sample.prompt === c.prompt && sample.answer === c.answer && JSON.stringify(sample.options?.map(o => [o.text,o.correct])) === JSON.stringify(c.options?.map(o => [o.text,o.correct]))))) return unsupported();
    return JSON.stringify({ issues: [], summary: t('Preset sample verification; no AI review performed.', '预置示例核验，没有调用 AI 审阅。'), checks: cards.map(c => ({ cardId: c.id, selfContained: 'pass', answerLeak: 'pass', optionQuality: ['quiz','multi'].includes(c.kind) ? 'pass' : 'na', learningValue: 'pass', sourceSupport: 'pass', explanationQuality: 'pass', explanation: t('Matches the built-in demonstration fixture.', '与内置演示示例一致。') })) });
  }
  if (data.evidence?.some(e => e.sourceId !== 'patterns-notes')) return unsupported();
  if (system.startsWith('You choose study material')) return JSON.stringify({ keys: (data.topics || []).filter(x => /Memento|Bridge/.test(x.key + x.name + x.topic)).slice(0, 6).map(x => x.key), title: t('Design patterns · preset lesson','设计模式 · 预置讲解') });
  if (/^You are a careful (Chinese )?tutor writing/.test(system)) {
    const evidence = data.evidence?.[0];
    return JSON.stringify({ markdown: en ? '> Prerecorded demo lesson. No model calls or personal assessment.\n\n' + lessons.en.map(([title, body]) => '## ' + title + '\n\n' + body).join('\n\n') : lesson, citations: evidence ? [{ sourceId: evidence.sourceId, quote: evidence.text.slice(0, 50) }] : [] });
  }
  if (/^Independently review this (Chinese )?learning article/.test(system)) return JSON.stringify({ grounded: true, coherent: true, explained: true, example: true, boundaries: true, issues: [] });
  if (system.includes("reading a learner's retelling")) return JSON.stringify({
    covered: [], missing: [], suggestion: 'continue',
    question: t('Who manages history, and who creates and restores state? Compare your explanation with the lesson.', '谁管理快照历史，谁创建和恢复状态？请自行对照讲解检查。'),
    note: t('Preset feedback: your retelling is saved in this browser. No AI assessment was performed; continue to practice to check your understanding.', '预置反馈演示：你的复述已保存在本浏览器。此处没有模型判断，可继续练习验证理解。'),
  });
  if (system.includes('学习卡片的追问老师')) return JSON.stringify(data.question
    ? { question: data.question, answer: t('Prerecorded reference, not a generated answer to your question:\n\n', '预置参考，不是针对你的问题生成的回答：\n\n') + data.card.explanation }
    : { questions: en ? ['Which role owns the state?', 'Why keep snapshots opaque?', 'How does Bridge separate independent changes?'] : ['谁拥有状态？', '为什么快照需要保持不透明？', 'Bridge 如何分离独立的变化？'] });
  if (system.startsWith('You design a knowledge skeleton')) {
    const topics = [...new Set((data.cards || []).map(c => c.topic))];
    const nodes = topics.map((topic, i) => ({ id: 't' + i, term: topic, meaning: t('Preset outline: compare the roles using the attached sample cards.', '预置脉络：结合关联示例题比较各角色的职责。'), cards: data.cards.filter(c => c.topic === topic).map(c => c.cardId) }));
    return JSON.stringify({ title: t('Design patterns · sample outline', '设计模式 · 示例脉络'), overview: t('Prerecorded outline; no AI analysis performed.', '预置脉络，没有调用 AI 分析。'), nodes, relations: [] });
  }
  const task = String(data.task || '');
  if (task.includes('刚答错') || task.includes('掌握程度自评')) {
    const bridge = data.card?.topic === 'Bridge';
    return JSON.stringify({ point: t('Preset reinforcement', '预置巩固示例'), explain: t('Compare your answer with this reference: ', '请将你的回答与参考解析比较：') + (data.card?.explanation || ''),
      check: bridge ? { q: t('Can report types and rendering backends vary independently with Bridge?', 'Bridge 中报表类型与渲染后端可以独立变化吗？'), options: en ? ['Yes','No'] : ['可以','不可以'], answer: 0, why: t('The abstraction delegates to a separate implementation.', '抽象将渲染委托给独立的实现。') } : { q: t('Does the Caretaker need to read snapshot contents?', 'Caretaker 需要读取快照内容吗？'), options: en ? ['Yes','No'] : ['需要','不需要'], answer: 1, why: t('It stores opaque snapshots; the Originator restores them.', '它保管不透明的快照，由 Originator 恢复状态。') } });
  }
  if (task.includes('仍然不懂')) return JSON.stringify({ explain: t('Preset analogy: sealed envelopes can be stored without reading them. The owner, rather than the keeper, interprets their contents.', '预置比喻：保管封好的信封不需要阅读内容，由写信者解释其中内容。') });
  if (task.includes('本轮指标')) return JSON.stringify({ headline: t('Practice saved', '练习已保存'), why: t('Your actual results are shown above. This summary is prerecorded.', '上方显示真实作答记录；此处总结为预置说明。'), next: data.defaultNext, summary: t('Continue reviewing the questions that need more practice.', '继续复习需要巩固的题目。') });
  return unsupported();
}
