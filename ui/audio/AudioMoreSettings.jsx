import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Disclosure, Hint } from '../components/index.js';
import CourseField from '../CourseField.jsx';
import { joinMeta } from '../format.js';

/* 音频导入, 更多设置: everything optional about a recording in one fold that opens by itself only when it carries something (or the import is a
   recovery). The name, what it covers and the terms are asked about this recording only; 只用付费密钥 starts from the learner's default (Settings > 音频转写).
   The course is the add-material dialog's own line; this form asks for it only when it stands alone on its page (`course` is given then). */
export default function AudioMoreSettings({ values, defaultPaid = false, course, courses = [], disabled, open, onToggle, onChange, onSettings }) {
  const { title = '', subject = '', terms = '', paidOnly = defaultPaid } = values;
  const termCount = terms.split(/[\n,，、;；]+/).map(term => term.trim()).filter(Boolean).length;
  const meta = joinMeta([title.trim(), subject.trim(), termCount ? uiFormat('{0} 个术语', [termCount]) : '', paidOnly ? ui('只用付费密钥') : '']);
  return (
    <Disclosure className="audio-more" summary={ui('更多设置')} meta={meta || ui('名称 · 术语 · 付费密钥')} open={open} onToggle={onToggle}>
      <label>{ui('逐字稿名称（可选）')}<input value={title} onChange={event => onChange({ title: event.target.value })} disabled={disabled} maxLength={200} /></label>
      <label>{ui('这段音频讲什么（可选，帮助纠正术语）')}
        <input value={subject} onChange={event => onChange({ subject: event.target.value })} disabled={disabled} maxLength={300}
          placeholder={ui('例如：SQL 数据库课程，讲事务、分区和索引')} />
      </label>
      <label>{ui('术语表（可选，逗号或换行分隔）')}
        <textarea value={terms} onChange={event => onChange({ terms: event.target.value })} disabled={disabled} rows={2}
          placeholder={ui('例如：partition, ACID, VARCHAR, PostgreSQL')} />
      </label>
      {course !== undefined && <CourseField courses={courses} value={course} onChange={value => onChange({ course: value })} multiple disabled={disabled} label={ui('所属课程（用它的主题词辅助校对）')} />}
      <Checkbox checked={paidOnly} onChange={value => onChange({ paidOnly: value })} disabled={disabled}
        label={ui('只用付费密钥（免费额度下，Google 可能用内容改进产品）')} />
      <Hint>{ui('课程里已有题组的标题和知识点，会自动用来纠正术语。')}</Hint>
      {onSettings && <Hint>{ui('「只用付费密钥」的默认值可以在设置里修改。')}{' '}<Button variant="link" size="sm" onClick={onSettings}>{ui('前往设置')}</Button></Hint>}
    </Disclosure>
  );
}
