import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, useUiLanguage, errorMessage } from '../i18n.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { useCopyFeedback } from '../use-copy-feedback.js';
import { useUndoable } from '../use-undoable.js';
import { useHandOff } from '../hand-off/use-hand-off.js';
import { AppContext } from '../app/app-context.js';
import { DiagramFrame } from '../diagram-frame.js';
import Markdown from '../Markdown.jsx';
import { Badge, Button, Checkbox, Dialog, Disclosure, Field, IconButton, InlineMessage, LoadingState, Select, TextArea, TextInput } from '../components/index.js';
import css from './companions.css';

function currentTheme(fallbackTheme) {
  if (typeof document !== 'undefined') {
    const explicit = document.documentElement?.getAttribute?.('data-theme');
    if (explicit === 'dark' || explicit === 'light') return explicit;
    const appExplicit = document.querySelector?.('.study-app')?.getAttribute?.('data-theme');
    if (appExplicit === 'dark' || appExplicit === 'light') return appExplicit;
  }
  if (fallbackTheme === 'dark' || fallbackTheme === 'light') return fallbackTheme;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function makeToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `shc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function feedbackTagLabel(tag) {
  if (tag === 'deepen') return ui('想深挖');
  if (tag === 'example') return ui('补例子');
  if (tag === 'errata') return ui('疑似有误');
  return ui('没看懂');
}

export default function CompanionViewer({ modal, onClose }) {
  useInjectCss(css, 'study-companions');
  const { call, host, notify } = useStudy();
  const app = useContext(AppContext);
  const refresh = app?.core?.refresh;
  const appTheme = app?.shell?.resolvedTheme;
  const undoable = useUndoable();
  const { send } = useHandOff();

  const companionId = modal?.id || modal?.companionId;
  const course = modal?.course || '';
  const initialAnchor = modal?.anchor || '';
  const requestedSlide = Math.max(0, Math.floor(Number(modal?.initialSlide ?? modal?.slide) || 0));
  const language = useUiLanguage();

  const frameRef = useRef(null);
  const questionRef = useRef(null);
  const [channelToken] = useState(makeToken);
  const checkResultsRef = useRef({});
  const progressTimerRef = useRef(0);

  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(Boolean(modal?.openDrawer));
  const [expanded, setExpanded] = useState(Boolean(modal?.expanded));
  const [inquiryFocusSeq, setInquiryFocusSeq] = useState(0);
  const [syncingDisk, setSyncingDisk] = useState(false);
  const [slideCtx, setSlideCtx] = useState({
    slide: requestedSlide >= 1 ? requestedSlide : 1,
    slideTotal: 1,
    slideTitle: '',
    beat: '',
    teacherLine: '',
    quote: '',
    codeSlice: '',
  });
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState('');
  const [tutorReply, setTutorReply] = useState(null);
  const [cardDraft, setCardDraft] = useState({ prompt: '', answer: '', misconception: '' });
  const [syncFeedback, setSyncFeedback] = useState(false);
  const [savingCard, setSavingCard] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(true);
  const [feedbackSeq, setFeedbackSeq] = useState(0);
  const [feedbackState, setFeedbackState] = useState({ loading: false, total: 0, open: 0, items: [], error: '' });

  const askLabel = ui('＋ 记疑问');
  const selectionLabel = ui('就这句提问');
  const bootInitRef = useRef({ channelToken, appTheme, initialAnchor, requestedSlide, askLabel, selectionLabel });
  useEffect(() => {
    bootInitRef.current = { channelToken, appTheme, initialAnchor, requestedSlide, askLabel, selectionLabel };
  }, [appTheme, askLabel, channelToken, initialAnchor, requestedSlide, selectionLabel]);

  useLiveEffect(isLive => {
    setState({ status: 'loading' });
    call('companion.get', { id: companionId, ...(course ? { course } : {}) })
      .then(res => {
        if (!isLive()) return;
        checkResultsRef.current = res.savedState?.checkResults || {};
        const init = bootInitRef.current;
        const slideTotal = Math.max(1, Number(res.lesson?.slideCount || res.companion?.slideCount) || 1);
        const savedSlide = Math.floor(Number(res.companion?.progress?.slide) || 0);
        const targetSlide = init.requestedSlide >= 1
          ? Math.min(slideTotal, init.requestedSlide)
          : (savedSlide >= 1 ? Math.min(slideTotal, savedSlide) : 1);
        const anchor = init.initialAnchor || (init.requestedSlide >= 1 ? `#${targetSlide}` : (savedSlide > 1 ? `#${targetSlide}` : ''));
        const bootConfig = {
          channelToken: init.channelToken,
          theme: currentTheme(init.appTheme),
          initialAnchor: anchor,
          ...(targetSlide >= 1 ? { initialSlide: targetSlide } : {}),
          memory: res.savedState?.memory || {},
          askLabel: init.askLabel,
          selectionLabel: init.selectionLabel,
        };
        setState({ status: 'ready', ...res, bootConfig });
        setSlideCtx(cur => ({
          ...cur,
          slide: targetSlide || cur.slide || 1,
          slideTotal,
        }));
      })
      .catch(err => {
        if (isLive()) setState({ status: 'failed', text: errorMessage(err) || ui('暂时无法读取这份交互伴学页。') });
      });
    return () => { clearTimeout(progressTimerRef.current); };
  }, [call, companionId, course, attempt]);

  useEffect(() => {
    function onMessage(event) {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const msg = event.data;
      if (!msg || msg.protocol !== 'studyhub-companion/1' || msg.token !== channelToken) return;

      if (msg.kind === 'self-check' && typeof msg.slot === 'string') {
        checkResultsRef.current = { ...checkResultsRef.current, [msg.slot]: Boolean(msg.correct) };
      } else if (msg.kind === 'progress') {
        const slide = Math.max(1, Number(msg.slide) || 1);
        const slideTotal = Math.max(slide, Number(msg.slideTotal) || 1);
        setSlideCtx(cur => {
          if (cur.slide === slide) return { ...cur, slide, slideTotal, beat: String(msg.beat || cur.beat || '') };
          const sl = state.lesson?.slides?.[slide - 1];
          return {
            slide,
            slideTotal,
            slideTitle: String(sl?.title || '').slice(0, 200),
            beat: String(msg.beat || sl?.beat || '').slice(0, 60),
            teacherLine: '',
            quote: '',
            codeSlice: '',
          };
        });
        setAskError('');
        clearTimeout(progressTimerRef.current);
        progressTimerRef.current = setTimeout(() => {
          call('companion.progress', {
            id: companionId,
            course: state.companion?.course || course,
            slide,
            slideTotal,
            completed: Boolean(msg.completed),
            ...(msg.memory && typeof msg.memory === 'object' ? { memory: msg.memory } : {}),
            checkResults: checkResultsRef.current,
          }).then(res => {
            if (res?.firstPassCredited > 0) {
              notify({ text: uiFormat('已完成本节交互推演，{0} 张关联卡片已采信首学记录并排入后续复习。', [res.firstPassCredited]), tone: 'success' });
              Promise.resolve(refresh?.()).catch(() => {});
            }
          }).catch(() => {});
        }, msg.completed ? 50 : 600);
      } else if (msg.kind === 'inquiry' && msg.context) {
        const c = msg.context;
        setSlideCtx({
          slide: Number(c.slide) || 1,
          slideTotal: Number(c.slideTotal) || 1,
          slideTitle: String(c.slideTitle || '').slice(0, 200),
          beat: String(c.beat || '').slice(0, 60),
          teacherLine: String(c.teacherLine || '').slice(0, 600),
          quote: String(c.quote || '').slice(0, 600),
          codeSlice: String(c.codeSlice || '').slice(0, 1500),
        });
        setDrawerOpen(true);
        setAskError('');
        setInquiryFocusSeq(n => n + 1);
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => questionRef.current?.focus?.());
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [call, channelToken, companionId, course, notify, refresh, state.companion?.course, state.lesson?.slides]);

  useEffect(() => {
    if (!drawerOpen || !inquiryFocusSeq) return undefined;
    if (typeof requestAnimationFrame === 'function') {
      const raf = requestAnimationFrame(() => questionRef.current?.focus?.());
      return () => cancelAnimationFrame(raf);
    }
    questionRef.current?.focus?.();
    return undefined;
  }, [drawerOpen, inquiryFocusSeq]);

  const courseName = state.companion?.course || course;
  const hasLinkedFeedback = Boolean(state.companion?.linkedRoot);
  const refreshFeedbackLedger = useCallback(() => setFeedbackSeq(n => n + 1), []);

  const handleSyncDisk = useCallback(async () => {
    setSyncingDisk(true);
    try {
      const res = await call('companion.sync', {
        id: companionId,
        ...(courseName ? { course: courseName } : {}),
      });
      setState(cur => (cur.status === 'ready' ? {
        ...cur,
        changedOnDisk: false,
        companion: res?.companion ? { ...cur.companion, ...res.companion } : cur.companion,
      } : cur));
      if (res?.companion?.slideCount > 0) {
        const nextTotal = res.companion.slideCount;
        setSlideCtx(cur => ({
          ...cur,
          slideTotal: nextTotal,
          slide: Math.min(cur.slide, nextTotal),
        }));
      }
      Promise.resolve(refresh?.()).catch(() => {});
      notify({
        text: ui('已同步磁盘最新伴学内容与关联题卡（原有复习进度已保留）。'),
        tone: 'success',
      });
    } catch (err) {
      notify({ text: errorMessage(err), tone: 'error' });
    } finally {
      setSyncingDisk(false);
    }
  }, [call, companionId, courseName, notify, refresh]);

  const postToFrame = useCallback(payload => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({
      protocol: 'studyhub-companion/1',
      token: channelToken,
      ...payload,
    }, '*');
  }, [channelToken]);

  const jumpToSlide = useCallback(rawSlide => {
    const total = Math.max(1, Number(slideCtx.slideTotal) || 1);
    const nextSlide = Math.max(1, Math.min(total, Math.floor(Number(rawSlide) || 1)));
    postToFrame({ kind: 'goto', slide: nextSlide });
    setSlideCtx(cur => {
      if (cur.slide === nextSlide) return cur;
      const sl = state.lesson?.slides?.[nextSlide - 1];
      return {
        slide: nextSlide,
        slideTotal: cur.slideTotal,
        slideTitle: String(sl?.title || '').slice(0, 200),
        beat: String(sl?.beat || '').slice(0, 60),
        teacherLine: '',
        quote: '',
        codeSlice: '',
      };
    });
    setAskError('');
  }, [postToFrame, slideCtx.slideTotal, state.lesson?.slides]);

  const lastRequestedRef = useRef(`${companionId || ''}:${requestedSlide}`);
  useEffect(() => {
    const nextKey = `${companionId || ''}:${requestedSlide}`;
    if (lastRequestedRef.current === nextKey) return;
    lastRequestedRef.current = nextKey;
    if (state.status === 'ready' && requestedSlide >= 1) {
      jumpToSlide(requestedSlide);
    }
  }, [companionId, jumpToSlide, requestedSlide, state.status]);

  useEffect(() => {
    const iframe = frameRef.current;
    if (state.status !== 'ready' || !iframe || requestedSlide < 1) return undefined;
    const syncInitialSlide = () => postToFrame({ kind: 'goto', slide: requestedSlide });
    iframe.addEventListener('load', syncInitialSlide);
    return () => iframe.removeEventListener('load', syncInitialSlide);
  }, [postToFrame, requestedSlide, state.status]);

  useEffect(() => {
    if (state.status !== 'ready' || typeof document === 'undefined') return undefined;
    const syncTheme = () => {
      const nextTheme = currentTheme(appTheme);
      if (nextTheme === 'dark' || nextTheme === 'light') {
        postToFrame({ kind: 'theme', theme: nextTheme });
      }
    };
    syncTheme();
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(syncTheme) : null;
    if (observer && document.documentElement) {
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    const appRoot = document.querySelector?.('.study-app');
    if (observer && appRoot && appRoot !== document.documentElement) {
      observer.observe(appRoot, { attributes: true, attributeFilter: ['data-theme'] });
    }
    const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;
    media?.addEventListener?.('change', syncTheme);
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.('change', syncTheme);
    };
  }, [appTheme, postToFrame, state.status]);

  useLiveEffect(isLive => {
    if (state.status !== 'ready' || !hasLinkedFeedback) {
      setFeedbackState({ loading: false, total: 0, open: 0, items: [], error: '' });
      return undefined;
    }
    setFeedbackState(cur => ({ ...cur, loading: true, error: '' }));
    call('companion.feedback.sync', {
      id: companionId,
      ...(courseName ? { course: courseName } : {}),
    })
      .then(res => {
        if (!isLive()) return;
        setFeedbackState({
          loading: false,
          total: Number(res?.total) || 0,
          open: Number(res?.open) || 0,
          items: Array.isArray(res?.items) ? res.items : [],
          error: '',
        });
      })
      .catch(err => {
        if (isLive()) {
          setFeedbackState(cur => ({ ...cur, loading: false, error: errorMessage(err) }));
        }
      });
    return undefined;
  }, [call, companionId, courseName, feedbackSeq, hasLinkedFeedback, state.status]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    postToFrame({ kind: 'labels', askLabel, selectionLabel });
  }, [askLabel, postToFrame, selectionLabel, state.status]);

  const openFeedbackItems = useMemo(() => {
    const allOpen = (feedbackState.items || []).filter(it => it && it.status !== 'resolved');
    if (!allOpen.length) return [];
    const curIds = new Set([state.companion?.lessonId, state.lesson?.id, state.companion?.id].filter(Boolean));
    if (!curIds.size) return allOpen;
    const matched = allOpen.filter(it => !it.lessonId || curIds.has(it.lessonId));
    return matched.length ? matched : allOpen;
  }, [feedbackState.items, state.companion?.id, state.companion?.lessonId, state.lesson?.id]);

  // Instant 0-token glossary & prerequisite lookup matching current quote or slide
  const matchedTerms = useMemo(() => {
    const terms = state.lesson?.terms || {};
    const entries = Object.entries(terms);
    if (!entries.length) return [];
    const needle = `${slideCtx.quote} ${slideCtx.slideTitle} ${question}`.toLowerCase();
    const hits = entries.filter(([term]) => needle.includes(term.toLowerCase()));
    return (hits.length ? hits : entries.slice(0, 4)).slice(0, 5);
  }, [question, slideCtx.quote, slideCtx.slideTitle, state.lesson?.terms]);

  const matchedPrereqCards = useMemo(() => {
    const cards = state.relatedCards || [];
    if (!cards.length) return [];
    const needle = `${slideCtx.quote} ${slideCtx.slideTitle} ${question}`.trim().toLowerCase();
    if (!needle) return cards.slice(0, 3);
    const hits = cards.filter(c => {
      const t = String(c.topic || '').toLowerCase();
      return (t.length >= 2 && needle.includes(t)) || (slideCtx.quote && String(c.prompt || '').toLowerCase().includes(slideCtx.quote.toLowerCase().slice(0, 18)));
    });
    return hits.slice(0, 3);
  }, [question, slideCtx.quote, slideCtx.slideTitle, state.relatedCards]);

  const handleAskTutor = useCallback(async () => {
    const q = question.trim() || (slideCtx.quote ? uiFormat('请帮我讲清这句：「{0}」', [slideCtx.quote]) : '');
    if (!q) { setAskError(ui('请先输入你的困惑，或在左侧页面划选一句内容。')); return; }
    setAsking(true);
    setAskError('');
    try {
      const res = await call('companion.ask', {
        id: companionId,
        course: courseName,
        language,
        question: q,
        context: {
          lessonTitle: state.companion?.title || '',
          ...slideCtx,
        },
      });
      setTutorReply(res.answerMarkdown || '');
      if (res.suggestedCard) {
        setCardDraft({
          prompt: res.suggestedCard.prompt || q,
          answer: res.suggestedCard.answer || '',
          misconception: res.suggestedCard.misconception || q,
          originCtx: { ...slideCtx },
        });
      }
    } catch (err) {
      setAskError(errorMessage(err));
    } finally {
      setAsking(false);
    }
  }, [call, companionId, courseName, language, question, slideCtx, state.companion?.title]);

  const handleSaveCatchup = useCallback(async () => {
    if (!cardDraft.prompt.trim() || !cardDraft.answer.trim()) return;
    setSavingCard(true);
    const targetCtx = cardDraft.originCtx || slideCtx;
    try {
      const saved = await call('companion.catchup.save', {
        companionId,
        course: courseName,
        slide: targetCtx.slide,
        slideTotal: targetCtx.slideTotal,
        slideTitle: targetCtx.slideTitle,
        beat: targetCtx.beat,
        teacherLine: targetCtx.teacherLine,
        quote: targetCtx.quote,
        note: question.trim(),
        prompt: cardDraft.prompt.trim(),
        answer: cardDraft.answer.trim(),
        misconception: cardDraft.misconception.trim(),
        syncFeedback,
        language,
      });
      Promise.resolve(refresh?.()).catch(() => {});
      if (saved.feedbackSynced) refreshFeedbackLedger();
      setCardDraft({ prompt: '', answer: '', misconception: '' });
      undoable.commitLater({
        keys: [`catchup:${saved.cardId}`],
        message: saved.feedbackSynced
          ? ui('已加入「伴学拾遗」（排入次日复习），并同步至讲义改进清单。')
          : ui('已加入「伴学拾遗」题组，排入次日复习。'),
        commit: async () => true,
        undo: async () => {
          await call('companion.catchup.remove', { deckId: saved.deckId, cardId: saved.cardId });
          Promise.resolve(refresh?.()).catch(() => {});
        },
      });
      notify({
        text: saved.feedbackSynced
          ? ui('已加入「伴学拾遗」（次日复习），并同步写入 questions.json。')
          : ui('已加入「伴学拾遗」题组（排入次日复习），可继续往下看课。'),
        tone: 'success',
      });
    } catch (err) {
      notify({ text: errorMessage(err), tone: 'error' });
    } finally {
      setSavingCard(false);
    }
  }, [call, cardDraft, companionId, courseName, language, notify, question, refresh, refreshFeedbackLedger, slideCtx, syncFeedback, undoable]);

  const handleSendMainChat = useCallback(() => {
    const ctxLines = [
      slideCtx.slideTitle
        ? uiFormat('第 {0}/{1} 页：{2}', [slideCtx.slide, slideCtx.slideTotal, slideCtx.slideTitle])
        : uiFormat('第 {0}/{1} 页', [slideCtx.slide, slideCtx.slideTotal]),
      slideCtx.teacherLine ? uiFormat('讲师旁白：{0}', [slideCtx.teacherLine]) : '',
      slideCtx.codeSlice ? `\n${slideCtx.codeSlice}` : '',
    ].filter(Boolean).join('\n');
    send('companion.ask', {
      companionId,
      course: courseName,
      title: state.companion?.title || '',
      slide: slideCtx.slide,
      slideTitle: slideCtx.slideTitle,
      quote: slideCtx.quote,
      contextText: ctxLines,
      question: question.trim() || slideCtx.quote || ui('请结合这一页帮我拆解底层机制与易混边界。'),
    });
  }, [companionId, courseName, question, send, slideCtx, state.companion?.title]);

  const practicePrereqCard = useCallback(async cardRef => {
    try {
      const run = await call('review.start', { mode: 'path', fresh: true, scope: [{ deckId: cardRef.deckId, cardId: cardRef.cardId }] });
      onClose();
      app?.session?.enterRun?.(run);
    } catch (err) {
      notify({ text: errorMessage(err), tone: 'error' });
    }
  }, [app?.session, call, notify, onClose]);

  const copyPath = useCopyFeedback(() => state.file || '');
  const openExternal = typeof host?.openFile === 'function' && state.file ? () => host.openFile(state.file) : null;
  const handleExportHtml = useCallback(() => {
    if (!state?.html || typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const rawBase = String(
      state.companion?.lessonId
      || state.lesson?.id
      || state.companion?.title
      || companionId
      || 'companion-lesson',
    ).trim();
    const printable = Array.from(rawBase).filter(ch => ch.charCodeAt(0) >= 32).join('');
    const safeBase = printable
      .replace(/[<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^\.+|-+$/g, '')
      .replace(/\.html?$/i, '')
      .slice(0, 80) || 'companion-lesson';
    const blob = new Blob([state.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeBase}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [companionId, state?.companion?.lessonId, state?.companion?.title, state?.html, state?.lesson?.id]);
  const totalSlides = Math.max(1, Number(slideCtx.slideTotal) || 1);
  const slideOptions = Array.from({ length: totalSlides }, (_, idx) => {
    const num = idx + 1;
    return {
      value: num,
      label: uiFormat('第 {0} / {1} 页', [num, totalSlides]),
    };
  });

  return (
    <Dialog
      size="full"
      className={expanded ? 'sh-comp-dialog--expanded' : undefined}
      title={state.companion?.title || modal?.title || ui('交互伴学页')}
      description={state.companion?.grounded === false
        ? ui('AI 推演伴学页（隔离沙箱运行，未绑定原讲义）')
        : ui('隔离沙箱交互伴学舞台 · 划选文字或点右上角可随时查前置、问导师、存防混卡')}
      onClose={onClose}
      footer={state.status === 'ready' && (
        <div className="sh-comp-foot">
          <div className="sh-comp-foot__actions">
            <div className="sh-comp-foot__nav" role="group" aria-label={ui('快速跳转伴学页')}>
              <IconButton
                size="sm"
                variant="secondary"
                icon="arrow-left"
                label={ui('上一张伴学页')}
                disabled={slideCtx.slide <= 1}
                onClick={() => jumpToSlide(slideCtx.slide - 1)}
              />
              {totalSlides > 1 ? (
                <Select
                  className="sh-comp-foot__select"
                  aria-label={ui('快速跳转伴学页')}
                  value={slideCtx.slide}
                  options={slideOptions}
                  onChange={val => jumpToSlide(Number(val))}
                />
              ) : (
                <Badge tone="neutral">{uiFormat('第 {0} / {1} 页', [slideCtx.slide, totalSlides])}</Badge>
              )}
              <IconButton
                size="sm"
                variant="secondary"
                icon="arrow-right"
                label={ui('下一张伴学页')}
                disabled={slideCtx.slide >= totalSlides}
                onClick={() => jumpToSlide(slideCtx.slide + 1)}
              />
            </div>
            {state.changedOnDisk && (
              <>
                <Badge tone="warning">{ui('磁盘文件已更新，已加载最新版')}</Badge>
                <Button size="sm" variant="secondary" icon="sync" busy={syncingDisk} onClick={handleSyncDisk}>
                  {ui('同步讲义与题卡')}
                </Button>
              </>
            )}
          </div>
          <div className="sh-comp-foot__actions sh-comp-bar__actions">
            <IconButton
              size="sm"
              variant="secondary"
              icon="download"
              disabled={!state?.html}
              label={ui('导出 HTML')}
              onClick={handleExportHtml}
            />
            <IconButton
              size="sm"
              variant={expanded ? 'primary' : 'secondary'}
              icon="fit"
              aria-pressed={expanded}
              label={expanded ? ui('退出铺满视图') : ui('铺满伴学舞台')}
              onClick={() => setExpanded(v => !v)}
            />
            <Button size="sm" variant={drawerOpen ? 'primary' : 'secondary'} onClick={() => setDrawerOpen(v => !v)}>
              {drawerOpen ? ui('收起解惑栏') : ui('查前置 / 记疑问')}
            </Button>
            {state.file && (
              <Button size="sm" variant="quiet" onClick={copyPath.copy}>
                {copyPath.copied ? ui('已复制路径') : ui('复制文件路径')}
              </Button>
            )}
            {openExternal && <Button size="sm" variant="quiet" onClick={openExternal}>{ui('在外部浏览器打开')}</Button>}
          </div>
        </div>
      )}
    >
      {state.status === 'loading' && <LoadingState label={ui('正在打开交互伴学页…')} />}
      {state.status === 'failed' && (
        <InlineMessage tone="error" boxed action={{ label: ui('重试'), onClick: () => setAttempt(n => n + 1) }}>
          {state.text}
        </InlineMessage>
      )}
      {state.status === 'ready' && (
        <div className={`sh-comp-viewer${drawerOpen ? ' sh-comp-viewer--split' : ''}${expanded ? ' sh-comp-viewer--expanded' : ''}`}>
          <div className="sh-comp-viewer__stage">
            <DiagramFrame
              frameRef={frameRef}
              className="sh-comp-viewer__frame"
              html={state.html}
              title={state.companion?.title || ui('交互伴学页')}
              companion={state.bootConfig}
            />
          </div>
          {drawerOpen && (
            <aside className="sh-comp-drawer" aria-label={ui('伴学解惑栏')}>
              <div className="sh-comp-drawer__head">
                <h4 className="sh-comp-drawer__title">{ui('伴学解惑与防混拾遗')}</h4>
                <span className="sh-comp-drawer__loc">{uiFormat('第 {0} 页', [slideCtx.slide])}</span>
              </div>

              {slideCtx.quote && (
                <blockquote className="sh-comp-drawer__quote">{slideCtx.quote}</blockquote>
              )}

              {hasLinkedFeedback && (
                <section className="sh-comp-drawer__section">
                  <Disclosure
                    open={ledgerOpen}
                    onToggle={setLedgerOpen}
                    summary={ui('伴学疑问清单（questions.json）')}
                    meta={<Badge size="sm" tone={openFeedbackItems.length > 0 ? 'warning' : 'neutral'}>{openFeedbackItems.length}</Badge>}
                  >
                    <div className="sh-comp-ledger">
                      <div className="sh-comp-ledger__bar">
                        <span className="sh-comp-drawer__loc">
                          {uiFormat('待解决 {0} 条 · 共 {1} 条', [openFeedbackItems.length, Math.max(openFeedbackItems.length, feedbackState.total)])}
                        </span>
                        <Button size="sm" variant="quiet" icon="sync" busy={feedbackState.loading} onClick={refreshFeedbackLedger}>
                          {ui('刷新疑问清单')}
                        </Button>
                      </div>
                      {feedbackState.error && <InlineMessage tone="error">{feedbackState.error}</InlineMessage>}
                      {!feedbackState.loading && openFeedbackItems.length === 0 && !feedbackState.error && (
                        <p className="sh-comp-ledger__empty">{ui('当前暂无待解决的伴学疑问。')}</p>
                      )}
                      {openFeedbackItems.length > 0 && (
                        <ul className="sh-comp-terms">
                          {openFeedbackItems.map(item => (
                            <li key={item.id} className="sh-comp-terms__item sh-comp-ledger__item">
                              <div className="sh-comp-ledger__meta">
                                <Badge size="sm" tone={item.tag === 'errata' ? 'warning' : 'info'}>{feedbackTagLabel(item.tag)}</Badge>
                                {item.slideTitle && <span className="sh-comp-drawer__loc">{item.slideTitle}</span>}
                              </div>
                              {item.note && <div className="sh-comp-ledger__note">{item.note}</div>}
                              {item.quote && <blockquote className="sh-comp-drawer__quote">{item.quote}</blockquote>}
                              <div className="sh-comp-foot__actions">
                                <Button size="sm" variant="secondary" icon="arrow-right" onClick={() => jumpToSlide(item.slide)}>
                                  {uiFormat('跳至第 {0} 页', [item.slide])}
                                </Button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </Disclosure>
                </section>
              )}

              {(matchedTerms.length > 0 || matchedPrereqCards.length > 0) && (
                <section className="sh-comp-drawer__section">
                  <h5 className="sh-comp-drawer__sub">{ui('本课术语与前置速查（零消耗）')}</h5>
                  <ul className="sh-comp-terms">
                    {matchedTerms.map(([term, def]) => (
                      <li key={term} className="sh-comp-terms__item">
                        <strong className="sh-comp-terms__term">{term}</strong>
                        <span>{def}</span>
                      </li>
                    ))}
                    {matchedPrereqCards.map(card => (
                      <li key={card.cardId} className="sh-comp-terms__item">
                        <strong className="sh-comp-terms__term">{card.topic || card.deckTitle}</strong>
                        <div>{card.prompt}</div>
                        <Button size="sm" variant="link" onClick={() => practicePrereqCard(card)}>{ui('闪回练一下这道题')}</Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="sh-comp-drawer__section">
                <h5 className="sh-comp-drawer__sub">{ui('就当前页秒问导师')}</h5>
                <TextArea
                  ref={questionRef}
                  rows={3}
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  placeholder={ui('写下你在这页卡壳或混淆的地方（例如：putIfAbsent 和 computeIfAbsent 到底差在哪？）')}
                />
                <div className="sh-comp-foot__actions">
                  <Button size="sm" variant="primary" busy={asking} onClick={handleAskTutor}>{ui('当场讲透')}</Button>
                  <Button size="sm" variant="secondary" onClick={handleSendMainChat}>{ui('发给主会话深挖')}</Button>
                </div>
                {askError && <InlineMessage tone="error">{askError}</InlineMessage>}
                {tutorReply && (
                  <div className="sh-comp-answer">
                    <Markdown text={tutorReply} />
                  </div>
                )}
              </section>

              {(cardDraft.prompt || tutorReply) && (
                <section className="sh-comp-drawer__section">
                  <h5 className="sh-comp-drawer__sub">{ui('一键存为防混闪卡（次日复习，不打断看课）')}</h5>
                  <div className="sh-comp-catchup">
                    <Field label={ui('问题')}>
                      <TextInput value={cardDraft.prompt} onChange={e => setCardDraft(d => ({ ...d, prompt: e.target.value }))} />
                    </Field>
                    <Field label={ui('解答')}>
                      <TextArea rows={3} value={cardDraft.answer} onChange={e => setCardDraft(d => ({ ...d, answer: e.target.value }))} />
                    </Field>
                    {hasLinkedFeedback && (
                      <Checkbox
                        checked={syncFeedback}
                        onChange={setSyncFeedback}
                        label={ui('同时记入伴学目录 feedback/questions.json（待改进讲义）')}
                      />
                    )}
                    <Button size="sm" variant="primary" busy={savingCard} onClick={handleSaveCatchup}>
                      {ui('存入「伴学拾遗」')}
                    </Button>
                  </div>
                </section>
              )}
            </aside>
          )}
        </div>
      )}
    </Dialog>
  );
}
