import React, { useEffect } from 'react';
import { ui, uiFormat } from './i18n.js';
import { Field, Hint, SegmentedControl, Select } from './components/index.js';

/** Segments up to this many levels (plus the follow choice); a select beyond. */
const SEGMENT_LEVELS = 4;

/**
 * What a level costs and buys, by its position among the model's levels
 * (DSH lists them lowest first). The wording never names a model's levels, so
 * it stays true whatever the provider calls them.
 */
export function effortTradeoff(options = [], current = '') {
  const at = options.findIndex((item) => item.id === current);
  if (options.length < 2 || at < 0) return { key: 'unknown', text: ui('档位越高，题目推理越严谨，但更慢、更耗额度；档位越低则相反。') };
  if (at === 0) return { key: 'low', text: ui('低档：更快、更省额度；适合基础记忆题、批量出题。') };
  if (at === options.length - 1) return { key: 'high', text: ui('高档：更慢、消耗更多额度；题目推理链更严谨，适合应用分析和案例题。') };
  return { key: 'mid', text: ui('中档：速度与严谨度折中；适合大多数课程资料。') };
}

/**
 * Reasoning effort for question generation, under the 生成模型 choice in Settings.
 * Props: `binding` (as binding.get/set return it, with `effort`), `busy`,
 * `onChange(levelId)` ('' follows), and `onRefresh()` (re-reads the binding when
 * Settings opens or the followed model changes, so the levels match the model).
 */
export default function ReasoningEffortField({ binding = {}, busy = false, onChange, onRefresh, refreshKey }) {
  useEffect(() => { onRefresh?.(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const effort = binding.effort || {}, options = Array.isArray(effort.options) ? effort.options : [];
  if (options.length < 2) {
    if (!effort.stale) return null;
    return <div className="binding-row effort-row"><Hint>{ui('当前模型不支持推理程度设置，已使用模型默认。')}</Hint></div>;
  }
  const preferred = effort.applied ? binding.reasoningEffort : '';
  // What following gives: the session's level, else the model's own default (binding.effort.followed).
  const followedName = options.find((item) => item.id === (effort.followed ?? binding.route?.reasoningEffort))?.name;
  const followLabel = binding.modelSource === 'session'
    ? (followedName ? uiFormat('跟随会话（{0}）', [followedName]) : ui('跟随会话'))
    : (followedName ? uiFormat('模型默认（{0}）', [followedName]) : ui('模型默认'));
  const choices = [{ value: '', label: followLabel }, ...options.map((item) => ({ value: item.id, label: item.name }))];
  const tradeoff = effortTradeoff(options, effort.current);
  const small = options.length <= SEGMENT_LEVELS;
  return <div className="binding-row effort-row"><div className="binding-main">
    <Field group={small} label={ui('推理程度')} width="full" hint={ui('只影响出题和改题；陪学提示固定用最低档，音频处理在音频设置里单独调。')}>
      {small
        ? <SegmentedControl label={ui('推理程度')} value={preferred} options={choices} disabled={busy} onChange={onChange} />
        : <Select value={preferred} disabled={busy} onChange={(value) => onChange?.(value)} options={choices} />}
    </Field>
    <Hint className="effort-tradeoff" data-effort={tradeoff.key}>{tradeoff.text}</Hint>
    {effort.stale && <Hint className="effort-note">{uiFormat('之前选的「{0}」当前模型没有，已改为跟随。', [binding.reasoningEffort])}</Hint>}
  </div></div>;
}
