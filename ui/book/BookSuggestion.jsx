import React from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, Disclosure } from '../components/index.js';
import Markdown from '../Markdown.jsx';

/* A file's waiting suggestions in the review book's 预览 (M2), newest first, at most three: a newer generated text of a point you changed (`generated`), or
   the other text of a save that met another change (`theirs`, 书已更新). The file keeps your text until you choose, one suggestion at a time: 采用 takes
   its text, 忽略 drops it. Rendered as Markdown with no links drawn (it is not the book yet). */

/** meta: { forked, suggestions }; onChoose(action, id) with 'accept' | 'ignore'; busy. */
export default function BookSuggestion({ meta, onChoose, busy = false }) {
  const list = meta?.suggestions || [];
  if (!list.length) return meta?.forked ? <p className="book-suggestion__forked"><Badge size="sm" tone="warning">{ui('已改动')}</Badge> {ui('这段讲解你改过：重新生成时不会覆盖它。')}</p> : null;
  return list.map(item => {
    const theirs = item.kind === 'theirs';
    return (
      <div key={item.id} className="book-suggestion" role="status" data-suggestion={item.kind}>
        <p className="book-suggestion__line">
          <Badge size="sm" tone="info">{theirs ? ui('书已更新') : ui('有新的生成内容')}</Badge>{' '}
          {theirs ? ui('保存时这一段在别处也改过：现在是你的版本，另一边的内容在下面。') : ui('这段讲解你改过，所以新生成的内容没有直接替换，放在下面。')}
        </p>
        <Disclosure className="book-suggestion__text" summary={ui('看建议的内容')}>
          <Markdown text={item.text} links={false} />
        </Disclosure>
        <div className="book-suggestion__actions">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onChoose('accept', item.id)}>{ui('采用')}</Button>
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => onChoose('ignore', item.id)}>{ui('忽略')}</Button>
        </div>
      </div>
    );
  });
}
