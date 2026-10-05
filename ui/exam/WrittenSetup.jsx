import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, ErrorState, Icon, InlineMessage, SegmentedControl } from '../components/index.js';
import { EXAM_LIMIT_MS } from '../../lib/exam-timing.js';
import { QUESTION_COUNT } from '../../lib/limits.js';
import { ExamSetupCard, CountField } from '../ExamShell.jsx';
import { DEFAULT_COUNT, EXAM_KIND_LABELS, typeAvailableOf } from './exam-written.js';

/* The written exam's setup card: which decks, which kinds of question, how many. The choices live in Exam.jsx
   (they are kept per course); this draws them and reports changes. */

const MINUTES = EXAM_LIMIT_MS / 60000;

export default function WrittenSetup({ data, header, recent, decks, deckNames, picked, onPick, kinds, typeMode, onTypeMode, count, onCount, busy, error,
  flashOnly, onStart, onCreate, onExit }) {
  const pickedTotal = kinds.quiz + kinds.multi;
  const typeAvailable = typeAvailableOf(kinds, typeMode);
  const canStart = decks.length > 0 && picked.size > 0 && typeAvailable > 0;
  const pickedLine = picked.size ? uiFormat('已选 {0} 个题组 · 共 {1} 道选择题', [picked.size, pickedTotal]) : '';
  return (
    <div className="exam-setup">
      {header}
      <ExamSetupCard data-tour="exam-start" title={ui('选择题笔试')}
        intro={ui('从勾选的题组里抽单选 / 多选题，先覆盖不同主题；交卷后统一判分。')}
        steps={[
          ui('勾选要考的题组，选好题型和题数。'),
          uiFormat('点「开始考试」，限时 {0} 分钟，到时自动交卷。', [MINUTES]),
          ui('作答中不显示对错，可以上一题 / 下一题，反复修改。'),
          ui('交卷后看成绩单；答错和没答的题可以一键排进学习路径。'),
          ui('再考一次时，优先抽没考过的题；题库不够时会重复。'),
        ]}
        summary={[uiFormat('{0} 题 · 限时 {1} 分钟', [count, MINUTES]),
          decks.length ? (picked.size ? pickedLine : uiFormat('{0} 个题组可用于模考', [decks.length])) : ''].filter(Boolean).join(' · ')}
        action={<Button variant="primary" busy={busy} disabled={!canStart} onClick={onStart}>
          {busy ? ui('正在出卷…') : decks.length && !picked.size ? ui('先勾选题组') : decks.length && !typeAvailable ? ui('没有符合题型的题') : ui('开始考试')}
        </Button>}>
        {data?.focus?.mode === 'interview' && data.focus.role && <p className="es-note"><Icon name="info" size={16} />
          <span>{uiFormat('目标岗位：{0}。本次按上方范围和勾选题组出题。', [data.focus.role])}</span></p>}
        {decks.length ? (
          <>
            <div className="es-section">
              <div className="es-section__head">
                <div>
                  <strong>{ui('选题组')}</strong>
                  <small>{pickedLine || ui('至少勾选一个题组')}</small>
                </div>
                <div className="es-tools">
                  <Button size="sm" variant="quiet" disabled={picked.size === decks.length} onClick={() => onPick(new Set(decks.map((deck) => deck.id)))}>{ui('全选')}</Button>
                  <Button size="sm" variant="quiet" disabled={!picked.size} onClick={() => onPick(new Set())}>{ui('清空')}</Button>
                </div>
              </div>
              <ul className="es-decks">
                {decks.map((deck) => (
                  <li key={deck.id}>
                    <label className={'es-deck' + (picked.has(deck.id) ? ' is-checked' : '')}>
                      <input type="checkbox" checked={picked.has(deck.id)}
                        onChange={(event) => onPick((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(deck.id); else next.delete(deck.id);
                          return next;
                        })} />
                      <span className="es-deck__name">
                        <strong title={deck.title}>{deckNames[deck.id] || deck.title}</strong>
                        <small>{uiFormat('单选 {0} · 多选 {1}', [deck.examQuizCount || 0, deck.examMultiCount || 0])}</small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
            <div className="exam-type-settings">
              <strong>{ui('题型')}</strong>
              <SegmentedControl label={ui('考试题型')} value={typeMode} onChange={onTypeMode}
                options={Object.entries(EXAM_KIND_LABELS).map(([value, label]) => ({ value, label: ui(label) }))} />
              <small className="muted">{uiFormat('已选题组：单选 {0} 道，多选 {1} 道。均衡模式尽量各占一半，不足时由另一类补齐。', [kinds.quiz, kinds.multi])}</small>
              {picked.size > 0 && !typeAvailable && <InlineMessage tone="warning">{ui('所选题组没有这种题型，请换题型或题组。')}</InlineMessage>}
            </div>
            <CountField value={count} presets={[5, 10, 20]} min={QUESTION_COUNT.min} max={QUESTION_COUNT.max} onChange={onCount}
              hint={picked.size && !typeAvailable
                ? ui('当前题型可选 0 道')
                : picked.size && typeAvailable < count
                  ? uiFormat('符合题型的题只有 {0} 道，将全部出题', [typeAvailable])
                  : uiFormat('{0}–{1} · 默认 {2}', [QUESTION_COUNT.min, QUESTION_COUNT.max, DEFAULT_COUNT])} />
          </>
        ) : (
          <div className="es-empty">
            <strong>{ui('还没有可以模考的选择题')}</strong>
            <p>{flashOnly
              ? ui('现有题组都是闪卡。模拟考试只抽单选 / 多选题，创建题组时勾选选择题题型即可。')
              : ui('模拟考试从题组里抽单选 / 多选题。先创建一个包含选择题的题组，再回来生成试卷。')}</p>
            {onCreate && <Button variant="secondary" icon="plus" onClick={onCreate}>{ui('创建题组')}</Button>}
            {data?.decks?.length > 0 && <Button variant="quiet" onClick={onExit}>{ui('去学习库')}</Button>}
          </div>
        )}
      </ExamSetupCard>
      {recent}
      {error && <ErrorState error={error} />}
    </div>
  );
}
