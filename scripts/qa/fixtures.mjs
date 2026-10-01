/* Study material for QA journeys and WP0 tests. Original text written for
   these fixtures; every sentence is long enough to be quoted as evidence. */

const MATERIAL = {
  zh: {
    title: "间隔重复与遗忘曲线",
    text: [
      "遗忘曲线描述了新学的内容在没有复习时会随着时间迅速变得难以回忆。",
      "间隔重复的核心做法是在快要忘记之前安排下一次复习，从而用较少的次数维持长期记忆。",
      "每次成功回忆之后，下一次复习的间隔会被拉长，这样复习负担不会随着卡片数量线性增长。",
      "如果某次回忆失败，间隔会被重置为较短的时间，让薄弱的内容尽快再出现一次。",
      "主动回忆要求学习者先尝试从记忆中提取答案，再对照参考答案，而不是反复阅读原文。",
      "研究表明，提取练习本身就会加强记忆痕迹，这一现象通常被称为测试效应。",
      "把相近概念交错安排在同一轮练习里，可以迫使学习者辨别它们的差异，这种做法叫作交错练习。",
      "好的复习卡片只考查一个可以判分的要点，题干要自足，不能依赖看不到的幻灯片。",
      "评分时区分“完全想起”“犹豫后想起”和“没想起”，算法才能据此调整下一次的间隔。",
      "长期来看，坚持每天少量复习比考前集中突击更能保留知识，也更不容易产生焦虑。",
    ].join("\n"),
  },
  en: {
    title: "Spaced repetition and the forgetting curve",
    text: [
      "The forgetting curve describes how newly learned material quickly becomes hard to recall when it is never reviewed.",
      "Spaced repetition schedules the next review shortly before an item would be forgotten, so fewer reviews keep a memory alive.",
      "After each successful recall the interval to the next review grows, so the workload does not grow linearly with the number of cards.",
      "When a recall fails, the interval is reset to a short delay so that the weak item comes back soon.",
      "Active recall asks the learner to retrieve the answer from memory before checking it, instead of rereading the source.",
      "Retrieval practice itself strengthens the memory trace, an effect that is usually called the testing effect.",
      "Interleaving mixes similar concepts in one session, which forces the learner to notice how they differ.",
      "A good review card tests one gradable point, and its prompt must be self-contained rather than relying on an unseen slide.",
      "Grading recall as easy, hard or failed gives the scheduling algorithm the signal it needs to adjust the next interval.",
      "In the long run a little review every day retains more knowledge than cramming before an exam, and it causes less stress.",
    ].join("\n"),
  },
};

const MARKDOWN = {
  zh: {
    name: "observer-pattern.md",
    text: `# 观察者模式笔记

观察者模式定义了一种一对多的依赖关系，当被观察对象的状态改变时，所有观察者都会收到通知。

## 角色

- 主题对象负责保存观察者列表，并在自身状态变化时逐个通知它们。
- 观察者只需要实现一个更新方法，不需要知道主题对象内部是如何保存状态的。

## 适用场景

当一个对象的改变需要同时影响其他对象，而又不希望这些对象彼此紧密耦合时，就适合使用观察者模式。

## 常见误区

把观察者模式和发布订阅混为一谈是常见误区，后者通常还有一个独立的消息中间层负责转发事件。
`,
  },
  en: {
    name: "observer-pattern.md",
    text: `# Observer pattern notes

The observer pattern defines a one-to-many dependency so that every observer is notified when the subject changes state.

## Roles

- The subject keeps a list of observers and notifies each of them whenever its own state changes.
- An observer only implements an update method and does not need to know how the subject stores its state.

## When to use it

Use the observer pattern when a change to one object must update other objects without coupling those objects tightly to each other.

## A common mistake

A common mistake is to treat the observer pattern and publish-subscribe as identical, because the latter usually adds a separate broker that forwards events.
`,
  },
};

/** Three printed pages, one heading and two paragraphs each. */
const PDF_PAGES = {
  zh: [
    ["数据库索引入门", "索引是一种额外维护的数据结构，它让数据库在查询时不必逐行扫描整张表。", "最常见的索引结构是平衡树，它能在对数时间内定位到某个键所在的位置。"],
    ["索引的代价", "每次插入、更新或删除数据时，数据库都必须同步维护相关的索引，因此写入会变慢。", "索引本身也占用存储空间，为很少被查询的列建立索引往往得不偿失。"],
    ["联合索引与最左前缀", "联合索引按照列的顺序组织键值，查询条件需要从最左边的列开始才能充分利用它。", "如果查询只使用联合索引中靠后的列，数据库通常无法用这个索引缩小扫描范围。"],
  ],
  en: [
    ["An introduction to database indexes", "An index is an extra data structure that lets the database answer a query without scanning every row of a table.", "The most common index structure is a balanced tree, which locates a key in logarithmic time."],
    ["What indexes cost", "Every insert, update or delete must also maintain the related indexes, so writes become slower.", "An index takes storage space as well, so indexing a column that is rarely queried is usually not worth it."],
    ["Composite indexes and the leftmost prefix", "A composite index orders its keys by column, so a query must constrain the leftmost column to use it fully.", "If a query only filters on a later column of a composite index, the database usually cannot use that index to narrow the scan."],
  ],
};

export const qaLanguage = (language) => (language === "en" ? "en" : "zh");

/** A pasted-text source: { title, text }. */
export function sampleMaterial(language = "zh") {
  return { ...MATERIAL[qaLanguage(language)] };
}

/** A Markdown file: { name, text }. */
export function sampleMarkdown(language = "zh") {
  return { ...MARKDOWN[qaLanguage(language)] };
}

/** Printable HTML whose pages become a multi-page PDF (one section per page). */
export function samplePdfHtml(language = "zh") {
  const pages = PDF_PAGES[qaLanguage(language)];
  const escape = (value) => value.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
  const body = pages.map(([heading, ...paragraphs], index) =>
    `<section${index < pages.length - 1 ? ' style="break-after:page"' : ""}><h1>${escape(heading)}</h1>${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}</section>`).join("");
  return `<!doctype html><html lang="${qaLanguage(language) === "en" ? "en" : "zh-CN"}"><meta charset="utf-8"><style>body{font:16px/1.7 "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;margin:48px}h1{font-size:24px}</style><body>${body}</body></html>`;
}

export const samplePdfPageCount = (language = "zh") => PDF_PAGES[qaLanguage(language)].length;
