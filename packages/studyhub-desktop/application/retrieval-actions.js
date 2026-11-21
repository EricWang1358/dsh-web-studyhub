const EAGER_RETRIEVAL_ACTIONS = new Set([
  'retrieval.index.plan',
  'retrieval.index.coverage',
  'retrieval.index.start',
  'retrieval.preview',
  'retrieval.test',
]);

const CONFIGURED_RETRIEVAL_ACTIONS = new Set([
  'generate',
  'generate.preview',
  'deck.generate',
  'supplement',
  'case.drills',
  'course.custom.fill',
  'course.custom.apply',
  'job.control',
]);

function unwrapForwardError(answer, fallbackMessage) {
  return Object.assign(
    new Error(answer?.error?.message || fallbackMessage),
    { code: answer?.error?.code || 'STUDY_ERROR' }
  );
}

/**
 * Lazy-start the retrieval server when an incoming action actually needs retrieval tools.
 */
export async function prepareRetrievalForAction(retrievalRuntime, action) {
  if (!retrievalRuntime || typeof action !== 'string') return;
  if (EAGER_RETRIEVAL_ACTIONS.has(action)) {
    await retrievalRuntime.ensureReady({ allowStart: true });
    return;
  }
  if (CONFIGURED_RETRIEVAL_ACTIONS.has(action) || action.startsWith('generation.')) {
    await retrievalRuntime.ensureReadyIfConfigured();
  }
}

/**
 * Create StudyHub Desktop RPC handlers for retrieval status, provider selection,
 * install/uninstall, hot-restart endpoint updates, and Windows-safe stop-repair-restart.
 */
export function createRetrievalActionHandlers({ retrievalRuntime, forward }) {
  if (!retrievalRuntime) return {};
  return {
    'retrieval.status': async (args) => {
      await retrievalRuntime.ensureReady({ allowStart: true });
      const answer = await forward('retrieval.status', args);
      if (!answer.ok) throw unwrapForwardError(answer, '读取检索状态失败');
      return retrievalRuntime.enrichStatus(answer.value);
    },
    'retrieval.set': async (args) => {
      await retrievalRuntime.ensureReady({ allowStart: true });
      const answer = await forward('retrieval.set', args);
      if (!answer.ok) throw unwrapForwardError(answer, '切换检索工具失败');
      return retrievalRuntime.enrichStatus(answer.value);
    },
    'retrieval.extension.install': () => retrievalRuntime.install(),
    'retrieval.extension.uninstall': () => retrievalRuntime.uninstall(),
    'retrieval.extension.restart': async (args) => {
      await retrievalRuntime.restart();
      const answer = await forward('retrieval.status', args);
      if (!answer.ok) throw unwrapForwardError(answer, '重启检索服务失败');
      return retrievalRuntime.enrichStatus(answer.value);
    },
    'retrieval.endpoint.set': async (args) => {
      const answer = await forward('retrieval.endpoint.set', args);
      if (!answer.ok) throw unwrapForwardError(answer, '保存模型下载地址失败');
      if (retrievalRuntime.isRunning() || retrievalRuntime.getCandidate()?.valid) {
        await retrievalRuntime.restart();
      }
      const next = await forward('retrieval.status', args);
      return retrievalRuntime.enrichStatus(next.ok ? next.value : answer.value);
    },
    'retrieval.index.repair': async (args) => {
      await retrievalRuntime.beforeRepair();
      let answer;
      try {
        answer = await forward('retrieval.index.repair', args);
      } finally {
        await retrievalRuntime.afterRepair();
      }
      if (!answer.ok) throw unwrapForwardError(answer, '修复检索索引失败');
      return {
        ...answer.value,
        restarted: true,
        running: retrievalRuntime.isRunning(),
      };
    },
  };
}
