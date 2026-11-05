import React, { useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { Button, Hint, InlineMessage, Tooltip } from './components/index.js';
import { useStudy } from './study-context.jsx';

/* What a converted book left out as repeated on most of its pages (lib/repeated-lines.js: a running header, an advertisement, the page numbers), said where
   the converter reports what it did: how many lines and one of them, and 恢复, which puts them back into the material as its new version
   (materials.document.restoreRepeated). The original file is never touched. */

const SAMPLE_CHARS = 40;

/** The sentence: how many lines went, and the first of them (cut short). '' when nothing went. */
export function repeatedText(repeated) {
  if (!(repeated?.count > 0)) return '';
  const first = String(repeated.lines?.[0]?.text ?? '').trim(), shown = first.length > SAMPLE_CHARS ? `${first.slice(0, SAMPLE_CHARS - 1)}…` : first;
  return shown ? uiFormat('去掉了 {0} 行每页都重复的内容（如「{1}」）', [repeated.count, shown]) : uiFormat('去掉了 {0} 行每页都重复的内容', [repeated.count]);
}

/** Put the lines back: resolves 'restored' or 'unchanged' (they were back already). */
export const restoreRepeated = (call, documentId) => call('materials.document.restoreRepeated', { documentId }).then(result => result?.status || 'restored');

export const RESTORE_TIP = () => ui('把这些行放回这份资料的文字里，存为它的新版本；原文件不变。');

/** The note and its 恢复, or nothing when no line went (or there is no document to put them back into). */
export function RepeatedNote({ documentId, repeated, onRestored }) {
  const { call } = useStudy();
  const [state, setState] = useState(''), [problem, setProblem] = useState('');
  const text = repeatedText(repeated);
  if (!documentId || !text) return null;
  if (state === 'done') return <Hint as="small" data-repeated-note="restored">{ui('已放回这些重复的行。')}</Hint>;
  const restore = async () => {
    setState('busy'); setProblem('');
    try { await restoreRepeated(call, documentId); setState('done'); onRestored?.(); }
    catch (error) { setState(''); setProblem(errorMessage(error)); }
  };
  return (
    <div className="repeated-note" data-repeated-note>
      <Hint as="small">{text}</Hint>
      <Tooltip layer content={RESTORE_TIP()}>
        <Button variant="link" size="sm" busy={state === 'busy'} aria-label={ui('恢复这些重复的行')} onClick={restore}>{ui('恢复')}</Button>
      </Tooltip>
      {problem && <InlineMessage tone="error">{problem}</InlineMessage>}
    </div>
  );
}
