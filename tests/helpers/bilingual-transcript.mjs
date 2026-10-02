/* The owner's bilingual lecture transcript, as a fixture: a title, then nine parts, each with a Chinese
   heading, an English bracket line, "### 英文原句" (the English sentences) and "### 中文对照" (their Chinese rendering). */
export const PART_TITLES = [
  ['平台的含义与作用', 'Meaning And Role Of Platforms'], ['平台边界与平台经济', 'Platform Boundaries And Platform Economy'],
  ['双边市场与网络效应', 'Two-Sided Markets And Network Effects'], ['定价与补贴策略', 'Pricing And Subsidy Strategy'],
  ['多平台接入与锁定', 'Multi-Homing And Lock-In'], ['数据与算法治理', 'Data And Algorithm Governance'],
  ['平台竞争与反垄断', 'Platform Competition And Antitrust'], ['生态系统与互补品', 'Ecosystems And Complements'],
  ['课程回顾与作业', 'Course Review And Assignment'],
];
const NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function bilingualMarkdown({ title = '平台经济课堂实录' } = {}) {
  const lines = title ? [`# ${title}`, ''] : [];
  PART_TITLES.forEach(([zh, en], index) => {
    lines.push(`## 第${NUMBERS[index]}部分：${zh}`, '', `[Part ${index + 1}: ${en}]`, '', '### 英文原句', '',
      `So in part ${index + 1} we look at ${en.toLowerCase()} and why it matters for the firms in the market.`, '',
      `A platform lets two groups find each other, and example ${index + 1} shows how the rules of the platform change what each group does.`, '',
      '### 中文对照', '', `在第${NUMBERS[index]}部分里，我们讨论${zh}，以及它为什么对市场里的企业很重要。`, '',
      `平台让两类人群找到彼此，第${index + 1}个例子说明平台规则如何改变各方的行为。`, '');
  });
  return lines.join('\n');
}

/** The h1–h4 headings of a Markdown text as the fake DOM nodes the reader tests use. */
export function headingNodes(markdown) {
  return String(markdown).split('\n').flatMap(line => {
    const mark = /^(#{1,4})\s+(.+)$/.exec(line);
    return mark ? [{ tagName: `H${mark[1].length}`, textContent: mark[2], closest: () => null, dataset: {} }] : [];
  });
}

/** The text a library keeps for that Markdown: every block on its own line, no markers (lib/contexts/materials/files.js). */
export function projectedText(markdown) {
  return String(markdown).split('\n').filter(line => line.trim()).map(line => line.replace(/^#{1,6}\s+/, '')).join('\n');
}
