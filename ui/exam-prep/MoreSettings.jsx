import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Disclosure, Field, Icon, SegmentedControl, TextInput } from '../components/index.js';
import { joinMeta } from '../format.js';
import CourseField from '../CourseField.jsx';
import Explain from './Explain.jsx';

/* 备考补习, 更多设置: everything optional about a new list in one fold that stays closed unless it carries values. The name, the list language and
   the other-course switch start from the learner's defaults (Settings > 备考补习), which this fold links to. */

const languageName = language => ({ zh: ui('中文'), en: 'English' })[language] ?? ui('自动');

export default function MoreSettings({ form, title, courses, hideCourse, disabled, open, onToggle, onChange, onReading, onSettings, problems }) {
  const reading = form.reading || {};
  const note = (field, label, maxLength) => (
    <Field label={label}>
      <TextInput value={reading[field] || ''} maxLength={maxLength} disabled={disabled} onChange={event => onReading(field, event.target.value)} />
    </Field>
  );
  return (
    <Disclosure className="exam-prep-more" summary={ui('更多设置')} meta={joinMeta([title, languageName(form.language)])} open={open} onToggle={onToggle}>
      <div className="exam-prep-form__fields">
        <Field label={ui('名称')} hint={ui('不填就用默认名称')}>
          <TextInput value={form.title} placeholder={title} maxLength={200} disabled={disabled} onChange={event => onChange({ title: event.target.value })} />
        </Field>
        <Field label={ui('范围（可选）')} hint={ui('这份清单覆盖的章节或考试，例如「传输层」')}>
          <TextInput value={form.scope} maxLength={200} disabled={disabled} onChange={event => onChange({ scope: event.target.value })} />
        </Field>
        {!hideCourse && <CourseField value={form.course} onChange={course => onChange({ course })} courses={courses} disabled={disabled} label={ui('课程')} />}
        <Field label={ui('清单语言')} group hint={ui('「自动」跟随界面语言。')}>
          <SegmentedControl size="sm" label={ui('清单语言')} value={form.language || 'auto'} disabled={disabled} onChange={language => onChange({ language })}
            options={[{ value: 'auto', label: ui('自动') }, { value: 'zh', label: ui('中文') }, { value: 'en', label: 'English' }]} />
        </Field>
        <Field label={ui('其它课程的资料')} group hint={ui('打开后，上面的表格也会列出其它课程的资料（默认不用）。')}>
          <SegmentedControl size="sm" label={ui('其它课程的资料')} value={form.others ? 'on' : 'off'} disabled={disabled}
            onChange={value => onChange({ others: value === 'on' })}
            options={[{ value: 'off', label: ui('不显示') }, { value: 'on', label: ui('显示') }]} />
        </Field>
      </div>
      <fieldset className="exam-prep-reading" data-role="textbook">
        <legend className="exam-prep-reading__head">
          <span>{ui('推荐教材')}</span>
          <Explain k="role.textbook" focusable label={uiFormat('「{0}」是什么', [ui('推荐教材')])}><Icon name="info" size={16} /></Explain>
        </legend>
        <div className="exam-prep-form__fields">
          {note('title', ui('书名'), 200)}
          {note('author', ui('作者'), 200)}
          <Field label={ui('网址')} error={problems.includes('reading-url') ? ui('网址要以 http:// 或 https:// 开头') : undefined}>
            <TextInput type="url" value={reading.url || ''} maxLength={500} disabled={disabled} onChange={event => onReading('url', event.target.value)} />
          </Field>
          {note('note', ui('备注'), 600)}
        </div>
      </fieldset>
      {onSettings && (
        <p className="exam-prep-more__settings">
          {ui('这些默认值可以在设置里修改')}{' '}
          <Button variant="link" size="sm" onClick={() => onSettings('settings-exam-prep')}>{ui('前往设置')}</Button>
        </p>
      )}
    </Disclosure>
  );
}
