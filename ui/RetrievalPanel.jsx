import React, { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Hint, InlineMessage } from './components/index.js';
import { formatNumber } from './format.js';
import { useStudy } from './study-context.jsx';
import css from './large-documents.css';

/* On 创建题组 (WP28): with a retrieval tool chosen, a big selection is narrowed to
   the pages the tool finds for the topic. This panel says so, shows which pages
   would be used before anything is sent, and lets the learner adjust them: 只用
   勾选的页面 replaces the selection with exactly those pages. */

/**
 * Props: call, advice (generateAdvice), sourceIds (the selection), focus (the topic),
 * course, onApply(ids), disabled, initialPreview (retrieval.preview result; tests and previews).
 */
export default function RetrievalPanel({ advice, sourceIds = [], focus = '', course, onApply, disabled = false, initialPreview = null }) {
  const { call } = useStudy();
  useInjectCss(css, 'study-large-documents');
  const [preview, setPreview] = useState(initialPreview);
  const [checked, setChecked] = useState(() => new Set((initialPreview?.pages || []).map(page => page.sourceId)));
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const topic = String(focus ?? '').trim();
  async function run() {
    setLoading(true); setError('');
    try {
      const result = await call('retrieval.preview', { sourceIds, query: topic, ...(course ? { course } : {}), limit: 20 });
      setPreview(result); setChecked(new Set((result?.pages || []).map(page => page.sourceId)));
    } catch (failure) { setError(failure?.message || String(failure)); }
    finally { setLoading(false); }
  }
  const toggle = (id, on) => setChecked(current => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  return (
    <section className="retrieval-panel" aria-label={ui('用检索挑选页面')}>
      <div className="retrieval-panel__head">
        <p>{advice?.needsTopic
          ? ui('所选资料太大。先在「这次想练什么？」写下主题，StudyHub 才能用检索挑出相关页面。')
          : uiFormat('检索已启用：出题时会先挑出和主题相关的页面，只把这些页面发给 AI（所选资料约 {0} 个字符）。', [formatNumber(Number(advice?.chars || 0))])}</p>
        <Button size="sm" variant="secondary" busy={loading} disabled={disabled || !topic} onClick={run}>{ui('预览会用到的页面')}</Button>
      </div>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {preview && preview.pages?.length > 0 && <>
        <ul className="retrieval-panel__pages" aria-label={ui('检索挑出的页面')}>
          {preview.pages.map(page => <li key={page.sourceId}>
            <label>
              <input type="checkbox" checked={checked.has(page.sourceId)} disabled={disabled} onChange={event => toggle(page.sourceId, event.target.checked)} />
              <span className="retrieval-panel__page">{page.page ? uiFormat('第 {0} 页', [page.page]) : page.title}</span>
              <span className="retrieval-panel__snippet">{page.snippet}</span>
            </label>
          </li>)}
        </ul>
        {preview.unresolved > 0 && <Hint>{uiFormat('另有 {0} 段没能对应到你资料里的页面，已忽略。', [preview.unresolved])}</Hint>}
        {preview.truncated && <Hint>{ui('相关页面很多，只列出了最相关的一部分。')}</Hint>}
        <div className="retrieval-panel__actions">
          <Button size="sm" variant="secondary" disabled={disabled || !checked.size} onClick={() => onApply?.(preview.pages.filter(page => checked.has(page.sourceId)).map(page => page.sourceId))}>{ui('只用勾选的页面')}</Button>
          <Button size="sm" variant="quiet" onClick={() => setPreview(null)}>{ui('关闭预览')}</Button>
        </div>
      </>}
      {preview && !preview.pages?.length && <Hint>{ui('检索没有找到相关页面。换个说法再试，或按章节缩小选择。')}</Hint>}
    </section>
  );
}
