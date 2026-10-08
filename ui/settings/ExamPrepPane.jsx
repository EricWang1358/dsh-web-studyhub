import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiIsEnglish, errorMessage } from '../i18n.js';
import { Badge, Button, Chip, Field, Hint, InlineMessage, Select, SettingsSection, Switch, TextInput, useToast } from '../components/index.js';
import { EXAM_PREP_DEFAULTS, EXAM_PREP_LIMITS, checkPaperWord, resolveExamPrepSettings } from '../../lib/exam-prep-settings.js';
import { PAPER_WORDS } from '../../lib/exam-prep-roles.js';

/* 设置 › 备考补习: whether the page is on (the host's switch, read from the snapshot), and the learner's personal defaults for the create form.
   Each control saves at once (settings.examPrep.set); 恢复默认 forgets the saved choices (settings.examPrep.reset). The pane works with the page off. */
const { max: WORDS_MAX, wordMax: WORD_MAX } = EXAM_PREP_LIMITS.paperWords;
// The English page lists the Latin words only (the Chinese ones are matching data, and the sentence says they exist).
const builtIn = () => (uiIsEnglish() ? PAPER_WORDS.filter(word => !/[㐀-鿿]/.test(word)) : PAPER_WORDS);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const LANGUAGES = [{ value: 'auto', label: '自动（跟随界面语言）' }, { value: 'zh', label: '中文' }, { value: 'en', label: 'English' }];
const problems = { long: () => uiFormat('每个关键词最多 {0} 个字符。', [WORD_MAX]), duplicate: () => ui('这个关键词已经在列表里了。'),
  full: () => uiFormat('最多 {0} 个关键词，先移除一个。', [WORDS_MAX]) };

/** Is the page on? When it is off: whose switch it is and where it is. */
export function ExamPrepStatus({ enabled, host }) {
  if (enabled) return <p className="settings-section__lead"><Badge tone="success" icon>{ui('已开启')}</Badge> {ui('备考补习已经开启，可以去「备考补习」页新建考点清单。')}</p>;
  return <InlineMessage tone="info" boxed title={ui('备考补习还没有开启')}
    action={host?.openPluginManager ? { label: ui('打开 DSH 插件管理器'), onClick: () => host.openPluginManager() } : undefined}>
    <span>{ui('这个开关由 DSH 管理，不在这里切换。')} {ui('开关是 StudyHub 运行时（runtime）设置里的 examBlueprint，在 DSH 插件管理器里打开即可。')}</span>
    <span> {ui('下面的个人默认值现在就可以先设好，已保存的考点清单仍可阅读。')}</span>
  </InlineMessage>;
}

/** The learner's own sample-paper words as removable tags, one input to add, and the built-in words read-only below. */
export function PaperWords({ words, disabled, onChange }) {
  const [text, setText] = useState(''), [problem, setProblem] = useState('');
  const add = event => {
    event.preventDefault();
    const check = checkPaperWord(words, text);
    if (!check.word) { setProblem(check.problem === 'empty' ? '' : check.problem); return; }
    setProblem(''); setText(''); onChange([...words, check.word]);
  };
  return <Field group label={ui('额外的样卷关键词')} error={problem ? problems[problem]() : undefined}
    hint={ui('文件名里有这些词、篇幅又不长的资料，会被当作样卷；样卷用来标出样卷考过的考点。不写也可以，内置的词已经够用。')}>
    <div>
      {words.length > 0 && <div className="settings-actions" role="list" aria-label={ui('额外的样卷关键词')}>
        {words.map(word => <Chip key={word} role="listitem" removeLabel={uiFormat('移除「{0}」', [word])}
          onRemove={() => onChange(words.filter(other => other !== word))}>{word}</Chip>)}
      </div>}
      <form className="settings-actions" onSubmit={add}>
        <TextInput name="paperWord" value={text} disabled={disabled} aria-label={ui('新的样卷关键词')}
          placeholder={ui('例如：练习卷')} onChange={event => { setText(event.target.value); setProblem(''); }} />
        <Button type="submit" disabled={disabled || !text.trim()}>{ui('添加')}</Button>
      </form>
      <Hint size="xs">{uiFormat('已内置：{0}', [builtIn().join(uiIsEnglish() ? ', ' : '、')])}</Hint>
    </div>
  </Field>;
}

export default function ExamPrepPane({ data, busy, act, host }) {
  const toast = useToast();
  const saved = data?.settings?.examPrep, savedValues = resolveExamPrepSettings(saved), key = JSON.stringify(savedValues);
  const [values, setValues] = useState(savedValues), [working, setWorking] = useState(false), [error, setError] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // What the library says wins again as soon as it arrives; until then the control shows what was just chosen.
  useEffect(() => { setValues(JSON.parse(key)); }, [key]);
  const run = async (action, args, shown) => {
    if (busy || working || typeof act !== 'function') return;
    setError(''); setWorking(true); setValues(shown);
    try {
      const result = await act(action, args, () => toast.success(ui('备考补习设置已保存')), { rethrow: true });
      if (result === undefined && live.current) setValues(savedValues); // another action was running: nothing was saved
    } catch (cause) { if (live.current) { setValues(savedValues); setError(errorMessage(cause)); } }
    finally { if (live.current) setWorking(false); }
  };
  const set = patch => run('settings.examPrep.set', { patch }, { ...values, ...patch });
  const disabled = busy || working;
  return <div className="settings-form">
    <SettingsSection tour="settings-exam-prep" disabled={disabled} title={ui('备考补习')}
      lead={ui('备考补习把课件、大纲和样卷整理成一份考点清单。这里是你的个人默认值：新建清单时会自动填好，每次仍可单独改。')}>
      <ExamPrepStatus enabled={data?.features?.examBlueprint === true} host={host} />
      <h3 className="settings-subtitle">{ui('个人默认值')}</h3>
      <Switch name="autoRoles" label={ui('自动识别资料用途')} checked={values.autoRoles} disabled={disabled} onChange={autoRoles => set({ autoRoles })}
        hint={ui('按文件名和篇幅猜每份资料是课件、样卷还是大纲，并写明依据；猜错点一下就能改。关掉后，所有资料都先当作课件。')} />
      <PaperWords words={values.paperWords} disabled={disabled} onChange={paperWords => set({ paperWords })} />
      <Field label={ui('清单语言')} hint={ui('「自动」跟随当前的界面语言：界面是中文就写中文清单，是 English 就写英文清单；想固定一种语言就在这里选。')}>
        <Select name="language" value={values.language} disabled={disabled} onChange={language => set({ language })}
          options={LANGUAGES.map(option => ({ value: option.value, label: ui(option.label) }))} />
      </Field>
      <Switch name="showOtherCourses" label={ui('默认显示其它课程的资料')} checked={values.showOtherCourses} disabled={disabled}
        onChange={showOtherCourses => set({ showOtherCourses })}
        hint={ui('打开后，新建清单时挑选资料会连其它课程的一起列出，并标明所属课程；默认只列当前课程的。')} />
      {error && <Hint tone="error" role="alert">{error}</Hint>}
      <div className="settings-actions">
        <Button disabled={disabled || (saved === undefined && same(values, EXAM_PREP_DEFAULTS))}
          onClick={() => run('settings.examPrep.reset', {}, resolveExamPrepSettings())}>{ui('恢复默认')}</Button>
      </div>
      <Hint>{ui('改动立即保存，只影响之后新建的清单；已经建好的清单不会变。')}</Hint>
    </SettingsSection>
  </div>;
}
