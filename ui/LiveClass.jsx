import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LiveClient } from './live-client.js';
import LiveAudioMonitor from './LiveAudioMonitor.jsx';
import LiveNotes from './LiveNotes.jsx';
import LiveHistory from './LiveHistory.jsx';
import { getUiLanguage, ui, useUiLanguage, uiMessage } from './i18n.js';
import { SetupRequired } from './components/index.js';
import { requestAudioSettingsFocus } from './AudioSettings.jsx';
import { useInjectCss } from './shared.js';
import css from './live-class.css';
import CourseField from './CourseField.jsx';
import { usePageScope } from './PageScope.jsx';

const t = (zh, en) => getUiLanguage() === 'en' ? en : zh;
const time = (ms = 0) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const active = (session) => session && !['ended', 'error'].includes(session.status);
const statusText = (status) => ({
  live: t('正在实录', 'Recording'), paused: t('已暂停', 'Paused'), connecting: t('正在连接', 'Connecting'),
  reconnecting: t('正在重连', 'Reconnecting'), ending: t('正在结束', 'Finishing'), ended: t('已结束', 'Ended'), error: t('连接中断', 'Disconnected'),
})[status] || status;
const MIN_CHARS = 120;

/**
 * The mark at the far right of a sentence, so the context correction can be told apart and tested:
 * a solid green dot means the model changed this sentence, a green ring means it was checked and left alone.
 */
export function SentenceMark({ segment, checked }) {
  if (segment.correctedAt) {
    const label = `${t('已由 AI 润色（上下文校正）', 'Polished by AI (context correction)')}${segment.correctionReason ? ` · ${segment.correctionReason}` : ''}`;
    return <span className="live-marks"><span className="live-dot polished" data-mark="polished" role="img" tabIndex={0} aria-label={label} title={label} /></span>;
  }
  if (checked) {
    const label = t('已检查，无需修改', 'Checked, no change needed');
    return <span className="live-marks"><span className="live-dot checked" data-mark="checked" role="img" aria-label={label} title={label} /></span>;
  }
  return <span className="live-marks" aria-hidden="true" />;
}

export const Sentence = memo(function Sentence({ segment, selected, generated, checked, onToggle, language }) {
  return <article className={`live-sentence${selected ? ' selected' : ''}${segment.correctedAt ? ' polished' : ''}`} data-segment-id={segment.id} tabIndex={-1}>
    <label className="live-select"><input type="checkbox" checked={selected} onChange={() => onToggle(segment.id)}
      aria-label={`${language === 'en' ? 'Select sentence' : '选择句子'} ${segment.id}`} />
      <time>{time(segment.t)}</time></label>
    <div className="live-words"><p lang="en">{segment.en}</p>
      <p className="live-chinese" lang="zh-Hans">{segment.zh || (segment.zhState === 'error' ? t('译文暂不可用，可重试', 'Translation unavailable; retry below') : t('正在翻译…', 'Translating…'))}</p>
      {segment.correctedAt && <details className="live-correction-original"><summary>{t('查看识别原稿', 'View original recognition')}</summary>
        <p>{segment.originalEn}</p>{segment.correctionReason && <small>{segment.correctionReason}</small>}
      </details>}
      {generated && <small className="live-used">{t('已用于出题', 'Used for questions')}</small>}
    </div>
    <SentenceMark segment={segment} checked={checked} />
  </article>;
});

/**
 * Shown INSTEAD of the start form while no Gemini key is configured: live transcription is Gemini Live only, so the
 * microphone (or tab sharing) is never requested before the provider is known to be there.
 */
function LiveSetup({ onSettings }) {
  return <SetupRequired className="live-setup-gate" icon="audio" title={ui('课堂实录需要 Gemini 密钥')}
    why={ui('边听边转写只支持 Google Gemini 的实时接口（需要海外网络）。硅基流动和 Groq 只用于导入录音文件：课后可以在「音频转录」里导入录音。')}
    steps={[{ text: ui('用 Google 账号登录 AI Studio'), href: 'https://aistudio.google.com' },
      { text: ui('在「Get API key」页创建一个密钥（这个项目不要开通计费）'), href: 'https://aistudio.google.com/apikey' },
      { text: ui('在音频设置的 Google Gemini 卡片里粘贴，点「保存并验证」') }]}
    primary={onSettings ? { label: ui('打开音频设置'), icon: 'key', onClick: () => { requestAudioSettingsFocus(); onSettings(); } } : undefined} />;
}

export default function LiveClass({ call, data, visible, onJobs, onSettings, onSources, initialReadiness = null }) {
  const language = useUiLanguage();
  useInjectCss(css, 'study-live-class');
  const [course, setCourse] = usePageScope(data?.root, 'live-class-course', data?.focus?.course ?? '');
  const client = useMemo(() => new LiveClient(call), [call]);
  const { session, capturing, busy, error } = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [sessions, setSessions] = useState([]), [title, setTitle] = useState(''), [subject, setSubject] = useState('');
  const [terms, setTerms] = useState(''), [kind, setKind] = useState('microphone'), [paidOnly, setPaidOnly] = useState(false);
  const [selected, setSelected] = useState(new Set()), [count, setCount] = useState(5), [working, setWorking] = useState(false);
  const [notice, setNotice] = useState(''), [follow, setFollow] = useState(true);
  const feed = useRef(null), operation = useRef(false);
  // Whether a live provider is configured, checked before anything asks for the microphone (null until known).
  const [readiness, setReadiness] = useState(initialReadiness);
  useEffect(() => {
    if (!visible || initialReadiness || !call) return;
    let alive = true;
    Promise.resolve(call('audio.preflight', {})).then((result) => { if (alive && result && typeof result === 'object') setReadiness(result); }, () => {});
    return () => { alive = false; };
  }, [visible, call, initialReadiness]);
  const refresh = useCallback(async () => {
    const result = await call('live.list'); setSessions(result.sessions || []);
  }, [call]);
  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => {
    if (visible) refresh().catch((failure) => client.fail(failure));
  }, [visible, refresh, client]);
  const needsPoll = !!session && (active(session) || session.translating > 0 || session.correction?.running || session.correction?.background?.running);
  useEffect(() => {
    if (!session?.id || !needsPoll) return;
    let disposed = false, timer;
    const tick = async () => {
      try { await client.poll(); } catch (failure) { if (!disposed) client.fail(failure); }
      if (!disposed) timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, session?.id, needsPoll]);
  useEffect(() => {
    if (!capturing) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [capturing]);
  useEffect(() => {
    if (visible && follow && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [visible, follow, session?.revision, session?.interim]);
  const perform = async (action) => {
    if (operation.current) return;
    operation.current = true; setWorking(true); setNotice(''); client.update({ error: '' });
    try { await action(); } catch (failure) { client.fail(failure); }
    finally { operation.current = false; setWorking(false); }
  };
  const toggle = useCallback((id) => setSelected((previous) => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  }), []);
  const segments = session?.segments || [], generated = new Set(session?.generatedIds || []);
  const correction = session?.correction, checkedThrough = correction?.enabled ? correction.coveredThrough || 0 : 0;
  const polished = segments.filter((segment) => segment.correctedAt).length;
  const chosen = segments.filter((segment) => selected.has(segment.id));
  const selectedChars = chosen.reduce((n, segment) => n + segment.en.length, 0);
  const disabled = busy || working;
  const total = session?.total || segments.length;
  const canGenerate = !disabled && selectedChars >= MIN_CHARS && chosen.length <= 400 && Number.isInteger(count) && count >= 1 && count <= 15;
  const tone = !session ? 'idle' : session.status === 'live' ? 'ok' : session.status === 'error' ? 'bad'
    : ['paused', 'connecting', 'reconnecting', 'ending'].includes(session.status) ? 'warn' : 'idle';
  function selectText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !feed.current?.contains(selection.anchorNode) || !feed.current?.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    const ids = [...feed.current.querySelectorAll('[data-segment-id]')].filter((node) => range.intersectsNode(node)).map((node) => Number(node.dataset.segmentId));
    if (ids.length) { setSelected(new Set(ids)); setFollow(false); }
  }
  return <section className="live-class" hidden={!visible} aria-label={t('课堂实录', 'Live class')}>
    <header className={`live-heading${session ? ' compact' : ''}`}><div><p className="eyebrow">{t('听课 · 理解 · 练习', 'LISTEN · UNDERSTAND · PRACTISE')}</p>
      <h1>{t('课堂实录', 'Live class')}</h1><p className="muted">{t('边听边看简体中文，选中重点就能出题。', 'Follow along in Simplified Chinese and turn key passages into questions.')}</p></div>
      <button className="ghost-btn" onClick={onSettings}>{t('音频设置', 'Audio settings')}</button></header>
    {error && <p className="alert error" role="alert">{uiMessage(error)}</p>}
    {notice && <p className="alert" role="status">{notice}</p>}
    {!active(session) && readiness && readiness.live === false && <LiveSetup onSettings={onSettings} />}
    {!active(session) && !(readiness && readiness.live === false) && <form className="live-setup" onSubmit={(event) => {
      event.preventDefault(); void perform(async () => { setSelected(new Set()); await client.start(kind, { title, course, subject, terms, paidOnly }); await refresh(); });
    }}>
      <div className="live-fields"><label>{t('课堂名称', 'Class title')}<input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder={t('例如：数据库 · 分区与索引', 'e.g. Databases · partitions and indexes')} /></label>
        <label>{t('声音来源', 'Audio source')}<select value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="microphone">{t('麦克风（现场课堂）', 'Microphone (in-person class)')}</option><option value="tab">{t('标签页 / 系统声音（网课）', 'Tab / system audio (online class)')}</option></select></label></div>
      {kind === 'tab' && <p className="muted">{t('选择正在播放课程的标签页，并勾选「共享标签页音频」。只发送声音，不发送画面。', 'Select the class tab and enable “Share tab audio”. Only audio is sent, never video.')}</p>}
      <CourseField value={course} onChange={setCourse} courses={data?.focus?.courses} disabled={disabled} />
      <details><summary>{t('课程背景与术语（可选）', 'Subject and terminology (optional)')}</summary>
        <label>{t('这堂课讲什么', 'Subject')}<input value={subject} maxLength={300} onChange={(event) => setSubject(event.target.value)} /></label>
        <label>{t('术语（逗号或换行分隔）', 'Terms (comma or line separated)')}<textarea value={terms} onChange={(event) => setTerms(event.target.value)} rows={2} /></label></details>
      <div className="live-setup-foot">
        <label className="live-check"><input type="checkbox" checked={paidOnly} onChange={(event) => setPaidOnly(event.target.checked)} /><span>{t('只用付费密钥', 'Use paid key only')}</span></label>
        <button className="primary" disabled={disabled}>{busy ? t('正在连接…', 'Connecting…') : t('开始实录', 'Start recording')}</button></div>
      <small className="muted">{t('转写使用 Gemini；简体中文翻译使用音频设置中选定的模型。免费额度用完会切到付费密钥。', 'Gemini transcribes audio; the model chosen in audio settings translates it. When free quota runs out, the paid key is used.')}</small>
    </form>}
    {!session && busy && <LiveAudioMonitor health={client.health} visible={visible} recording={capturing} />}
    {session && <>
      <div className="live-bar">
        <div className="live-bar-main">
          <span className={`live-state ${tone}`}><i aria-hidden="true" />{session.archivedAt ? t('已归档', 'Archived') : statusText(session.status)}</span>
          <strong className="live-title">{session.title}</strong>
          <span className="muted">{session.course || t('未分类', 'Uncategorised')}</span>
          <span className="muted live-meta">{time(session.elapsedMs)} · {total} {t('句', 'sentences')}
            {session.tier && active(session) ? ` · ${session.tier === 'free' ? t('免费额度', 'Free tier') : t('付费密钥', 'Paid key')}` : ''}</span>
        </div>
        <div className="live-actions">{capturing && <button disabled={disabled} onClick={() => void perform(() => client.pause())}>{session.status === 'paused' ? t('继续', 'Resume') : t('暂停', 'Pause')}</button>}
          {active(session) && <button disabled={disabled} onClick={() => void perform(async () => { await client.stop(); await refresh(); })}>{t('结束实录', 'End recording')}</button>}
          {!active(session) && !session.archivedAt && readiness?.live !== false && <button disabled={disabled} onClick={() => void perform(async () => { await client.start(kind, { resumeId: session.id, paidOnly }); })}>{t('接着录', 'Continue recording')}</button>}</div></div>
      <LiveAudioMonitor compact health={client.health} visible={visible} recording={capturing} />
      {correction && <div className="live-correction-line">
        <span className={`live-correction-state${correction.running ? ' running' : ''}`}>{correction.running ? t('正在按上下文润色…', 'Polishing with context…') : t('上下文润色', 'Context polish')}</span>
        <span className="muted">{t(`已检查 ${correction.covered} / ${total} 句 · 已润色 ${polished} 句`, `Checked ${correction.covered} / ${total} · polished ${polished}`)}{correction.pending > 0 ? t(` · 待处理 ${correction.pending}`, ` · ${correction.pending} pending`) : ''}</span>
        <span className="live-legend" aria-label={t('右侧标记说明', 'Marker legend')}>
          <span><i className="live-dot polished" aria-hidden="true" />{t('已润色', 'Polished')}</span>
          <span><i className="live-dot checked" aria-hidden="true" />{t('已检查未改', 'Checked')}</span></span>
        {!correction.running && correction.pending > 0 && (correction.error || !active(session)) &&
          <button disabled={disabled} onClick={() => void perform(async () => { client.accept(await call('live.correct', { id: session.id })); })}>{t('重试待校正内容', 'Retry pending correction')}</button>}
        <details className="live-correction-more"><summary>{t('说明与用量', 'Details and usage')}</summary>
          <p className="muted">{t('每 30 秒检查一次，按顺序分批：每批最多 8 句新内容，再带上前批最后 2 句作上下文（共约 10 句）；结束后补齐剩余内容。只有模型高置信度改动过的句子才会亮绿点，实心表示已润色，空心圈表示检查过、无需修改。', 'Checked every 30s in ordered batches: up to 8 new sentences plus the last 2 of the previous batch as context (about 10). Remaining sentences are checked when recording ends. A solid green dot means the model changed the sentence; a ring means it was checked and left alone.')}</p>
          <p>{t(`模型调用 ${correction.calls} 次 · 本地结果复用 ${correction.cacheHits} 次`, `${correction.calls} model calls · ${correction.cacheHits} local cache hits`)}</p>
          <p>{correction.usage ? t(`服务商缓存命中 ${(correction.usage.free?.cachedInputTokens || 0) + (correction.usage.paid?.cachedInputTokens || 0)} 输入 tokens`, `Provider cache: ${(correction.usage.free?.cachedInputTokens || 0) + (correction.usage.paid?.cachedInputTokens || 0)} input tokens`)
            : t('当前模型未提供缓存用量。', 'Cache usage is unavailable from this model.')}</p>
          <small>{t('没有新句子时跳过调用；新上下文中的重叠句会重新判断。', 'No new sentences means no call; overlapping sentences are reconsidered with their new context.')}</small>
        </details>
        {correction.error && <p className="live-correction-error" role="status">{correction.error}</p>}
      </div>}
      {session.message && <p role="status" className="muted">{session.message}</p>}
      {session.warnings?.length > 0 && <details><summary>{t('连接与额度提示', 'Connection and quota notices')}</summary>{session.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <div className="live-stage">
        <div className="live-feed-head">
          <span className="muted">{t('原文在上，简体中文在下；勾选句子或划选文字即可出题。', 'Original above, Simplified Chinese below. Check sentences or highlight text to make questions.')}</span>
          <div className="live-actions">
            {segments.some((segment) => segment.zhState === 'error') && <button disabled={disabled} onClick={() => void perform(async () => { await call('live.retry', { id: session.id }); await client.poll(); })}>{t('重试失败的翻译', 'Retry failed translations')}</button>}
            <button className={`link-btn live-follow${follow ? ' on' : ''}`} onClick={() => setFollow(!follow)} aria-pressed={follow}>{follow ? t('正在跟随最新', 'Following latest') : t('回到最新', 'Jump to latest')}</button></div>
        </div>
        <div className="live-feed" ref={feed} tabIndex={0} onMouseUp={selectText} onKeyUp={selectText} onScroll={() => {
          const node = feed.current; if (node && node.scrollHeight - node.scrollTop - node.clientHeight > 80) setFollow(false);
        }} aria-label={t('课堂原文与译文', 'Class transcript and translation')}>
          {!segments.length && <p className="live-empty">{active(session) ? t('开始说话后，原文和译文会出现在这里。', 'The transcript and translation appear here when speech is detected.') : t('这场实录还没有文字。', 'This recording has no transcript yet.')}</p>}
          {segments.map((segment) => <Sentence key={segment.id} segment={segment} selected={selected.has(segment.id)} generated={generated.has(segment.id)}
            checked={checkedThrough >= segment.id && !segment.correctedAt} onToggle={toggle} language={language} />)}
          {session.interim && <p className="live-interim">{session.interim}<span aria-hidden="true"> …</span></p>}
        </div>
        <div className="live-selection">
          <div className="live-selection-info"><strong>{t(`已选 ${chosen.length} 句`, `${chosen.length} sentences selected`)}</strong>
            <span className="muted">{chosen.length ? (selectedChars >= MIN_CHARS ? t(`约 ${selectedChars} 个原文字符`, `about ${selectedChars} original characters`)
              : t(`再多选约 ${MIN_CHARS - selectedChars} 个字符才能出题`, `select about ${MIN_CHARS - selectedChars} more characters to create questions`))
              : t('至少选约 120 个原文字符', 'Select at least 120 original characters')}</span></div>
          <div className="live-actions"><button disabled={!segments.length} onClick={() => setSelected(new Set(segments.slice(-8).map((segment) => segment.id)))}>{t('最近 8 句', 'Last 8 sentences')}</button>
            <button disabled={!selected.size} onClick={() => setSelected(new Set())}>{t('清空', 'Clear')}</button>
            <div className="live-count" role="group" aria-label={t('题数', 'Number of questions')}>
              <span className="live-count-label">{t('题数', 'Questions')}</span>
              <button type="button" aria-label={t('减少题数', 'Fewer questions')} disabled={count <= 1} onClick={() => setCount(Math.max(1, count - 1))}>−</button>
              <output aria-live="polite">{count}</output>
              <button type="button" aria-label={t('增加题数', 'More questions')} disabled={count >= 15} onClick={() => setCount(Math.min(15, count + 1))}>+</button></div>
            <button className="primary" disabled={!canGenerate} title={selectedChars < MIN_CHARS ? t(`至少约 ${MIN_CHARS} 个原文字符，目前 ${selectedChars}`, `At least about ${MIN_CHARS} original characters; now ${selectedChars}`) : undefined}
              onClick={() => void perform(async () => {
                const result = await call('live.generate', { id: session.id, segmentIds: chosen.map((segment) => segment.id), count, language: language === 'en' ? 'English' : '中文' });
                setNotice(t('已加入出题任务；课堂实录会继续。完成后在收件箱打开草稿。', 'Question generation queued; recording continues. Open the draft from the inbox when it is ready.'));
                setSelected(new Set()); await client.poll(); onJobs?.(result);
              })}>{t('选中内容出题', 'Create questions from selection')}</button></div></div>
      </div>
      {correction && <LiveNotes correction={correction} disabled={disabled} onSentence={id => {
        setFollow(false);
        const node = feed.current?.querySelector(`[data-segment-id="${id}"]`);
        node?.scrollIntoView({ block: 'center' }); node?.focus({ preventScroll: true });
      }} onRetry={() => void perform(async () => { client.accept(await call('live.correct.background', { id: session.id })); })} />}
      <footer className="live-footer"><p className="muted">{t('付费转写估算', 'Estimated paid transcription')} ${session.usage?.estimatedPaidUsd || 0} · {t('不含翻译费用', 'translation excluded')}</p>
        {!active(session) && segments.length > 0 && <div className="live-actions"><button disabled={disabled || session.translating > 0 || session.correction?.running || session.correction?.background?.pending > 0 || (session.correction?.enabled && session.correction.pending > 0)} onClick={() => void perform(async () => {
          await call('live.save', { id: session.id }); setNotice(t('已保存中英对照资料与课堂笔记（如有）。', 'Saved bilingual sources and class notes (if available).')); onJobs?.();
        })}>{t('保存为资料', 'Save as source')}</button><button disabled={disabled || session.correction?.running || session.correction?.background?.pending > 0 || (session.correction?.enabled && session.correction.pending > 0)} onClick={() => void perform(async () => {
          await call('live.save', { id: session.id, proofread: true, paidOnly }); setNotice(t('已加入校对任务，完成后会保存为资料。', 'Proofreading queued; the result will be saved as a source.')); onJobs?.();
        })}>{t('校对后保存', 'Proofread and save')}</button><button className="link-btn" onClick={onSources}>{t('打开资料', 'Open sources')}</button></div>}</footer>
    </>}
    <LiveHistory sessions={sessions} disabled={disabled} capturing={capturing}
      onOpen={id => void perform(async () => { setSelected(new Set()); await client.open(id); })}
      onArchive={(id, archived) => void perform(async () => {
        const result = await call('live.archive', { id, archived });
        if (client.getSnapshot().session?.id === id) client.accept(result);
        await refresh();
      })}
      onDelete={id => void perform(async () => {
        await call('live.delete', { id }); client.close(id); setSelected(new Set()); await refresh();
      })} />
  </section>;
}
