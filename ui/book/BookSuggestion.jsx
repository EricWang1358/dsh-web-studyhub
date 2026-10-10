import React from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, Disclosure } from '../components/index.js';
import Markdown from '../Markdown.jsx';

/* A file's waiting suggestion in the review book's 预览 (M2): a newer generated text of a point you changed (`generated`), or the other text of a save that
   met another change (`theirs`, 书已更新). The file keeps your text until you choose: 采用 takes the suggested text, 忽略 drops it. Rendered as Markdown with
   no links drawn (it is not the book yet). */

/** meta: { forked, suggestion }; onChoose(action) with 'accept' | 'ignore'; busy. */
export default function BookSuggestion({ meta, onChoose, busy = false }) {
  if (!meta?.suggestion) return meta?.forked ? <p className="book-suggestion__forked"><Badge size="sm" tone="warning">{ui('已改动')}</Badge> {ui('这段讲解你改过：重新生成时不会覆盖它。')}</p> : null;
  const theirs = meta.suggestion.kind === 'theirs';
  return (
    <div className="book-suggestion" role="status">
      <p className="book-suggestion__line">
        <Badge size="sm" tone="info">{theirs ? ui('书已更新') : ui('有新的生成内容')}</Badge>{' '}
        {theirs ? ui('保存时这一段在别处也改过：现在是你的版本，另一边的内容在下面。') : ui('这段讲解你改过，所以新生成的内容没有直接替换，放在下面。')}
      </p>
      <Disclosure className="book-suggestion__text" summary={ui('看建议的内容')}>
        <Markdown text={meta.suggestion.text} links={false} />
      </Disclosure>
      <div className="book-suggestion__actions">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onChoose('accept')}>{ui('采用')}</Button>
        <Button size="sm" variant="quiet" disabled={busy} onClick={() => onChoose('ignore')}>{ui('忽略')}</Button>
      </div>
    </div>
  );
}
