/* The wording of the 资料清点, in the language the learner asked in. Chinese is the source text; English sits beside it. The only file of the folder with such text. */
const say = (language, zh, en) => (language === 'en' ? en : zh);

/** The name of the inventory record of a course, and the one line an older release shows of it. */
export const inventoryTitle = (language, course) => say(language, `资料清点 · ${course || '未分类课程'}`, `Inventory of the materials · ${course || 'Uncategorised'}`);
export const inventoryNotice = (language, items, documents) => say(language,
  `资料清点（由 StudyHub 管理，请勿删除）：${documents} 份资料里的 ${items} 个术语、定义、概念与步骤。它只是参考，不是资料。`,
  `Inventory of the materials (managed by StudyHub; do not delete): ${items} terms, definitions, concepts and steps in ${documents} materials. A reference, not material.`);

/** The stage line of the 清点 in the task console. */
export const inventoryStageText = (language, { done, total, failed }) => say(language,
  `正在清点资料：${Math.min(done, total)}/${total} 段${failed ? `（${failed} 段没读成，下次补读）` : ''}`,
  `Taking stock of the materials: ${Math.min(done, total)}/${total} ranges${failed ? ` (${failed} not read; read next time)` : ''}`);
