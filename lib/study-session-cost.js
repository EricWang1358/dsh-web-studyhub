/**
 * Pure function module for calculating itemized session study costs and efficiency per check item (Section 4.7).
 */

export function calculateSessionCost(session, progress = {}, usageRecords = []) {
  let tutoringTokens = 0;
  let tutoringMeasured = false;
  let generationTokens = 0;
  let generationUnmeasured = false;
  let qaTokens = 0;
  let reusedExistingQuestionsCount = 0;

  for (const record of usageRecords || []) {
    const tokens = record.tokens || 0;
    if (record.kind === 'tutoring' || record.kind === 'scene_read') {
      tutoringTokens += tokens;
      tutoringMeasured = true;
    } else if (record.kind === 'generation') {
      generationTokens += tokens;
      if (!Number.isFinite(record.tokens)) generationUnmeasured = true;
    } else if (record.kind === 'qa_organize') {
      qaTokens += tokens;
    } else if (record.kind === 'reuse_existing') {
      reusedExistingQuestionsCount += (record.count || 1);
    }
  }

  const independentPassedCount = progress.independentPassedCount || 0;
  const totalTokens = tutoringTokens + generationTokens + qaTokens;

  let costPerIndependentCheckItem = 'pending_first_pass';
  if (independentPassedCount > 0) {
    // Tokens only, as DSH's panel shows them; the plugin never turns them into a price. The main chat's own reasoning is counted
    // only when something measured it, and the unit cost says whether it is in.
    costPerIndependentCheckItem = {
      tokens: Math.round(totalTokens / independentPassedCount),
      includesTutoring: tutoringMeasured,
    };
  }

  return {
    breakdown: {
      tutoring: { tokens: tutoringMeasured ? tutoringTokens : null, measured: tutoringMeasured, note: tutoringMeasured
        ? '主会话教学讲解与读现场推理（读现场与导航工具本身 0 模型调用）'
        : '主会话教学讲解与读现场推理：插件读不到主会话的用量，没有计入（读现场与导航工具本身 0 模型调用）' },
      reusedQuestions: { count: reusedExistingQuestionsCount, tokens: 0, note: '复用题库已有题目（0 模型调用）' },
      generation: { tokens: generationUnmeasured ? null : generationTokens, measured: !generationUnmeasured, note: generationUnmeasured
        ? '新题生成与独立审核：有一次出题没有报告用量，没有计入'
        : '新题生成与独立审核' },
      qaOrganize: { tokens: qaTokens, note: qaTokens === 0 ? '复用讲解对话归位（0 额外模型调用）' : '独立模型组织 QA' },
    },
    totalTokens,
    independentPassedCount,
    costPerIndependentCheckItem,
  };
}
