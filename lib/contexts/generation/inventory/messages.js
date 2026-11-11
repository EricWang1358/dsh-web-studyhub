/* The wording of the 资料清点, in the language the learner asked in. Chinese is the source text; English sits beside it. The only file of the folder with such text. */
const say = (language, zh, en) => (language === 'en' ? en : zh);

/** The name of the inventory record of a course, and the one line an older release shows of it. */
export const inventoryTitle = (language, course) => say(language, `资料清点 · ${course || '未分类课程'}`, `Inventory of the materials · ${course || 'Uncategorised'}`);
export const inventoryNotice = (language, items, documents) => say(language,
  // An older release lists this record as a material, so this is the one sentence it can show: a release before 3.5 writes empty explanations over a book of page spans (#487).
  `资料清点（由 StudyHub 管理，请勿删除）：${documents} 份资料里的 ${items} 个术语、定义、概念与步骤。它只是参考，不是资料，不要拿它出题；在 3.5 以下的版本里不要点「更新全书」。`,
  `Inventory of the materials (managed by StudyHub; do not delete): ${items} terms, definitions, concepts and steps in ${documents} materials. `
    + 'A reference, not material: make no questions from it; in a release before 3.5 do not press Update the book.');

/** Why the model calls of a stage fail, from inventory/model-failure.js causeOf: a kind and, when known, the status and the provider's code (never its text). */
function causeText(language, { kind, status, code, minutes }) {
  const detail = [status, code].filter(Boolean).join(' '), of = detail ? say(language, `（${detail}）`, ` (${detail})`) : '';
  return {
    silent: say(language, `${minutes} 分钟没有任何输出，请求没有回应`, `no output at all for ${minutes} min; the request got no answer`),
    refused: say(language, `模型拒绝了调用${of}：多半是密钥、额度或模型设置的问题，再问一次也不会变`,
      `the model refused the call${of}: most likely its key, quota or model settings; asking again will not change it`),
    'rate-limit': say(language, `模型请求太频繁，被限流了${of}`, `too many requests: the model is rate limited${of}`),
    timeout: say(language, '请求超时', 'the request timed out'),
    unavailable: say(language, `模型服务暂时不可用${of}`, `the model service is unavailable${of}`),
  }[kind] ?? say(language, `模型调用出错${of}`, `the model call failed${of}`);
}

/** The one reason a stage stops with when the model itself is failing, and the way on: the parts read so far are kept for 接着做 (the Job's retry). */
export const modelFailingText = (language, cause, run) => (cause.kind === 'refused'
  ? say(language, `已停下：${causeText(language, cause)}。请检查这次用的模型（会话里选的模型和它的密钥、额度），改好后点「接着做」；已经完成的部分会保留。`,
    `Stopped: ${causeText(language, cause)}. Check the model this task uses (the session's model, its key and quota), then press Continue; what was done is kept.`)
  : say(language, `已停下：模型连续 ${run} 次调用都失败了，原因相同：${causeText(language, cause)}。剩下的部分没有再问。请换一个能用的模型，或等它恢复后点「接着做」；已经完成的部分会保留。`,
    `Stopped: ${run} model calls in a row failed the same way: ${causeText(language, cause)}. The rest was not asked. `
      + 'Switch to a model that works, or wait until it recovers, then press Continue; what was done is kept.'));

/** The stage line of the 清点 in the task console. */
export const inventoryStageText = (language, { done, total, failed }) => say(language,
  `正在清点资料：${Math.min(done, total)}/${total} 段${failed ? `（${failed} 段没读成，下次补读）` : ''}`,
  `Taking stock of the materials: ${Math.min(done, total)}/${total} ranges${failed ? ` (${failed} not read; read next time)` : ''}`);
