import React from 'react';
import { ui, uiFormat, uiMessage } from '../i18n.js';
import { joinMeta } from '../format.js';

/* 索引详情: a search-index build (lib/contexts/generation/retrieval/jobs) writes pages to the local search extension and asks no model, so the console shows
   no model-call panels for it. This section says what the build did: the pages written, the ones that needed no update, the ones with no searchable text,
   the ones taken out, what the search service said about the pages it could not write (by cause, of the first 10 the job keeps), and a page whose write was
   cut by a stop (written again by the next build). */

/** The kept failed pages by what the search service said: [[message, pages]], the most frequent first (a stop after 5 pages is usually one cause 5 times). */
const causes = (failed) => [...failed.reduce((all, item) => all.set(item.message, (all.get(item.message) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);

export default function IndexDetail({ contract }) {
  const index = contract.detail?.index || {}, failed = index.failed || [], unconfirmed = index.unconfirmed || [];
  const counts = joinMeta([uiFormat('已完成 {0} / {1} 页', [contract.progress.done, contract.progress.total ?? 0]),
    index.added > 0 ? uiFormat('新写入 {0} 页', [index.added]) : '', index.removed > 0 ? uiFormat('移除 {0} 页', [index.removed]) : '',
    index.unchanged > 0 ? uiFormat('无需更新 {0} 页', [index.unchanged]) : '', index.skipped > 0 ? uiFormat('无检索文字 {0} 页', [index.skipped]) : '',
    index.failedCount > 0 ? uiFormat('没能写入 {0} 页', [index.failedCount]) : '']);
  return (
    <div className="tc-scroll" data-index-detail>
      <ul className="tc-steps tc-steps--index">
        <li data-state={contract.status === 'complete' ? 'done' : contract.status === 'failed' ? 'failed' : 'active'}>{counts}</li>
        {causes(failed).map(([message, pages]) => <li key={message} data-state="failed">{uiFormat('{0} · {1} 页', [uiMessage(message), pages])}</li>)}
        {index.failedCount > failed.length && <li>{uiFormat('另有 {0} 页没能写入，下次建立时会重试。', [index.failedCount - failed.length])}</li>}
        {unconfirmed.length > 0 && <li>{uiFormat('停止时有 {0} 页正在写入，不确定是否写进去了；下次建立会重新写它。', [unconfirmed.length])}</li>}
        <li>{ui('在本机把页面写进检索扩展，不调用 AI，不花 token。停止后已写入的页会保留，再次开始只写还没建好的页。')}</li>
      </ul>
    </div>
  );
}
