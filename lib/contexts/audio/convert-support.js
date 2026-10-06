import { MINERU } from '../../mineru-api.js';

/* What a conversion looks like to the panel and to the history, whichever path runs it (the original background run, or the runtime job):
   the working card (the job record the panel has always read), the pieces as the history keeps them, the stage words. */

export const NO_MATERIALS = '资料组件没有启用，转换结果没地方保存。请先启用资料组件再用云端解析。';
export const TYPE = 'pdf-convert';

export const finishedPages = manifest => manifest.chunks.reduce((sum, chunk) => sum + (chunk.state === 'done' ? chunk.pages : 0), 0);
export const publicChunks = manifest => manifest.chunks.map(chunk => ({ index: chunk.index + 1, startPage: chunk.startPage, endPage: chunk.endPage, pages: chunk.pages, state: chunk.state,
  ...(chunk.seconds > 0 ? { seconds: chunk.seconds } : {}) }));

/** What runs a cloud conversion: MinerU's model version and language (the settings the API is called with), the limits a piece is cut to, the size of the book. The token is never part of it. */
export const cloudEnvironment = manifest => ({ kind: 'cloud', modelVersion: MINERU.modelVersion, language: MINERU.language, maxPages: manifest.plan?.maxPages ?? manifest.limits?.maxPages,
  maxBytes: manifest.plan?.maxBytes ?? manifest.limits?.maxBytes, bookBytes: manifest.sourceBytes });
/** How a local run works on pages, read from the plan the manifest carries: a fixed window size, or the numbers of the adaptive plan. */
export const windowsOfPlan = plan => (plan?.kind === 'fixed' ? { kind: 'fixed', pages: plan.windowPages }
  : plan?.kind === 'adaptive' ? { kind: 'adaptive', firstPages: plan.firstPages, targetSeconds: plan.targetSeconds, minPages: plan.minPages, maxPages: plan.maxPages } : undefined);
export const adaptiveOf = manifest => manifest.route === 'local' && manifest.plan?.kind === 'adaptive';
/** The plan as the history keeps it at the end: the numbers it followed and, for an adaptive plan, the pace that was measured. */
export const endedPlan = (plan, local) => (plan?.kind === 'adaptive' && local?.pace?.secondsPerPage > 0 ? { ...plan, secondsPerPage: local.pace.secondsPerPage } : undefined);

/** The pieces of the book as the history keeps them: pages and state (the one that failed, the one running, the rest). `current` is the 1-based piece being worked on. */
export function recordWindows(chunks = [], { current = 0, finished = false } = {}) {
  return chunks.map(chunk => ({ start: chunk.startPage, end: chunk.endPage, pages: chunk.pages, seconds: chunk.seconds,
    state: chunk.state === 'done' || (finished && chunk.state === 'done') ? 'done' : chunk.error ? 'failed' : chunk.index === current && !finished ? 'running' : 'planned' }));
}

/** The plain-language stage of a phase, e.g. "第 2/3 段 · 正在解析". */
export function stageText(phase, { index = 0, count = 1 } = {}) {
  const piece = count > 1 && index > 0 ? `第 ${index}/${count} 段 · ` : '';
  switch (phase) {
    case 'split': return '正在切分 PDF';
    case 'upload': return `${piece}正在上传`;
    case 'parse': return `${piece}正在解析`;
    case 'local': return `${piece}正在本地解析`;
    case 'download': return `${piece}正在下载结果`;
    case 'merge': return '正在合并各段结果';
    case 'save': return '正在保存为资料';
    case 'queued': return '排队中';
    default: return '正在处理';
  }
}

/** The sentences of a conversion's end (each has an English form in lib/application-messages*.js). */
export const CONVERT_TEXT = Object.freeze({
  savedAs: count => `已存为 ${count} 页资料`,
  cleanupLeft: '临时文件没能全部清理；它们在 DSH 主目录里，之后会自动清除。',
  cancelled: '已取消；已解析好的段落会保留，再导入同一个文件不会重复解析',
  letterFailed: '信箱通知未能保存，请在资料页查看任务结果。',
  resumeHint: '已完成的部分已保存，可在资料页点「接着做」',
});
