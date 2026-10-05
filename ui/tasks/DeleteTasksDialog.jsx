import React from 'react';
import { ConfirmDialog } from '../components/index.js';
import { ui, uiFormat } from '../i18n.js';

/* The confirmation of 删除 (for good): what goes (the task records, and for audio the working copy of the batch on this computer) and what does NOT (the imported sources,
   drafts and decks). `count` tasks, of which `archived` are in the archive and `audio` are audio imports. The caller supplies the deletion; this dialog says it. */
export default function DeleteTasksDialog({ count, archived = 0, audio = 0, onConfirm, onDone, onClose }) {
  const one = count === 1;
  return (
    <ConfirmDialog title={one ? ui('删除这个任务？') : uiFormat('删除 {0} 个任务？', [count])} confirmLabel={ui('确认删除')} onConfirm={onConfirm} onDone={onDone} onClose={onClose}>
      <p>{one ? ui('这个任务记录会被永久删除，不能撤销。') : uiFormat('这 {0} 个任务记录会被永久删除，不能撤销。', [count])}</p>
      {!one && archived > 0 && <p>{uiFormat('其中 {0} 个在「已归档」里，会从归档中一并删除。', [archived])}</p>}
      {audio > 0 && <p>{one ? ui('这个音频任务在本机的工作副本（中间文件）也会一并清理。') : uiFormat('其中 {0} 个音频任务：它们在本机的工作副本（中间文件）也会一并清理。', [audio])}</p>}
      <p>{ui('不会删除：已导入的资料（转写稿）、草稿和题组。')}</p>
    </ConfirmDialog>
  );
}
