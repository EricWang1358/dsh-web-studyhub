/* Wave 3 · WP-Q QA page (built by scripts/qa/wp-q.mjs): the real ThumbFeedback with a fake host `call`, the app's toast region,
   and a stand-in for the review page's 修题 box that fills from onFix. Query: ?lang=zh|en&theme=dark|light&rewriteVia=1|0 */
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import coachCss from '../../ui/coach.css';
import { setUiLanguage } from '../../ui/i18n.js';
import ThumbFeedback from '../../ui/ThumbFeedback.jsx';
import ActionFeedback from '../../ui/ActionFeedback.jsx';
import { ToastContext, createToastApi } from '../../ui/components/Feedback.jsx';
import { fixSuggestionFor } from '../../ui/card-fix.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const withFix = params.get('onFix') !== '0';
setUiLanguage(lang);
document.documentElement.dataset.theme = theme;

const style = document.createElement('style');
style.textContent = styleCss + coachCss + `
  html, body, #root { height: 100%; margin: 0; }
  .qa-body { padding: 280px 16px 16px; display: grid; gap: 14px; max-width: 760px; }
  .qa-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
`;
document.head.appendChild(style);

const calls = [];
window.__calls = calls;
const CONSENT = params.get('consent') !== '0';
const DIFFICULTY = ['too-easy', 'too-hard'];
// The same contract as the coach.feedback operation: tags recorded, `fix` for rewrite tags, prep only with consent.
async function call(action, args) {
  calls.push({ action, args });
  if (action !== 'coach.feedback') return {};
  const tags = args.tags || [];
  const fix = tags.filter(tag => !DIFFICULTY.includes(tag));
  const scheduled = [];
  if (args.rewriteVia !== 'assist' && fix.length) scheduled.push('rewrite');
  if (CONSENT && tags.some(tag => DIFFICULTY.includes(tag))) scheduled.push('prep');
  return { vote: args.vote, tags, scheduled, ...(args.rewriteVia === 'assist' ? { fix } : {}) };
}

function Page() {
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const toast = useMemo(() => createToastApi({ setNotice, setError }), []);
  const [fix, setFix] = useState({ open: false, text: '' });
  const run = { id: 'r1', deckId: 'd1', card: { id: 'c1', prompt: lang === 'en' ? 'Why is a retry idempotent?' : '为什么重试要幂等？' } };
  return <ToastContext.Provider value={toast}>
    <div className="study-app" data-theme={theme} tabIndex={-1} style={{ minHeight: '100%' }}>
      <div className="qa-body">
        <div className="qa-bar question-toolbar">
          <strong>{run.card.prompt}</strong>
          <ThumbFeedback run={run} call={call} canShortcut={() => true}
            onFix={withFix ? tags => setFix({ open: true, text: fixSuggestionFor(tags) }) : undefined} />
        </div>
        {fix.open && <form className="assist-form" aria-label="improve-box" onSubmit={event => event.preventDefault()}>
          <label>{lang === 'en' ? 'What is wrong with this question?' : '这道题哪里不好？'}
            <textarea rows={4} value={fix.text} onChange={event => setFix({ open: true, text: event.target.value })} />
          </label>
        </form>}
        <ActionFeedback notice={notice} error={error} onCloseNotice={() => setNotice('')} onCloseError={() => setError('')} placement="inline" />
      </div>
    </div>
  </ToastContext.Provider>;
}

createRoot(document.getElementById('root')).render(<Page />);
