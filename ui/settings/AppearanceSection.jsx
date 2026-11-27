import React, { useEffect, useState } from 'react';
import { ui } from '../i18n.js';
import { APPEARANCE_LABELS, APPEARANCE_OPTIONS } from '../appearance-prefs.js';
import { FONT_NAME_MAX, cleanFontName } from '../font-presets.js';
import { Button, Disclosure, Field, Hint, InlineMessage, SegmentedControl, SettingsSection, Switch, TextInput } from '../components/index.js';
import { useLiteViewSetting } from '../use-lite-view.js';
import { playSound, playSoundPreview, stopSoundPreview } from '../sound-effects.js';
import AppearanceTransfer from './AppearanceTransfer.jsx';

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

/** 恢复默认外观: always in the open, because a size or a font that went wrong is what the learner needs it for. */
function AppearanceReset({ onReset }) {
  const [note, setNote] = useState(null);
  return (
    <div className="appearance-backup" data-tour="settings-appearance-reset">
      <div className="settings-actions"><Button variant="quiet" icon="undo" className="appearance-reset" onClick={() => { onReset(); setNote({ tone: 'success', text: ui('已恢复默认外观。') }); }}>{ui('恢复默认外观')}</Button></div>
      <Hint>{ui('恢复外观与音效（含折叠内选项），不改界面语言。')}</Hint>
      {note && <InlineMessage tone={note.tone}>{note.text}</InlineMessage>}
    </div>
  );
}

/** 简洁版 (ui/lite-view.js), at the top of the section. It is a choice of this browser with its own key, so 恢复默认外观 below does not reach it. */
function LiteViewSwitch() {
  const [on, setOn] = useLiteViewSetting();
  return (
    <div data-tour="settings-appearance-lite">
      <Switch name="lite-view" data-usage="settings.lite-view" label={ui('简洁版')} checked={on} onChange={setOn}
        hint={ui('侧栏和首页只留练题常用的部分，其余页面仍在「更多」里；不删数据，也不改复习安排。')} />
    </div>
  );
}

/** One appearance choice: a label, the segmented control and an optional hint. */
const Choice = ({ label, hint, value, onChange, kind, ...rest }) => (
  <Field group label={label} hint={hint} width="full" {...rest}>
    <SegmentedControl label={label} value={value} onChange={onChange} options={appearanceOptions(kind)} />
  </Field>
);

/** The interface language and appearance, the same two switches as the sidebar's, for people who look for them here. Open: language, look, accent colour, size, sound effects (and 恢复默认外观); the rest (typefaces, animation, contrast, density, corners, carrying the look to another computer) is behind 更多外观选项. */
export default function AppearanceSection({ appearance }) {
  if (!appearance) return null;
  return (
    <SettingsSection className="appearance-settings" tour="settings-appearance" title={ui('界面')}>
      <LiteViewSwitch />
      <Field group label={ui('界面语言')} width="full" data-tour="settings-appearance-language">
        <SegmentedControl label={ui('界面语言')} value={appearance.language} onChange={appearance.onLanguage}
          options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} />
      </Field>
      <Choice data-tour="settings-appearance-theme" label={ui('外观')} value={appearance.theme} onChange={appearance.onTheme} kind="theme" />
      {appearance.onAccent && <Choice data-tour="settings-appearance-accent" label={ui('强调色')} value={appearance.accent} onChange={appearance.onAccent} kind="accent" />}
      {appearance.onScale && <Choice data-tour="settings-appearance-scale" label={ui('界面大小')} value={appearance.scale} onChange={appearance.onScale} kind="scale"
        hint={ui('放大整个界面（文字、按钮和间距一起），最大 200%；「跟随窗口」在窗口变宽时自动放大一些。阅读和做题页另有 Aa 可以单独调字号和宽度。')} />}
      {appearance.onSound && (
        <Field group label={ui('互动音效')} width="full" data-tour="settings-appearance-sound"
          hint={ui('翻面、判分和完成一轮时的纸木轻响；选「标准」时，点选多选项和标重点也有轻触声。录音或课堂实录时自动静音。')}>
          <div className="appearance-sound-row">
            <SegmentedControl label={ui('互动音效')} value={appearance.sound || 'off'}
              onChange={(value) => {
                appearance.onSound(value);
                if (!value || value === 'off') stopSoundPreview();
                else {
                  stopSoundPreview();
                  playSound(value === 'standard' ? 'tap' : 'flip', { mode: value });
                }
              }}
              options={appearanceOptions('sound')} />
            <Button variant="quiet" size="sm" icon="play" className="appearance-sound-preview"
              onClick={() => playSoundPreview(appearance.sound)}>
              {ui('试听')}
            </Button>
          </div>
        </Field>
      )}
      {appearance.onReset && <AppearanceReset onReset={appearance.onReset} />}
      <Disclosure className="appearance-more settings-disclosure" summaryClassName="settings-disclosure__summary" bodyClassName="settings-disclosure__body"
        summary={ui('更多外观选项')} meta={ui('字体、动画、对比度等')}>
      {appearance.onFont && <Choice data-tour="settings-appearance-font" label={ui('界面字体')} value={appearance.font} onChange={appearance.onFont} kind="font" />}
      {appearance.onFont && appearance.font === 'custom' && appearance.onFontCustom && <CustomFontField value={appearance.fontCustom || ''} onChange={appearance.onFontCustom} />}
      {appearance.onFontTitle && <Choice label={ui('标题字体')} value={appearance.fontTitle} onChange={appearance.onFontTitle} kind="fontTitle"
        hint={appearance.font && appearance.font !== 'system'
          ? ui('可让标题跟随上方所选的界面字体，或继续保持系统默认字体。')
          : ui('修改上方「界面字体」后生效；当前使用系统默认字体时切换不会有视觉变化。')} />}
      {appearance.onMotion && <Choice data-tour="settings-appearance-motion" label={ui('动画')} value={appearance.motion} onChange={appearance.onMotion} kind="motion"
        hint={ui('减弱只保留很短的淡入淡出；无动画则不再有页面切换和卡片动画（转圈提示仍会转）。页面切换卡顿时可以试试。')} />}
      {appearance.onContrast && <Choice data-tour="settings-appearance-contrast" label={ui('对比度')} value={appearance.contrast} onChange={appearance.onContrast} kind="contrast"
        hint={ui('高对比会加深边框和次要文字、加粗焦点框；跟随系统时遵循系统的“增加对比度”设置。')} />}
      {appearance.onDensity && <Choice data-tour="settings-appearance-density" label={ui('界面密度')} value={appearance.density} onChange={appearance.onDensity} kind="density" hint={ui('密度只改间距和行距，不改字号。')} />}
      {appearance.onRadius && <Choice data-tour="settings-appearance-radius" label={ui('圆角')} value={appearance.radius} onChange={appearance.onRadius} kind="radius" />}
      {appearance.onCraft && <Choice data-tour="settings-appearance-craft" label={ui('控件与字阶')} value={appearance.craft} onChange={appearance.onCraft} kind="craft"
        hint={ui('更偏紧凑工具风格：按钮更矮、顶栏和说明字稍小、浅色下边框更清晰；可与上方密度和圆角叠加。「标准」保持原版设计不变。')} />}
      <AppearanceTransfer appearance={appearance} />
      </Disclosure>
    </SettingsSection>
  );
}
