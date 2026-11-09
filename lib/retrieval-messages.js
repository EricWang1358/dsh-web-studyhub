/* The words of the search-index build, in one place (Chinese source text; lib/application-messages-en.js has the English).
   The build's job code (lib/contexts/retrieval) carries no prose of its own. */

const SCOPE_ALL = '*';

export const INDEX_TEXT = Object.freeze({
  noSources: '这门课还没有资料，没有可以建立索引的内容',
  batchInvalid: '检索扩展返回了无法确认的批次结果，请重试建立索引。',
  batchPageFailed: '这一页没能写入检索索引。',
  batchMaintenance: error => `检索批次整理没有完成，本批次会在重试时重新确认：${String(error).slice(0, 300)}`,
  manifestUnsaved: '检索扩展已经收下这些页，但本地的索引记录没能保存。再次开始会用同一个来源标识重新写入，会替换而不会重复建立。',
  repairRunning: '检索服务正在运行，不需要修复。',
  repairFailed: '索引正被占用，没能移开。请完全退出 DSH 再打开，然后再点修复。',
  title: course => (course && course !== SCOPE_ALL ? `建立检索索引 · ${course}` : '建立检索索引'),
  stage: (phase, { done = 0, total = 0 } = {}) => ({
    preparing: '正在准备…',
    model: '正在准备检索模型（首次需要下载，可能要一两分钟）…',
    indexing: `正在建立索引 ${done} / ${total} 页`,
    done: '索引已建好',
    cancelled: '已停止；已写入的页会保留，再次开始会接着做',
    failed: '建立索引没有完成',
  })[phase],
});
