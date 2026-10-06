/* The words of the search-index build, in one place (Chinese source text; lib/application-messages-en.js has the English).
   The build's job code (lib/contexts/retrieval) carries no prose of its own. */

const SCOPE_ALL = '*';

export const INDEX_TEXT = Object.freeze({
  noSources: '这门课还没有资料，没有可以建立索引的内容',
  needsSession: '后台建立索引需要一个正在使用的学习会话：请先在 DSH 里打开一个会话，再从学习面板重新点「建立索引」。',
  manifestUnsaved: '检索扩展已经收下这些页，但本地的索引记录没能保存。再次开始会用同一个来源标识重新写入，会替换而不会重复建立。',
  title: course => (course && course !== SCOPE_ALL ? `检索索引 · ${course}` : '检索索引'),
  stage: (phase, { done = 0, total = 0 } = {}) => ({
    preparing: '正在准备…',
    model: '正在准备检索模型（首次需要下载，可能要一两分钟）…',
    indexing: `正在建立索引 ${done} / ${total} 页`,
    done: '索引已建好',
    cancelled: '已停止；已写入的页会保留，再次开始会接着做',
    failed: '建立索引没有完成',
  })[phase],
});
