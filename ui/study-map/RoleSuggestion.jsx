import React, { useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, InlineMessage } from '../components/index.js';

/** The role the learner is preparing for (interview mode), as an editable draft that follows the saved focus. */
export function useRoleDraft(saved) {
  const [draft, setDraft] = useState(saved || '');
  useEffect(() => { setDraft(saved || ''); }, [saved]);
  return { draft, setDraft };
}

/**
 * Interview mode's preparation: paste a job description, let the model match
 * it to the library's topics, confirm the proposed scope, and start on the weak
 * points of that role. It keeps its own draft, proposal and busy state.
 */
export default function RoleSuggestion({ data, role, suggestRole, onFocus, start }) {
  const focus = data.focus || {};
  const [jdDraft, setJdDraft] = useState(focus.jd || '');
  const [proposal, setProposal] = useState(null);
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setJdDraft(focus.jd || ''); }, [focus.jd]);
  const match = async () => {
    setMatching(true);
    setError('');
    try { setProposal(await suggestRole?.({ role: role.trim(), jd: jdDraft })); }
    catch (failure) { setError(failure.message); }
    finally { setMatching(false); }
  };
  return (
    <div className="role-prep">
      <details>
        <summary>{ui('用岗位描述细化练习范围')}</summary>
        <textarea rows={4} value={jdDraft} placeholder={ui('需要时粘贴 JD；不贴也可按岗位方向匹配')} onChange={(event) => setJdDraft(event.target.value)} />
        <Button size="sm" busy={matching} disabled={!role.trim()} onClick={match}>{matching ? ui('匹配中…') : ui('AI 匹配知识点')}</Button>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {proposal && <div className="role-proposal">
          <p>{ui('建议练习：')}{proposal.targetTopics.length ? proposal.targetTopics.join('、') : ui('暂无匹配的现有知识点，可先用全库薄弱题练习')}</p>
          <Button variant="primary" size="sm" onClick={() => {
            onFocus?.({ mode: 'interview', role: proposal.role, jd: proposal.jd, targetTopics: proposal.targetTopics });
            setProposal(null);
          }}>{ui('确认岗位范围')}</Button>
        </div>}
      </details>
      {!!focus.roleWeak?.length && <div className="role-weak">
        <strong>{ui('优先练这些薄弱点')}</strong>
        {focus.roleWeak.slice(0, 3).map((item) => <Button key={`${item.deckId}:${item.topic}`} size="sm" iconEnd="arrow-right"
          onClick={() => start({ mode: 'path', scope: [{ deckId: item.deckId, topic: item.topic }] })}>
          {uiFormat('{0} · {1} 道薄弱题', [item.topic, item.weak])}</Button>)}
      </div>}
    </div>
  );
}
