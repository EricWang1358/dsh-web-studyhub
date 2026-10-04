import React, { useEffect, useState } from 'react';
import { ui } from '../i18n.js';
import { APPEARANCE_LABELS, APPEARANCE_OPTIONS } from '../appearance-prefs.js';
import { FONT_NAME_MAX, cleanFontName } from '../font-presets.js';
import { Button, Field, InlineMessage, SegmentedControl, SettingsSection, TextArea, TextInput } from '../components/index.js';

/** The choices of one appearance setting, from the module's own lists (so a new value shows up here by itself). */
const appearanceOptions = (kind) => APPEARANCE_OPTIONS[kind].map((value) => {
  const label = APPEARANCE_LABELS[kind]?.[value];
  return { value, label: label ? ui(label) : kind === 'scale' ? `${value}%` : String(value) };
});

/** The name of a font installed on this computer (the `custom` typeface), typed. Only a name that passes cleanFontName is applied; anything
 *  else says so and changes nothing. */
function CustomFontField({ value, onChange }) {
  const [draft, setDraft] = useState(value), clean = cleanFontName(draft), invalid = draft.trim() && !clean;
  useEffect(() => { setDraft((text) => (cleanFontName(text) === value ? text : value)); }, [value]);
  return (
    <Field hint={invalid ? undefined : ui('填已安装的字体名，找不到会用系统字体。')} error={invalid ? ui('字体名只能含文字、数字、空格和连字符。') : undefined}>
      <TextInput value={draft} maxLength={FONT_NAME_MAX + 8} spellCheck={false} aria-label={ui('本机字体')}
        onChange={(event) => { setDraft(event.target.value); if (!event.target.value.trim() || cleanFontName(event.target.value)) onChange(cleanFontName(event.target.value)); }} />
    </Field>
  );
}

/** 恢复默认外观, and the whole look as one small piece of text to carry to another computer: export fills the box, import reads it back
 *  through the same whitelist. */
function AppearanceBackup({ appearance }) {
  const [text, setText] = useState(''), [note, setNote] = useState(null);
  return (
    <div className="appearance-backup">
      <div className="settings-actions">
        <Button variant="quiet" onClick={() => { appearance.onReset(); setNote({ tone: 'success', text: ui('已恢复默认外观。') }); }}>{ui('恢复默认外观')}</Button>
        {appearance.onExport && <Button icon="download" onClick={() => { setText(appearance.onExport()); setNote({ tone: 'success', text: ui('已导出，可以复制保存。') }); }}>{ui('导出外观')}</Button>}
        {appearance.onImport && <Button icon="upload" disabled={!text.trim()}
          onClick={() => setNote(appearance.onImport(text) ? { tone: 'success', text: ui('已应用这份外观设置。') } : { tone: 'error', text: ui('这不是 StudyHub 的外观设置，没有改动。') })}>{ui('导入外观')}</Button>}
      </div>
      {appearance.onImport && <Field width="full"><TextArea rows={2} spellCheck={false} value={text} onChange={(event) => { setText(event.target.value); setNote(null); }} onFocus={(event) => event.target.select()}
        aria-label={ui('外观设置（一小段文字，可粘贴到另一台电脑）')} placeholder={ui('外观设置（一小段文字，可粘贴到另一台电脑）')} /></Field>}
      {note && <InlineMessage tone={note.tone}>{note.text}</InlineMessage>}
    </div>
  );
}

/** One appearance choice: a label, the segmented control and an optional hint. */
const Choice = ({ label, hint, value, onChange, kind }) => (
  <Field group label={label} hint={hint} width="full">
    <SegmentedControl label={label} value={value} onChange={onChange} options={appearanceOptions(kind)} />
  </Field>
);

/** The interface language and appearance, the same two switches as the sidebar's, for people who look for them here. */
export default function AppearanceSection({ appearance }) {
  if (!appearance) return null;
  return (
    <SettingsSection className="appearance-settings" title={ui('界面')}>
      <Field group label={ui('界面语言')} width="full">
        <SegmentedControl label={ui('界面语言')} value={appearance.language} onChange={appearance.onLanguage}
          options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} />
      </Field>
      <Choice label={ui('外观')} value={appearance.theme} onChange={appearance.onTheme} kind="theme" />
      {appearance.onAccent && <Choice label={ui('强调色')} value={appearance.accent} onChange={appearance.onAccent} kind="accent" />}
      {appearance.onScale && <Choice label={ui('界面大小')} value={appearance.scale} onChange={appearance.onScale} kind="scale"
        hint={ui('放大整个界面（文字、按钮和间距一起），最大 200%。阅读和做题页另有 Aa 可以单独调字号和宽度。')} />}
      {appearance.onFont && <Choice label={ui('界面字体')} value={appearance.font} onChange={appearance.onFont} kind="font" />}
      {appearance.onFont && appearance.font === 'custom' && appearance.onFontCustom && <CustomFontField value={appearance.fontCustom || ''} onChange={appearance.onFontCustom} />}
      {appearance.onFontTitle && <Choice label={ui('标题字体')} value={appearance.fontTitle} onChange={appearance.onFontTitle} kind="fontTitle" />}
      {appearance.onMotion && <Choice label={ui('动画')} value={appearance.motion} onChange={appearance.onMotion} kind="motion"
        hint={ui('减弱只保留很短的淡入淡出；无动画则不再有页面切换和卡片动画（转圈提示仍会转）。页面切换卡顿时可以试试。')} />}
      {appearance.onContrast && <Choice label={ui('对比度')} value={appearance.contrast} onChange={appearance.onContrast} kind="contrast"
        hint={ui('高对比会加深边框和次要文字、加粗焦点框；跟随系统时遵循系统的“增加对比度”设置。')} />}
      {appearance.onDensity && <Choice label={ui('界面密度')} value={appearance.density} onChange={appearance.onDensity} kind="density" hint={ui('密度只改间距和行距，不改字号。')} />}
      {appearance.onRadius && <Choice label={ui('圆角')} value={appearance.radius} onChange={appearance.onRadius} kind="radius" />}
      {appearance.onReset && <AppearanceBackup appearance={appearance} />}
    </SettingsSection>
  );
}
