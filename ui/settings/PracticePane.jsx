import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, Field, Hint, Select, SettingsSection, Switch, useToast } from '../components/index.js';
import { NEW_CARD_ORDERS, PRACTICE_DEFAULTS, freshRoundCount, lookBackBlindRecall, notesPracticeBridge, resolvePracticeSettings, studyChainRecipes, wrongbookClinic } from '../../lib/practice-settings.js';
import { leechMisses } from '../../lib/leech.js';
import { COVERAGE_DEFAULT, CRUNCH_MINUTES, CRUNCH_WINDOW, bookConfusableDrill, bookCoverage, bookInlinePractice, crunchMinutes, crunchWindow, resolveBookSettings } from '../../lib/book-settings.js';
import { levelHint, levelOptions } from '../outline/words.js';
import { AUTO_ADVANCE_MS, RESULT_COUNTDOWN_SECONDS } from '../review/session-logic.js';
import { useStudy } from '../study-context.jsx';

/* 设置 › 练习: the learner's personal defaults for the daily practice, saved at once (settings.practice.set); 恢复默认 forgets them (settings.practice.reset).
   Autopilot and the round size are what the practice page and the home card read; 本轮点评 is the one place that says the result page asks the model. */
export const ROUND_SIZES = [10, 15, 20, 30, 40, 50];
export const NEW_CARD_ORDER_LABELS = Object.freeze({
  reading: '按资料顺序（从前往后）',
  focus: '重点优先（适合考前冲刺）',
  shuffle: '随机穿插（适合通读后自测）',
});
/** 顽固题 (lib/leech.js): how many wrong answers, and what share of the latest few attempts (per cent), make a question stubborn; inside PRACTICE_LIMITS. */
export const LEECH_FAILURES = [3, 4, 5, 6, 8, 10];
export const LEECH_RATES = [50, 60, 70, 80, 100];
/** How long before an exam its 期末一周 plan shows (settings.book.crunchWindowDays, lib/book-settings.js). */
export const CRUNCH_WINDOWS = [7, 14, 21, 30, 45, 60];
/** How many minutes a day of that plan holds (settings.book.crunchMinutes). */
export const CRUNCH_DAY_MINUTES = [60, 90, 120, 180, 240];
const withSaved = (choices, value) => (choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const seconds = (ms) => String(ms / 1000);

export default function PracticePane({ data, busy, act, openSchedule }) {
  const { openSettings } = useStudy();
  const toast = useToast();
  const saved = data?.settings?.practice, savedValues = resolvePracticeSettings(saved), key = JSON.stringify(savedValues);
  const [values, setValues] = useState(savedValues), [working, setWorking] = useState(false), [error, setError] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // What the library says wins again as soon as it arrives; until then the control shows what was just chosen.
  useEffect(() => { setValues(JSON.parse(key)); }, [key]);
  const run = async (action, args, shown) => {
    if (busy || working || typeof act !== 'function') return;
    setError(''); setWorking(true); setValues(shown);
    try {
      const result = await act(action, args, () => toast.success(ui('练习设置已保存')), { rethrow: true });
      if (result === undefined && live.current) setValues(savedValues); // another action was running: nothing was saved
    } catch (cause) { if (live.current) { setValues(savedValues); setError(errorMessage(cause)); } }
    finally { if (live.current) setWorking(false); }
  };
  const set = (patch) => run('settings.practice.set', { patch }, { ...values, ...patch });
  const setOptional = async (settingKey, on) => {
    if (busy || working || typeof act !== 'function') return;
    setError('');
    setValues((current) => {
      const next = { ...current };
      if (on) next[settingKey] = true;
      else delete next[settingKey];
      return next;
    });
    try {
      const result = await act('settings.practice.set', { patch: { [settingKey]: on ? true : null } }, () => toast.success(ui('练习设置已保存')), { rethrow: true });
      if (result === undefined && live.current) setValues(savedValues);
    } catch (cause) { if (live.current) { setValues(savedValues); setError(errorMessage(cause)); } }
  };
  // 自动加入复习全书 (lib/book-settings.js, settings.book): its own key, saved at once too; the practice page has the same switch beside its Q&A.
  const savedBook = resolveBookSettings(data?.settings?.book).qaToBook;
  const [bookMode, setBookMode] = useState(savedBook);
  useEffect(() => { setBookMode(savedBook); }, [savedBook]);
  const setBook = async (mode) => {
    if (busy || working || typeof act !== 'function') return;
    setError(''); setBookMode(mode);
    try { await act('settings.book.set', { patch: { qaToBook: mode } }, () => toast.success(ui('练习设置已保存')), { rethrow: true }); }
    catch (cause) { if (live.current) { setBookMode(savedBook); setError(errorMessage(cause)); } }
  };
  // 期末一周 (M7): how many days before a course's exam date its plan shows on the home and in the book, and how many minutes a day of it holds;
  // saved at once like the switch above (the default is saved as no key at all).
  const savedCrunch = { crunchWindowDays: crunchWindow(data?.settings?.book), crunchMinutes: crunchMinutes(data?.settings?.book) }, crunchKey = JSON.stringify(savedCrunch);
  const [crunch, setCrunch] = useState(savedCrunch);
  useEffect(() => { setCrunch(JSON.parse(crunchKey)); }, [crunchKey]);
  const setCrunchValue = async (key, value, fallback) => {
    if (busy || working || typeof act !== 'function') return;
    setError(''); setCrunch((current) => ({ ...current, [key]: value }));
    try { await act('settings.book.set', { patch: { [key]: value === fallback ? null : value } }, () => toast.success(ui('练习设置已保存')), { rethrow: true }); }
    catch (cause) { if (live.current) { setCrunch(JSON.parse(crunchKey)); setError(errorMessage(cause)); } }
  };
  // 讲解详尽程度 (settings.book.coverage): how much of a point's material a 复习全书 build reads; the 总纲 page's choice beside 生成复习全书 is the same setting.
  const savedCoverage = bookCoverage(data?.settings?.book);
  const [coverage, setCoverage] = useState(savedCoverage);
  useEffect(() => { setCoverage(savedCoverage); }, [savedCoverage]);
  const setCoverageValue = async (level) => {
    if (busy || working || typeof act !== 'function') return;
    setError(''); setCoverage(level);
    try { await act('settings.book.set', { patch: { coverage: level === COVERAGE_DEFAULT ? null : level } }, () => toast.success(ui('练习设置已保存')), { rethrow: true }); }
    catch (cause) { if (live.current) { setCoverage(savedCoverage); setError(errorMessage(cause)); } }
  };
  const savedBookFlags = { inlinePractice: bookInlinePractice(data?.settings?.book), confusableDrill: bookConfusableDrill(data?.settings?.book) };
  const bookFlagsKey = JSON.stringify(savedBookFlags);
  const [bookFlags, setBookFlags] = useState(savedBookFlags);
  useEffect(() => { setBookFlags(JSON.parse(bookFlagsKey)); }, [bookFlagsKey]);
  const setBookFlag = async (flagKey, on) => {
    if (busy || working || typeof act !== 'function') return;
    setError(''); setWorking(true); setBookFlags((current) => ({ ...current, [flagKey]: on }));
    try {
      const result = await act('settings.book.set', { patch: { [flagKey]: on ? true : null } }, () => toast.success(ui('练习设置已保存')), { rethrow: true });
      if (result === undefined && live.current) setBookFlags(JSON.parse(bookFlagsKey));
    } catch (cause) { if (live.current) { setBookFlags(JSON.parse(bookFlagsKey)); setError(errorMessage(cause)); } }
    finally { if (live.current) setWorking(false); }
  };
  const disabled = busy || working;
  const sizes = ROUND_SIZES.includes(values.roundSize) ? ROUND_SIZES : [...ROUND_SIZES, values.roundSize].sort((a, b) => a - b);
  return <div className="settings-form">
    <SettingsSection tour="settings-practice" disabled={disabled} title={ui('练习')}
      lead={ui('每天的练习怎么走。这里是你的个人默认值，改动立即保存；练习页里也能临时开关自动跳下一步。')}>
      <Field label={ui('每轮题数')} hint={uiFormat('首页的「今日学习」每轮最多这么多题：先排到期复习，再排薄弱题，最后补新题，新题最多占一半。当前是 {0} 题一轮，新题最多 {1} 道。', [values.roundSize, freshRoundCount(values)])}>
        <Select name="roundSize" value={String(values.roundSize)} disabled={disabled} onChange={(roundSize) => set({ roundSize: Number(roundSize) })}
          options={sizes.map((size) => ({ value: String(size), label: uiFormat('{0} 题', [size]) }))} />
      </Field>
      <Field label={ui('新题出场顺序')} hint={ui('还没学过的新题按什么顺序排进每一轮：默认顺着资料页码或章节从前往后学，避免还没看过的后半本突然跳出来；到期复习和薄弱题仍优先巩固，前置题也会排在依赖它的题前面。')}>
        <Select name="newCardOrder" value={values.newCardOrder} disabled={disabled} onChange={(newCardOrder) => set({ newCardOrder })}
          options={NEW_CARD_ORDERS.map((order) => ({ value: order, label: ui(NEW_CARD_ORDER_LABELS[order]) }))} />
      </Field>
      <Switch name="autopilot" label={ui('自动跳下一步')} checked={values.autopilot} disabled={disabled} onChange={(autopilot) => set({ autopilot })}
        hint={uiFormat('答对（或自评达标）后，等 {0} 秒自动进入下一题；一轮做完，结果页也会在 {1} 秒后自动开始建议的下一步（学习流和「回到原题」的练习除外）。点任意处或按任意键就能停下。练习页的工具栏里也有这个开关，按 A 键同样可以切换。', [seconds(AUTO_ADVANCE_MS), RESULT_COUNTDOWN_SECONDS])} />
      <Switch name="debrief" label={ui('本轮点评由模型来写')} checked={values.debrief} disabled={disabled} onChange={(debrief) => set({ debrief })}
        hint={ui('每轮做完、答了 3 题以上时，结果页会请较轻量的模型写一句点评并更新你的学习画像摘要，这是练习里唯一自动调用模型的地方。关掉后不再调用模型：点评卡片只按作答统计给出建议。')} />
      <Switch name="rereadMarks" label={ui('首页提醒重读划过的段落')} checked={values.rereadMarks} disabled={disabled} onChange={(rereadMarks) => set({ rereadMarks })}
        hint={ui('阅读器里用荧光笔或加粗标过的段落，3 天没再看、所在章节或页又有到期或薄弱题时，首页「今日」会出现一行「重读 N 段」，每天最多 3 段。关掉后这一行不再出现。')} />
      <Switch name="studyChainRecipes" label={ui('找功能里显示学习场景向导')} checked={studyChainRecipes(values)} disabled={disabled}
        onChange={(on) => set({ studyChainRecipes: on ? true : null })}
        hint={ui('打开「找功能」（Ctrl K 或 /）且未输入搜索词时，在完整索引上方按常见学习处境串起下一步（刚加新资料、刷完清错、读讲义边问边练、考前限时自检），并根据当前题库与资料状态展开最贴近的一组；纯本地整理，不调用模型。')} />
      <Switch name="examPostmortemBridge" label={ui('笔试报告拆分答错与未答并附原出处')} checked={!!values.examPostmortemBridge} disabled={disabled} onChange={(on) => set({ examPostmortemBridge: on ? true : null })}
        hint={ui('打开后，笔试模拟考报告会在有未答题时列出已作答正确率，拆出「只练答错」与「补做未答」按钮，并在逐题列表中附带「打开出处」与「去练这道题」（不调用模型）。关掉后保持原有合并视图。')} />
      <Switch name="companionSlideCheck" label={ui('交互伴学开启当页随堂自测')} checked={!!values.companionSlideCheck} disabled={disabled} onChange={(on) => {
        const next = { ...values };
        if (on) next.companionSlideCheck = true; else delete next.companionSlideCheck;
        return run('settings.practice.set', { patch: { companionSlideCheck: on ? true : null } }, next);
      }}
        hint={ui('打开后，交互伴学课抽屉会自动匹配当前页关联题卡并提供「当页自测」与「抽屉自测」：不关伴学窗口直接在侧栏作答，课程伴学栏也会显示配套题入口，不消耗模型。关掉后保持原有伴学界面。')} />
      <Switch name="readerDoubtLedger" label={ui('阅读器未选段时显示本文疑问收件匣')} checked={!!values.readerDoubtLedger} disabled={disabled} onChange={(on) => {
        const next = { ...values };
        if (on) next.readerDoubtLedger = true; else delete next.readerDoubtLedger;
        return run('settings.practice.set', { patch: { readerDoubtLedger: on ? true : null } }, next);
      }}
        hint={ui('打开后，资料阅读器里还没选中段落时，右侧会列出这篇资料本次问过的回答与已存批注；点「遮住答案自测」可以先自己回想再看回答，也能一键存成闪卡，不消耗模型。关掉后保持原有提示。')} />
      <Switch name="wrongbookClinic" label={ui('错题页显示靶向清零处方')} checked={wrongbookClinic(values)} disabled={disabled}
        onChange={(on) => {
          const next = { ...values };
          if (on) next.wrongbookClinic = true; else delete next.wrongbookClinic;
          return run('settings.practice.set', { patch: { wrongbookClinic: on ? true : null } }, next);
        }}
        hint={ui('打开后，「错题与待巩固」在列表上方按同一处原文、顽固题和单次失误整理出可直接开练的处方行，只看现有作答和引用记录，不调用模型；关着时保持原有的错题列表不变。')} />
      <Switch name="lookBackBlindRecall" label={ui('练习结果页错题先遮答案并可标错因')} checked={lookBackBlindRecall(values)} disabled={disabled}
        onChange={(on) => {
          const next = { ...values };
          if (on) next.lookBackBlindRecall = true; else delete next.lookBackBlindRecall;
          return run('settings.practice.set', { patch: { lookBackBlindRecall: on ? true : null } }, next);
        }}
        hint={ui('每轮做完点开「本轮题目」里的错题时，先遮住正确答案与解析让你回想一遍再揭晓；揭晓后可顺手点选错因（概念混淆、漏看条件、推导卡住、粗心手滑），按错因一键重练或带进复制的复盘摘录。只影响回看显示，不改复习间隔，也不调用模型。')} />
      <Switch name="notesPracticeBridge" label={ui('学习笔记显示关联题整套开练')} checked={notesPracticeBridge(values)} disabled={disabled}
        onChange={(on) => {
          const next = { ...values };
          if (on) next.notesPracticeBridge = true; else delete next.notesPracticeBridge;
          return run('settings.practice.set', { patch: { notesPracticeBridge: on ? true : null } }, next);
        }}
        hint={ui('打开后，「学习笔记」列表会出现「只看含关联题」筛选，点开笔记阅读时上方也会给出「练这 N 道关联题」按钮，把整篇笔记或每日总结关联的题目排成一轮重练，练完回到这篇笔记；自动跳过已移除或已归档的题目，不调用模型。')} />
      <Switch name="outlineGapLens" label={ui('总纲缺口筛选与无题直出')} checked={Boolean(values.outlineGapLens)} disabled={disabled} onChange={(on) => setOptional('outlineGapLens', on)}
        hint={ui('打开后，「总纲」页面的筛选栏增加「薄弱与到期」和「尚无题目」视图，并提供一键专练全部薄弱与到期小节，以及在无题章节旁直接跳转创建题组。默认关闭，不调用模型。')} />
      <Switch name="qaToBook" label={ui('自动加入复习全书')} checked={bookMode === 'auto'} disabled={disabled} onChange={(on) => setBook(on ? 'auto' : 'manual')}
        hint={ui('练习时得到的追问和「帮我弄懂」的回答，打开后会自动放进这门课的复习全书（这道题所在知识点的问答里）；关着时在每条问答旁点「加入复习全书」才放进去。题目自己的问答记录不受影响，加进书里的随时可以撤回。只影响之后的问答。')} />
      <Switch name="bookInlinePractice" label={ui('复习全书开启薄弱节筛选与页内自测')} checked={bookFlags.inlinePractice} disabled={disabled} onChange={(on) => setBookFlag('inlinePractice', on)}
        hint={ui('打开后，复习全书目录在有待巩固或到期题的章节时可切到「薄弱节」，每节下方也会提供「合书自测」：留在当前书页直接作答并轻掩正文讲解（悬停或聚焦可看），不消耗模型。关掉后保持原有阅读界面。')} />
      <Switch name="bookConfusableDrill" label={ui('复习全书速查页开启易混概念自测')} checked={bookFlags.confusableDrill} disabled={disabled} onChange={(on) => setBookFlag('confusableDrill', on)}
        hint={ui('打开后，复习全书「速查页 › 易混概念」支持一键遮住概念名，只看适用场景、关键区别和常见误区做辨析自测，点一下即可揭晓，不改复习排期、不消耗模型。')} />
      <Field label={ui('多少次答错算顽固题')} hint={ui('一道题累计答错这么多次，错题本里会标上「顽固」，展开后有修题、补前置小卡、发给主会话和暂停几个办法。只看作答记录，不调用模型。')}>
        <Select name="leechFailures" value={String(values.leechFailures)} disabled={disabled} onChange={(leechFailures) => set({ leechFailures: Number(leechFailures) })}
          options={withSaved(LEECH_FAILURES, values.leechFailures).map((count) => ({ value: String(count), label: uiFormat('{0} 次', [count]) }))} />
      </Field>
      <Field label={ui('最近几次里答错的占多少算顽固题')} hint={uiFormat('只看最近 {0} 次作答：答错 {1} 次以上也算顽固，哪怕累计次数还不到；作答不满 {0} 次时也这样算。最近 {0} 次作答全部答对，标记就会消失。', [values.leechWindow, leechMisses({ window: values.leechWindow, rate: values.leechRate })])}>
        <Select name="leechRate" value={String(values.leechRate)} disabled={disabled} onChange={(leechRate) => set({ leechRate: Number(leechRate) })}
          options={withSaved(LEECH_RATES, values.leechRate).map((rate) => ({ value: String(rate), label: uiFormat('{0}%', [rate]) }))} />
      </Field>
      <Field label={ui('期末一周提前几天出现')} hint={ui('课程设了考试日期、也有复习全书时，离考试这么多天起，首页和复习全书里会排出每天读哪几节：前面的日子读书练题，最后两天翻看全书和易错点、做模拟卷。')}>
        <Select name="crunchWindowDays" value={String(crunch.crunchWindowDays)} disabled={disabled} onChange={(days) => setCrunchValue('crunchWindowDays', Number(days), CRUNCH_WINDOW.days)}
          options={withSaved(CRUNCH_WINDOWS, crunch.crunchWindowDays).map((days) => ({ value: String(days), label: uiFormat('考前 {0} 天', [days]) }))} />
      </Field>
      <Field label={ui('期末一周每天学多久')} hint={ui('期末一周每天排多少分钟：节数多于时间时，那几天会合并几节并写明超出多少，不会丢掉哪一节。')}>
        <Select name="crunchMinutes" value={String(crunch.crunchMinutes)} disabled={disabled} onChange={(minutes) => setCrunchValue('crunchMinutes', Number(minutes), CRUNCH_MINUTES.minutes)}
          options={withSaved(CRUNCH_DAY_MINUTES, crunch.crunchMinutes).map((minutes) => ({ value: String(minutes), label: uiFormat('每天 {0} 分钟', [minutes]) }))} />
      </Field>
      <Field label={ui('讲解详尽程度')} hint={levelHint()}>
        <Select name="bookCoverage" value={coverage} disabled={disabled} onChange={setCoverageValue} options={levelOptions()} />
      </Field>
      {error && <Hint tone="error" role="alert">{error}</Hint>}
      <div className="settings-actions">
        <Button disabled={disabled || (saved === undefined && same(values, PRACTICE_DEFAULTS))}
          onClick={() => run('settings.practice.reset', {}, resolvePracticeSettings())}>{ui('恢复默认')}</Button>
        <Button variant="link" size="sm" iconEnd="arrow-right"
          onClick={() => (openSchedule ? openSchedule() : openSettings('settings-data'))}>{ui('间隔复习 · FSRS-6')}</Button>
      </div>
      <Hint>{ui('改动立即保存，只影响之后的练习。')}</Hint>
    </SettingsSection>
  </div>;
}
