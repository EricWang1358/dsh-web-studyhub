import React, { useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, InlineConfirm, InlineMessage, Tooltip } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { GENERATION_RULE_LIMITS, addGenerationRule, canAddGenerationRule } from '../../lib/course-rules.js';

/* 「设为本课守则」 (#889): a line from the 修题 box or the rules a 👎 tag stands for become rules of the question's course. Nothing is saved before the learner has
   seen which course and which rules: the confirmation lists them, says what cannot be added and why, and only 加为守则 writes. `courseRules` is
   ui/course-rules/use-course-rules.js ({ course, rules, add }). */
const WHY = {
  saved: () => ui('已经是这门课的出题守则'),
  long: () => uiFormat('超过 {0} 字，不能设为出题守则', [GENERATION_RULE_LIMITS.length]),
  full: () => uiFormat('这门课已有 {0} 条出题守则，先在课程设置里删掉一条', [GENERATION_RULE_LIMITS.count]),
};

/** What `texts` would add to `rules`: the rules that would be added, in order, and the texts that cannot be, with the reason. */
export function rulePlan(rules, texts) {
  let list = rules;
  const adding = [], refused = [];
  for (const text of texts) {
    const check = canAddGenerationRule(list, text);
    if (check.ok) { list = addGenerationRule(list, text); adding.push(String(text).trim()); }
    else if (check.reason !== 'empty') refused.push({ text: String(text).trim(), reason: check.reason });
  }
  return { adding, refused };
}

const clip = (text) => ([...text].length > 40 ? `${[...text].slice(0, 40).join('')}…` : text);

/** The confirmation itself: the course, the rules to be added, what cannot be added; 加为守则 / 取消. `onClose` after a save or a cancel. */
export function CourseRuleConfirm({ courseRules, texts, onClose, returnFocusRef }) {
  const [working, setWorking] = useState(false);
  const { course, rules, add } = courseRules;
  const { adding, refused } = rulePlan(rules, texts);
  const reasons = refused.map(({ text, reason }) => <p key={text} className="muted small">{`「${clip(text)}」：${WHY[reason]()}`}</p>);
  if (!adding.length) return <InlineMessage tone="info" className="course-rule-confirm" action={{ label: ui('知道了'), onClick: onClose }}>{reasons}</InlineMessage>;
  const confirm = async () => {
    setWorking(true);
    const saved = await add(adding);
    setWorking(false);
    if (saved) onClose();
  };
  return (
    <InlineConfirm tone="primary" className="course-rule-confirm" title={uiFormat('加为「{0}」的出题守则？', [course])} confirmLabel={ui('加为守则')}
      busy={working} returnFocusRef={returnFocusRef} onConfirm={confirm} onCancel={onClose} data-course-rule-confirm="">
      <ul className="course-rule-confirm__list">{adding.map((text) => <li key={text}>{text}</li>)}</ul>
      {reasons}
      <p className="muted small">{ui('以后给这门课出题，规划、出题和审阅都会照这几条来；可以在课程设置的「更多设置 › 出题守则」里改或删。')}</p>
    </InlineConfirm>
  );
}

/** Under the 修题 box: 「设为本课守则」 for the typed text, then the confirmation. Nothing while the box is empty or the question has no course. */
export function CourseRuleAdd({ courseRules, text }) {
  const { busy } = useStudy();
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  if (!courseRules?.course || !String(text ?? '').trim()) return null;
  if (open) return <CourseRuleConfirm courseRules={courseRules} texts={[text]} returnFocusRef={trigger} onClose={() => setOpen(false)} />;
  return (
    <Tooltip content={ui('把这句话存成这门课的出题守则：以后给这门课出题都会带上')}>
      <Button ref={trigger} variant="link" size="sm" align="start" data-usage="review.course-rule" lock={busy} onClick={() => setOpen(true)}>{ui('设为本课守则')}</Button>
    </Tooltip>
  );
}
