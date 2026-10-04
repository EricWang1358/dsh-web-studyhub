/* Materials / import / generation-status / update surfaces (QA only), with fixed props and no backend; built and screenshotted by
   scripts/qa/wpm-shots.mjs. The PDF job rows and the history are the scenes of scripts/qa/mineru-gallery.jsx.
   Query: ?lang=zh|en&theme=dark|light&scene=merge|import|generate|update */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import { setUiLanguage } from '../../ui/i18n.js';
import { StudyServicesContext } from '../../ui/study-context.jsx';
import Manage from '../../ui/Manage.jsx';
import ImportHub from '../../ui/ImportHub.jsx';
import Generate from '../../ui/Generate.jsx';
import { UpdateChip, UpdateSettings } from '../../ui/UpdateCenter.jsx';
import ModelErrorNote from '../../ui/ModelErrorNote.jsx';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'merge';
setUiLanguage(lang);

const style = document.createElement('style');
style.textContent = `${styleCss}
  html, body, #root { height: 100%; margin: 0; }
  .gallery { max-width: 1040px; margin: 0 auto; padding: 24px 28px 96px; }
  .g-section { padding: 24px 0; border-top: 1px solid var(--line-soft); }
  .g-section > h2 { margin: 0 0 14px; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
  @container study (max-width: 640px) { .gallery { padding: 16px 12px 72px; } }`;
document.head.appendChild(style);

const noop = () => {};
const Section = ({ title, children }) => <section className="g-section"><h2>{title}</h2>{children}</section>;

const card = (id, topic, prompt) => ({ id, topic, prompt, kind: 'quiz', explanation: '' });
const deck = { id: 'd-patterns', title: '设计模式 · 第 4 章', folder: '', archived: false, cards: [card('c1', '观察者', '观察者模式解决什么问题？'), card('c2', '观察者', '被观察者如何通知订阅者？'), card('c3', '策略', '策略模式与状态模式有何区别？')] };
const peers = [deck, { id: 'd-se', title: '软件工程基础', folder: '', count: 20 }, { id: 'd-os', title: '操作系统期中', folder: '复习', count: 35 }];

/* Pages read call / act / busy / askInChat from the study services, not from props. */
const services = (over) => ({ call: async () => ({}), act: async () => undefined, busy: false, notify: () => {}, askInChat: () => {}, host: {}, openSettings: () => {}, navigate: () => {}, openModal: () => {}, ...over });
const Study = ({ over, children }) => <StudyServicesContext.Provider value={services(over)}>{children}</StudyServicesContext.Provider>;
function MergeScene() {
  const [folder, setFolder] = React.useState('');
  return <main><div className="page gallery"><Study over={{ call: async () => deck, act: async () => ({ moved: 3 }) }}><Manage openDraft={noop} setPage={noop}
    managedDeck={deck} decks={peers} sources={[]} setManagedDeck={noop} folderDraft={folder} setFolderDraft={setFolder} onRemoveDeck={noop} /></Study></div></main>;
}

const REQUEST_PROBLEM = Object.assign(new Error('Extracted text exceeds 600,000 characters'), { code: 'text-too-long', details: { limit: 600000 } });
const importCall = async (action, args) => {
  if (action === 'materials.document.import') throw args.filename.endsWith('.docx') ? REQUEST_PROBLEM : new Error('unexpected');
  if (action === 'retrieval.status') return { providers: [], extension: { canInstall: true, installed: false } };
  return {};
};

function ImportScene() {
  return <main><div className="page gallery"><Study over={{ call: importCall }}><ImportHub data={{ focus: { course: '数据结构', courses: [{ name: '数据结构' }, { name: '操作系统' }] }, contexts: ['audio'] }} /></Study></div></main>;
}

const sources = [{ id: 'a', title: '数据库索引笔记', text: '索引加快查找。', courses: ['数据库'] }, { id: 'b', title: '事务笔记.md', text: '事务保证一致性。', courses: ['数据库'] }];
function GenerateScene() {
  const data = { root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: false, focus: { course: '数据库', courses: [{ name: '数据库' }] } };
  return <main><div className="page gallery"><Study><Generate data={data} running={false} openDraft={noop} setPage={noop} setNotice={noop} genSource="files" setGenSource={noop}
    gen={{ kind: 'mixed', count: 10, difficulty: 'mixed', language: lang === 'en' ? 'English' : '中文', focus: '', role: '' }} setGen={noop} selectedSources={['a']} setSelectedSources={noop}
    setModal={noop} openModelSettings={noop} /></Study></div></main>;
}

const update = (extra = {}) => ({ current: '2.5.12', latest: '2.5.12', newer: false, installed: '2.5.12', publishedAt: '2026-10-01T08:00:00Z', url: 'https://example.test/release',
  checkedAt: '2026-10-03T10:00:00.000Z', autoCheck: true, snoozed: false, pendingRestart: null, ...extra });
function UpdateScene() {
  return <main><div className="page gallery">
    <Section title="Manual check failed"><UpdateSettings update={update()} call={async () => ({})} onOpen={noop} initialCheckError="Study connection is unavailable" /></Section>
    <Section title="GitHub unreachable (automatic check)"><UpdateSettings update={update({ error: 'network' })} call={async () => ({})} onOpen={noop} /></Section>
    <Section title="Up to date"><UpdateSettings update={update()} call={async () => ({})} onOpen={noop} /></Section>
    <Section title="New version, and a setting that did not save"><UpdateSettings update={update({ latest: '2.6.0', newer: true })} call={async () => ({})} onOpen={noop} initialSaveError="denied" /></Section>
    <Section title="Sidebar chip"><div style={{ width: 232 }}><UpdateChip update={update({ latest: '2.6.0', newer: true })} onOpen={noop} /></div></Section>
    <Section title="Model errors"><div style={{ display: 'grid', gap: 12 }}>
      <ModelErrorNote error="429 Too Many Requests: rate limit" onRetry={noop} onSettings={noop} />
      <ModelErrorNote error="401 Unauthorized: invalid api key" onRetry={noop} onSettings={noop} />
    </div></Section>
  </div></main>;
}

const Scene = { merge: MergeScene, import: ImportScene, generate: GenerateScene, update: UpdateScene }[scene] || MergeScene;
createRoot(document.getElementById('root')).render(<div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'}><Scene /></div>);
