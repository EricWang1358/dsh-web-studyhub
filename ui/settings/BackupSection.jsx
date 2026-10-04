import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, ConfirmDialog, Hint, Icon, InlineMessage, SettingsSection, formatBytes } from '../components/index.js';
import { backupFileName } from './backup-name.js';

export { backupFileName };

/* ---------- 数据备份与恢复 ---------- */

/** What a backup holds, counted client-side before anything is replaced. */
export function backupSummary(state = {}) {
  const decks = Array.isArray(state.decks) ? state.decks : [];
  return { courses: Array.isArray(state.courses) ? state.courses.length : 0, sources: state.sources?.length || 0, decks: decks.length,
    cards: decks.reduce((sum, deck) => sum + (Array.isArray(deck.cards) ? deck.cards.length : 0), 0), attempts: state.attempts?.length || 0 };
}

const isFullBackup = state => state && Number.isInteger(state.version) && Array.isArray(state.sources) && Array.isArray(state.decks) &&
  Array.isArray(state.drafts) && Array.isArray(state.runs) && Array.isArray(state.attempts);
const backupsFolder = root => root ? `${root.replace(/[\\/]+$/, '')}${root.includes('\\') ? '\\' : '/'}backups` : '';

/** The chosen backup: name, size and contents, with the destructive action. */
export function RestorePreview({ file, busy, onConfirm, onCancel }) {
  const count = backupSummary(file.state);
  return <div className="restore-preview" role="status">
    <div className="restore-preview__file"><Icon name="file" size={18} /><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div>
    <p>{[uiFormat('{0} 门课程', [count.courses]), uiFormat('{0} 份资料', [count.sources]),
      uiFormat('{0} 个题组（{1} 道题）', [count.decks, count.cards]), uiFormat('{0} 条作答记录', [count.attempts])].join(' · ')}</p>
    <div className="settings-actions">
      <Button variant="danger" disabled={busy} onClick={onConfirm}>{ui('用此备份替换当前学习库')}</Button>
      <Button variant="quiet" disabled={busy} onClick={onCancel}>{ui('换一个文件')}</Button>
    </div>
  </div>;
}

/** Export and restore as two blocks with the same shape: what it does, where the file goes, one action. */
export function BackupSection({ root, busy, exportData, act, onRestored }) {
  const [file, setFile] = useState(null), [error, setError] = useState(''), [confirm, setConfirm] = useState(false);
  const input = useRef(null), readRequest = useRef(0);
  const exportId = useId(), restoreId = useId();
  const folder = backupsFolder(root);
  useEffect(() => {
    readRequest.current += 1;
    setFile(null); setError(''); setConfirm(false);
    return () => { readRequest.current += 1; };
  }, [root]);
  async function read(chosen) {
    const request = ++readRequest.current;
    setFile(null); setError(''); setConfirm(false);
    if (!chosen) return;
    try {
      const text = await chosen.text();
      if (request !== readRequest.current) return;
      const state = JSON.parse(text);
      if (!isFullBackup(state)) throw new Error(ui('这不是完整学习库备份'));
      setFile({ name: chosen.name, size: chosen.size, state });
    } catch (e) {
      if (request === readRequest.current) setError(uiFormat('无法读取备份：{0}', [e.message || String(e)]));
    } finally { if (request === readRequest.current && input.current) input.current.value = ''; }
  }
  function chooseBackup() { read(null); input.current?.click(); }
  // A failure stays inside the confirmation (the dialog shows it and the learner can try again); the library is untouched.
  async function restore() {
    try {
      await act('restore', { state: file.state }, (result) => { setFile(null); onRestored?.(result); }, { rethrow: true });
    } catch (e) {
      throw new Error(uiFormat('恢复没有完成，当前学习库保持不变：{0}', [e?.message || String(e)]));
    }
  }
  return (
    <SettingsSection className="backup-settings" title={ui('数据备份与恢复')}>
      <div className="backup-blocks">
        <section className="backup-block" aria-labelledby={exportId}>
          <h3 id={exportId} className="settings-subtitle">{ui('导出')}</h3>
          <p>{ui('下载一个完整的 JSON 备份：资料、题组、复习进度和作答记录都在里面。')}</p>
          <Hint>{ui('已复制到资料库的原文件会放进备份；只记了路径的原文件留在你的电脑上，不在备份里，换电脑后需要重新指定。')}</Hint>
          <Hint>{uiFormat('文件名形如 {0}，保存到浏览器的下载文件夹。', [backupFileName()])}</Hint>
          <div className="settings-actions"><Button variant="primary" icon="download" data-usage="settings.export" disabled={busy} onClick={exportData}>{ui('导出学习库')}</Button></div>
        </section>
        <section className="backup-block" aria-labelledby={restoreId}>
          <h3 id={restoreId} className="settings-subtitle">{ui('恢复')}</h3>
          <p>{ui('用一份完整备份替换当前学习库。替换前，当前数据会自动另存一份到：')}</p>
          <code className="backup-path" title={folder}>{folder || ui('当前学习库的 backups 文件夹')}</code>
          <input ref={input} type="file" hidden accept=".json,application/json" onChange={(e) => read(e.target.files?.[0])} />
          {!file && <div className="settings-actions"><Button icon="upload" disabled={busy} onClick={chooseBackup}>{ui('选择备份文件…')}</Button></div>}
          {error && <InlineMessage>{error}</InlineMessage>}
          {file && <RestorePreview file={file} busy={busy || confirm} onConfirm={() => setConfirm(true)} onCancel={chooseBackup} />}
        </section>
      </div>
      {confirm && file && <ConfirmDialog title={ui('用此备份替换当前学习库？')} confirmLabel={ui('用此备份替换当前学习库')} busy={busy} onClose={() => setConfirm(false)}
        description={uiFormat('当前学习库会被「{0}」替换。替换前，当前数据会自动保存到 {1}。', [file.name, folder || ui('当前学习库的 backups 文件夹')])}
        onConfirm={restore}>
        <Hint>{ui('出题任务进行中时不能恢复；恢复后会回到学习库首页。')}</Hint>
      </ConfirmDialog>}
    </SettingsSection>
  );
}
