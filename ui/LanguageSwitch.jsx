import React from 'react';
import { ui } from './i18n.js';
import { SegmentedControl } from './components/index.js';
import Icon from './Icon.jsx';
import NavGlyph from './NavGlyph.jsx';

/* The sidebar's interface-language switch (WP14): one row the height of a nav
   item — "语言" with a small segmented control. The 62 px icon rail gets one
   small toggle showing the current language instead. Language names are not
   translated: each is written in its own language. */
const NAMES = { zh: '中文', en: 'English' };
const OPTIONS = [{ value: 'zh', label: '中文' }, { value: 'en', label: 'EN' }];

export default function LanguageSwitch({ language = 'zh', narrow = false, onChange }) {
  const name = ui('Interface language / 界面语言');
  if (narrow) {
    const next = language === 'zh' ? 'en' : 'zh';
    return <button type="button" className="nav study-language-toggle" data-usage="nav.language" aria-label={`${name}: ${NAMES[language] || language}`}
      title={`${name}: ${NAMES[language] || language} → ${NAMES[next]}`} onClick={() => onChange?.(next)}>
      <span className="study-language-toggle__code" aria-hidden="true">{language === 'zh' ? '中' : 'EN'}</span>
    </button>;
  }
  return <div className="study-language-switch" data-usage="nav.language">
    <Icon><NavGlyph name="language" /></Icon>
    <span className="study-language-switch__label" aria-hidden="true">{ui('语言')}</span>
    <SegmentedControl size="sm" label={name} value={language} options={OPTIONS} onChange={onChange} />
  </div>;
}
