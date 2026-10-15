import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Field, InlineMessage, RadioCard, RadioCardGroup, TextInput, Tooltip } from '../components/index.js';
import { sizeLabel } from '../mineru-flow.js';

/* Where to install (opened by 「选择位置」, inline, never a dialog). On Windows one card per fixed drive, each its would-be folder with the free space,
   the recommended one marked, the system drive and a full drive said so; choosing a card applies it at once. 「其他文件夹…」 opens the host's folder
   picker when it has one, else a path field. Elsewhere (no drives) only the default folder and 「其他文件夹…」. */

export default function LocationChooser({ plan, location, pickDirectory, onChoose, onClose, disabled = false }) {
  const [draft, setDraft] = useState(null), [problem, setProblem] = useState('');
  const drives = plan?.platform === 'win32' ? plan.drives || [] : [];
  const needed = plan?.disk?.neededMb || 0;
  const current = (location || plan?.folder || '').toLowerCase();
  const other = async () => {
    setProblem('');
    if (!pickDirectory) { setDraft(location || ''); return; }
    try { const picked = await pickDirectory(); if (picked) onChoose(picked); }
    catch { setDraft(location || ''); setProblem(ui('无法打开文件夹选择器，请直接输入路径。')); }
  };
  const use = () => { const value = (draft || '').trim(); if (value) { onChoose(value); setDraft(null); } };
  return <div className="mineru-install__chooser">
    {drives.length > 0 ? <RadioCardGroup legend={ui('装到哪里')} className="mineru-install__drives">
      {drives.map(drive => {
        const full = drive.freeMb < needed;
        return <RadioCard key={drive.root} name="mineru-install-drive" value={drive.folder} checked={current === drive.folder.toLowerCase()} disabled={disabled}
          onSelect={onChoose} title={<code translate="no">{drive.folder}</code>} hint={uiFormat('剩余 {0}', [sizeLabel(drive.freeMb)])}
          badges={<>
            {drive.recommended && <Badge size="sm" tone="success">{ui('推荐')}</Badge>}
            {drive.system && <Tooltip layer content={ui('系统盘：装在这里会占用 C 盘空间。')}><span tabIndex={0} className="mineru-install__tipped"><Badge size="sm" tone="warning">{ui('系统盘')}</Badge></span></Tooltip>}
            {full && <Badge size="sm" tone="error">{ui('空间不够')}</Badge>}
          </>} />;
      })}
    </RadioCardGroup> : <p className="mineru-install__where"><span>{ui('默认位置')}</span><code translate="no">{plan?.defaultFolder || ''}</code></p>}
    {draft !== null && <form className="mineru-install__draft" onSubmit={event => { event.preventDefault(); use(); }}>
      <Field label={ui('文件夹的完整路径')}>
        <TextInput autoFocus value={draft} placeholder="D:\StudyHub\MinerU" aria-label={ui('文件夹的完整路径')} onChange={event => setDraft(event.target.value)} />
      </Field>
      <div className="mineru-install__row">
        <Button type="submit" size="sm" disabled={!draft.trim()}>{ui('使用这个位置')}</Button>
        <Button size="sm" variant="quiet" onClick={() => setDraft(null)}>{ui('取消')}</Button>
      </div>
    </form>}
    {problem && <InlineMessage tone="warning">{problem}</InlineMessage>}
    <div className="mineru-install__row">
      {draft === null && <Button size="sm" variant="secondary" disabled={disabled} onClick={other}>{ui('其他文件夹…')}</Button>}
      <Button size="sm" variant="quiet" onClick={onClose}>{ui('收起')}</Button>
    </div>
  </div>;
}
