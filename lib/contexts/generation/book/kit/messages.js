/* The Chinese words the exam answer kit reads sample papers by (book/kit/group.js, book/kit/questions.js), kept in the one file of this layer that may hold
   Chinese text. */

/** The Chinese command words of each question family, tried after the English ones. */
export const ZH_COMMAND_WORDS = Object.freeze({
  compare: ['比较', '对比', '区别', '异同', '不同'],
  calculate: ['计算', '求出', '估算', '推导'],
  design: ['设计', '画出', '提出', '构建'],
  evaluate: ['评价', '评估', '论证', '优缺点', '利弊', '讨论'],
  apply: ['给定', '假设', '考虑', '情景', '案例'],
  explain: ['解释', '说明', '描述', '什么是', '为什么', '定义'],
  list: ['列出', '写出', '指出', '举出'],
});

/** A Chinese question label (第 3 题), as the source of a regular expression. */
export const ZH_LABEL = '第\\s*[一二三四五六七八九十\\d]+\\s*题';
