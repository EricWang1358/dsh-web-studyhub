import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ui, uiFormat, getUiLanguage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { IconButton } from './components/index.js';
import css from './library-usage.css';

const MB = 1024 ** 2;
const SHORT = {
  materials: (size) => uiFormat('资料 {0}', [size]), audio: (size) => uiFormat('音频 {0}', [size]),
  bank: (size) => uiFormat('题库 {0}', [size]), backups: (size) => uiFormat('备份 {0}', [size]), other: (size) => uiFormat('其他 {0}', [size]),
};
const FULL = { materials: '资料原文与提取文字', audio: '音频与转写', bank: '题库与复习记录', backups: '备份', other: '其他' };

/** "1.2 GB", "820 MB", "12 KB": B/KB/MB/GB, one decimal below 100, none above. */
export function formatUsageBytes(bytes, language = getUiLanguage()) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.max(0, Number(bytes) || 0), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(language === 'en' ? 'en' : 'zh-CN', { maximumFractionDigits: digits, useGrouping: false }).format(value);
  return `${number} ${units[unit]}`;
}

/** The one-line summary: the total, then each part that holds something. */
export function usageSummary(usage) {
  const parts = (usage.parts || []).filter((part) => part.bytes > 0);
  const total = formatUsageBytes(usage.total);
  const head = usage.partial ? uiFormat('占用至少 {0}（目录很大，只统计了一部分）', [total]) : uiFormat('占用 {0}', [total]);
  const details = parts.map((part) => (SHORT[part.id] || ((size) => `${ui(part.label || part.id)} ${size}`))(formatUsageBytes(part.bytes)));
  return { text: [head, ...details].join(' · '), parts };
}

/** Old backups are worth a word when they are most of the folder or simply very large. */
export function shouldHintBackups(usage) {
  const backups = (usage.parts || []).find((part) => part.id === 'backups')?.bytes || 0;
  return backups > 500 * MB || (backups > 50 * MB && usage.total > 0 && backups / usage.total > 0.3);
}

/**
 * The disk-use line under the library path. `state`: { status: 'idle'|'loading'|'ready'|'error', usage?, refreshing? }.
 * Loading and ready share one container, so the card does not change height;
 * a failed count shows nothing (it is a convenience, not a gate).
 */
export function LibraryUsageView({ state, onRefresh }) {
  useInjectCss(css, 'study-library-usage');
  if (state.status === 'loading') return <div className="usage-line">
    <small role="status" aria-live="polite" className="usage-text">{ui('占用空间计算中…')}</small>
  </div>;
  if (state.status !== 'ready' || !state.usage) return null;
  const { usage } = state, { text, parts } = usageSummary(usage);
  const total = usage.total || 1;
  const shares = parts.map((part) => `${ui(FULL[part.id] || part.label || part.id)} ${Math.max(1, Math.round((part.bytes / total) * 100))}%`).join(' · ');
  return <>
    <div className="usage-line">
      <small className="usage-text">{text}</small>
      <span className="usage-bar" role="img" aria-label={`${ui('占用比例')}：${shares}`}>
        {parts.map((part) => <span key={part.id} className={`usage-seg usage-seg--${part.id}`} style={{ flexGrow: Math.max(1, Math.round(part.bytes)) }} title={`${ui(FULL[part.id] || part.label)} · ${formatUsageBytes(part.bytes)}`} />)}
      </span>
      <IconButton icon="refresh" size="sm" variant="quiet" label={ui('重新计算')} busy={!!state.refreshing} onClick={onRefresh} />
    </div>
    {shouldHintBackups(usage) && <small className="usage-hint">{uiFormat('旧备份可以手动删除：{0}（程序不会自动删除）', [usage.paths?.backups || 'backups'])}</small>}
  </>;
}

/**
 * Counts the library in the background once it is on screen (`active`), never
 * at app start. `call(action, args)` is the panel's host call; the walk itself
 * runs on the host, so the panel stays responsive however large the library.
 */
export default function LibraryUsage({ root, call, active = true }) {
  const [state, setState] = useState({ status: 'idle' });
  const callRef = useRef(call);
  callRef.current = call;
  const live = useRef(0);
  const measure = useCallback((force) => {
    const turn = ++live.current;
    setState((current) => current.usage ? { ...current, refreshing: true } : { status: 'loading' });
    callRef.current('library.usage', force ? { force: true } : {}).then(
      (usage) => { if (turn === live.current) setState({ status: 'ready', usage }); },
      () => { if (turn === live.current) setState({ status: 'error' }); },
    );
  }, []);
  useEffect(() => {
    if (!active || !root) { live.current++; return undefined; }
    setState({ status: 'idle' });
    measure(false);
    return () => { live.current++; };
  }, [active, root, measure]);
  return <LibraryUsageView state={state} onRefresh={() => measure(true)} />;
}
