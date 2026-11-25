import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { useLiveEffect } from '../use-async.js';
import { Badge, Button, ConfirmDialog, Hint, Icon, InlineConfirm, InlineMessage, SettingsSection, formatBytes } from '../components/index.js';
import { backupFileName } from './backup-name.js';
import { useStudy } from '../study-context.jsx';
import { isActiveJob } from '../job-visibility.js';
import { uploadInChunks } from '../upload.js';

const CHUNKED_RESTORE_THRESHOLD = 16 * 1024 * 1024;

export { backupFileName };

/* ---------- 数据备份与恢复 ---------- */

const DEFAULT_RETENTION = Object.freeze({ daily: 7, weekly: 4 });

function parseLocalDayIndex(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const utc = Date.UTC(year, month - 1, date);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return Math.floor(utc / 86_400_000);
}

/** Human-friendly label for a `YYYY-MM-DD` restore point (`昨天 · 2026-11-16`, `前天 · ...`, or `YYYY-MM-DD`). */
export function formatRestorePointDate(date, now = Date.now()) {
  const target = parseLocalDayIndex(date);
  if (target === null) return String(date || '');
  const ref = now instanceof Date ? now : new Date(now);
  const today = Number.isFinite(ref.getTime())
    ? Math.floor(Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate()) / 86_400_000)
    : null;
  const diff = today !== null ? today - target : null;
  if (diff === 0) return `${ui('今天')} · ${date}`;
  if (diff === 1) return `${ui('昨天')} · ${date}`;
  if (diff === 2) return uiFormat('前天 · {0}', [date]);
  return date;
}

/** What a backup holds, counted client-side before anything is replaced. */
export function backupSummary(state = {}) {
  const decks = Array.isArray(state.decks) ? state.decks : [];
  return { courses: Array.isArray(state.courses) ? state.courses.length : 0, sources: state.sources?.length || 0, decks: decks.length,
    cards: decks.reduce((sum, deck) => sum + (Array.isArray(deck.cards) ? deck.cards.length : 0), 0), attempts: state.attempts?.length || 0 };
}

const isFullBackup = state => state && Number.isInteger(state.version) && Array.isArray(state.sources) && Array.isArray(state.decks) &&
  Array.isArray(state.drafts) && Array.isArray(state.runs) && Array.isArray(state.attempts);
const backupsFolder = root => root ? `${root.replace(/[\\/]+$/, '')}${root.includes('\\') ? '\\' : '/'}backups` : '';

/* The jobs of this library that keep a restore from running (ui/job-visibility.js `isActiveJob`, the panel's copy of the host's rule; the snapshot's jobs
   are this library's already). The host checks again when the restore arrives: this only tells the learner before they commit, it promises nothing. */
// One sentence for the one fact, in the block and in the confirmation.
const RUNNING_JOB = '学习库还有任务在运行，现在还不能恢复。先等任务结束，或到任务页把它停掉。';
export const restoreBlockers = (jobs = []) => (Array.isArray(jobs) ? jobs.filter(isActiveJob) : []);

/** The chosen backup: name, size and contents, with the destructive action. */
export function RestorePreview({ file, busy, blocked = false, onConfirm, onCancel }) {
  const count = backupSummary(file.state);
  return <div className="restore-preview" role="status">
    <div className="restore-preview__file"><Icon name="file" size={18} /><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div>
    <p>{[uiFormat('{0} 门课程', [count.courses]), uiFormat('{0} 份资料', [count.sources]),
      uiFormat('{0} 个题组（{1} 道题）', [count.decks, count.cards]), uiFormat('{0} 条作答记录', [count.attempts])].join(' · ')}</p>
    <div className="settings-actions">
      <Button variant="danger" lock={busy} disabled={blocked} onClick={onConfirm}>{ui('用此备份替换当前学习库')}</Button>
      <Button variant="quiet" lock={busy} onClick={onCancel}>{ui('换一个文件')}</Button>
    </div>
  </div>;
}

/** Export and restore as two blocks with the same shape: what it does, where the file goes, one action,
    plus automatic sharded-manifest restore points (`7 daily + 4 weekly`) below.
    `jobs` is the library snapshot's job list and `nav.show.task` opens one in 任务: together they tell the learner, before they commit, that a running
    job will stop the restore. The host still refuses at the end, so a job that starts after the preview, or one the snapshot has not shown yet, comes back
    as an error inside the confirmation with the same 查看任务 on it. */
export function BackupSection({ root, exportData, onRestored, jobs = [], nav, initialRestorePoints = null, now }) {
  const { busy, act, call, host } = useStudy();
  const isDesktop = host?.capabilities?.edition === 'desktop';
  const [file, setFile] = useState(null), [error, setError] = useState(''), [confirm, setConfirm] = useState(false);
  const [restorePoints, setRestorePoints] = useState(() => initialRestorePoints);
  const [confirmPointId, setConfirmPointId] = useState(null), [pointError, setPointError] = useState(''), [restoringPoint, setRestoringPoint] = useState(false);
  const input = useRef(null), readRequest = useRef(0);
  const exportId = useId(), restoreId = useId(), pointsId = useId();
  const folder = backupsFolder(root);
  const blockers = restoreBlockers(jobs);
  // One job to point at: the first that is running, in the snapshot's order.
  const openTask = blockers[0] && typeof nav?.show?.task === 'function' ? () => nav.show.task(blockers[0].id) : null;
  useEffect(() => {
    readRequest.current += 1;
    setFile(null); setError(''); setConfirm(false);
    return () => { readRequest.current += 1; };
  }, [root]);
  useLiveEffect((isLive) => {
    setConfirmPointId(null);
    setPointError('');
    if (initialRestorePoints) {
      setRestorePoints(initialRestorePoints);
      return;
    }
    setRestorePoints(null);
    if (!root || typeof call !== 'function') return;
    Promise.resolve(call('library.restorePoints.list')).then(
      (res) => { if (isLive() && res && Array.isArray(res.points)) setRestorePoints(res); },
      () => { if (isLive()) setRestorePoints({ retention: DEFAULT_RETENTION, totalExtraBytes: 0, points: [] }); },
    );
  }, [root, call, initialRestorePoints]);
  async function read(chosen) {
    const request = ++readRequest.current;
    setFile(null); setError(''); setConfirm(false);
    if (!chosen) return;
    try {
      const text = await chosen.text();
      if (request !== readRequest.current) return;
      const state = JSON.parse(text);
      if (!isFullBackup(state)) throw new Error(ui('这不是完整学习库备份'));
      setFile({ name: chosen.name, size: chosen.size, state, rawFile: chosen });
    } catch (e) {
      if (request === readRequest.current) setError(uiFormat('无法读取备份：{0}', [errorMessage(e)]));
    } finally { if (request === readRequest.current && input.current) input.current.value = ''; }
  }
  function chooseBackup() { read(null); input.current?.click(); }
  // A failure stays inside the confirmation (the dialog shows it and the learner can try again); the library is untouched.
  async function restore() {
    try {
      const needsChunked = Boolean(file?.rawFile && typeof call === 'function' && (Number(file.size) || 0) > CHUNKED_RESTORE_THRESHOLD);
      if (needsChunked) {
        const uploadId = await uploadInChunks(call, 'backup', file.rawFile);
        await act('restore', { uploadId }, (result) => { setFile(null); onRestored?.(result); }, { rethrow: true });
      } else {
        await act('restore', { state: file.state }, (result) => { setFile(null); onRestored?.(result); }, { rethrow: true });
      }
    } catch (e) {
      throw new Error(uiFormat('恢复没有完成，当前学习库保持不变：{0}', [errorMessage(e)]));
    }
  }
  async function restoreFromPoint(id) {
    if (blockers.length > 0) {
      setPointError(ui(RUNNING_JOB));
      return;
    }
    setPointError('');
    setRestoringPoint(true);
    try {
      await act('library.restorePoints.restore', { id }, (result) => {
        setConfirmPointId(null);
        onRestored?.(result);
      }, { rethrow: true });
    } catch (e) {
      setPointError(uiFormat('恢复没有完成，当前学习库保持不变：{0}', [errorMessage(e)]));
    } finally {
      setRestoringPoint(false);
    }
  }
  const retention = restorePoints?.retention || DEFAULT_RETENTION;
  const points = Array.isArray(restorePoints?.points) ? restorePoints.points : [];
  const totalExtraBytes = Number.isFinite(restorePoints?.totalExtraBytes) ? restorePoints.totalExtraBytes : 0;
  return (
    <SettingsSection className="backup-settings" tour="settings-backup" title={ui('数据备份与恢复')}>
      <div className="backup-blocks">
        <section className="backup-block" aria-labelledby={exportId}>
          <h3 id={exportId} className="settings-subtitle">{ui('导出')}</h3>
          <p>{ui('下载一个完整的 JSON 备份：资料、题组、复习进度和作答记录都在里面。')}</p>
          <Hint>{ui('已复制到资料库的原文件会放进备份；只记了路径的原文件留在你的电脑上，不在备份里，换电脑后需要重新指定。')}</Hint>
          <Hint>{ui('API 密钥与外观设置不在备份内；如需把外观带到另一台电脑，请在「设置 › 界面」导出外观配置。')}</Hint>
          <Hint>{isDesktop
            ? uiFormat('文件名形如 {0}，保存到系统下载文件夹（或你选择的保存位置）。', [backupFileName()])
            : uiFormat('文件名形如 {0}，保存到浏览器的下载文件夹。', [backupFileName()])}</Hint>
          <div className="settings-actions"><Button variant="primary" icon="download" data-usage="settings.export" lock={busy} onClick={exportData}>{ui('导出学习库')}</Button></div>
        </section>
        <section className="backup-block" aria-labelledby={restoreId}>
          <h3 id={restoreId} className="settings-subtitle">{ui('恢复')}</h3>
          <p>{ui('用一份完整备份替换当前学习库。替换前，当前数据会自动另存一份到：')}</p>
          <code className="backup-path">{folder || ui('当前学习库的 backups 文件夹')}</code>
          {/* Said before the learner picks a file: the restore cannot run now, and the reason is a task they can open. */}
          {blockers.length > 0 && <InlineMessage tone="warning" action={openTask ? { label: ui('查看任务'), iconEnd: 'arrow-right', onClick: openTask } : undefined}>
            {ui(RUNNING_JOB)}
          </InlineMessage>}
          <input ref={input} type="file" hidden accept=".json,application/json" onChange={(e) => read(e.target.files?.[0])} />
          {!file && <div className="settings-actions"><Button icon="upload" lock={busy} onClick={chooseBackup}>{ui('选择备份文件…')}</Button></div>}
          {error && <InlineMessage>{error}</InlineMessage>}
          {file && <RestorePreview file={file} busy={busy || confirm} blocked={blockers.length > 0} onConfirm={() => setConfirm(true)} onCancel={chooseBackup} />}
        </section>
      </div>
      <section className="restore-points-block" aria-labelledby={pointsId}>
        <div className="restore-points-head">
          <h3 id={pointsId} className="settings-subtitle">{ui('自动恢复点')}</h3>
          {points.length > 0 && <small className="restore-points-usage">{uiFormat('共额外占用 {0}', [formatBytes(totalExtraBytes)])}</small>}
        </div>
        <p>{uiFormat('跨天修改学习库时自动留存前一天的题库与进度快照，滚动保留最近 {0} 天和 {1} 个周点；你手动导出的备份文件永远不会自动删除。', [retention.daily, retention.weekly])}</p>
        <Hint>{ui('恢复点涵盖课程、资料文字、题组、作答记录与排程；原附件、复习全书历史与骨架图示保持不变，跨电脑迁移请用上方「导出学习库」。')}</Hint>
        {points.length === 0 ? (
          <p className="restore-points-empty">{ui('跨天继续使用学习库后，这里会自动列出可回退的日期恢复点。')}</p>
        ) : (
          <ul className="restore-points-list">
            {points.map((point) => {
              const label = formatRestorePointDate(point.date, now);
              const summary = point.summary || {};
              const confirming = confirmPointId === point.id;
              return (
                <li key={point.id} className="restore-point-row">
                  <div className="restore-point-row__info">
                    <div className="restore-point-row__title">
                      <Icon name="clock" className="restore-point-row__icon sh-icon--inline" />
                      <strong>{label}</strong>
                      {point.tier === 'weekly' && <Badge tone="neutral">{ui('周恢复点')}</Badge>}
                      <small className="restore-point-row__bytes">{uiFormat('额外 {0}', [formatBytes(point.extraBytes || 0)])}</small>
                    </div>
                    <p className="restore-point-row__meta">
                      {[
                        uiFormat('保存次数 {0}', [summary.revision ?? 0]),
                        uiFormat('{0} 门课程', [summary.courses ?? 0]),
                        uiFormat('{0} 份资料', [summary.sources ?? 0]),
                        uiFormat('{0} 个题组（{1} 道题）', [summary.decks ?? 0, summary.cards ?? 0]),
                        uiFormat('{0} 条作答记录', [summary.attempts ?? 0]),
                      ].join(' · ')}
                    </p>
                  </div>
                  {!confirming && (
                    <div className="restore-point-row__actions">
                      <Button variant="secondary" size="sm" icon="undo" lock={busy} disabled={blockers.length > 0}
                        onClick={() => { setPointError(''); setConfirmPointId(point.id); }}>
                        {ui('恢复到这一天')}
                      </Button>
                    </div>
                  )}
                  {confirming && (
                    <InlineConfirm tone="warning" className="restore-point-row__confirm" busy={restoringPoint}
                      title={uiFormat('恢复到 {0}？', [label])}
                      confirmLabel={ui('确认恢复到这一天')}
                      onCancel={() => { setConfirmPointId(null); setPointError(''); }}
                      onConfirm={() => restoreFromPoint(point.id)}>
                      <p>{uiFormat('回到这一天前会自动保存当前状态副本到 {0}；原附件、复习全书历史与骨架图示保持不变。', [folder || ui('当前学习库的 backups 文件夹')])}</p>
                      {blockers.length > 0 && <Hint>{ui(RUNNING_JOB)}</Hint>}
                      {pointError && <InlineMessage>{pointError}</InlineMessage>}
                    </InlineConfirm>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {confirm && file && <ConfirmDialog title={ui('用此备份替换当前学习库？')} confirmLabel={ui('用此备份替换当前学习库')} busy={busy} blocked={blockers.length > 0}
        onClose={() => setConfirm(false)}
        errorAction={openTask ? { label: ui('查看任务'), iconEnd: 'arrow-right', onClick: openTask } : undefined}
        description={uiFormat('当前学习库会被「{0}」替换，替换后回到学习库首页。替换前，当前数据会自动保存到 {1}。', [file.name, folder || ui('当前学习库的 backups 文件夹')])}
        onConfirm={restore}>
        {blockers.length > 0 && <Hint>{ui(RUNNING_JOB)}</Hint>}
      </ConfirmDialog>}
    </SettingsSection>
  );
}
