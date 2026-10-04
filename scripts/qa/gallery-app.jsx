/* Component gallery (QA only): every ui/components state in one page, built by
   scripts/qa/gallery.mjs. Query: ?lang=zh|en&theme=dark|light&scene=all|toast|dialog|full|drop */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/styles.js';
import { setUiLanguage } from '../../ui/i18n.js';
import ActionFeedback from '../../ui/ActionFeedback.jsx';
import ModalFrame from '../../ui/ModalFrame.jsx';
import {
  Banner, Button, Dialog, Disclosure, EmptyState, FileDrop, IconButton, InlineMessage, PageHeader, Panel,
  SegmentedControl, SetupRequired, Toast,
} from '../../ui/components/index.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'all';
setUiLanguage(lang);
const t = (zh, en) => lang === 'en' ? en : zh;
const MB = 1024 * 1024;

const style = document.createElement('style');
style.textContent = styleCss + `
  html, body, #root { height: 100%; margin: 0; }
  .gallery { max-width: 1120px; margin: 0 auto; padding: 28px 32px 120px; }
  .g-section { padding: 28px 0; border-top: 1px solid var(--line-soft); }
  .g-section > h2 { margin: 0 0 18px; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
  .g-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .g-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; }
  .g-stack { display: grid; gap: 12px; }
  .g-caption { margin: 0 0 8px; font-size: 13px; color: var(--text-muted); }
  .g-swatches { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
  .g-swatch { padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; }
  .g-swatch span { display: block; font-size: 15px; line-height: 1.6; }
  .g-host { position: relative; padding: 12px; border: 1px dashed var(--line); border-radius: 12px; }
  .g-host-label { font-size: 13px; color: var(--text-muted); margin: 0 0 8px; }
  .g-filler { height: 1400px; display: grid; align-content: start; gap: 12px; color: var(--text-muted); }
  .g-filler p { margin: 0; padding: 18px; border: 1px solid var(--line-soft); border-radius: 12px; }
  @container study (max-width: 640px) { .gallery { padding: 20px 16px 96px; } }
`;
document.head.appendChild(style);

const log = window.__galleryLog = [];

function Tokens() {
  const text = ['--text', '--text-dim', '--text-muted', '--text-faint', '--accent-text', '--ok', '--warn', '--bad', '--info'];
  return <div className="g-swatches">
    {['--bg-canvas', '--bg-surface', '--bg-raised', '--bg-sunken'].map(bg => <div key={bg} className="g-swatch" style={{ background: `var(${bg})` }}>
      <p className="g-caption">{bg}</p>
      {text.map(fg => <span key={fg} style={{ color: `var(${fg})` }}>{fg} {t('学习资料', 'Sources')}</span>)}
      <span style={{ color: 'var(--decor-faint)' }}>● --decor-faint ({t('仅装饰', 'decor only')})</span>
    </div>)}
  </div>;
}

function Buttons() {
  const [busy, setBusy] = useState(false);
  return <div className="g-stack">
    {['md', 'sm'].map(size => <div key={size} className="g-row">
      <Button variant="primary" size={size} icon="sparkle">{t('用资料出题', 'Generate from sources')}</Button>
      <Button size={size} icon="upload">{t('添加资料', 'Add sources')}</Button>
      <Button variant="quiet" size={size}>{t('稍后再说', 'Later')}</Button>
      <Button variant="link" size={size}>{t('查看示例', 'See an example')}</Button>
      <Button variant="danger" size={size}>{t('删除资料', 'Delete source')}</Button>
      <Button variant="primary" size={size} disabled>{t('生成', 'Generate')}</Button>
      <Button size={size} disabled>{t('不可用', 'Unavailable')}</Button>
      <IconButton icon="close" size={size} label={t('关闭', 'Close')} />
    </div>)}
    <div className="g-row">
      <Button variant="primary" busy={busy} onClick={() => { setBusy(true); setTimeout(() => setBusy(false), 1500); }}>{t('保存资料', 'Save source')}</Button>
      <Button busy>{t('正在上传…', 'Uploading…')}</Button>
    </div>
  </div>;
}

function Segments() {
  const [language, setLanguage] = useState(lang);
  const [mode, setMode] = useState('auto');
  return <div className="g-row">
    <SegmentedControl label={t('界面语言', 'Interface language')} value={language} onChange={setLanguage}
      options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'EN' }]} />
    <SegmentedControl label={t('外观', 'Appearance')} value={mode} onChange={setMode} size="sm"
      options={[{ value: 'auto', label: t('跟随系统', 'System') }, { value: 'dark', label: t('深色', 'Dark') }, { value: 'light', label: t('浅色', 'Light') }]} />
  </div>;
}

function Feedback() {
  return <div className="g-grid">
    <div className="g-stack">
      <Toast tone="success" onDismiss={() => {}}>{t('资料已保存，可用于生成题组', 'Source saved — ready for generating questions')}</Toast>
      <Toast tone="info" action={{ label: t('撤销', 'Undo'), onClick() {} }} onDismiss={() => {}}>{t('已斩这道题：移入斩题组，不再复习。', 'Question slain: moved to the slain deck and out of review.')}</Toast>
      <Toast tone="warning" onDismiss={() => {}}>{t('浏览器暂存不可用，请及时保存草稿。', 'Browser storage is unavailable; save your draft soon.')}</Toast>
      <Toast tone="error" title={t('生成失败', 'Generation failed')} action={{ label: t('去设置模型', 'Set up a model'), onClick() {} }} onDismiss={() => {}}>
        {t('还没有可用的模型密钥。', 'No model key is configured yet.')}</Toast>
    </div>
    <div className="g-stack">
      <div>
        <label className="g-caption" htmlFor="g-key">{t('API Key', 'API key')}</label>
        <input id="g-key" aria-describedby="g-key-error" defaultValue="sk-xxxx" />
        <InlineMessage id="g-key-error" tone="error" action={{ label: t('打开说明', 'How to fix'), onClick() {} }}>
          {t('这个 Key 无效：服务商返回 401。', 'This key was rejected (401 from the provider).')}</InlineMessage>
      </div>
      <InlineMessage tone="success">{t('连接正常，已找到 3 个模型。', 'Connected — 3 models found.')}</InlineMessage>
      <Banner tone="warning" title={t('还没有配置 AI 模型', 'No AI model configured yet')}
        action={{ label: t('去设置', 'Open settings'), onClick() {} }} secondary={{ label: t('先看示例', 'See a sample'), onClick() {} }}>
        {t('用资料出题、讲解和陪学需要一个模型。', 'Generating questions, explanations and coaching need a model.')}</Banner>
      <Banner tone="info" onDismiss={() => {}} title={t('学习库：个人学习库', 'Library: personal library')}>
        {t('D:\\Study\\library · 可以在设置里更改', 'D:\\Study\\library · change it in Settings')}</Banner>
      <p className="g-caption">ActionFeedback in review&apos;s .action-feedback-slot (inline)</p>
      <div className="action-feedback-slot" data-testid="review-slot">
        <ActionFeedback notice={{ text: t('已斩这道题：移入斩题组，不再复习。', 'Question slain: moved to the slain deck and out of review.'), action: { label: t('撤销', 'Undo'), run() {} } }}
          onCloseNotice={() => {}} />
      </div>
    </div>
  </div>;
}

function Setup() {
  return <div className="g-grid">
    <SetupRequired tone="warning" icon="model" badge={t('需要先配置 · 国内直连', 'Setup needed · works in China')}
      title={t('需要先配置 AI 模型', 'Set up an AI model first')}
      why={t('用资料出题要调用一个模型。配置一次，之后出题、讲解都能用。', 'Generating questions calls a model. Set it up once and every AI feature works.')}
      steps={[{ text: t('注册硅基流动并创建 API Key', 'Create a SiliconFlow API key'), href: 'https://cloud.siliconflow.cn/account/ak', hint: t('新用户有免费额度', 'New accounts get free credit') },
        { text: t('回到这里，在「设置 › AI 模型」填入 Key', 'Paste it in Settings › AI model') }, { text: t('点「测试」，看到“连接正常”即可', 'Press Test and wait for “Connected”') }]}
      primary={{ label: t('打开模型设置', 'Open model settings'), onClick() {} }} secondary={{ label: t('先看示例题组', 'Try the sample deck'), onClick() {} }} />
    <SetupRequired icon="audio" title={t('音频转写需要一个转写服务', 'Audio needs a transcription service')}
      why={t('上传前先配置，避免传完才发现用不了。', 'Configure it before uploading so nothing is wasted.')}
      steps={[{ text: t('在「设置 › 音频转写」选择服务商', 'Pick a provider in Settings › Audio') }]}
      primary={{ label: t('打开音频设置', 'Open audio settings'), onClick() {} }} />
  </div>;
}

function Files() {
  const [items, setItems] = useState([
    { id: '1', name: t('第三章 递归.pdf', 'Week 3 recursion.pdf'), status: 'done', detail: t('12 页 · 已保存为 1 份资料', '12 pages · saved as one source') },
    { id: '2', name: 'lecture-notes.md', status: 'working', detail: t('正在提取文字', 'Extracting text') },
    { id: '3', name: 'scan.pdf', status: 'error', detail: t('无法读取文字：可能是扫描件', 'No text found — probably a scan'), action: { label: t('重试', 'Retry'), onClick() {} } },
    { id: '4', name: 'tutorial-4.txt', status: 'pending' },
  ]);
  return <div className="g-grid">
    <div className="g-stack">
      <p className="g-caption">default · multiple</p>
      <FileDrop data-testid="drop-main" accept={['.pdf', '.md', '.txt', '.html']} multiple maxBytes={8 * MB}
        hint="PDF · Markdown · TXT · HTML"
        onFiles={(accepted, rejected) => {
          log.push({ type: 'files', accepted: accepted.map(file => file.name), rejected: rejected.map(item => item.reason) });
          setItems(current => [...current, ...accepted.map((file, index) => ({ id: `n${Date.now()}${index}`, name: file.name, status: 'pending' }))]);
        }} items={items} />
    </div>
    <div className="g-stack">
      <p className="g-caption">compact · disabled · busy</p>
      <FileDrop compact accept={['.mp3', '.m4a', 'audio/*']} multiple maxBytes={512 * MB} icon="audio" onFiles={() => {}} />
      <FileDrop compact accept={['.json']} disabled onFiles={() => {}} />
      <FileDrop accept={['.json', '.txt']} busy onFiles={() => {}} />
    </div>
  </div>;
}

function Layout() {
  return <div className="g-grid">
    <Panel title={t('AI 模型', 'AI model')} description={t('出题、讲解和陪学共用。', 'Shared by generation, explanations and coaching.')}
      actions={<Button size="sm">{t('测试', 'Test')}</Button>}>
      <Disclosure summary={t('高级设置', 'Advanced')} meta={t('3 项', '3 items')}>
        <p style={{ margin: 0, color: 'var(--text-muted)' }}>{t('推理强度、并发数和超时。', 'Reasoning effort, concurrency and timeouts.')}</p>
      </Disclosure>
      <Disclosure summary={t('用量', 'Usage')} defaultOpen>
        <p style={{ margin: 0, color: 'var(--text-muted)' }}>{t('今天 12 次请求', '12 requests today')}</p>
      </Disclosure>
    </Panel>
    <EmptyState icon="file" title={t('还没有资料', 'No sources yet')}
      description={t('添加讲义、笔记或 PDF，StudyHub 会据此出题并标出处。', 'Add handouts, notes or PDFs; StudyHub writes questions from them and cites the passage.')}
      primary={{ label: t('添加资料', 'Add sources'), icon: 'upload', onClick() {} }} secondary={{ label: t('载入示例', 'Load the sample'), onClick() {} }} />
  </div>;
}

function DialogDemo({ withToast }) {
  const [open, setOpen] = useState(scene === 'dialog');
  const [closes, setCloses] = useState(0);
  const [error, setError] = useState(withToast ? t('保存失败：资料标题不能为空。', 'Could not save: the source needs a title.') : '');
  const trap = params.get('trap') === '1';
  useEffect(() => { window.__galleryCloses = closes; }, [closes]);
  // The same Escape/Tab trap ui/App.jsx installs for its modals.
  useEffect(() => {
    if (!open || !trap) return;
    const dialog = document.querySelector('[role="dialog"]');
    const elements = () => [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')];
    elements()[0]?.focus();
    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setCloses(count => count + 1); }
      if (event.key === 'Tab') {
        const items = elements(), first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, trap]);
  return <>
    <ActionFeedback error={error} notice="" onCloseError={() => setError('')} />
    <div className="g-row">
      <Button id="open-dialog" onClick={() => setOpen(true)}>{t('打开对话框', 'Open dialog')}</Button>
      <Button id="raise-error" variant="quiet" onClick={() => setError(t('保存失败：资料标题不能为空。', 'Could not save: the source needs a title.'))}>{t('触发错误', 'Raise an error')}</Button>
    </div>
    {open && <Dialog title={t('添加资料', 'Add source')} description={t('课程放在最前，导入后可直接出题。', 'Course first; generate right after importing.')}
      onClose={reason => { log.push({ type: 'close', reason }); setCloses(count => count + 1); setOpen(false); }}
      footer={<><Button variant="quiet" onClick={() => setOpen(false)}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" id="dialog-save">{t('保存资料', 'Save source')}</Button></>}>
      <label>{t('课程', 'Course')}<input placeholder={t('例如：CS1010', 'e.g. CS1010')} /></label>
      <FileDrop accept={['.pdf', '.md', '.txt']} multiple maxBytes={8 * MB} onFiles={() => {}} />
      <label>{t('标题', 'Title')}<input /></label>
      <label>{t('原文', 'Original text')}<textarea rows={10} /></label>
    </Dialog>}
  </>;
}

function FullDemo() {
  const [open, setOpen] = useState(true);
  return open ? <ModalFrame fullscreen title={t('第三章 递归与栈帧（讲义）.pdf', 'Week 3 — recursion and stack frames (handout).pdf')} onClose={() => setOpen(false)}>
    <p style={{ maxWidth: '68ch', lineHeight: 1.9, color: 'var(--text-dim)' }}>{t('递归函数每调用一次就压入一个栈帧……', 'Each recursive call pushes a stack frame…')}</p>
  </ModalFrame> : null;
}

function DropHost() {
  // A stand-in for DSH's chat drop handler on an ancestor element.
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    const onDrop = event => { window.__hostDrops = (window.__hostDrops || 0) + 1; event.preventDefault(); };
    const onOver = event => event.preventDefault();
    element.addEventListener('drop', onDrop);
    element.addEventListener('dragover', onOver);
    return () => { element.removeEventListener('drop', onDrop); element.removeEventListener('dragover', onOver); };
  }, []);
  return <div ref={ref} className="g-host" id="drop-host">
    <p className="g-host-label">host drop listener (stands in for the DSH composer)</p>
    <FileDrop data-testid="drop-guarded" accept={['.md']} multiple onFiles={(accepted, rejected) => log.push({ type: 'guarded', accepted: accepted.map(f => f.name), rejected: rejected.map(r => r.reason) })} />
    <p id="outside-zone" className="g-caption" style={{ marginTop: 12 }}>outside the zone</p>
  </div>;
}

function Section({ title, children }) {
  return <section className="g-section"><h2>{title}</h2>{children}</section>;
}

function Gallery() {
  if (scene === 'full') return <main><div className="page gallery"><FullDemo /></div></main>;
  if (scene === 'toast') return <main>
    <ActionFeedback notice={{ text: t('已导入「第三章 递归」共 12 题。可检查后直接发布。', 'Imported “Week 3 recursion” with 12 questions. Review and publish.'), tone: 'success', persistent: true }}
      error={t('学习库读取失败：文件被占用。', 'Could not read the library: the file is in use.')} onCloseError={() => {}} onCloseNotice={() => {}} />
    <div className="page gallery">
      <PageHeader eyebrow={t('资料', 'Sources')} title={t('学习资料', 'Study sources')} description={t('滚动后提示仍停在视口顶部。', 'After scrolling, notices stay at the top of the viewport.')} />
      <div className="g-filler">{Array.from({ length: 14 }, (_, index) => <p key={index}>{t('资料', 'Source')} #{index + 1}</p>)}</div>
    </div>
  </main>;
  if (scene === 'dialog') return <main><div className="page gallery"><DialogDemo withToast={params.get('toast') === '1'} />
    <div className="g-filler">{Array.from({ length: 6 }, (_, index) => <p key={index}>{t('页面内容', 'Page content')} #{index + 1}</p>)}</div></div></main>;
  return <main>
    <div className="page gallery">
      <PageHeader eyebrow="StudyHub · ui/components" title={t('组件库', 'Component gallery')}
        description={t('上手流程用到的统一组件：按钮、门槛卡、文件投放、提示与对话框。', 'The shared pieces of onboarding: buttons, setup gates, file drop, feedback and dialogs.')}
        actions={<><Button icon="file">{t('查看文档', 'Docs')}</Button><Button variant="primary" icon="sparkle">{t('开始', 'Start')}</Button></>} />
      <Section title="Tokens · text on surfaces"><Tokens /></Section>
      <Section title="Button · IconButton"><Buttons /></Section>
      <Section title="SegmentedControl"><Segments /></Section>
      <Section title="Toast · InlineMessage · Banner"><Feedback /></Section>
      <Section title="SetupRequired"><Setup /></Section>
      <Section title="FileDrop"><Files /></Section>
      <Section title="Drop isolation"><DropHost /></Section>
      <Section title="Panel · Disclosure · EmptyState"><Layout /></Section>
      <Section title="Dialog"><DialogDemo /></Section>
    </div>
  </main>;
}

createRoot(document.getElementById('root')).render(
  <div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'}><Gallery /></div>,
);
