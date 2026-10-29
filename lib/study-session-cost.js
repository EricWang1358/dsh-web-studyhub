/**
 * Pure function module for calculating itemized session study costs and efficiency per check item (Section 4.7).
 */

export function calculateSessionCost(session, progress = {}, usageRecords = []) {
  let tutoringTokens = 0;
  let generationTokens = 0;
  let generationCostUsd = 0;
  let qaTokens = 0;
  let reusedExistingQuestionsCount = 0;

  for (const record of usageRecords || []) {
    const tokens = record.tokens || 0;
    const cost = record.costUsd || 0;
    if (record.kind === 'tutoring' || record.kind === 'scene_read') {
      tutoringTokens += tokens;
    } else if (record.kind === 'generation') {
      generationTokens += tokens;
      generationCostUsd += cost;
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
    costPerIndependentCheckItem = {
      tokens: Math.round(totalTokens / independentPassedCount),
      costUsd: Number((generationCostUsd / independentPassedCount).toFixed(4)),
    };
  }

  return {
    breakdown: {
      tutoring: { tokens: tutoringTokens, note: '主会话教学讲解与读现场推理（读现场与导航工具本身 0 模型调用）' },
      reusedQuestions: { count: reusedExistingQuestionsCount, tokens: 0, note: '复用题库已有题目（0 模型调用）' },
      generation: { tokens: generationTokens, costUsd: generationCostUsd, note: '新题生成与独立审核' },
      qaOrganize: { tokens: qaTokens, note: qaTokens === 0 ? '复用讲解对话归位（0 额外模型调用）' : '独立模型组织 QA' },
    },
    totalTokens,
    generationCostUsd,
    independentPassedCount,
    costPerIndependentCheckItem,
  };
}
