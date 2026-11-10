import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Hint, IconButton, TextInput } from '../components/index.js';
import { GENERATION_RULE_LIMITS, canAddGenerationRule } from '../../lib/course-rules.js';

/* 出题守则 (#889) in the course settings (ui/CourseSettings.jsx, 更多设置): the course's rules, each editable in place and with its own delete, and a line to add
   one more. `value` is the list being edited; the panel's 保存课程信息 saves it with the rest of the course (course.save, which trims, drops empty lines and
   duplicates, and refuses more than 12 or a line over 200 characters). */
const WHY = {
  saved: () => ui('已经有这条守则'),
  long: () => uiFormat('每条最多 {0} 字', [GENERATION_RULE_LIMITS.length]),
  full: () => uiFormat('最多 {0} 条，先删掉一条', [GENERATION_RULE_LIMITS.count]),
};

export default function CourseRulesEditor({ value, onChange, disabled }) {
  const [text, setText] = useState('');
  const check = canAddGenerationRule(value, text);
  const add = () => { if (!check.ok) return; onChange([...value, text.trim()]); setText(''); };
  return (
    <div className="course-rules" data-course-rules="">
      <Hint>{uiFormat('给这门课出题时，规划、出题和审阅都会照这些守则来，每次出题前的「预览生效要求」里也能看到。每条一句话，最多 {0} 条；改了守则，之前审阅过的草稿原来的审阅就不再算数。', [GENERATION_RULE_LIMITS.count])}</Hint>
      {value.length > 0 ? <ol className="course-rules__list">
        {value.map((rule, index) => <li key={index} className="course-rules__row">
          <TextInput className="course-rules__input" value={rule} maxLength={GENERATION_RULE_LIMITS.length} disabled={disabled} aria-label={uiFormat('第 {0} 条守则', [index + 1])}
            onChange={(event) => onChange(value.map((item, at) => at === index ? event.target.value : item))} />
          <IconButton icon="close" size="sm" label={uiFormat('删除第 {0} 条守则', [index + 1])} disabled={disabled} onClick={() => onChange(value.filter((_, at) => at !== index))} />
        </li>)}
      </ol> : <Hint>{ui('还没有守则。练习时在「修题」框或 👎 的标签旁点「设为本课守则」，也会加到这里。')}</Hint>}
      <div className="course-rules__add">
        <TextInput className="course-rules__input" value={text} maxLength={GENERATION_RULE_LIMITS.length} disabled={disabled} aria-label={ui('新守则')}
          placeholder={ui('例如：题干要自带情境和条件，不出只有一句空问的题')} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); add(); } }} />
        <Button size="sm" variant="secondary" icon="plus" disabled={disabled || !check.ok} onClick={add}>{ui('添加守则')}</Button>
      </div>
      {!check.ok && check.reason !== 'empty' && <p className="muted small" role="status">{WHY[check.reason]()}</p>}
    </div>
  );
}
