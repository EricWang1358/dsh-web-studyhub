import React, { useId, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import css from './secret-key.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';
import { InlineMessage } from './Feedback.jsx';
import { useAsyncAction } from '../use-async.js';

/* One form for every secret the learner pastes (an API key, a token): paste, save and check it, check a saved one,
   clear it. The key is shown back only as `saved.hint`; a key that comes from an environment variable cannot be cleared
   here (clearing the file would change nothing), and the form says so. */

/** Save a pasted key, then check it (unless the page says not to). `afterSave` runs between the two (the form empties its field there). null for an empty paste. */
export async function submitSecret({ key, onSave, onVerify, verifyAfterSave = true, afterSave }) {
  const clean = String(key ?? '').trim();
  if (!clean) return null;
  const saved = await onSave(clean);
  afterSave?.(saved);
  const result = onVerify && verifyAfterSave ? await onVerify() : null;
  return { saved, result };
}

/** Clear the saved key through the page; an environment key or `canClear: false` is left alone. */
export async function clearSecret({ saved, onClear, canClear = true }) {
  if (canClear === false || saved?.source === 'env') return undefined;
  return onClear();
}

/**
 * name: the input's name; label: its accessible name; placeholder: shown while nothing is saved.
 * saved: { set, hint, source } as the host reports it (source 'env' = from an environment variable).
 * onSave(key): store it (may return the new settings). onVerify(): check the stored key, answering a result that
 * resultText(result) turns into a sentence; { ok } picks the tone. onClear(): forget it. canClear: false hides Clear.
 * verifyAfterSave: false saves without checking. envNote: false when the page explains an environment key itself.
 * saveLabel / verifyLabel / clearLabel rename the buttons. busy: the page is working, so everything waits.
 * initialResult shows a check result at first render (previews and tests). A page that runs the steps itself passes `result` and
 * `working` (the kind that is running) and the form only displays them.
 */
export default function SecretKeyForm({ name, label, placeholder, saved, onSave, onVerify, onClear, canClear = true, resultText, footnote,
  busy = false, primary = true, verifyAfterSave = true, verifyDisabled = false, envNote, saveLabel, verifyLabel, clearLabel, initialResult = null,
  result: shownResult, working: shownWorking, className, ...rest }) {
  useComponentCss(css, 'study-secret-key');
  const [value, setValue] = useState(''), [ownResult, setResult] = useState(initialResult);
  const own = useAsyncAction(), { run, error, clearError } = own;
  const result = shownResult !== undefined ? shownResult : ownResult, working = shownWorking || own.working;
  const messageId = useId(), hasKey = !!saved?.set, hasHint = hasKey && !!saved.hint, fromEnv = saved?.source === 'env';
  const locked = busy || !!working;
  const checks = !!onVerify && verifyAfterSave;
  const save = (event) => {
    event.preventDefault();
    if (!value.trim()) return;
    setResult(null);
    void run('save', async () => {
      const outcome = await submitSecret({ key: value, onSave, onVerify, verifyAfterSave, afterSave: () => setValue('') });
      if (outcome?.result) setResult(outcome.result);
    });
  };
  const verify = () => { setResult(null); void run('verify', async () => { setResult(await onVerify()); }); };
  const clear = () => { setResult(null); void run('clear', () => clearSecret({ saved, onClear, canClear })); };
  const text = result && (resultText ? resultText(result) : result.message);
  const showClear = hasKey && !!onClear && canClear !== false && !fromEnv;
  const note = hasKey && fromEnv && !!onClear && envNote !== false ? (envNote || ui('这个密钥来自环境变量，不能在这里清除；要换掉它，请改系统的环境变量。')) : null;
  return (
    <form className={cx('sh-secret', className)} onSubmit={save} {...rest}>
      <input name={name} className="sh-secret__input" type="password" autoComplete="off" spellCheck={false} value={value} disabled={locked}
        aria-label={label} aria-describedby={result || error ? messageId : undefined}
        placeholder={hasHint ? uiFormat('已保存 {0}；粘贴新的会替换它', [saved.hint]) : placeholder}
        onChange={(event) => { setValue(event.target.value); if (error) clearError(); }} />
      <div className="sh-secret__actions">
        <Button type="submit" variant={primary ? 'primary' : 'secondary'} busy={working === 'save'} disabled={locked || !value.trim()}>
          {saveLabel || (checks ? ui('保存并验证') : ui('保存'))}</Button>
        {hasKey && onVerify && <Button variant="secondary" busy={working === 'verify'} disabled={locked || verifyDisabled} onClick={verify}>{verifyLabel || ui('验证')}</Button>}
        {showClear && <Button variant="quiet" size="sm" className="sh-secret__clear" busy={working === 'clear'} disabled={locked} onClick={clear}>{clearLabel || ui('清除已保存的密钥')}</Button>}
      </div>
      <div className="sh-secret__foot">
        {error ? <InlineMessage id={messageId} tone="error">{error}</InlineMessage>
          : result && <InlineMessage id={messageId} tone={result.ok ? 'success' : 'error'}>{text}</InlineMessage>}
        {note && <p className="sh-secret__note">{note}</p>}
        {footnote}
      </div>
    </form>
  );
}
