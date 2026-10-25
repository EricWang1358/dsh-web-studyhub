import React, { useId, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, Dialog, Field, Hint, InlineMessage, Select, TextInput } from '../components/index.js';
import { MAX_TITLE_CHARS } from '../../lib/document-title.js';
import { moveTargets, nodeAt, shiftPlace, structureFailureText } from './book-structure.js';

/* 复习全书 structure from the page (#470, docs/review-book.md "Structure"): 更多 › 改名… / 移动到… / 删除这个知识点…, beside 编辑这个知识点….
   What changes here is the point being read (its chapter and section stay the main chat's): rename keeps its id, files and questions; move takes
   everything below it and shifts its files' headings to the new depth; delete leaves no placeholder and puts what the learner wrote into 未归位
   (lib/book-parked-text.js). Every change is compare-and-set on the book's structureVersion (lib/course-book-structure.js): a stale one is said in
   the dialog, the book is read again (ui/book/use-book-actions.js), and what was typed stays in its field. */

const label = node => [node.number, node.title].filter(Boolean).join(' ');

/** One run of a structure action: the dialog stays usable, and a refusal is said inside it. */
function useStructureRun(onRun) {
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(null);
  const run = async (action, args) => {
    setBusy(true);
    setFailure(null);
    try {
      const answer = await onRun(action, args);
      if (!answer.ok) setFailure(answer.failure || new Error('failed'));
      return answer.ok;
    } finally { setBusy(false); }
  };
  return { busy, failure, run };
}

const Refusal = ({ failure }) => (failure ? <InlineMessage tone="error">{structureFailureText(failure) ?? errorMessage(failure)}</InlineMessage> : null);

/** 改名…: the title the book shows for the point, the outline's own title left as it is; an empty or unchanged title closes without a call. */
export function RenameDialog({ book, node, onRun, onClose }) {
  const current = nodeAt(book?.nodes, node.hid)?.node ?? node, formId = useId();
  const [title, setTitle] = useState(node.title);
  const { busy, failure, run } = useStructureRun(onRun);
  const next = title.trim();
  const submit = async event => {
    event.preventDefault();
    if (busy || !next) return;
    if (next === current.title) { onClose(); return; }
    if (await run('course.book.rename', { hid: node.hid, title: next })) onClose();
  };
  return (
    <Dialog title={ui('给这个知识点改名')} size="sm" className="book-structure-dialog" onClose={onClose}
      footer={<>
        <Button variant="quiet" onClick={() => onClose()} disabled={busy}>{ui('取消')}</Button>
        <Button variant="primary" type="submit" form={formId} busy={busy} disabled={!next}>{ui('保存')}</Button>
      </>}>
      <div className="book-structure">
        <form id={formId} onSubmit={submit}>
          <Field label={ui('名称')} hint={ui('改名只改书里显示的名字：编号、讲解、笔记和题目都不变。')}>
            <TextInput value={title} maxLength={MAX_TITLE_CHARS} autoFocus required onChange={event => setTitle(event.target.value)} />
          </Field>
        </form>
        <Refusal failure={failure} />
      </div>
    </Dialog>
  );
}

/** 移动到…: 上移 / 下移 among its siblings, or under another chapter or section (there it goes last; 上移 / 下移 adjust it after). It stays open
    after each move, so one visit can put a point in order. */
export function MoveDialog({ book, node, onRun, onClose }) {
  const current = nodeAt(book?.nodes, node.hid)?.node ?? node;
  const up = shiftPlace(book, node.hid, -1), down = shiftPlace(book, node.hid, 1);
  const targets = moveTargets(book, node.hid);
  const [parent, setParent] = useState('');
  const { busy, failure, run } = useStructureRun(onRun);
  const move = async place => { if (await run('course.book.move', { hid: node.hid, ...place })) setParent(''); };
  return (
    <Dialog title={ui('移动这个知识点')} size="sm" className="book-structure-dialog" onClose={onClose} busy={busy}
      footer={<Button variant="secondary" onClick={() => onClose()} disabled={busy}>{ui('完成')}</Button>}>
      <div className="book-structure">
        <p className="book-structure__what">{label(current)}</p>
        <div className="book-structure__row">
          <Button variant="secondary" size="sm" className="book-structure__up" disabled={!up || busy} onClick={() => move(up)}>{ui('上移')}</Button>
          <Button variant="secondary" size="sm" className="book-structure__down" disabled={!down || busy} onClick={() => move(down)}>{ui('下移')}</Button>
        </div>
        <Hint>{ui('上移、下移是在同一层里换位置。选一个章或节，会把这一节连同它下面的一起移过去。')}</Hint>
        <Field label={ui('放到')} hint={ui('移到那个章或节的末尾；放好以后还可以用上移、下移调整。')}>
          <Select options={targets} value={parent} placeholder={ui('选一个章或节')} disabled={busy} onChange={value => setParent(value)} />
        </Field>
        <div className="book-structure__row">
          <Button variant="secondary" size="sm" className="book-structure__go" disabled={!parent || busy} onClick={() => move({ toParent: parent })}>{ui('移过去')}</Button>
        </div>
        <Refusal failure={failure} />
      </div>
    </Dialog>
  );
}

/** 删除这个知识点…: one confirmation, saying that nothing takes its place and where what the learner wrote goes. A point holds no chapter or
    section below it, so there is no children choice here (a chapter's is the main chat's). */
export function DeleteDialog({ book, node, onRun, onClose, onDeleted }) {
  const current = nodeAt(book?.nodes, node.hid)?.node ?? node;
  const { busy, failure, run } = useStructureRun(onRun);
  const remove = async () => { if (await run('course.book.delete', { hid: node.hid, children: 'promote' })) onDeleted(); };
  return (
    <Dialog title={ui('删除这个知识点')} size="sm" className="book-structure-dialog" onClose={onClose} busy={busy}
      footer={<>
        <Button variant="quiet" autoFocus onClick={() => onClose()} disabled={busy}>{ui('取消')}</Button>
        <Button variant="danger" busy={busy} onClick={remove}>{ui('删除')}</Button>
      </>}>
      <div className="book-structure">
        <p className="book-structure__what">{label(current)}</p>
        <p>{uiFormat('「{0}」会从书里删掉，不留空标题，也不留占位文字。', [current.title])}</p>
        <p>{ui('你在这个知识点里写的内容（笔记、问答、改过的讲解）会放进「未归位」，不会丢。')}</p>
        <p>{ui('它下面没有别的章或节；要删的只有它自己。')}</p>
        <Refusal failure={failure} />
      </div>
    </Dialog>
  );
}

/** The one structure dialog the page opens: kind 'rename' | 'move' | 'delete' (ui/book/more-actions.js). onRun(action, args) -> { ok, failure }
    (ui/book/use-book-actions.js: compare-and-set on structureVersion, the book read again on a conflict). */
export default function BookStructureDialog({ kind, book, node, onRun, onClose, onDeleted }) {
  if (kind === 'rename') return <RenameDialog book={book} node={node} onRun={onRun} onClose={onClose} />;
  if (kind === 'move') return <MoveDialog book={book} node={node} onRun={onRun} onClose={onClose} />;
  if (kind === 'delete') return <DeleteDialog book={book} node={node} onRun={onRun} onClose={onClose} onDeleted={onDeleted} />;
  return null;
}
