import React, { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { Button, Chip, TextInput } from './components/index.js';
import { addTopics, removeTopic, splitTopics } from './course-topics.js';

/**
 * A course's focus topics as chips: each can be removed, a box adds more (Enter, the button or leaving the box; several at once with ; or a new line), and the learner's
 * weakest topics are offered under them as suggestions that are only added when clicked. `value` is the topics as one text ("a; b"), as the course panel keeps it; `onChange`
 * gets the new text. `suggestions` is [{ topic, weak }] (generate.weakTopics).
 */
export default function TopicChips({ value, onChange, suggestions = [], disabled = false }) {
  const [draft, setDraft] = useState('');
  const topics = splitTopics(value), have = new Set(topics);
  const offered = suggestions.filter(item => item?.topic && !have.has(item.topic));
  const commit = () => { if (draft.trim()) onChange(addTopics(value, draft)); setDraft(''); };
  return (
    <div className="topic-chips">
      {topics.length > 0 && <ul className="topic-chips__list" aria-label={ui('重点知识点')}>
        {topics.map(topic => <li key={topic}><Chip removeLabel={uiFormat('删除「{0}」', [topic])} onRemove={disabled ? undefined : () => onChange(removeTopic(value, topic))}>{topic}</Chip></li>)}
      </ul>}
      <div className="topic-chips__add">
        <TextInput aria-label={ui('添加重点知识点')} value={draft} disabled={disabled} maxLength={200} placeholder={ui('输入一个知识点，按回车添加；例如 迁移策略')}
          onChange={event => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); commit(); } }} />
        <Button size="sm" variant="secondary" disabled={disabled || !draft.trim()} onClick={commit}>{ui('添加')}</Button>
      </div>
      {offered.length > 0 && <div className="topic-chips__suggest">
        <small className="muted">{ui('建议：这些是你答错最多的知识点，点一下才会加入')}</small>
        <ul className="topic-chips__list" aria-label={ui('建议的知识点')}>
          {offered.map(item => <li key={item.topic}><Chip size="sm" disabled={disabled} onClick={() => onChange(addTopics(value, item.topic))}>{`＋ ${item.topic}`}</Chip></li>)}
        </ul>
      </div>}
    </div>
  );
}
