import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Badge, Button, Combobox, InlineMessage } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { bookFiles, fileText } from './model.js';
import { forgetUnsaved, keepUnsaved, readUnsaved } from './unsaved-draft.js';

/* 原文 of the review book (docs/plans/review-book.md M2): the raw Markdown of ONE file in the CodeMirror Markdown editor (the one ui/BlogNotes.jsx uses), any
   file: a point's generated file (editing it forks it: the program then offers its new texts instead of writing over yours) or your own file, or 未归位.
   保存 is compare-and-set on the version the edit started from (course.book.save); when the book changed meanwhile your text is kept and the other one
   is offered (书已更新). 回退到上一版 takes the file's previous version back. Typing touches only this editor, never the rendered book. */

// Long lines wrap: the page never scrolls sideways, at 420 px either.
const extensions = [markdown(), EditorView.lineWrapping];

/** book: course.book.open's answer; file; onPick(file); onChanged(book) with the new answer; onDirty(dirty): whether there are unsaved edits (the page asks before
    leaving them); theme: 'light' | 'dark'; root: the library (what was left unsaved with no question possible waits per library, ui/book/unsaved-draft.js); discarded: a ref, true once the learner answered
    丢掉改动 (nothing is kept then). */
export default function BookEditor({ book, file, onPick, onChanged, onDirty, theme = 'dark', root = '', discarded }) {
  const { call, notify } = useStudy();
  const meta = book.files[file] || { version: 0 };
  const [draft, setDraft] = useState(() => fileText(book, file));
  const [saving, setSaving] = useState(false);
  const [merged, setMerged] = useState(false);
  const base = useRef({ file, version: meta.version, text: fileText(book, file) });
  // Text left unsaved last time with no question possible: offered back, never put in by itself. Text that is what the file holds now needs no offer.
  const rescueOf = name => { const kept = readUnsaved(root, book.course, name); return kept && kept.text !== fileText(book, name) ? kept : null; };
  const [rescue, setRescue] = useState(() => rescueOf(file));
  const typed = useRef(draft);
  typed.current = draft;
  // The editor goes with unsaved text and nobody answered: the leave gate could not ask (see ui/book/unsaved-draft.js).
  useEffect(() => () => {
    if (typed.current === base.current.text || discarded?.current) return;
    if (!keepUnsaved(root, book.course, base.current.file, typed.current, base.current.version)) notify({ text: ui('编辑器关掉了，没保存的改动没能留在这个浏览器里（太大，或者浏览器不让存），这些字丢了。'), tone: 'error' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const closeRescue = () => { forgetUnsaved(root, book.course, file); setRescue(null); };
  // From the version it was edited from: a file that moved since goes through the save's 书已更新, nothing is written over.
  const restore = () => { base.current = { ...base.current, version: rescue.version ?? base.current.version }; setDraft(rescue.text); closeRescue(); };
  // Another file: start from its saved text and version. The same file after a save or a merge: from what was saved.
  useEffect(() => {
    if (base.current.file === file) return;
    base.current = { file, version: book.files[file]?.version ?? 0, text: fileText(book, file) };
    setDraft(base.current.text);
    setMerged(false);
    setRescue(rescueOf(file));
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  const options = useMemo(() => bookFiles(book).map(item => ({ value: item.file,
    label: item.kind === 'unplaced' ? book.unplaced.title : uiFormat(item.kind === 'gen' ? '{0} {1} · 讲解（生成）' : item.kind === 'qa' ? '{0} {1} · 问答' : '{0} {1} · 我的笔记', [item.row.number, item.row.title]) })), [book]);
  const dirty = draft !== base.current.text;
  useEffect(() => { onDirty?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirty?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const settle = (next, { kept = true } = {}) => {
    // Saved, and a rebuilt outline waits for the learner's answer: the page shows it next (ui/book/BookRebuildPreview.jsx).
    if (next.status !== 'ok') { base.current = { ...base.current, text: typed.current }; onChanged(next); return; }
    base.current = { file, version: next.files[file]?.version ?? 0, text: fileText(next, file) };
    if (kept) setDraft(base.current.text);
    onChanged(next);
  };
  const save = async () => {
    setSaving(true);
    try {
      const next = await call('course.book.save', { course: book.course, file, text: draft, version: base.current.version });
      // A save answers what was left unsaved of this file.
      closeRescue();
      setMerged(next.write === 'merged');
      if (next.write === 'merged') notify({ text: ui('书已更新：你的改动已保存，另一边的内容放在了建议里。'), tone: 'info' });
      settle(next);
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); } finally { setSaving(false); }
  };
  const revert = async () => {
    setSaving(true);
    try { settle(await call('course.book.revert', { course: book.course, file })); setMerged(false); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); } finally { setSaving(false); }
  };
  return (
    <section className="book-editor" aria-label={ui('原文')}>
      <div className="book-editor__bar">
        {/* While there are unsaved edits the file stays chosen: save them or 放弃改动 first, so nothing is lost by switching. */}
        <Combobox className="book-editor__file" label={ui('要改的文件')} aria-label={ui('要改的文件')} searchPlaceholder={ui('搜索文件')} value={file} options={options} disabled={dirty} onChange={value => onPick(value)} />
        {book.files[file]?.forked && <Badge size="sm" tone="warning" className="book-editor__forked">{ui('已改动')}</Badge>}
        <Button size="sm" variant="primary" icon="check" disabled={!dirty || saving} busy={saving} onClick={save} className="book-editor__save">{ui('保存')}</Button>
        <Button size="sm" variant="quiet" disabled={!dirty || saving} onClick={() => setDraft(base.current.text)}>{ui('放弃改动')}</Button>
        <Button size="sm" variant="quiet" icon="refresh" disabled={!book.history?.[file] || saving || dirty} onClick={revert} className="book-editor__revert">{ui('回退到上一版')}</Button>
      </div>
      {file.endsWith('.gen.md') && !book.files[file]?.forked && <p className="book-editor__note">{ui('这是程序生成的讲解。改了之后它就归你：以后重新生成时，新内容只作为建议给你，不会覆盖。')}</p>}
      {rescue && <InlineMessage tone="warning" data-book-rescue="" action={{ label: ui('恢复这些改动'), onClick: restore }} secondary={{ label: ui('不要了'), onClick: closeRescue }}>
        {ui('上次离开时这份文件还有没保存的改动，当时没来得及问你。')}</InlineMessage>}
      {merged && <InlineMessage tone="info">{ui('书已更新：你的改动已保存，另一边的内容放在了建议里，可以在预览里采用或忽略。')}</InlineMessage>}
      <CodeMirror className="book-editor__code" value={draft} height="60vh" theme={theme === 'light' ? 'light' : 'dark'} extensions={extensions} onChange={setDraft}
        basicSetup={{ lineNumbers: false, foldGutter: false }} />
    </section>
  );
}
