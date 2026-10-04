import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LiveClient } from './live-client.js';
import LiveAudioMonitor from './LiveAudioMonitor.jsx';
import LiveNotes from './LiveNotes.jsx';
import LiveHistory from './LiveHistory.jsx';
import { ui, uiFormat, useUiLanguage, uiMessage } from './i18n.js';
import { formatClock } from './format.js';
import { usePolling } from './use-polling.js';
import { providerOf } from '../lib/audio-providers.js';
import { Button, IconButton, InlineMessage, PageHeader, SetupRequired, useToast } from './components/index.js';
import { requestAudioSettingsFocus } from './AudioSettings.jsx';
import { useInjectCss } from './shared.js';
import css from './live-class.css';
import CourseField from './CourseField.jsx';
import { usePageScope } from './PageScope.jsx';
import { useLiveEffect } from './use-async.js';

// What the host's generator is told to write in, by interface language.
const GENERATION_LANGUAGE = { en: 'English', zh: '中文' };
const active = (session) => session && !['ended', 'error'].includes(session.status);
const statusText = (status) => ({
  live: ui('正在实录'), paused: ui('已暂停'), connecting: ui('正在连接'),
  reconnecting: ui('正在重连'), ending: ui('正在结束'), ended: ui('已结束'), error: ui('连接中断'),
})[status] || status;
const MIN_CHARS = 120;

/**
 * The mark at the far right of a sentence, so the context correction can be told apart and tested:
 * a solid green dot means the model changed this sentence, a green ring means it was checked and left alone.
 */
export function SentenceMark({ segment, checked }) {
  if (segment.correctedAt) {
    const label = `${ui('已由 AI 润色（上下文校正）')}${segment.correctionReason ? ` · ${segment.correctionReason}` : ''}`;
    return <span className="live-marks"><span className="live-dot polished" data-mark="polished" role="img" tabIndex={0} aria-label={label} title={label} /></span>;
  }
  if (checked) {
    const label = ui('已检查，无需修改');
    return <span className="live-marks"><span className="live-dot checked" data-mark="checked" role="img" aria-label={label} title={label} /></span>;
  }
  return <span className="live-marks" aria-hidden="true" />;
}

export const Sentence = memo(function Sentence({ segment, selected, generated, checked, onToggle, language }) {
  return <article className={`live-sentence${selected ? ' selected' : ''}${segment.correctedAt ? ' polished' : ''}`} data-segment-id={segment.id} tabIndex={-1}>
    <label className="live-select"><input type="checkbox" checked={selected} onChange={() => onToggle(segment.id)}
      aria-label={uiFormat('选择句子 {0}', [segment.id])} />
      <time>{formatClock(segment.t)}</time></label>
    <div className="live-words"><p lang="en">{segment.en}</p>
      <p className="live-chinese" lang="zh-Hans">{segment.zh || (segment.zhState === 'error' ? ui('译文暂不可用，可重试') : ui('正在翻译…'))}</p>
      {segment.correctedAt && <details className="live-correction-original"><summary>{ui('查看识别原稿')}</summary>
        <p>{segment.originalEn}</p>{segment.correctionReason && <small>{segment.correctionReason}</small>}
      </details>}
      {generated && <small className="live-used">{ui('已用于出题')}</small>}
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
    why={ui('边听边转写只支持 Google Gemini 的实时接口（需要海外网络）。硅基流动和 Groq 只用于导入录音文件：课后可以在「音频转写」里导入录音。')}
    steps={[{ text: ui('用 Google 账号登录 AI Studio'), href: providerOf('free').consoleUrl },
      { text: ui('在「Get API key」页创建一个密钥（这个项目不要开通计费）'), href: providerOf('free').keyUrl },
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
  const toast = useToast();
  const [follow, setFollow] = useState(true);
  const feed = useRef(null), operation = useRef(false);
  // Whether a live provider is configured, checked before anything asks for the microphone (null until known).
  const [readiness, setReadiness] = useState(initialReadiness);
  useLiveEffect((alive) => {
    if (!visible || initialReadiness || !call) return;
    Promise.resolve(call('audio.preflight', {})).then((result) => { if (alive() && result && typeof result === 'object') setReadiness(result); }, () => {});
  }, [visible, call, initialReadiness]);
  const refresh = useCallback(async () => {
    const result = await call('live.list'); setSessions(result.sessions || []);
  }, [call]);
  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => {
    if (visible) refresh().catch((failure) => client.fail(failure));
  }, [visible, refresh, client]);
  const needsPoll = !!session && (active(session) || session.translating > 0 || session.correction?.running || session.correction?.background?.running);
  // Not paused in a background tab: the poll is also how the page learns that the host ended the session and stops the microphone.
  usePolling(async () => { try { await client.poll(); } catch (failure) { client.fail(failure); } }, { intervalMs: 1000, enabled: !!session?.id && needsPoll, pauseWhenHidden: false });
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
    operation.current = true; setWorking(true); client.update({ error: '' });
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
  return <section className="page live-class" hidden={!visible} aria-label={ui('课堂实录')}>
    <PageHeader title={ui('课堂实录')}
      description={session ? undefined : ui('边听边看简体中文，选中重点就能出题。')}
      actions={<Button variant="quiet" onClick={onSettings}>{ui('音频设置')}</Button>} />
    {error && <InlineMessage tone="error" boxed>{uiMessage(error)}</InlineMessage>}
    {!active(session) && readiness && readiness.live === false && <LiveSetup onSettings={onSettings} />}
    {!active(session) && !(readiness && readiness.live === false) && <form className="live-setup" onSubmit={(event) => {
      event.preventDefault(); void perform(async () => { setSelected(new Set()); await client.start(kind, { title, course, subject, terms, paidOnly }); await refresh(); });
    }}>
      <div className="live-fields"><label>{ui('课堂名称')}<input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder={ui('例如：数据库 · 分区与索引')} /></label>
        <label>{ui('声音来源')}<select value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="microphone">{ui('麦克风（现场课堂）')}</option><option value="tab">{ui('标签页 / 系统声音（网课）')}</option></select></label></div>
      {kind === 'tab' && <p className="muted">{ui('选择正在播放课程的标签页，并勾选「共享标签页音频」。只发送声音，不发送画面。')}</p>}
      <CourseField value={course} onChange={setCourse} courses={data?.focus?.courses} disabled={disabled} />
      <details><summary>{ui('课程背景与术语（可选）')}</summary>
        <label>{ui('这堂课讲什么')}<input value={subject} maxLength={300} onChange={(event) => setSubject(event.target.value)} /></label>
        <label>{ui('术语（逗号或换行分隔）')}<textarea value={terms} onChange={(event) => setTerms(event.target.value)} rows={2} /></label></details>
      <div className="live-setup-foot">
        <label className="live-check"><input type="checkbox" checked={paidOnly} onChange={(event) => setPaidOnly(event.target.checked)} /><span>{ui('只用付费密钥')}</span></label>
        <Button variant="primary" disabled={disabled} type="submit">{busy ? ui('正在连接…') : ui('开始实录')}</Button></div>
      <small className="muted">{ui('转写使用 Gemini；简体中文翻译使用音频设置中选定的模型。免费额度用完会切到付费密钥。')}</small>
    </form>}
    {!session && busy && <LiveAudioMonitor health={client.health} visible={visible} recording={capturing} />}
    {session && <>
      <div className="live-bar">
        <div className="live-bar-main">
          <span className={`live-state ${tone}`}><i aria-hidden="true" />{session.archivedAt ? ui('已归档') : statusText(session.status)}</span>
          <strong className="live-title">{session.title}</strong>
          <span className="muted">{session.course || ui('未分类')}</span>
          <span className="muted live-meta">{formatClock(session.elapsedMs)} · {uiFormat('{0} 句', [total])}
            {session.tier && active(session) ? ` · ${session.tier === 'free' ? ui('免费额度') : ui('付费密钥')}` : ''}</span>
        </div>
        <div className="live-actions">{capturing && <Button disabled={disabled} onClick={() => void perform(() => client.pause())}>{session.status === 'paused' ? ui('继续') : ui('暂停')}</Button>}
          {active(session) && <Button disabled={disabled} onClick={() => void perform(async () => { await client.stop(); await refresh(); })}>{ui('结束实录')}</Button>}
          {!active(session) && !session.archivedAt && readiness?.live !== false && <Button disabled={disabled} onClick={() => void perform(async () => { await client.start(kind, { resumeId: session.id, paidOnly }); })}>{ui('接着录')}</Button>}</div></div>
      <LiveAudioMonitor compact health={client.health} visible={visible} recording={capturing} />
      {correction && <div className="live-correction-line">
        <span className={`live-correction-state${correction.running ? ' running' : ''}`}>{correction.running ? ui('正在按上下文润色…') : ui('上下文润色')}</span>
        <span className="muted">{uiFormat('已检查 {0} / {1} 句 · 已润色 {2} 句', [correction.covered, total, polished])}{correction.pending > 0 ? uiFormat(' · 待处理 {0}', [correction.pending]) : ''}</span>
        <span className="live-legend" aria-label={ui('右侧标记说明')}>
          <span><i className="live-dot polished" aria-hidden="true" />{ui('已润色')}</span>
          <span><i className="live-dot checked" aria-hidden="true" />{ui('已检查未改')}</span></span>
        {!correction.running && correction.pending > 0 && (correction.error || !active(session)) &&
          <Button disabled={disabled} onClick={() => void perform(async () => { client.accept(await call('live.correct', { id: session.id })); })}>{ui('重试待校正内容')}</Button>}
        <details className="live-correction-more"><summary>{ui('说明与用量')}</summary>
          <p className="muted">{ui('每 30 秒检查一次，按顺序分批：每批最多 8 句新内容，再带上前批最后 2 句作上下文（共约 10 句）；结束后补齐剩余内容。只有模型高置信度改动过的句子才会亮绿点，实心表示已润色，空心圈表示检查过、无需修改。')}</p>
          <p>{uiFormat('模型调用 {0} 次 · 本地结果复用 {1} 次', [correction.calls, correction.cacheHits])}</p>
          <p>{correction.usage ? uiFormat('服务商缓存命中 {0} 输入 tokens', [(correction.usage.free?.cachedInputTokens || 0) + (correction.usage.paid?.cachedInputTokens || 0)])
            : ui('当前模型未提供缓存用量。')}</p>
          <small>{ui('没有新句子时跳过调用；新上下文中的重叠句会重新判断。')}</small>
        </details>
        {correction.error && <p className="live-correction-error" role="status">{correction.error}</p>}
      </div>}
      {session.message && <p role="status" className="muted">{session.message}</p>}
      {session.warnings?.length > 0 && <details><summary>{ui('连接与额度提示')}</summary>{session.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <div className="live-stage">
        <div className="live-feed-head">
          <span className="muted">{ui('原文在上，简体中文在下；勾选句子或划选文字即可出题。')}</span>
          <div className="live-actions">
            {segments.some((segment) => segment.zhState === 'error') && <Button disabled={disabled} onClick={() => void perform(async () => { await call('live.retry', { id: session.id }); await client.poll(); })}>{ui('重试失败的翻译')}</Button>}
            <Button variant="link" size="sm" className={`live-follow${follow ? ' on' : ''}`} onClick={() => setFollow(!follow)} aria-pressed={follow}>{follow ? ui('正在跟随最新') : ui('回到最新')}</Button></div>
        </div>
        <div className="live-feed" ref={feed} tabIndex={0} onMouseUp={selectText} onKeyUp={selectText} onScroll={() => {
          const node = feed.current; if (node && node.scrollHeight - node.scrollTop - node.clientHeight > 80) setFollow(false);
        }} aria-label={ui('课堂原文与译文')}>
          {!segments.length && <p className="live-empty">{active(session) ? ui('开始说话后，原文和译文会出现在这里。') : ui('这场实录还没有文字。')}</p>}
          {segments.map((segment) => <Sentence key={segment.id} segment={segment} selected={selected.has(segment.id)} generated={generated.has(segment.id)}
            checked={checkedThrough >= segment.id && !segment.correctedAt} onToggle={toggle} language={language} />)}
          {session.interim && <p className="live-interim">{session.interim}<span aria-hidden="true"> …</span></p>}
        </div>
        <div className="live-selection">
          <div className="live-selection-info"><strong>{uiFormat('已选 {0} 句', [chosen.length])}</strong>
            <span className="muted">{chosen.length ? (selectedChars >= MIN_CHARS ? uiFormat('约 {0} 个原文字符', [selectedChars])
              : uiFormat('再多选约 {0} 个字符才能出题', [MIN_CHARS - selectedChars]))
              : ui('至少选约 120 个原文字符')}</span></div>
          <div className="live-actions"><Button disabled={!segments.length} onClick={() => setSelected(new Set(segments.slice(-8).map((segment) => segment.id)))}>{ui('最近 8 句')}</Button>
            <Button disabled={!selected.size} onClick={() => setSelected(new Set())}>{ui('清空')}</Button>
            <div className="live-count" role="group" aria-label={ui('题数')}>
              <span className="live-count-label">{ui('题数')}</span>
              <IconButton icon="minus" size="sm" label={ui('减少题数')} disabled={count <= 1} onClick={() => setCount(Math.max(1, count - 1))} />
              <output aria-live="polite">{count}</output>
              <IconButton icon="plus" size="sm" label={ui('增加题数')} disabled={count >= 15} onClick={() => setCount(Math.min(15, count + 1))} /></div>
            <Button variant="primary" disabled={!canGenerate} title={selectedChars < MIN_CHARS ? uiFormat('至少约 {0} 个原文字符，目前 {1}', [MIN_CHARS, selectedChars]) : undefined}
              onClick={() => void perform(async () => {
                const result = await call('live.generate', { id: session.id, segmentIds: chosen.map((segment) => segment.id), count, language: GENERATION_LANGUAGE[language] });
                toast.success(ui('已加入出题任务；课堂实录会继续。完成后在收件箱打开草稿。'));
                setSelected(new Set()); await client.poll(); onJobs?.(result);
              })}>{ui('选中内容出题')}</Button></div></div>
      </div>
      {correction && <LiveNotes correction={correction} disabled={disabled} onSentence={id => {
        setFollow(false);
        const node = feed.current?.querySelector(`[data-segment-id="${id}"]`);
        node?.scrollIntoView({ block: 'center' }); node?.focus({ preventScroll: true });
      }} onRetry={() => void perform(async () => { client.accept(await call('live.correct.background', { id: session.id })); })} />}
      <footer className="live-footer"><p className="muted">{ui('付费转写估算')} ${session.usage?.estimatedPaidUsd || 0} · {ui('不含翻译费用')}</p>
        {!active(session) && segments.length > 0 && <div className="live-actions"><Button disabled={disabled || session.translating > 0 || session.correction?.running || session.correction?.background?.pending > 0 || (session.correction?.enabled && session.correction.pending > 0)} onClick={() => void perform(async () => {
          await call('live.save', { id: session.id }); toast.success(ui('已保存中英对照资料与课堂笔记（如有）。')); onJobs?.();
        })}>{ui('保存为资料')}</Button><Button disabled={disabled || session.correction?.running || session.correction?.background?.pending > 0 || (session.correction?.enabled && session.correction.pending > 0)} onClick={() => void perform(async () => {
          await call('live.save', { id: session.id, proofread: true, paidOnly }); toast.success(ui('已加入校对任务，完成后会保存为资料。')); onJobs?.();
        })}>{ui('校对后保存')}</Button><Button variant="link" size="sm" onClick={onSources}>{ui('打开资料')}</Button></div>}</footer>
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
