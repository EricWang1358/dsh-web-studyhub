import React, { useMemo, useState } from 'react';
import { errorMessage, ui, uiFormat, useUiLanguage } from './i18n.js';
import { useStudy } from './study-context.jsx';
import { useInjectCss } from './shared.js';
import { useLiveEffect } from './use-async.js';
import { useHandOff } from './hand-off/use-hand-off.js';
import { downloadVoicePackMarkdown } from './voice-pack-download.js';
import { Badge, Button, Chip, Dialog, Field, Icon, InlineMessage, SegmentedControl, Spinner, TextInput, useToast } from './components/index.js';
import css from './voice-pack.css';

const MODE_OPTIONS = [
  { value: 'cram', label: '速成优先' },
  { value: 'weak', label: '只看薄弱' },
  { value: 'new', label: '只看新题' },
  { value: 'focus', label: '只看重点' },
  { value: 'due', label: '到期复习' },
];

const LIMIT_PRESETS = [10, 20, 30, 50];
const MINUTE_PRESETS = [15, 30, 45];

/** Configure, preview, copy or download an anti-drift voice study pack, and hand transcripts back to the Head Coach. */
export default function VoicePackDialog({ modal, onClose }) {
  useInjectCss(css, 'study-voice-pack');
  const { call } = useStudy();
  const toast = useToast();
  const handOff = useHandOff();
  const language = useUiLanguage();

  const [only, setOnly] = useState(modal?.only || 'cram');
  const [limit, setLimit] = useState(modal?.limit || 20);
  const [minutes, setMinutes] = useState(modal?.minutes || 30);
  const [banter, setBanter] = useState(modal?.banter || 'light');
  const [goal, setGoal] = useState(modal?.goal || '');
  const [pack, setPack] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const scopeArgs = useMemo(() => ({
    ...(Array.isArray(modal?.scope) && modal.scope.length ? { scope: modal.scope } : {}),
    ...(modal?.deckId ? { deckId: modal.deckId } : {}),
    ...(modal?.course && !modal?.deckId && !modal?.scope?.length ? { course: modal.course } : {}),
    ...(modal?.topic ? { topic: modal.topic } : {}),
  }), [modal?.course, modal?.deckId, modal?.scope, modal?.topic]);

  useLiveEffect((isLive) => {
    setLoading(true);
    setError('');
    setCopied(false);
    const timer = setTimeout(() => {
      Promise.resolve(call('study.voicePack', {
        ...scopeArgs,
        only,
        limit,
        minutes,
        banter,
        ...(goal.trim() ? { goal: goal.trim() } : {}),
        language,
      }))
        .then((res) => {
          if (!isLive()) return;
          setPack(res || null);
          setLoading(false);
        })
        .catch((err) => {
          if (!isLive()) return;
          setPack(null);
          setError(errorMessage(err) || ui('导出语音带学包失败，请重试。'));
          setLoading(false);
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [call, scopeArgs, only, limit, minutes, banter, goal, language]);

  const scopeTitle = modal?.deckTitle
    ? uiFormat('题组：{0}', [modal.deckTitle])
    : modal?.scope?.length
      ? uiFormat('已选 {0} 项范围', [modal.scope.length])
      : modal?.course
        ? uiFormat('课程：{0}', [modal.course])
        : ui('全部学习库');

  const canExport = !loading && !!pack?.count && !!pack?.markdown;

  const handleCopy = async () => {
    if (!canExport) return;
    try {
      await navigator.clipboard.writeText(pack.markdown);
      setCopied(true);
      toast?.success?.(uiFormat('已复制语音带学提示词（{0} 题），直接粘贴给 Gemini / 豆包即可开始。', [pack.count]));
    } catch {
      downloadVoicePackMarkdown(pack);
      toast?.info?.(ui('浏览器未允许写入剪贴板，已改为下载 .md 文件。'));
    }
  };

  const handleDownload = () => {
    if (!canExport) return;
    downloadVoicePackMarkdown(pack);
    const mastery = pack.progress?.mastery;
    toast?.success?.(
      Number.isFinite(mastery)
        ? uiFormat('已下载语音带学包（当前掌握度 {1}% · {0} 题），发给外部语音 AI 学完后把记录回传主教练即可结算。', [pack.count, mastery])
        : uiFormat('已下载语音带学包（{0} 题），可直接发给外部语音 AI。', [pack.count]),
    );
  };

  const handleDebrief = () => {
    onClose?.();
    handOff.send('coach.debrief', {
      course: modal?.course || pack?.course || '',
      deckTitle: modal?.deckTitle || '',
    });
  };

  const progress = pack?.progress;
  const counts = progress?.counts;

  const footer = (
    <div className="vp-footer">
      <Button variant="quiet" size="sm" icon="external" onClick={handleDebrief}>
        {ui('回传语音记录给主教练结算')}
      </Button>
      <div className="vp-footer__right">
        <Button variant="secondary" icon="download" disabled={!canExport} onClick={handleDownload}>
          {ui('下载 .md 文件')}
        </Button>
        <Button variant="primary" icon={copied ? 'check' : 'copy'} disabled={!canExport} onClick={handleCopy}>
          {copied ? ui('已复制提示词') : ui('一键复制提示词')}
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog
      size="md"
      onClose={onClose}
      title={ui('语音带学包')}
      description={scopeTitle}
      footer={footer}
    >
      <div className="vp-shell">
        <div className="vp-steps">
          <div className="vp-step">
            <span className="vp-step__title">{ui('① 复制或下载给外部语音 AI')}</span>
            <span className="vp-step__desc">{ui('自动打包当前进度快照、防跑偏心跳协议与精简题单，直接发给 Gemini / ChatGPT / 豆包闭眼聊。')}</span>
          </div>
          <div className="vp-step">
            <span className="vp-step__title">{ui('② 聊完回传主教练 + 4 助教结算')}</span>
            <span className="vp-step__desc">{ui('自动预填大白话 QA、理顺前置顺序、查漏补题、同步 FSRS 掌握度，并排 5–12 道验收题。')}</span>
          </div>
        </div>

        <div className="vp-summary" aria-live="polite">
          {loading && !pack ? (
            <div className="vp-summary__top">
              <Spinner size="sm" />
              <span className="vp-summary__label">{ui('正在生成进度快照与题单…')}</span>
            </div>
          ) : progress ? (
            <>
              <div className="vp-summary__top">
                <div className="vp-summary__mastery">
                  <span className="vp-summary__pct">{progress.mastery}%</span>
                  <span className="vp-summary__label">{ui('当前范围掌握度')}</span>
                </div>
                <span className="vp-summary__count">
                  {uiFormat('本次导出 {0} / {1} 题', [pack.count, pack.totalAvailable])}
                </span>
              </div>
              {counts && (
                <div className="vp-summary__stats">
                  <Badge size="sm" tone="error">{uiFormat('薄弱 {0}', [counts.weak])}</Badge>
                  <Badge size="sm">{uiFormat('未做 {0}', [counts.new])}</Badge>
                  <Badge size="sm" tone="warning">{uiFormat('学习中 {0}', [counts.learning])}</Badge>
                  <Badge size="sm" tone="info">{uiFormat('熟悉 {0}', [counts.familiar])}</Badge>
                  <Badge size="sm" tone="success">{uiFormat('已掌握 {0}', [counts.mastered])}</Badge>
                  {progress.due > 0 && <Badge size="sm" tone="warning">{uiFormat('到期 {0}', [progress.due])}</Badge>}
                </div>
              )}
              {(progress.exam?.date || progress.focusTopics?.length > 0) && (
                <div className="vp-summary__meta">
                  {[
                    progress.exam?.date ? uiFormat('考试日 {0}', [progress.exam.date]) : '',
                    progress.focusTopics?.length ? uiFormat('课程重点 {0} 条', [progress.focusTopics.length]) : '',
                  ].filter(Boolean).join(' · ')}
                </div>
              )}
            </>
          ) : null}
        </div>

        {error && <InlineMessage tone="error" role="alert">{error}</InlineMessage>}
        {!loading && !error && pack && pack.count === 0 && (
          <InlineMessage tone="info">{ui('当前筛选下没有可导出的题目，请切换抽题策略。')}</InlineMessage>
        )}

        <div className="vp-controls">
          <Field label={ui('抽题策略')}>
            <div className="vp-chip-row">
              {MODE_OPTIONS.map((opt) => (
                <Chip key={opt.value} selected={only === opt.value} onClick={() => setOnly(opt.value)}>
                  {ui(opt.label)}
                </Chip>
              ))}
            </div>
          </Field>

          <div className="vp-split-row">
            <Field label={ui('本次题数')}>
              <div className="vp-chip-row">
                {LIMIT_PRESETS.map((n) => (
                  <Chip key={n} selected={limit === n} onClick={() => setLimit(n)}>
                    {uiFormat('{0} 题', [n])}
                  </Chip>
                ))}
              </div>
            </Field>
            <Field label={ui('时间预算')}>
              <div className="vp-chip-row">
                {MINUTE_PRESETS.map((m) => (
                  <Chip key={m} selected={minutes === m} onClick={() => setMinutes(m)}>
                    {uiFormat('{0} 分钟', [m])}
                  </Chip>
                ))}
              </div>
            </Field>
          </div>

          <Field label={ui('防跑偏互动节奏')} hint={ui('内置每轮 [进度 k/N] 心跳锚点 + 单题 3 轮熔断，避免闲聊忘掉清单。')}>
            <SegmentedControl
              value={banter}
              onChange={setBanter}
              options={[
                { value: 'light', label: ui('轻度闲聊 + 强拉回（推荐）') },
                { value: 'strict', label: ui('纯硬核零跑题') },
              ]}
            />
          </Field>

          <Field label={ui('本次速成目标（可选）')}>
            <TextInput
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder={ui('例如：3 周速成 React 面试，今天先过核心机制')}
            />
          </Field>
        </div>

        <div className="vp-guardrails">
          <span className="vp-guardrail"><Icon name="check" className="sh-icon--inline" />{ui('每轮带 [进度 k/N · 本题第 t/3 轮] 心跳')}</span>
          <span className="vp-guardrail"><Icon name="check" className="sh-icon--inline" />{ui('单题最多 3 轮自动熔断推进')}</span>
          <span className="vp-guardrail"><Icon name="check" className="sh-icon--inline" />{ui('支持口令：跳过 / 快进模式 / 今天先到这，给我结算')}</span>
        </div>

        {pack?.cards?.length > 0 && (
          <details className="vp-preview">
            <summary className="vp-preview__summary">
              {uiFormat('预览已抽出的前 {0} 题（共 {1} 题）', [Math.min(6, pack.cards.length), pack.cards.length])}
            </summary>
            <ul className="vp-preview__list">
              {pack.cards.slice(0, 6).map((card, index) => (
                <li key={card.cardId} className="vp-preview__item">
                  <span className="vp-preview__topic">{index + 1}. {card.topic}</span>
                  <span className="vp-preview__stem">{card.prompt}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Dialog>
  );
}
