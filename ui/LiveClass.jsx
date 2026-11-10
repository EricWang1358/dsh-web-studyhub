import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LiveClient } from './live-client.js';
import LiveAudioMonitor from './LiveAudioMonitor.jsx';
import LiveNotes from './LiveNotes.jsx';
import LiveCorrectionLine from './LiveCorrectionLine.jsx';
import { RECENT_CHARS, isChinese, recentWindow, showsTranslation, tidyCjk } from './live-display.js';
import LiveHistory from './LiveHistory.jsx';
import { ui, uiFormat, useUiLanguage, uiMessage } from './i18n.js';
import { formatClock } from './format.js';
import { usePolling } from './use-polling.js';
import { providerOf } from '../lib/audio-providers.js';
import { Button, Checkbox, CheckboxInput, IconButton, InlineMessage, PageHeader, Select, SetupRequired, Tooltip, useToast } from './components/index.js';
import LiveLocalCard from './LiveLocalCard.jsx';
import LiveLoopbackCard from './LiveLoopbackCard.jsx';
import { localTip } from './live-local-flow.js';
import { openAudioSettings } from './audio-focus.js';
import { LIVE_PAUSE_ANCHOR, usePauseHint } from './live-pause-hint.js';
import { hostInfo, tabSharingAllowed } from './live-audio.js';
import { useInjectCss } from './shared.js';
import css from './live-class.css';
import CourseField from './CourseField.jsx';
import { usePageScope } from './PageScope.jsx';
import { useLiveEffect } from './use-async.js';
import { useUndoable } from './use-undoable.js';
import { useStudy } from './study-context.jsx';

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

/**
 * One sentence. A sentence that is Chinese already is shown once (the polished text when it was corrected, with the recognised original behind 查看识别原稿);
 * an English one has its translation under it. Spacing and punctuation are tidied for display only. `skipReason` is why the polish gave up on it, if it did.
 */
export const Sentence = memo(function Sentence({ segment, selected, generated, checked, skipReason, onToggle, language }) {
  const chinese = isChinese(segment);
  return <article className={`live-sentence${selected ? ' live-sentence--selected' : ''}${segment.correctedAt ? ' polished' : ''}`} data-segment-id={segment.id} tabIndex={-1}>
    <label className="live-select"><CheckboxInput checked={selected} onChange={() => onToggle(segment.id)}
      aria-label={uiFormat('选择句子 {0}', [segment.id])} />
      <time>{formatClock(segment.t)}</time></label>
    <div className={`live-words${chinese ? ' live-words--chinese' : ''}`}><p lang={chinese ? 'zh-Hans' : segment.zhState === 'none' ? undefined : 'en'}>{tidyCjk(segment.en)}</p>
      {/* No second line where the sentence is Chinese already, or nothing is translated (the local engine wrote Chinese, or a class without a text model). */}
      {showsTranslation(segment) && (segment.zh ? <p className="live-chinese" lang="zh-Hans">{tidyCjk(segment.zh)}</p>
        : <small className="live-zh-state" data-zh-state={segment.zhState === 'error' ? 'error' : 'pending'}>{segment.zhState === 'error' ? ui('译文暂时没有') : ui('正在翻译…')}</small>)}
      {segment.correctedAt && <details className="live-correction-original"><summary>{ui('查看识别原稿')}</summary>
        <p>{tidyCjk(segment.originalEn)}</p>{segment.correctionReason && <small>{segment.correctionReason}</small>}
      </details>}
      {skipReason !== undefined && <small className="live-skipped">{skipReason ? uiFormat('{0}，原文保留', [uiMessage(skipReason)]) : ui('没能润色，原文保留')}</small>}
      {generated && <small className="live-used">{ui('已用于出题')}</small>}
    </div>
    <SentenceMark segment={segment} checked={checked} />
  </article>;
});

/** A button that may be off: a Tooltip says what it does or, when it is off, why. A disabled button gets no hover of its own, so the words sit on a wrapper. */
function Why({ reason, off = false, children }) {
  return <Tooltip layer content={reason || ''} anchorClassName="live-why"><span className="live-why__anchor" tabIndex={off ? 0 : undefined}>{children}</span></Tooltip>;
}

const GEMINI_STEPS = () => [{ text: ui('用 Google 账号登录 AI Studio'), href: providerOf('free').consoleUrl },
  { text: ui('在「Get API key」页创建一个密钥（这个项目不要开通计费）'), href: providerOf('free').keyUrl },
  { text: ui('在音频设置的 Google Gemini 卡片里粘贴，点「保存并验证」') }];

/**
 * Shown INSTEAD of the start form while no live engine can run, so the microphone (or tab sharing) is never requested before one is there. Where this
 * computer has the local engine, it comes first (one click, no key, offline: ui/LiveLocalCard.jsx) and Gemini is the other way; a learner who chose
 * Gemini on purpose (liveReason 'no-gemini-key') or whose computer has no local engine sees the Gemini steps.
 */
export function LiveSetup({ readiness, onSettings, onReady, initialLocal = null }) {
  // A pre-flight that says nothing about the local engine (an older backend) keeps the Gemini steps.
  const local = readiness?.liveLocal?.supported === true && readiness?.liveReason !== 'no-gemini-key';
  const settings = onSettings ? { label: ui('打开音频设置'), icon: 'key', onClick: onSettings } : undefined;
  if (!local) return <SetupRequired className="live-setup-gate" icon="audio" title={ui('课堂实录需要 Gemini 密钥')}
    why={readiness?.liveReason === 'no-gemini-key' ? ui('你在音频设置里选了用 Gemini 转写课堂实录，但还没有填 Gemini 密钥。也可以在音频设置里改选「本地转写（声音不上传）」。')
      : ui('这台电脑没有现成的本地转写引擎，边听边转写要用 Google Gemini 的实时接口（需要海外网络）。也可以课后在「音频转写」里导入录音。')}
    steps={GEMINI_STEPS()} primary={settings} />;
  return <SetupRequired className="live-setup-gate" icon="audio" title={ui('先装一个转写引擎')}
    why={ui('课堂实录要边听边转成文字。本地转写装在这台电脑上，不需要密钥，声音不上传；也可以改用 Google Gemini（需要密钥和海外网络）。')}
    secondary={settings ? { ...settings, label: ui('改用 Gemini 密钥') } : undefined}>
    <LiveLocalCard initialStatus={initialLocal} onReady={onReady} />
  </SetupRequired>;
}

/** Under the start form: which engine this class will use, and, where both can run, the choice between them (per class; the default is in 音频设置). */
export function ProviderChoice({ readiness, value, onChange, disabled }) {
  const gemini = !!(readiness?.providers?.free || readiness?.providers?.paid), local = !!readiness?.liveLocal?.ready;
  if (gemini && local) return <label className="live-provider live-field">{ui('转写')}<Select className="live-input" value={value} onChange={onChange} disabled={disabled}
    options={[{ value: 'gemini', label: ui('Gemini（云端）') }, { value: 'local', label: ui('本地转写（声音不上传）') }]} /></label>;
  return null;
}
/**
 * 接着录 on the engine the class was recorded with (a class saved before the local engine existed was Gemini). When that engine cannot run now it says
 * so, and offers the other engine as its own button: never a silent switch. A pre-flight that says nothing about the local engine (an older backend)
 * keeps the old button.
 */
export function ResumeControl({ session, readiness, disabled, busy = false, lock = false, onResume }) {
  const held = lock || disabled;
  const recorded = session.engine === 'local' ? 'local' : 'gemini';
  if (!readiness?.liveLocal) return readiness?.live === false ? null : <Button busy={busy} lock={held} onClick={() => onResume(undefined)}>{ui('接着录')}</Button>;
  const localReady = recorded === 'local' ? readiness.liveLocalModels?.[session.localModel || 'sense-voice'] ?? readiness.liveLocal.ready : readiness.liveLocal.ready;
  const can = { local: !!localReady, gemini: !!(readiness.providers?.free || readiness.providers?.paid) };
  if (can[recorded]) return <Button busy={busy} lock={held} onClick={() => onResume(recorded)}>{ui('接着录')}</Button>;
  const other = recorded === 'local' ? 'gemini' : 'local';
  return <span className="live-resume-blocked" data-resume-blocked={recorded}>
    <span className="muted">{recorded === 'local' ? ui('这堂课是用本地转写录的，本地转写现在用不了（可能已删除或需要修复）。') : ui('这堂课是用 Gemini 录的，现在没有 Gemini 密钥。')}</span>
    {can[other] && <Button busy={busy} lock={held} onClick={() => onResume(other)}>{other === 'gemini' ? ui('用 Gemini 接着录') : ui('用本地转写接着录')}</Button>}
  </span>;
}
const engineNote = provider => (provider === 'local'
  ? <Tooltip layer content={localTip(null)}><span tabIndex={0} className="live-engine-note">{ui('转写在这台电脑上进行，声音不上传；简体中文翻译和润色使用音频设置中选定的文字模型（文字会发给模型服务商；没有时只出原文）。')}</span></Tooltip>
  : ui('转写使用 Gemini；简体中文翻译使用音频设置中选定的模型。免费额度用完会切到付费密钥。'));

/**
 * Under the 声音来源 select: what the chosen source needs. Where the browser's permissions policy says this frame may not share a tab (a panel embedded
 * in another page), the usual instruction would be a lie, so a quiet note says so before the first click instead of an error after it. The start
 * button stays usable: the policy check can be wrong, and the refusal then explains itself (ui/live-audio.js classifyTabRefusal).
 */
export function SourceHint({ kind, tabAllowed, loopbackReady = false, onUseMicrophone }) {
  if (kind === 'system') {
    return loopbackReady
      ? <p className="muted" data-system-audio="ready">{ui('直接采集这台电脑耳机或扬声器正在播放的声音，不弹共享窗口；暂停或结束实录会立即释放声卡。')}</p>
      : null;
  }
  if (kind !== 'tab') return null;
  if (tabAllowed === false) return <p className="muted" data-tab-sharing="blocked">{ui('浏览器显示这个面板不允许共享标签页，点「开始实录」多半弹不出选择窗口。请改用麦克风，或在独立的浏览器窗口里打开 StudyHub；也可以课后在「音频转写」里导入录音。')}{' '}
    {onUseMicrophone && <Button variant="link" size="sm" onClick={onUseMicrophone}>{ui('改用麦克风')}</Button>}</p>;
  return <p className="muted">{ui('选择正在播放课程的标签页，并勾选「共享标签页音频」。只发送声音，不发送画面。')}</p>;
}

const PLATFORM_NAME = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
/** The observed facts behind a refusal, in one line the learner can read out or paste. Only what the browser reported; empty parts are left out. */
export function captureFactsLine(facts) {
  if (!facts) return '';
  const window = facts.app ? ui('窗口：应用内置的窗口') : facts.topLevel === false ? ui('窗口：嵌在别的页面里') : facts.topLevel ? ui('窗口：独立页面') : '';
  const policy = facts.policy === 'allowed' ? ui('共享权限策略：允许') : facts.policy === 'denied' ? ui('共享权限策略：禁止') : ui('共享权限策略：读不出来');
  return [facts.browser && uiFormat('浏览器：{0}', [facts.browser]), facts.platform && uiFormat('系统：{0}', [PLATFORM_NAME[facts.platform]]), window, policy,
    facts.elapsedMs != null && uiFormat('点击后 {0} 毫秒被拒绝', [facts.elapsedMs])].filter(Boolean).join(' · ');
}

/**
 * Under a refused tab share: the next step as buttons, not as a sentence to obey. 「改用麦克风并开始」 changes the source and starts at once (the click is
 * the gesture the microphone prompt needs); 「再试一次共享」 only where trying again can work (a permission the learner may just have fixed, or an unknown cause).
 * Where the window itself cannot share (policy, an app shell, a frame) retrying is not offered. The facts line says what the browser reported.
 */
export function CaptureHelp({ kind, facts, disabled, activeOp = '', lock = false, liveLoopback = null, initialLoopback = null, onMicrophone, onSystemAudio, onLoopbackReady, onRetry }) {
  if (!['blocked', 'embedded-instant', 'app-window', 'instant', 'unknown'].includes(kind)) return null;
  const retry = kind === 'instant' || kind === 'unknown';
  const held = lock || disabled;
  const line = captureFactsLine(facts);
  const canLoopback = liveLoopback?.supported === true;
  return <div className="live-capture-help" data-capture-help={kind}>
    <div className="live-capture-actions">
      {canLoopback && liveLoopback.ready && onSystemAudio &&
        <Button busy={activeOp === 'start-system'} lock={held} onClick={onSystemAudio}>{ui('改用电脑系统声音并开始')}</Button>}
      <Button busy={activeOp === 'start-mic'} lock={held} onClick={onMicrophone}>{ui('改用麦克风并开始')}</Button>
      {retry && <Button variant="quiet" busy={activeOp === 'start-tab'} lock={held} onClick={onRetry}>{ui('再试一次共享')}</Button>}
    </div>
    {canLoopback && !liveLoopback.ready && <LiveLoopbackCard initialStatus={initialLoopback} onReady={onLoopbackReady} />}
    {!canLoopback && facts?.platform === 'windows' && <p className="muted" data-capture-loopback>{ui('戴着耳机、不想外放：把 Windows 的默认录音设备改成「立体声混音」（或虚拟声卡的 Output），然后选「麦克风」，就能直接录到电脑播放的声音。步骤见文档「课堂实录」。')}</p>}
    {line && <details className="live-capture-facts"><summary>{ui('排查信息')}</summary><p className="muted">{line}</p></details>}
  </div>;
}

export default function LiveClass({ data, visible, onJobs, onSettings, onSources, initialReadiness = null, initialLocal = null, initialLoopback = null, initialAppHost, initialKind = 'microphone', initialSession = null }) {
  const { call } = useStudy();
  const language = useUiLanguage();
  useInjectCss(css, 'study-live-class');
  const [course, setCourse] = usePageScope(data?.root, 'live-class-course', data?.focus?.course ?? '');
  // `initialSession`: a class already open (tests and screenshots); the client then starts with it, as after 打开 in the history.
  const client = useMemo(() => { const made = new LiveClient(call); if (initialSession) made.accept(initialSession); return made; }, [call, initialSession]);
  const { session, capturing, busy, error, errorKind, errorFacts } = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [sessions, setSessions] = useState([]), [title, setTitle] = useState(''), [subject, setSubject] = useState('');
  const [terms, setTerms] = useState(''), [kind, setKind] = useState(initialKind), [paidOnly, setPaidOnly] = useState(false);
  const [selected, setSelected] = useState(new Set()), [count, setCount] = useState(5), [activeOp, setActiveOp] = useState('');
  const working = activeOp !== '';
  const toast = useToast();
  // 删除 of an archived class asks nothing (a recording is not a source or a question): the row leaves and the notice offers 撤销 (ui/undoable.js).
  const undoable = useUndoable();
  const [follow, setFollow] = useState(true);
  // Read once, in the first render: the policy of a frame does not change, and a note that arrived later would push the form down.
  const [tabAllowed] = useState(() => tabSharingAllowed());
  const [appHost] = useState(() => initialAppHost ?? hostInfo().app);
  const openAudio = openAudioSettings(onSettings);
  const openPause = openAudioSettings(onSettings, LIVE_PAUSE_ANCHOR);
  // A speaker who never pauses leaves everything in the grey line: after a minute of that, one quiet line says where 断句停顿 is.
  const pauseHint = usePauseHint(session);
  const feed = useRef(null), operation = useRef(false);
  // Whether a live provider is configured, checked before anything asks for the microphone (null until known).
  const [readiness, setReadiness] = useState(initialReadiness), [checked, setChecked] = useState(0);
  useLiveEffect((alive) => {
    if (!visible || (initialReadiness && !checked) || !call) return;
    Promise.resolve(call('audio.preflight', {})).then((result) => { if (alive() && result && typeof result === 'object') setReadiness(result); }, () => {});
  }, [visible, call, initialReadiness, checked]);
  // The engine of the next class: the pre-flight's answer (the learner's default), changed here per class where both engines can run.
  const [provider, setProvider] = useState('');
  const engine = provider || readiness?.liveProvider || 'gemini';
  const loopbackSupported = readiness?.liveLoopback?.supported === true;
  const loopbackReady = readiness?.liveLoopback?.ready === true;
  const sourceOptions = loopbackSupported && appHost === 'electron'
    ? [{ value: 'microphone', label: ui('麦克风（现场课堂）') }, { value: 'system', label: ui('电脑系统声音（客户端 / 网课）') }]
    : loopbackSupported
      ? [{ value: 'microphone', label: ui('麦克风（现场课堂）') }, { value: 'system', label: ui('电脑系统声音（本机组件直采）') }, { value: 'tab', label: ui('标签页 / 系统声音（网课）') }]
      : [{ value: 'microphone', label: ui('麦克风（现场课堂）') }, { value: 'tab', label: ui('标签页 / 系统声音（网课）') }];
  const effectiveKind = loopbackSupported && appHost === 'electron' && kind === 'tab'
    ? 'system'
    : (!loopbackSupported && kind === 'system' ? 'microphone' : kind);
  const needsLoopbackInstall = effectiveKind === 'system' && !loopbackReady;
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
  // A refusal that retrying cannot fix moves the form to system audio when ready, or the microphone, so the next click on 「开始实录」 works.
  useEffect(() => {
    if (error && ['blocked', 'embedded-instant', 'app-window'].includes(errorKind)) {
      setKind(loopbackSupported && loopbackReady ? 'system' : 'microphone');
    }
  }, [error, errorKind, loopbackSupported, loopbackReady]);
  const perform = async (op, action) => {
    if (operation.current) return;
    operation.current = true; setActiveOp(op); client.update({ error: '' });
    try { await action(); } catch (failure) { client.fail(failure); }
    finally { operation.current = false; setActiveOp(''); }
  };
  const toggle = useCallback((id) => setSelected((previous) => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  }), []);
  const begin = (source, op = 'start') => perform(op, async () => {
    setSelected(new Set());
    await client.start(source, { title, course, subject, terms, paidOnly: engine !== 'local' && paidOnly, ...(readiness?.liveProvider ? { provider: engine } : {}) });
    await refresh();
  });
  const segments = session?.segments || [], generated = new Set(session?.generatedIds || []);
  const correction = session?.correction, checkedThrough = correction?.enabled ? correction.coveredThrough || 0 : 0;
  // A sentence the cursor passed but gave up on is not checked: it carries its reason instead of a tick.
  const skippedWhy = useMemo(() => new Map((correction?.skippedItems || []).map((item) => [item.id, item.reason || ''])), [correction?.skippedItems]);
  const everyChinese = segments.length > 0 && segments.every(isChinese);
  const polished = segments.filter((segment) => segment.correctedAt).length;
  const chosen = segments.filter((segment) => selected.has(segment.id));
  const selectedChars = chosen.reduce((n, segment) => n + segment.en.length, 0);
  const disabled = busy || working;
  const total = session?.total || segments.length;
  const canGenerate = !disabled && selectedChars >= MIN_CHARS && chosen.length <= 400 && Number.isInteger(count) && count >= 1 && count <= 15;
  // Why 选中内容出题 is off (nothing while a request is running: that is just waiting).
  const generateWhy = canGenerate || disabled ? '' : chosen.length > 400 ? ui('一次最多选 400 句') : !chosen.length ? ui('先选几句话；至少约 120 个原文字符才能出题')
    : uiFormat('至少约 {0} 个原文字符，目前 {1}', [MIN_CHARS, selectedChars]);
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
      actions={<Button variant="quiet" onClick={openAudio}>{ui('音频设置')}</Button>} />
    {error && <InlineMessage tone="error" boxed>{uiMessage(error)}</InlineMessage>}
    {error && !active(session) && <CaptureHelp kind={errorKind} facts={errorFacts} activeOp={activeOp} lock={disabled}
      liveLoopback={readiness?.liveLoopback || null} initialLoopback={initialLoopback}
      onSystemAudio={() => { setKind('system'); void begin('system', 'start-system'); }}
      onLoopbackReady={() => { setKind('system'); setChecked((value) => value + 1); }}
      onMicrophone={() => { setKind('microphone'); void begin('microphone', 'start-mic'); }}
      onRetry={() => void begin('tab', 'start-tab')} />}
    {!active(session) && readiness && readiness.live === false && <LiveSetup readiness={readiness} onSettings={openAudio} initialLocal={initialLocal}
      onReady={() => setChecked((value) => value + 1)} />}
    {!active(session) && !(readiness && readiness.live === false) && <form className="live-setup" onSubmit={(event) => {
      event.preventDefault(); if (!needsLoopbackInstall) void begin(effectiveKind, 'start');
    }}>
      <div className="live-fields"><label className="live-field">{ui('课堂名称')}<input className="live-input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder={ui('例如：数据库 · 分区与索引')} /></label>
        <label className="live-field">{ui('声音来源')}<Select className="live-input" value={effectiveKind} onChange={setKind}
          options={sourceOptions} /></label></div>
      <SourceHint kind={effectiveKind} tabAllowed={tabAllowed} loopbackReady={loopbackReady} onUseMicrophone={() => setKind('microphone')} />
      {needsLoopbackInstall && <LiveLoopbackCard initialStatus={initialLoopback} onReady={() => setChecked((value) => value + 1)} />}
      <CourseField value={course} onChange={setCourse} courses={data?.focus?.courses} disabled={disabled} />
      <details><summary>{ui('课程背景与术语（可选）')}</summary>
        <label className="live-field">{ui('这堂课讲什么')}<input className="live-input" value={subject} maxLength={300} onChange={(event) => setSubject(event.target.value)} /></label>
        <label className="live-field">{ui('术语（逗号或换行分隔）')}<textarea className="live-input" value={terms} onChange={(event) => setTerms(event.target.value)} rows={2} /></label></details>
      <ProviderChoice readiness={readiness} value={engine} onChange={setProvider} disabled={disabled} />
      <div className="live-setup-foot">
        {engine !== 'local' && <Checkbox checked={paidOnly} onChange={setPaidOnly} label={ui('只用付费密钥')} />}
        <Button variant={needsLoopbackInstall ? 'secondary' : 'primary'} busy={busy || activeOp === 'start'} lock={disabled} disabled={needsLoopbackInstall} busyLabel={ui('正在连接…')} type="submit">{ui('开始实录')}</Button></div>
      <small className="muted">{engineNote(engine)}</small>
    </form>}
    {!session && busy && <LiveAudioMonitor health={client.health} visible={visible} recording={capturing} />}
    {session && <>
      <div className="live-bar">
        <div className="live-bar-main">
          <span className={`live-state ${tone}`}><i aria-hidden="true" />{session.archivedAt ? ui('已归档') : statusText(session.status)}</span>
          <strong className="live-title">{session.title}</strong>
          <span className="muted">{session.course || ui('未分类')}</span>
          <span className="muted live-meta">{formatClock(session.elapsedMs)} · {uiFormat('{0} 句', [total])}
            {session.tier && active(session) ? ` · ${{ free: ui('免费额度'), local: ui('本地转写（声音不上传）') }[session.tier] || ui('付费密钥')}` : ''}</span>
        </div>
        <div className="live-actions">{capturing && <Button busy={activeOp === 'pause'} lock={disabled} onClick={() => void perform('pause', () => client.pause())}>{session.status === 'paused' ? ui('继续') : ui('暂停')}</Button>}
          {active(session) && <Button busy={activeOp === 'stop'} lock={disabled} onClick={() => void perform('stop', async () => { await client.stop(); await refresh(); })}>{ui('结束实录')}</Button>}
          {!active(session) && !session.archivedAt && <ResumeControl session={session} readiness={readiness} busy={activeOp === 'resume'} lock={disabled}
            onResume={(onEngine) => void perform('resume', async () => { await client.start(effectiveKind, { resumeId: session.id, paidOnly: onEngine !== 'local' && paidOnly, ...(onEngine ? { provider: onEngine } : {}) }); })} />}</div>
        {active(session) && <small className="muted live-after" data-live-after>{ui('结束后点「保存为资料」，会先补完润色和译文，再存下文字稿和课堂笔记。')}</small>}</div>
      <LiveAudioMonitor compact health={client.health} visible={visible} recording={capturing} sentences={total} />
      {correction && <LiveCorrectionLine correction={correction} total={total} polished={polished} active={active(session)} busy={activeOp === 'correct'} lock={disabled} onSettings={openAudio}
        onRetry={() => void perform('correct', async () => { client.accept(await call('live.correct', { id: session.id })); })} />}
      {session.message && <p role="status" className="muted">{session.message}</p>}
      {session.warnings?.length > 0 && <details><summary>{ui('连接与额度提示')}</summary>{session.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <div className="live-stage">
        <div className="live-feed-head">
          <span className="muted">{everyChinese ? ui('勾选句子或划选文字即可出题。') : ui('原文在上，简体中文在下；勾选句子或划选文字即可出题。')}</span>
          <div className="live-actions">
            {segments.some((segment) => showsTranslation(segment) && segment.zhState === 'error') && <Button busy={activeOp === 'retry-zh'} lock={disabled} onClick={() => void perform('retry-zh', async () => { await call('live.retry', { id: session.id }); await client.poll(); })}>{ui('重试失败的翻译')}</Button>}
            <Button variant="link" size="sm" className="live-follow" onClick={() => setFollow(!follow)} aria-pressed={follow}>{follow ? ui('正在跟随最新') : ui('回到最新')}</Button></div>
        </div>
        {pauseHint && <p className="live-pause-hint muted" role="status" data-live-pause-hint>{ui('讲得很快、一直没有断句？到 音频设置 › 断句停顿 选『短』，下次开始或接着录时生效。')}
          {openPause && <> <Button variant="link" size="sm" onClick={openPause}>{ui('打开断句停顿设置')}</Button></>}</p>}
        <div className="live-feed" ref={feed} tabIndex={0} onMouseUp={selectText} onKeyUp={selectText} onScroll={() => {
          const node = feed.current; if (node && node.scrollHeight - node.scrollTop - node.clientHeight > 80) setFollow(false);
        }} aria-label={ui('课堂原文与译文')}>
          {!segments.length && !session.interim && <p className="live-empty">{active(session) ? ui('开始说话后，原文和译文会出现在这里。') : ui('这场实录还没有文字。')}</p>}
          {segments.map((segment) => <Sentence key={segment.id} segment={segment} selected={selected.has(segment.id)} generated={generated.has(segment.id)}
            checked={checkedThrough >= segment.id && !segment.correctedAt && !skippedWhy.has(segment.id)} skipReason={skippedWhy.get(segment.id)} onToggle={toggle} language={language} />)}
          {session.interim && <div className="live-interim" data-live-interim><small className="live-interim__label">{ui('正在听写，句子说完后会定稿')}</small>
            <p>{tidyCjk(session.interim)}<span aria-hidden="true"> …</span></p></div>}
        </div>
        <div className="live-selection" data-tour="live-selection">
          <div className="live-selection-info"><strong>{uiFormat('已选 {0} 句', [chosen.length])}</strong>
            <span className="muted live-selection-info__note" data-blocking={chosen.length > 0 && selectedChars < MIN_CHARS ? 'true' : undefined} data-ok={selectedChars >= MIN_CHARS ? 'true' : undefined}>{chosen.length ? (selectedChars >= MIN_CHARS ? uiFormat('约 {0} 个原文字符', [selectedChars])
              : uiFormat('再多选约 {0} 个字符才能出题', [MIN_CHARS - selectedChars]))
              : ui('至少选约 120 个原文字符')}</span></div>
          <div className="live-actions">
            <Why off={!segments.length} reason={segments.length ? uiFormat('选中最近约 {0} 个原文字符的内容', [RECENT_CHARS]) : ui('还没有句子可选')}>
              <Button className="live-selection-btn" disabled={!segments.length} onClick={() => setSelected(new Set(recentWindow(segments).map((segment) => segment.id)))}>{ui('最近一段')}</Button></Why>
            <Why off={!selected.size} reason={selected.size ? '' : ui('还没有选中的句子')}>
              <Button className="live-selection-btn" disabled={!selected.size} onClick={() => setSelected(new Set())}>{ui('清空')}</Button></Why>
            <div className="live-count" role="group" aria-label={ui('题数')}>
              <span className="live-count-label">{ui('题数')}</span>
              <IconButton className="live-count-btn" icon="minus" size="sm" label={ui('减少题数')} disabled={count <= 1} onClick={() => setCount(Math.max(1, count - 1))} />
              <output aria-live="polite">{count}</output>
              <IconButton className="live-count-btn" icon="plus" size="sm" label={ui('增加题数')} disabled={count >= 15} onClick={() => setCount(Math.min(15, count + 1))} /></div>
            <Why off={!canGenerate && !disabled} reason={generateWhy}><Button className="live-selection-btn" variant="primary" busy={activeOp === 'generate'} lock={disabled} disabled={!canGenerate}
              onClick={() => void perform('generate', async () => {
                const result = await call('live.generate', { id: session.id, segmentIds: chosen.map((segment) => segment.id), count, language: GENERATION_LANGUAGE[language] });
                toast.success(ui('已加入出题任务；课堂实录会继续。草稿会出现在「学习库 › 待发布草稿」，进度在「任务」。'));
                setSelected(new Set()); await client.poll(); onJobs?.(result);
              })}>{ui('选中内容出题')}</Button></Why></div></div>
      </div>
      {correction && <LiveNotes correction={correction} disabled={disabled} onSentence={id => {
        setFollow(false);
        const node = feed.current?.querySelector(`[data-segment-id="${id}"]`);
        node?.scrollIntoView({ block: 'center' }); node?.focus({ preventScroll: true });
      }} onRetry={() => void perform('notes-retry', async () => { client.accept(await call('live.correct.background', { id: session.id })); })} />}
      <footer className="live-footer"><p className="muted">{ui('付费转写估算')} ${session.usage?.estimatedPaidUsd || 0} · {ui('不含翻译费用')}</p>
        {!active(session) && segments.length > 0 && <div className="live-actions" data-tour="live-save">
          {/* Never off for what the polish or the translations are doing: the save finishes what is missing first (one job in 任务) and says what it could not. */}
          <Why reason={ui('保存时会先补完润色和译文，再存下文字稿和课堂笔记；没能做完的，会在任务里说明。')}>
            <Button busy={activeOp === 'save'} lock={disabled} onClick={() => void perform('save', async () => {
              const saved = await call('live.save', { id: session.id });
              if (saved?.jobId) toast.success(ui('已加入保存任务：先补完润色和译文，再保存。进度在任务里，完成后在资料里打开。'));
              // Said plainly either way: the notes are saved, or they are not (no model, or the model gave nothing usable).
              else if (saved?.noteSourceId) toast.success(ui('已保存文字稿和课堂笔记。'));
              else toast.warning(ui('已保存文字稿，但没有保存课堂笔记：没有可用的文字模型，或模型没有给出可用的笔记。'));
              onJobs?.(saved?.jobId ? saved : undefined);
            })}>{ui('保存为资料')}</Button></Why>
          <Why reason={ui('再校对一遍整份文字、按段翻译并起标题，需要文字模型，比较慢；一般点「保存为资料」就够了。')}>
            <Button variant="quiet" busy={activeOp === 'save-proofread'} lock={disabled} onClick={() => void perform('save-proofread', async () => {
              await call('live.save', { id: session.id, proofread: true, paidOnly }); toast.success(ui('已加入校对任务，完成后会保存为资料。')); onJobs?.();
            })}>{ui('校对后保存')}</Button></Why>
          <Button variant="link" size="sm" onClick={onSources}>{ui('打开资料')}</Button></div>}</footer>
    </>}
    <LiveHistory sessions={sessions.filter(item => !undoable.hidden(`live:${item.id}`))} disabled={disabled} capturing={capturing}
      onOpen={id => void perform('history-open', async () => { setSelected(new Set()); await client.open(id); })}
      onArchive={(id, archived) => void perform('history-archive', async () => {
        const result = await call('live.archive', { id, archived });
        if (client.getSnapshot().session?.id === id) client.accept(result);
        await refresh();
      })}
      onDelete={item => undoable.commitLater({ keys: [`live:${item.id}`], message: uiFormat('已删除「{0}」的实录、译文和课堂笔记；另存的学习资料还在。', [item.title]),
        commit: async () => { await call('live.delete', { id: item.id }); client.close(item.id); setSelected(new Set()); await refresh(); return true; },
        failed: reason => uiFormat('没能删除「{0}」，已放回原处：{1}', [item.title, reason]),
        focus: () => document.querySelector(`[data-live="${CSS.escape(item.id)}"] .live-actions button:last-child`) })} />
  </section>;
}
