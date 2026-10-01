/* WP17 QA harness (built by scripts/qa/wp17-rows.mjs): every SegmentedControl
   variant, the recording-setup rows (Ingest, which the preview host does not
   offer) and a Disclosure, in one page. Query: ?lang=zh|en&theme=dark|light */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/style.css';
import { setUiLanguage } from '../../ui/i18n.js';
import Ingest from '../../ui/Ingest.jsx';
import { Disclosure, SegmentedControl } from '../../ui/components/index.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
setUiLanguage(lang);
const t = (zh, en) => (lang === 'en' ? en : zh);
const style = document.createElement('style');
style.textContent = `${styleCss}
  html, body, #root { height: 100%; margin: 0; }
  .h { max-width: 900px; margin: 0 auto; padding: 24px; display: grid; gap: 22px; }
  .h h2 { margin: 0 0 8px; font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-muted); }
  .h-narrow { width: 300px; }`;
document.head.appendChild(style);

function Row({ title, ...props }) {
  const [value, setValue] = useState(props.options[1]?.value ?? props.options[0].value);
  return <section><h2>{title}</h2><SegmentedControl {...props} value={value} onChange={setValue} /></section>;
}
const opts = labels => labels.map((label, index) => ({ value: String(index), label }));

function App() {
  return (
    <div className="study-app" data-theme={theme} style={{ minHeight: '100%', background: 'var(--bg)', color: 'var(--text)', containerType: 'inline-size', containerName: 'study' }}>
      <div className="h">
        <Row title="md" label="md" options={opts([t('不限题型', 'Any type'), t('只单选', 'Single'), t('只多选', 'Multiple'), t('单双均衡', 'Balanced')])} />
        <Row title="sm" size="sm" label="sm" options={opts([t('脉络', 'Spine'), t('结构图', 'Canvas')])} />
        <Row title="icons" label="icons" options={[{ value: 'a', label: t('文件', 'Files'), icon: 'file' }, { value: 'b', label: t('音频', 'Audio'), icon: 'audio' }, { value: 'c', label: t('粘贴', 'Paste'), icon: 'plus' }]} />
        <Row title="disabled option (arrow keys skip it)" label="disabled" options={[{ value: 'a', label: 'One' }, { value: 'b', label: 'Two' }, { value: 'c', label: 'Three (off)', disabled: true }, { value: 'd', label: 'Four' }]} />
        <section className="h-narrow"><Row title="wraps at 300 px" label="wrap" options={opts([t('自动识别', 'Auto-detect'), t('闪卡', 'Flashcards'), t('单选 MQ', 'Single choice'), t('多选', 'Multiple'), t('开放问答', 'Open')])} /></section>
        <section><h2>Ingest (recording setup)</h2><Ingest data={{ decks: [], modelReady: true }} busy={false} start={() => {}} /></section>
        <section><h2>Disclosure</h2><Disclosure summary={t('高级选项', 'Advanced options')} meta={t('可选', 'Optional')}><p>{t('这里是展开后的内容。', 'Expanded content lives here.')}</p></Disclosure></section>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
