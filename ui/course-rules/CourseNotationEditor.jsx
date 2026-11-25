import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Hint, IconButton, TextInput } from '../components/index.js';
import { NOTATION_OVERRIDE_LIMITS } from '../../lib/courses.js';

/* Manual course notation overrides (`course.notationOverrides`, 5.0.0 Evolution 2 #6) inside
   CourseSettings › 更多设置 › 符号与术语口径. Always takes highest priority over outline auto-extracted
   `notationLedger` (slides/exam > textbook > live). Saved atomically via `course.save`. */

const splitAliases = raw => String(raw ?? '').split(/[,，;；、\n]/).map(s => s.trim()).filter(Boolean);
const normKey = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function mergePendingNotationDraft(overrides = [], draft = {}) {
  const canonical = String(draft.canonical ?? '').trim();
  const symbol = String(draft.symbol ?? '').trim();
  const aliases = splitAliases(draft.aliases).join('; ');
  const meaning = String(draft.meaning ?? '').trim();
  if (!canonical && !symbol && !aliases && !meaning) return { status: 'empty', next: overrides };
  if (!canonical) return { status: 'invalid', reason: ui('「符号与术语口径」里还有未提交的草稿，请先补全「规范名称」或清空后再保存。'), next: overrides };
  if (overrides.some(item => normKey(item.canonical) === normKey(canonical))) {
    return { status: 'invalid', reason: ui('已经有这条规范名称'), next: overrides };
  }
  if (overrides.length >= NOTATION_OVERRIDE_LIMITS.max) {
    return { status: 'invalid', reason: uiFormat('最多 {0} 条口径覆写', [NOTATION_OVERRIDE_LIMITS.max]), next: overrides };
  }
  return { status: 'merged', next: [...overrides, { canonical, symbol, aliases, meaning }] };
}

export default function CourseNotationEditor({ value = [], onChange, disabled = false, draftRef }) {
  const [canonical, setCanonical] = useState('');
  const [symbol, setSymbol] = useState('');
  const [aliases, setAliases] = useState('');
  const [meaning, setMeaning] = useState('');

  if (draftRef) {
    const draftObj = { canonical, symbol, aliases, meaning };
    draftRef.current = {
      hasDraft: Boolean(canonical.trim() || symbol.trim() || aliases.trim() || meaning.trim()),
      resolve: (current = value) => mergePendingNotationDraft(current, draftObj),
      clear: () => { setCanonical(''); setSymbol(''); setAliases(''); setMeaning(''); },
    };
  }

  const trimmed = canonical.trim();
  const duplicate = Boolean(trimmed) && value.some(item => normKey(item.canonical) === normKey(trimmed));
  const full = value.length >= NOTATION_OVERRIDE_LIMITS.max;
  const canAdd = Boolean(trimmed) && !duplicate && !full;

  const add = () => {
    if (!canAdd) return;
    onChange([
      ...value,
      {
        canonical: trimmed,
        symbol: symbol.trim(),
        aliases: splitAliases(aliases).join('; '),
        meaning: meaning.trim(),
      },
    ]);
    setCanonical('');
    setSymbol('');
    setAliases('');
    setMeaning('');
  };

  const patch = (index, field, nextVal) =>
    onChange(value.map((item, at) => (at === index ? { ...item, [field]: nextVal } : item)));

  const onEnter = event => {
    if (event.key === 'Enter' && !event.nativeEvent?.isComposing && canAdd) {
      event.preventDefault();
      add();
    }
  };

  return (
    <div className="course-notation" data-course-notation="">
      <Hint>{ui('统一这门课在复习全书、出题、伴学与带学里的术语和符号写法。这里手动指定的口径优先级最高，高于课件/样卷、教材和课堂实录自动归并的结果。')}</Hint>
      {value.length > 0 ? (
        <ol className="course-notation__list">
          {value.map((entry, index) => (
            <li key={index} className="course-notation__row">
              <div className="course-notation__fields">
                <TextInput
                  value={entry.canonical}
                  maxLength={NOTATION_OVERRIDE_LIMITS.canonicalChars}
                  disabled={disabled}
                  aria-label={uiFormat('第 {0} 条规范名称', [index + 1])}
                  placeholder={ui('规范名称')}
                  onChange={event => patch(index, 'canonical', event.target.value)}
                />
                <TextInput
                  value={entry.symbol}
                  maxLength={NOTATION_OVERRIDE_LIMITS.symbolChars}
                  disabled={disabled}
                  aria-label={uiFormat('第 {0} 条符号', [index + 1])}
                  placeholder={ui('符号（选填）')}
                  onChange={event => patch(index, 'symbol', event.target.value)}
                />
                <TextInput
                  value={entry.aliases}
                  maxLength={NOTATION_OVERRIDE_LIMITS.aliasChars * 2}
                  disabled={disabled}
                  aria-label={uiFormat('第 {0} 条别名', [index + 1])}
                  placeholder={ui('别名（分号分隔，选填）')}
                  onChange={event => patch(index, 'aliases', event.target.value)}
                />
                <TextInput
                  value={entry.meaning}
                  maxLength={NOTATION_OVERRIDE_LIMITS.meaningChars}
                  disabled={disabled}
                  aria-label={uiFormat('第 {0} 条含义', [index + 1])}
                  placeholder={ui('简明含义（选填）')}
                  onChange={event => patch(index, 'meaning', event.target.value)}
                />
              </div>
              <IconButton
                icon="close"
                size="sm"
                label={uiFormat('删除第 {0} 条口径', [index + 1])}
                disabled={disabled}
                onClick={() => onChange(value.filter((_, at) => at !== index))}
              />
            </li>
          ))}
        </ol>
      ) : (
        <Hint>{ui('还没有手动口径覆写；未设置时自动按「课件/样卷 > 教材 > 课堂实录」合并。')}</Hint>
      )}
      <div className="course-notation__add">
        <div className="course-notation__fields">
          <TextInput
            value={canonical}
            maxLength={NOTATION_OVERRIDE_LIMITS.canonicalChars}
            disabled={disabled}
            aria-label={ui('新规范名称')}
            placeholder={ui('规范名称，例如 一致收敛')}
            onChange={event => setCanonical(event.target.value)}
            onKeyDown={onEnter}
          />
          <TextInput
            value={symbol}
            maxLength={NOTATION_OVERRIDE_LIMITS.symbolChars}
            disabled={disabled}
            aria-label={ui('新符号')}
            placeholder={ui('符号（选填），例如 f_n => f')}
            onChange={event => setSymbol(event.target.value)}
            onKeyDown={onEnter}
          />
          <TextInput
            value={aliases}
            maxLength={NOTATION_OVERRIDE_LIMITS.aliasChars * 2}
            disabled={disabled}
            aria-label={ui('新别名')}
            placeholder={ui('别名（分号分隔，选填）')}
            onChange={event => setAliases(event.target.value)}
            onKeyDown={onEnter}
          />
          <TextInput
            value={meaning}
            maxLength={NOTATION_OVERRIDE_LIMITS.meaningChars}
            disabled={disabled}
            aria-label={ui('新含义')}
            placeholder={ui('简明含义（选填）')}
            onChange={event => setMeaning(event.target.value)}
            onKeyDown={onEnter}
          />
        </div>
        <Button size="sm" variant="secondary" icon="plus" disabled={disabled || !canAdd} onClick={add}>
          {ui('添加口径')}
        </Button>
      </div>
      {duplicate && <p className="muted small" role="status">{ui('已经有这条规范名称')}</p>}
      {full && !duplicate && <p className="muted small" role="status">{uiFormat('最多 {0} 条口径覆写', [NOTATION_OVERRIDE_LIMITS.max])}</p>}
    </div>
  );
}
