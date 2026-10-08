import React from 'react';
import { ui } from './i18n.js';
import { Checkbox } from './components/index.js';
import { documentsOf, poolOf, settingsOf, suggestionsOf } from './exam-prep/form.js';
import { reasonWords } from './exam-prep/form-words.js';

/* Materials that look like the course's exam syllabus, offered under 考官指引. Guidance feeds the case questions and the grading, so nothing here is ever chosen for the
   learner: each is an unticked box with the reason it is offered, and the learner ticks it. The same rule as the 备考补习 form's roles (lib/exam-prep-roles.js: a strong word
   in the name AND a size that fits a syllabus; another course's material is never suggested), and it follows the learner's switch for automatic roles in Settings. */

/** The materials of `course` (and the unfiled ones) whose name says syllabus and that are not chosen yet: [{ key, title, ids, reason }]. */
export function guidanceSuggestions(data, course, chosen = []) {
  if (!settingsOf(data).autoRoles) return [];
  const known = (data?.focus?.courses || []).map(item => typeof item === 'string' ? item : item?.name).filter(name => typeof name === 'string' && name);
  const picked = new Set(chosen);
  const pool = poolOf(documentsOf(data?.sources).filter(item => !item.archived), { course, known });
  const list = suggestionsOf(pool, { course, known, guidance: [], autoRoles: true });
  return pool.filter(item => list.get(item.key)?.role === 'syllabus' && !item.sourceIds.some(id => picked.has(id)))
    .map(item => ({ key: item.key, title: item.title, ids: item.sourceIds, reason: reasonWords(list.get(item.key).reason) }));
}

/** The suggestions as unticked boxes; ticking one hands its source ids to `onAdd`, and it leaves the list because it is chosen. */
export default function GuidanceSuggestions({ items = [], onAdd, disabled = false }) {
  if (!items.length) return null;
  return (
    <div className="guidance-suggestions" role="group" aria-label={ui('建议的考官指引')}>
      <small className="muted">{ui('建议：这些资料的名字像考试大纲，勾选后才会加入')}</small>
      {items.map(item => <Checkbox key={item.key} label={item.title} hint={item.reason} checked={false} disabled={disabled} onChange={() => onAdd?.(item.ids)} />)}
    </div>
  );
}
