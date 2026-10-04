import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getUiLanguage, ui, uiFormat } from './i18n.js';
import { Button, ConfirmDialog, Hint, InlineMessage, SegmentedControl, SettingsSection, Switch, useToast } from './components/index.js';
import { useInjectCss } from './shared.js';
import { USAGE_AREAS, USAGE_GROUPS, usageArea } from './usage/registry.js';
import { displayName } from './usage/names.js';
import { flushUsageNow, notifyUsageChanged } from './usage/controller.js';
import css from './usage.css';

/* 设置 › 高级 › 使用频率记录 and 我的使用报告 (lib/usage-frequency.js, lib/usage-report.js; docs/usage-frequency.md).

   The privacy contract is on the screen before the switch. Five states, each in plain words: off with nothing recorded; on with nothing yet;
   on with data; paused; off with data from before. The report is folded until the record holds data. Every bar has its numbers as text.
   The whole section is marked `data-usage-ignore`: using it is never counted. */

/** The promises, in the order they are made. Also read by the docs test. */
export const usagePrivacyPoints = () => [
  ui('只记录你用了哪些控件、各用了多少次（按天累计）。'),
  ui('不记录你输入、阅读或回答的任何内容，也不记录任何文件、课程或资料的名字。'),
  ui('只保存在这台电脑上，不在学习库里（备份和导出学习库都不带它）；StudyHub 不会把它发送到任何地方。'),
  ui('你可以随时查看、导出、暂停和删除。'),
];

const ROLES = {
  button: ['按钮', 'a button'], link: ['链接', 'a link'], disclosure: ['展开项', 'a disclosure'], tab: ['标签页', 'a tab'], checkbox: ['复选框', 'a checkbox'], radio: ['单选框', 'a radio button'],
  select: ['下拉框', 'a dropdown'], switch: ['开关', 'a switch'], menuitem: ['菜单项', 'a menu item'], input: ['输入控件', 'an input'], file: ['文件选择', 'a file chooser'], range: ['滑块', 'a slider'],
  combobox: ['组合框', 'a combo box'], option: ['选项', 'an option'], treeitem: ['树节点', 'a tree item'], slider: ['滑块', 'a slider'], spinbutton: ['数字框', 'a number box'],
};
const BARE = /^(tour|testid|id)\./;

/**
 * A readable name for one row of the report. Registered controls come named by the backend; an unregistered one is a derived key
 * (`page/role/name`), named here from the app's own copy in the language of the page; nothing else can be in it.
 */
export function usageRowName(row, language = getUiLanguage()) {
  if (row.name) return row.name;
  const en = language === 'en';
  if (row.key === 'other') return en ? 'Everything else (folded together)' : '其他控件（合并计数）';
  if (BARE.test(row.key)) return row.key;
  const [area, role, ...rest] = row.key.split('/');
  if (!USAGE_AREAS.some(item => item.id === area) || !ROLES[role]) return row.key;
  const where = usageArea(area)[en ? 'en' : 'zh'], [zh, english] = ROLES[role], canon = rest.join('/');
  if (!canon) return en ? `${where} · ${english} without a name` : `${where} · 一个没有名字的${zh}`;
  return `${where} · ${en ? english.replace(/^an? /, '') : zh} · ${displayName(canon, en ? 'en' : 'zh')}`;
}

const pct = share => `${(Math.round(share * 1000) / 10).toFixed(1)}%`;
const PERIODS = [[7, '最近 7 天'], [30, '最近 30 天'], ['all', '全部时间']];

function Bar({ share, max }) {
  const width = max > 0 ? Math.max(2, Math.round((share / max) * 100)) : 0;
  return <span className="usage-meter" aria-hidden="true" style={{ width: `${width}%` }} />;
}

function ShareList({ title, note, rows, nameOf }) {
  const max = Math.max(0, ...rows.map(row => row.share));
  return (
    <section className="usage-block">
      <h4 className="settings-subtitle">{title}</h4>
      <Hint>{note}</Hint>
      {rows.length === 0 ? <Hint>{ui('这段时间没有记录。')}</Hint>
        : <ul className="usage-shares">{rows.map(row => <li key={row.area || row.tier} className="usage-share__row">
          <span className="usage-share__name">{nameOf(row)}</span><span className="usage-share__num">{row.count} · {pct(row.share)}</span><Bar share={row.share} max={max} />
        </li>)}</ul>}
    </section>
  );
}

function Rhythm({ rhythm, period }) {
  const peak = rhythm.reduce((best, day) => (day.n > best.n ? day : best), { day: '', n: 0 }), top = Math.max(1, peak.n);
  return (
    <section className="usage-block">
      <h4 className="settings-subtitle">{ui('每天的节奏')}</h4>
      <ol className="usage-rhythm" aria-label={uiFormat('每天的互动次数（{0}）', [ui(PERIODS.find(([value]) => value === period)?.[1] || '')])}>
        {rhythm.map(day => <li key={day.day} className="usage-rhythm__day" title={`${day.day}: ${day.n}`}>
          <span className="usage-rhythm__bar" aria-hidden="true" style={{ height: `${day.n > 0 ? Math.max(6, Math.round((day.n / top) * 100)) : 0}%` }} />
          <span className="usage-sr">{`${day.day}: ${day.n}`}</span>
        </li>)}
      </ol>
      <Hint>{peak.n > 0 ? uiFormat('最忙的一天：{0}（{1} 次）', [peak.day, peak.n]) : ui('这段时间没有记录。')}</Hint>
    </section>
  );
}

/** The report as it is shown. `report` is usage.frequency.report (names for registered controls come with it). */
export function UsageReportView({ report, period, onPeriod, language = getUiLanguage() }) {
  const max = Math.max(0, ...report.ranking.map(row => row.share));
  const never = {};
  for (const row of report.neverUsed) (never[row.group] ||= []).push(row);
  return (
    <div className="usage-report__body">
      <SegmentedControl size="sm" label={ui('时间范围')} value={period} onChange={onPeriod} options={PERIODS.map(([value, label]) => ({ value, label: ui(label) }))} />
      <dl className="usage-summary">
        <div><dt>{ui('有记录的天数')}</dt><dd>{report.summary.daysWithData}</dd></div>
        <div><dt>{ui('互动次数')}</dt><dd>{report.summary.interactions}</dd></div>
        <div><dt>{ui('用过的控件')}</dt><dd>{report.summary.distinctControls}</dd></div>
      </dl>
      <section className="usage-block">
        <h4 className="settings-subtitle">{ui('最常用的控件')}</h4>
        {report.ranking.length === 0 ? <Hint>{ui('这段时间没有记录。')}</Hint>
          : <ol className="usage-rank">{report.ranking.map(row => <li key={row.key} className="usage-rank__row">
            <span className="usage-rank__name">{usageRowName(row, language)}</span>
            <span className="usage-rank__num">{row.count} · {pct(row.share)}</span>
            <Bar share={row.share} max={max} />
          </li>)}</ol>}
      </section>
      <div className="usage-pair">
        <ShareList title={ui('按页面')} note={ui('用到这些控件时，你正在哪个页面。')} rows={report.byArea} nameOf={row => row.name} />
        <ShareList title={ui('按使用时机')} note={ui('按每个控件本来在什么时候用来归类：每天、阶段性、一次性。')} rows={report.byTier.filter(row => row.count > 0 || row.tier !== 'other')} nameOf={row => row.name} />
      </div>
      <Rhythm rhythm={report.rhythm} period={period} />
      <details className="usage-never">
        <summary>{uiFormat('从没用过的功能（{0}）', [report.neverUsed.length])}</summary>
        <Hint>{ui('这些功能在记录期间一次都没被用过：可能你不需要，也可能你不知道它在那里。')}</Hint>
        {Object.entries(never).map(([group, rows]) => <p key={group} className="usage-never__group"><strong>{USAGE_GROUPS[group]?.[language === 'en' ? 'en' : 'zh'] || group}</strong>
          {`${language === 'en' ? ': ' : '：'}${rows.map(row => row.name).join(language === 'en' ? ', ' : '、')}`}</p>)}
      </details>
      <section className="usage-block usage-hints">
        <h4 className="settings-subtitle">{ui('小提示')}</h4>
        <Hint>{ui('这些只是提示，每一条都可以不管。')}</Hint>
        <ul className="usage-hints__list">{report.observations.map(item => <li key={`${item.id}-${item.key || ''}`}><span className="usage-chip">{ui('可选')}</span><span>{item.text}</span></li>)}</ul>
      </section>
    </div>
  );
}

const stateOf = status => {
  if (status.enabled && status.paused) return 'paused';
  if (status.enabled) return status.hasData ? 'on' : 'empty';
  return status.hasData ? 'off-data' : 'off';
};

/** The section, from what the host said. Pure: every action is a callback. */
export function UsageSettingsView({ status, report, period, busy = false, working = '', error = '', confirming = false,
  onSwitch, onPause, onPeriod, onReportToggle, onExport, onCopy, onAskClear, onCancelClear, onClear }) {
  const language = getUiLanguage();
  const state = stateOf(status);
  const line = {
    off: ui('已关闭：什么都没有记录。'),
    empty: ui('正在记录。还没有记录：照常使用 StudyHub，过一两天再来看。'),
    on: uiFormat('正在记录。已有 {0} 天的记录（从 {1} 起）。', [status.daysWithData, status.since || '—']),
    paused: ui('已暂停：继续记录之前，不会记任何东西。'),
    'off-data': ui('已关闭：不再记录。之前的记录还在，可以继续查看、导出或删除。'),
  }[state];
  return (
    <SettingsSection className="usage-settings" data-usage-ignore data-state={state} tour="settings-usage" title={ui('使用频率记录')}
      lead={ui('记下你用了哪些控件、各用了多少次，帮你看清自己的使用习惯。默认关闭，打开之前什么都不会记。')}>
      <ul className="usage-promises">{usagePrivacyPoints().map(point => <li key={point}>{point}</li>)}</ul>
      <Switch name="usage-frequency" label={ui('记录使用频率')} hint={ui('关掉后，已有的记录保留，可以继续查看、导出或删除。')}
        checked={!!status.enabled} disabled={busy || !!working} onChange={onSwitch} />
      <p className="usage-status" role="status">{line}</p>
      {error && <InlineMessage>{error}</InlineMessage>}
      {state !== 'off' && state !== 'off-data' && (
        <div className="settings-actions">
          <Button variant="secondary" size="sm" disabled={busy || !!working} onClick={onPause}>{status.paused ? ui('继续记录') : ui('暂停记录')}</Button>
        </div>
      )}
      {status.hasData && (
        <details className="usage-report" onToggle={event => onReportToggle?.(event.currentTarget.open)}>
          <summary className="usage-report__summary">{ui('我的使用报告')}</summary>
          {report ? <UsageReportView report={report} period={period} onPeriod={onPeriod} language={language} />
            : <Hint>{ui('正在整理报告…')}</Hint>}
          <div className="settings-actions usage-actions">
            <Button variant="secondary" size="sm" icon="download" disabled={busy || !!working} onClick={() => onExport?.('markdown')}>{ui('导出 Markdown')}</Button>
            <Button variant="secondary" size="sm" icon="download" disabled={busy || !!working} onClick={() => onExport?.('json')}>{ui('导出 JSON')}</Button>
            <Button variant="secondary" size="sm" disabled={busy || !!working} onClick={onCopy}>{ui('复制报告')}</Button>
            <Button variant="danger" size="sm" disabled={busy || !!working} onClick={onAskClear}>{ui('删除全部记录')}</Button>
          </div>
          <Hint className="usage-file">{uiFormat('记录文件：{0}', [status.file || 'usage-frequency.json'])}</Hint>
        </details>
      )}
      {confirming && <ConfirmDialog title={ui('删除全部使用记录？')} onClose={onCancelClear} onDone={onCancelClear}
        description={ui('将删除所有已记录的次数和日期。不影响学习库，也不改变记录开关。')}
        confirmLabel={ui('删除全部记录')} busy={working === 'clear'} blocked={!!working} onConfirm={onClear}>
        <Hint>{ui('之后可以重新开始记录；已经导出的文件不受影响。')}</Hint>
      </ConfirmDialog>}
    </SettingsSection>
  );
}

const EMPTY = { enabled: false, paused: false, hasData: false, daysWithData: 0, since: '', file: '', limits: {} };

function download(file) {
  const url = URL.createObjectURL(new Blob([file.content], { type: `${file.mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url; link.download = file.filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The container: reads the status once, loads the report only when the learner opens it, and turns the switch through the host. */
export default function UsageSettings({ call, busy = false, initial = null }) {
  useInjectCss(css, 'study-usage');
  const toast = useToast();
  const [status, setStatus] = useState(initial?.status || EMPTY);
  const [report, setReport] = useState(initial?.report || null);
  const [period, setPeriod] = useState(30);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(''), [error, setError] = useState(''), [confirming, setConfirming] = useState(false);
  const live = useRef(true), callRef = useRef(call);
  useEffect(() => { callRef.current = call; });
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const ask = useCallback((action, args) => Promise.resolve(callRef.current(action, args)), []);
  const failure = useCallback(reason => { if (live.current) setError(reason?.message || ui('没有完成，请再试一次。')); }, []);

  useEffect(() => {
    if (initial || typeof call !== 'function') return undefined;
    // What was counted since the last batch goes out first, so a record that is only seconds old already shows.
    flushUsageNow().then(() => ask('usage.frequency.status', {})).then(value => { if (live.current && value) setStatus(value); }, () => { /* an unreadable status reads as off */ });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const loadReport = useCallback(async (next) => {
    try {
      // The report includes what was counted in the last seconds: send it before asking.
      await flushUsageNow();
      const value = await ask('usage.frequency.report', { period: next, language: getUiLanguage() });
      if (live.current) { setReport(value); setError(''); }
    }
    catch (reason) { failure(reason); }
  }, [ask, failure]);
  useEffect(() => { if (open && status.hasData) void loadReport(period); }, [open, period, status.hasData, status.daysWithData, loadReport]);

  const change = async (action, args, label) => {
    setWorking(label); setError('');
    try {
      // What was counted in the last seconds goes out before the host stops accepting it.
      if (args.enabled === false || args.paused === true) await flushUsageNow();
      const next = await ask(action, args);
      if (live.current && next) setStatus(next);
      notifyUsageChanged();
    } catch (reason) { failure(reason); }
    finally { if (live.current) setWorking(''); }
  };
  const exportAs = async (format) => {
    setWorking('export'); setError('');
    try {
      await flushUsageNow();
      const labels = {};
      for (const row of report?.ranking || []) if (!row.name) labels[row.key] = usageRowName(row);
      const file = await ask('usage.frequency.export', { format, period, language: getUiLanguage(), labels });
      return file;
    } catch (reason) { failure(reason); return null; }
    finally { if (live.current) setWorking(''); }
  };
  return (
    <UsageSettingsView status={status} report={report} period={period} busy={busy} working={working} error={error} confirming={confirming}
      onSwitch={enabled => change('usage.frequency.set', { enabled }, 'switch')}
      onPause={() => change('usage.frequency.set', { paused: !status.paused }, 'pause')}
      onPeriod={setPeriod}
      onReportToggle={setOpen}
      onExport={async format => { const file = await exportAs(format); if (file) { download(file); toast.success(uiFormat('已导出 {0}', [file.filename])); } }}
      onCopy={async () => {
        const file = await exportAs('markdown');
        if (!file) return;
        try { await navigator.clipboard.writeText(file.content); toast.success(ui('报告已复制，可以粘贴到任何地方。')); }
        catch { setError(ui('这个窗口不允许复制；请改用「导出 Markdown」。')); }
      }}
      onAskClear={() => setConfirming(true)}
      onCancelClear={() => setConfirming(false)}
      onClear={async () => {
        // A failure is thrown to the confirmation, which shows it and lets the learner try again.
        setWorking('clear'); setError('');
        try {
          const next = await ask('usage.frequency.clear', {});
          if (live.current) { setStatus(next); setReport(null); setConfirming(false); toast.success(ui('已删除全部使用记录。')); }
          notifyUsageChanged();
        } finally { if (live.current) setWorking(''); }
      }} />
  );
}
