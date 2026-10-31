import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { readText, writeText } from '../storage.js';
import { Button, Tooltip } from '../components/index.js';

/* The review book is upgrade-only (docs/review-book.md "Rolling back"), and a release before 3.5 can write empty explanations over a book it cannot read: nothing in this version can
   stop that release (#487). So the home says once, per library, to keep a copy of the library folder. An older release keeps no record of itself, so "the first start after an
   upgrade" cannot be told apart: it shows the first time this version sees the library with a book, which for someone new is right after their first book. */

/** The key prefix of 知道了, one key per library; 设置 › 引导 reads it (ui/guidance/registry.js, item book.backup). */
export const BOOK_BACKUP_PREFIX = 'study-book-backup-seen:';
const keyOf = root => `${BOOK_BACKUP_PREFIX}${root || 'local'}`;
export const backupSeen = root => readText(keyOf(root), null) !== null;
/** Remember that it was read; true when it was stored (a write that fails only says it again next time). */
export const rememberBackupSeen = root => writeText(keyOf(root), '1');

/** bookCourses: the snapshot's courses with a book; root: the library folder. */
export default function BookBackupHint({ bookCourses, root }) {
  const [seen, setSeen] = useState(() => backupSeen(root));
  if (!bookCourses?.length || seen) return null;
  const done = () => { rememberBackupSeen(root); setSeen(true); };
  return (
    <div className="group-reminder" role="status" data-book-backup="">
      <span>{ui('复习全书的升级是单向的：想退回旧版前，先把学习库文件夹复制一份。')}{' '}
        <Tooltip layer content={uiFormat('备份：关掉 DSH，复制文件夹 {0}。恢复：关掉 DSH，用复制的那份换回原来的文件夹。3.5 以下的版本里不要点「更新全书」：它读不懂按页整理的知识点，会写出空的讲解。', [root || ui('学习库')])}>
          <span className="outline-what" tabIndex={0}>{ui('怎么备份和恢复？')}</span></Tooltip></span>
      <span className="group-reminder-actions"><Button variant="quiet" size="sm" onClick={done}>{ui('知道了')}</Button></span>
    </div>
  );
}
