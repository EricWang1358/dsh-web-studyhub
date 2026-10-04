import { getUiLanguage, ui, uiFormat, uiLocale } from "./i18n.js";
import React, { useEffect, useId, useRef, useState } from "react";
import AudioSettings, { audioFocusPending } from "./AudioSettings.jsx";
import ExtensionsSettings from './ExtensionsSettings.jsx';
import MineruSettings from './MineruSettings.jsx';
import JevSettings from './JevSettings.jsx';
import { ExperimentalSection } from './ExperimentalSettings.jsx';
import UsageSettings from './UsageSettings.jsx';
import GenerationSettings from './GenerationSettings.jsx';
import ScienceSettings from './ScienceSettings.jsx';
import { experimentalShown } from './experimental-flag.js';
import { hasContext } from './capabilities.js';
import { APPEARANCE_LABELS, APPEARANCE_OPTIONS } from './appearance-prefs.js';
import { SETTINGS_GROUPS, categoriesFor, categoryForAnchor, initialCategory, settingsGroupState } from './settings-groups.js';
import { UpdateSettingsPanel } from './UpdateCenter.jsx';
import { Button, Dialog, Icon, InlineMessage, SegmentedControl, formatBytes } from './components/index.js';
import { useInjectCss } from './shared.js';
import { previewSchedule } from '../lib/sm2.js';
import { syncScheduleSettings } from './schedule-settings.js';
import css from './settings.css';

const GOALS = [["", "未设定"], ["exam", "应付考试"], ["interview", "面试求职"], ["work", "工作中落地"], ["explore", "兴趣拓展"]];

/* 设置视图：学习库绑定与模型、课程、音频、上手、陪学、旧库导入、调度参数与完整备份。
   WP14: every section is a .settings-section with the same title, one left
   edge and token spacing (settings.css). */

/* ---------- 陪学 ---------- */

/**
 * The consent and goal toggles. App's act() is single-flight, so reloading the
 * profile with a nested act() inside the first one's callback was skipped and
 * the section kept showing the old profile; the reload uses call() instead.
 */
export function coachActions({ act, call, setProfile }) {
  const reload = async () => {
    const next = call ? await call("coach.profile", {}) : null;
    if (next) setProfile(next);
  };
  return {
    setConsent: (prep) => act("coach.consent", { prep }, reload),
    setGoal: (goal) => act("coach.goal", { goal }, reload),
  };
}

/** 陪学: what the profile changes, the goal, a short profile with a compact feedback row, and a confirmed reset. */
export function CoachSection({ profile, busy, act, call, setProfile, setNotice, confirmForget = false }) {
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(confirmForget);
  const summaryId = useId();
  const { setConsent, setGoal } = coachActions({ act, call, setProfile });
  const summary = profile.summary || "";
  const long = summary.length > 60;
  const updated = profile.updatedAt && Number.isFinite(Date.parse(profile.updatedAt))
    ? new Date(profile.updatedAt).toLocaleDateString(uiLocale(), { year: "numeric", month: "short", day: "numeric" }) : "";
  const stats = [["check", "懂了", profile.signals?.got], ["help", "不懂", profile.signals?.confused],
    ["thumb-up", "有用", profile.signals?.up], ["thumb-down", "没用", profile.signals?.down]];
  return (
    <fieldset className="settings-section coach-settings">
      <legend className="settings-section__title">{ui("陪学")}</legend>
      <p className="settings-section__lead">{ui("陪学记住的学习目标和画像只保存在这个学习库文件里，用来让变式题和建议更贴近你。模型调用使用最低思考档位。")}</p>
      <p className="settings-section__note">{ui("画像只影响陪学：答错后的提示、追问、改题、强化变式题和每轮复盘的措辞与侧重；不影响出题和复习排期。")}</p>
      <label className="inline-check">
        <input type="checkbox" checked={profile.consent === true} disabled={busy}
          onChange={(e) => setConsent(e.target.checked)} />{ui("做题时在后台准备变式题和应用场景题")}</label>
      <div className="settings-field">
        <label>{ui("学习目标")}<select value={profile.goal} disabled={busy} onChange={(e) => setGoal(e.target.value)}>
          {GOALS.map(([id, label]) => <option key={id} value={id}>{ui(label)}</option>)}
        </select></label>
        <small>{ui("提示语气与例子会贴近这个目标。")}</small>
      </div>
      <div className="coach-profile">
        <div className="coach-profile__head">
          <strong>{ui("画像")}</strong>
          {updated && <small>{uiFormat("上次更新 {0}", [updated])}</small>}
        </div>
        {summary
          ? <p id={summaryId} className={`coach-profile__summary${long && !expanded ? " is-clamped" : ""}`}>{summary}</p>
          : <p className="settings-section__note">{ui("还没有画像：做完一轮后，陪学会根据表现写一段简短摘要。")}</p>}
        {long && <Button variant="link" size="sm" className="coach-profile__more" aria-expanded={expanded} aria-controls={summaryId}
          onClick={() => setExpanded(value => !value)}>{expanded ? ui("收起") : ui("展开")}</Button>}
        <ul className="coach-stats" aria-label={ui("你的反馈")}>
          {stats.map(([icon, label, count]) => <li key={label}><Icon name={icon} size={16} />{`${ui(label)} `}<strong>{count || 0}</strong></li>)}
          {profile.ready ? <li className="coach-stats__ready">{uiFormat("已备 {0} 道定制题", [profile.ready])}</li> : null}
        </ul>
      </div>
      <div className="settings-actions">
        <Button variant="secondary" disabled={busy} onClick={() => setConfirm(true)}>{ui("清空画像")}</Button>
      </div>
      {confirm && <Dialog size="sm" title={ui("清空陪学画像？")} onClose={() => setConfirm(false)}
        description={uiFormat("将删除：学习目标、画像摘要、反馈计数和 {0} 道未使用的定制题。", [profile.ready || 0])}
        footer={<>
          <Button variant="quiet" disabled={busy} onClick={() => setConfirm(false)}>{ui("取消")}</Button>
          <Button variant="danger" busy={busy} onClick={() => act("coach.forget", {}, (next) => {
            setProfile(next); setConfirm(false);
            setNotice?.({ text: ui("已清空陪学画像和未使用的定制题；练习记录不受影响。"), tone: "success" });
          })}>{ui("清空画像")}</Button>
        </>}>
        <p className="settings-section__note">{ui("练习记录和复习进度不受影响；之后做完一轮，陪学会重新写画像。")}</p>
      </Dialog>}
    </fieldset>
  );
}

/* ---------- 间隔复习 · SM-2 ---------- */

const SM2_FIELDS = [
  ["first_interval_days", "首次间隔", "天", 1, 1],
  ["second_interval_days", "第二次间隔", "天", 1, 1],
  ["initial_ease_factor", "初始熟练系数", "", 0.1, 0.1],
  ["minimum_ease_factor", "最低熟练系数", "", 0.1, 0.1],
];
const numbers = (settings = {}) => Object.fromEntries(SM2_FIELDS.map(([key]) => [key, Number(settings[key])]));
const dayList = points => points.map(point => point.day).join(getUiLanguage() === "en" ? ", " : "、");
const TICKS = [[1, "1 天"], [7, "1 周"], [30, "1 个月"], [90, "3 个月"], [180, "半年"], [365, "1 年"], [730, "2 年"]];

/** The predicted review days for "熟练" and "勉强答对" answers, drawn on a square-root time axis. */
function SchedulePreview({ good, hard }) {
  const titleId = useId(), descId = useId();
  if (!good) return <p className="settings-section__note sm2-preview">{ui("填好四个数值后，这里会显示复习时间预览。")}</p>;
  const width = 640, left = 16, right = 24, max = Math.max(30, good.at(-1).day, hard?.at(-1).day || 0);
  const x = day => left + Math.sqrt(day / max) * (width - left - right);
  const rows = [[good, 46, "is-good"], ...(hard ? [[hard, 92, "is-hard"]] : [])];
  return <figure className="sm2-preview">
    <svg viewBox="0 0 640 150" role="img" aria-labelledby={titleId} aria-describedby={descId} preserveAspectRatio="xMinYMid meet">
      <title id={titleId}>{ui("复习时间预览")}</title>
      <desc id={descId}>{uiFormat("一直答「{0}」：第 {1} 天复习", [ui("熟练"), dayList(good)])}</desc>
      {TICKS.filter(([day]) => day <= max * 1.02).map(([day, label]) => <g key={day} className="sm2-tick">
        <line x1={x(day)} x2={x(day)} y1="16" y2="122" /><text x={x(day)} y="144" textAnchor="middle">{ui(label)}</text>
      </g>)}
      {rows.map(([points, y, tone]) => <g key={tone} className={`sm2-series ${tone}`}>
        <line className="sm2-track" x1={x(0)} x2={x(points.at(-1).day)} y1={y} y2={y} />
        {points.map(point => <g key={point.review}>
          <circle cx={x(point.day)} cy={y} r="5" />
          <text x={x(point.day)} y={tone === "is-good" ? y - 12 : y + 20} textAnchor="middle">{point.day}</text>
        </g>)}
      </g>)}
    </svg>
    <figcaption>
      <span className="sm2-key is-good">{uiFormat("一直答「{0}」：第 {1} 天复习", [ui("熟练"), dayList(good)])}</span>
      {hard && <span className="sm2-key is-hard">{uiFormat("一直答「{0}」：第 {1} 天复习", [ui("勉强答对"), dayList(hard)])}</span>}
    </figcaption>
  </figure>;
}

/** SM-2 parameters: one compact row of number fields, a live preview and save/undo. */
export function ScheduleSection({ root, settings = {}, saved = {}, setSettings, act, busy, setNotice }) {
  const savedKey = JSON.stringify(numbers(saved));
  const [baseline, setBaseline] = useState(() => numbers(saved));
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const previousSaved = useRef({ root, key: savedKey, values: numbers(saved) });
  const scope = useRef({ root, live: true }), pending = useRef(null);
  useEffect(() => {
    const owner = { root, live: true }; scope.current = owner; pending.current = null;
    setWorking(false); setError('');
    return () => { owner.live = false; };
  }, [root]);
  useEffect(() => {
    const before = previousSaved.current;
    if (before.root === root && before.key === savedKey) return;
    const incoming = JSON.parse(savedKey);
    previousSaved.current = { root, key: savedKey, values: incoming };
    setBaseline(incoming);
    setSettings(current => before.root === root ? syncScheduleSettings(current, before.values, incoming) : { ...current, ...incoming });
  }, [root, savedKey, setSettings]);
  const dirty = SM2_FIELDS.some(([key]) => Number(settings[key]) !== baseline[key]);
  const current = numbers(settings);
  const good = previewSchedule(current, { grade: 4, reviews: 6 }), hard = good && previewSchedule(current, { grade: 3, reviews: 6 });
  const save = async event => {
    event.preventDefault();
    if (busy || pending.current || !dirty || !good) return;
    const changes = Object.fromEntries(SM2_FIELDS.filter(([key]) => current[key] !== baseline[key]).map(([key]) => [key, current[key]]));
    const owner = scope.current, operation = {};
    pending.current = operation; setWorking(true); setError('');
    const isCurrent = () => owner.live && owner.root === root && scope.current === owner && pending.current === operation;
    try {
      await act('settings', changes, (result, context) => {
        if (!isCurrent() || context?.isCurrent?.() === false) return;
        const next = numbers(result);
        setBaseline(next);
        setSettings(previous => syncScheduleSettings(previous, current, next));
        setNotice?.({ text: ui('复习调度已保存'), tone: 'success' });
      }, { rethrow: true });
    } catch (cause) { if (isCurrent()) setError(cause?.message || String(cause)); }
    finally { if (isCurrent()) { pending.current = null; setWorking(false); } }
  };
  return (
    <form className="settings-form" onSubmit={save}>
      <fieldset className="settings-section sm2-settings">
        <legend className="settings-section__title">{ui("间隔复习 · SM-2")}</legend>
        <p className="settings-section__lead">{ui("答对时，下一次复习的间隔逐次拉长；答错时回到 1 天。")}</p>
        <div className="sm2-fields">
          {SM2_FIELDS.map(([key, label, unit, min, step]) => <label key={key} className="sm2-field">
            <span>{ui(label)}</span>
            <span className="sm2-input">
              <input type="number" required min={min} max="365" step={step} value={settings[key] ?? ""} disabled={busy}
                onChange={(e) => { const value = Number(e.target.value); setError(''); setSettings(current => ({ ...current, [key]: value })); }} />
              {unit && <span className="sm2-unit">{ui(unit)}</span>}
            </span>
          </label>)}
        </div>
        <p className="settings-section__note">{ui("熟练系数越大，间隔增长越快；答得吃力时会下降，但不低于最低系数。")}</p>
        <SchedulePreview good={good} hard={hard} />
        {error && <p className="settings-section__note" role="alert">{error}</p>}
        <div className="settings-actions">
          <Button type="submit" variant="primary" busy={working} disabled={busy || !dirty || !good}>{ui("保存复习设置")}</Button>
          <Button variant="quiet" disabled={busy || working || !dirty} onClick={() => { setError(''); setSettings(current => ({ ...current, ...baseline })); }}>{ui("撤销未保存修改")}</Button>
        </div>
      </fieldset>
    </form>
  );
}

/* ---------- 数据备份与恢复 ---------- */

/** The export file name: study-library-YYYY-MM-DD.json (local date). */
export function backupFileName(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `study-library-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

/** What a backup holds, counted client-side before anything is replaced. */
export function backupSummary(state = {}) {
  const decks = Array.isArray(state.decks) ? state.decks : [];
  return { courses: Array.isArray(state.courses) ? state.courses.length : 0, sources: state.sources?.length || 0, decks: decks.length,
    cards: decks.reduce((sum, deck) => sum + (Array.isArray(deck.cards) ? deck.cards.length : 0), 0), attempts: state.attempts?.length || 0 };
}

const isFullBackup = state => state && Number.isInteger(state.version) && Array.isArray(state.sources) && Array.isArray(state.decks) &&
  Array.isArray(state.drafts) && Array.isArray(state.runs) && Array.isArray(state.attempts);
const backupsFolder = root => root ? `${root.replace(/[\\/]+$/, "")}${root.includes("\\") ? "\\" : "/"}backups` : "";

/** The chosen backup: name, size and contents, with the destructive action. */
export function RestorePreview({ file, busy, onConfirm, onCancel }) {
  const count = backupSummary(file.state);
  return <div className="restore-preview" role="status">
    <div className="restore-preview__file"><Icon name="file" size={18} /><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div>
    <p>{[uiFormat("{0} 门课程", [count.courses]), uiFormat("{0} 份资料", [count.sources]),
      uiFormat("{0} 个题组（{1} 道题）", [count.decks, count.cards]), uiFormat("{0} 条作答记录", [count.attempts])].join(" · ")}</p>
    <div className="settings-actions">
      <Button variant="danger" disabled={busy} onClick={onConfirm}>{ui("用此备份替换当前学习库")}</Button>
      <Button variant="quiet" disabled={busy} onClick={onCancel}>{ui("换一个文件")}</Button>
    </div>
  </div>;
}

/** Export and restore as two blocks with the same shape: what it does, where the file goes, one action. */
export function BackupSection({ root, busy, exportData, act, onRestored }) {
  const [file, setFile] = useState(null), [error, setError] = useState(""), [confirm, setConfirm] = useState(false), [working, setWorking] = useState(false);
  const input = useRef(null), readRequest = useRef(0);
  const exportId = useId(), restoreId = useId();
  const folder = backupsFolder(root);
  useEffect(() => {
    readRequest.current += 1;
    setFile(null); setError(""); setConfirm(false);
    return () => { readRequest.current += 1; };
  }, [root]);
  async function read(chosen) {
    const request = ++readRequest.current;
    setFile(null); setError(""); setConfirm(false);
    if (!chosen) return;
    try {
      const text = await chosen.text();
      if (request !== readRequest.current) return;
      const state = JSON.parse(text);
      if (!isFullBackup(state)) throw new Error(ui("这不是完整学习库备份"));
      setFile({ name: chosen.name, size: chosen.size, state });
    } catch (e) {
      if (request === readRequest.current) setError(uiFormat("无法读取备份：{0}", [e.message || String(e)]));
    } finally { if (request === readRequest.current && input.current) input.current.value = ""; }
  }
  function chooseBackup() { read(null); input.current?.click(); }
  async function restore() {
    setWorking(true); setError("");
    try {
      await act("restore", { state: file.state }, (result) => { setFile(null); setConfirm(false); onRestored?.(result); }, { rethrow: true });
    } catch (e) {
      setConfirm(false);
      setError(uiFormat("恢复没有完成，当前学习库保持不变：{0}", [e?.message || String(e)]));
    } finally { setWorking(false); }
  }
  return (
    <fieldset className="settings-section backup-settings">
      <legend className="settings-section__title">{ui("数据备份与恢复")}</legend>
      <div className="backup-blocks">
        <section className="backup-block" aria-labelledby={exportId}>
          <h3 id={exportId} className="settings-subtitle">{ui("导出")}</h3>
          <p>{ui("下载一个完整的 JSON 备份：资料、题组、复习进度和作答记录都在里面。")}</p>
          <p className="settings-section__note">{ui("已复制到资料库的原文件会放进备份；只记了路径的原文件留在你的电脑上，不在备份里，换电脑后需要重新指定。")}</p>
          <p className="settings-section__note">{uiFormat("文件名形如 {0}，保存到浏览器的下载文件夹。", [backupFileName()])}</p>
          <div className="settings-actions"><Button variant="primary" icon="download" data-usage="settings.export" disabled={busy} onClick={exportData}>{ui("导出学习库")}</Button></div>
        </section>
        <section className="backup-block" aria-labelledby={restoreId}>
          <h3 id={restoreId} className="settings-subtitle">{ui("恢复")}</h3>
          <p>{ui("用一份完整备份替换当前学习库。替换前，当前数据会自动另存一份到：")}</p>
          <code className="backup-path" title={folder}>{folder || ui("当前学习库的 backups 文件夹")}</code>
          <input ref={input} type="file" hidden accept=".json,application/json" onChange={(e) => read(e.target.files?.[0])} />
          {!file && <div className="settings-actions"><Button icon="upload" disabled={busy} onClick={chooseBackup}>{ui("选择备份文件…")}</Button></div>}
          {error && <InlineMessage>{error}</InlineMessage>}
          {file && <RestorePreview file={file} busy={busy || working} onConfirm={() => setConfirm(true)} onCancel={chooseBackup} />}
        </section>
      </div>
      {confirm && file && <Dialog size="sm" title={ui("用此备份替换当前学习库？")} onClose={() => { if (!working) setConfirm(false); }}
        description={uiFormat("当前学习库会被「{0}」替换。替换前，当前数据会自动保存到 {1}。", [file.name, folder || ui("当前学习库的 backups 文件夹")])}
        footer={<>
          <Button variant="quiet" disabled={working} onClick={() => setConfirm(false)}>{ui("取消")}</Button>
          <Button variant="danger" busy={working} onClick={restore}>{ui("用此备份替换当前学习库")}</Button>
        </>}>
        <p className="settings-section__note">{ui("出题任务进行中时不能恢复；恢复后会回到学习库首页。")}</p>
      </Dialog>}
    </fieldset>
  );
}

/* ---------- categories: a list on the left, one category on the right ---------- */

const CATEGORY_KEY = "study-settings-category";
const readCategory = () => { try { return localStorage.getItem(CATEGORY_KEY) || ""; } catch { return ""; } };
const writeCategory = (value) => { try { localStorage.setItem(CATEGORY_KEY, value); } catch { /* the choice still applies this session */ } };

/** The list of categories under the three group headings; the selected one is marked, and one that needs attention says so in words (not by colour alone). */
export function SettingsNav({ available, active, missing, onSelect }) {
  return (
    <nav className="settings-nav" aria-label={ui("设置分类")}>
      {SETTINGS_GROUPS.map((group) => {
        const items = available.filter((category) => category.group === group.id);
        if (!items.length) return null;
        return (
          <div className="settings-nav__group" key={group.id}>
            <p className="settings-nav__label">{ui(group.title)}</p>
            <ul>
              {items.map((category) => (
                <li key={category.id}>
                  <button type="button" className="settings-nav__item" data-category={category.id} aria-current={active === category.id ? "page" : undefined} onClick={() => onSelect(category.id)}>
                    <span>{ui(category.title)}</span>
                    {missing.includes(category.id) && <span className="settings-nav__todo">{ui("待设置")}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** The choices of one appearance setting, from the module's own lists (so a new value shows up here by itself). */
const appearanceOptions = (kind) => APPEARANCE_OPTIONS[kind].map((value) => {
  const label = APPEARANCE_LABELS[kind]?.[value];
  return { value, label: label ? ui(label) : kind === "scale" ? `${value}%` : String(value) };
});

/** 恢复默认外观, and the whole look as one small piece of text to carry to another computer: export fills the box, import reads it back
 *  through the same whitelist. */
function AppearanceBackup({ appearance }) {
  const [text, setText] = useState(""), [note, setNote] = useState(null);
  return (
    <div className="settings-field appearance-backup">
      <div className="settings-actions">
        <Button variant="quiet" onClick={() => { appearance.onReset(); setNote({ tone: "success", text: ui("已恢复默认外观。") }); }}>{ui("恢复默认外观")}</Button>
        {appearance.onExport && <Button icon="download" onClick={() => { setText(appearance.onExport()); setNote({ tone: "success", text: ui("已导出，可以复制保存。") }); }}>{ui("导出外观")}</Button>}
        {appearance.onImport && <Button icon="upload" disabled={!text.trim()}
          onClick={() => setNote(appearance.onImport(text) ? { tone: "success", text: ui("已应用这份外观设置。") } : { tone: "error", text: ui("这不是 StudyHub 的外观设置，没有改动。") })}>{ui("导入外观")}</Button>}
      </div>
      {appearance.onImport && <textarea rows={2} spellCheck={false} value={text} onChange={(event) => { setText(event.target.value); setNote(null); }} onFocus={(event) => event.target.select()}
        aria-label={ui("外观设置（一小段文字，可粘贴到另一台电脑）")} placeholder={ui("外观设置（一小段文字，可粘贴到另一台电脑）")} />}
      {note && <InlineMessage tone={note.tone}>{note.text}</InlineMessage>}
    </div>
  );
}

/** The interface language and appearance, the same two switches as the sidebar's, for people who look for them here. */
function AppearanceSection({ appearance }) {
  if (!appearance) return null;
  return (
    <fieldset className="settings-section appearance-settings">
      <legend className="settings-section__title">{ui("界面")}</legend>
      <div className="settings-field">
        <span>{ui("界面语言")}</span>
        <SegmentedControl label={ui("界面语言")} value={appearance.language} onChange={appearance.onLanguage}
          options={[{ value: "zh", label: "中文" }, { value: "en", label: "English" }]} />
      </div>
      <div className="settings-field">
        <span>{ui("外观")}</span>
        <SegmentedControl label={ui("外观")} value={appearance.theme} onChange={appearance.onTheme} options={appearanceOptions("theme")} />
      </div>
      {appearance.onScale && <div className="settings-field">
        <span>{ui("界面大小")}</span>
        <SegmentedControl label={ui("界面大小")} value={appearance.scale} onChange={appearance.onScale} options={appearanceOptions("scale")} />
        <small className="muted">{ui("放大整个界面（文字、按钮和间距一起），最大 200%。阅读和做题页另有 Aa 可以单独调字号和宽度。")}</small>
      </div>}
      {appearance.onFont && <div className="settings-field">
        <span>{ui("界面字体")}</span>
        <SegmentedControl label={ui("界面字体")} value={appearance.font} onChange={appearance.onFont} options={appearanceOptions("font")} />
      </div>}
      {appearance.onMotion && <div className="settings-field">
        <span>{ui("动画")}</span>
        <SegmentedControl label={ui("动画")} value={appearance.motion} onChange={appearance.onMotion} options={appearanceOptions("motion")} />
        <small className="muted">{ui("减弱只保留很短的淡入淡出；无动画则不再有页面切换和卡片动画（转圈提示仍会转）。页面切换卡顿时可以试试。")}</small>
      </div>}
      {appearance.onContrast && <div className="settings-field">
        <span>{ui("对比度")}</span>
        <SegmentedControl label={ui("对比度")} value={appearance.contrast} onChange={appearance.onContrast} options={appearanceOptions("contrast")} />
        <small className="muted">{ui("高对比会加深边框和次要文字、加粗焦点框；跟随系统时遵循系统的“增加对比度”设置。")}</small>
      </div>}
      {appearance.onDensity && <div className="settings-field">
        <span>{ui("界面密度")}</span>
        <SegmentedControl label={ui("界面密度")} value={appearance.density} onChange={appearance.onDensity} options={appearanceOptions("density")} />
        <small className="muted">{ui("密度只改间距和行距，不改字号。")}</small>
      </div>}
      {appearance.onRadius && <div className="settings-field">
        <span>{ui("圆角")}</span>
        <SegmentedControl label={ui("圆角")} value={appearance.radius} onChange={appearance.onRadius} options={appearanceOptions("radius")} />
      </div>}
      {appearance.onReset && <AppearanceBackup appearance={appearance} />}
    </fieldset>
  );
}

/* ---------- the page ---------- */

export default function Settings({
  data,
  busy,
  act,
  call,
  host,
  setNotice,
  settings,
  setSettings,
  legacy,
  setLegacy,
  workspacePanel,
  coursePanel,
  onboardingPanel,
  exportData,
  onRestored,
  initialProfile = null,
  appearance = null,
  tourActive = false,
  focusSection = "",
  onFocused,
}) {
  useInjectCss(css, "study-settings");
  const [profile, setProfile] = useState(initialProfile);
  useEffect(() => {
    act("coach.profile", {}, setProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the host says is set up: read once, quietly (no model is called). It only decides which group starts open.
  const [status, setStatus] = useState({});
  useEffect(() => {
    if (typeof call !== "function") return undefined;
    let live = true;
    const keep = (name) => (value) => { if (live && value) setStatus((current) => ({ ...current, [name]: value })); };
    if (hasContext(data, "audio")) {
      Promise.resolve(call("audio.settings.get", {})).then((value) => keep("audio")(value && { configured: ["freeKey", "siliconflowKey", "groqKey", "paidKey"].some((field) => value[field]?.set) }), () => {});
      Promise.resolve(call("mineru.settings.get", {})).then((value) => keep("mineru")(value && !value.unavailable && { configured: !!value.token?.set }), () => {});
    }
    if (hasContext(data, "generation")) {
      Promise.resolve(call("retrieval.status", {})).then((value) => keep("retrieval")(value && { status: value, plan: null }), () => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the host can show, what needs attention, and which category is selected: a deep link (the audio key, the search extension, the model) or the tour
  // points at one; otherwise the first that needs attention, otherwise the one used last.
  const capabilities = { audio: hasContext(data, "audio"), generation: hasContext(data, "generation"), system: hasContext(data, "system") };
  const available = categoriesFor(capabilities);
  const missing = settingsGroupState({ data, status }).common.missing.concat(settingsGroupState({ data, status }).once.missing);
  const [category, setCategory] = useState(() => initialCategory({ available, focusSection: focusSection || (audioFocusPending() ? "settings-audio" : ""), missing, last: readCategory() }));
  const select = (id) => { setCategory(id); writeCategory(id); };
  useEffect(() => {
    if (!focusSection) return;
    const linked = categoryForAnchor(focusSection);
    if (linked && available.some((item) => item.id === linked)) setCategory(linked);
    // The pane for the linked category renders on the next frame: scroll to the section then.
    const frame = requestAnimationFrame(() => document.querySelector(`[data-tour="${focusSection}"]`)?.scrollIntoView?.({ block: "start", behavior: "smooth" }));
    onFocused?.();
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSection]);
  const legacyPanel = (
    <fieldset className="settings-section">
      <legend className="settings-section__title">{ui("导入 study-lib-spar")}</legend>
      <p className="settings-section__lead">{ui("从已有本地学习库导入，保留可迁移的复习记录。")}</p>
      <label className="settings-field">{ui("原学习库路径")}<input value={legacy} onChange={(e) => setLegacy(e.target.value)} /></label>
      <div className="settings-actions">
        <Button disabled={busy || !legacy} onClick={() =>
          act("legacy.import", { path: legacy }, (r) =>
            setNotice(r.reused ? ui("该学习库已导入") : uiFormat("已导入 {0} 道题。{1}", [r.count, (r.warnings || []).join("；")])))}>{ui("导入学习库")}</Button>
      </div>
    </fieldset>
  );
  const pane = (id) => {
    switch (id) {
      case "appearance": return <AppearanceSection appearance={appearance} />;
      case "science": return <ScienceSettings onChange={appearance?.onScience} />;
      case "model": return (
        <fieldset className="settings-section" data-tour="settings-model">
          <legend className="settings-section__title">{ui("学习库与模型")}</legend>
          {workspacePanel}
        </fieldset>
      );
      case "generation": return capabilities.generation ? <GenerationSettings root={data.root} saved={data.settings?.generation} busy={busy} act={act} setNotice={setNotice} /> : null;
      case "courses": return coursePanel;
      case "audio": return capabilities.audio ? <AudioSettings busy={busy} act={act} call={call} setNotice={setNotice} /> : null;
      case "mineru": return capabilities.audio ? <MineruSettings busy={busy} call={call} setNotice={setNotice} /> : null;
      case "retrieval": return capabilities.generation ? <ExtensionsSettings call={call} setNotice={setNotice} courses={data.focus?.courses} defaultCourse={data.focus?.course} /> : null;
      case "profile": return <>{onboardingPanel}{profile && <CoachSection profile={profile} busy={busy} act={act} call={call} setProfile={setProfile} setNotice={setNotice} />}</>;
      case "data": return <>{legacyPanel}<ScheduleSection key={data.root} root={data.root} settings={settings} saved={data.settings} setSettings={setSettings} act={act} busy={busy} setNotice={setNotice} /><BackupSection root={data.root} busy={busy} exportData={exportData} act={act} onRestored={onRestored} /></>;
      case "update": return <UpdateSettingsPanel call={call} host={host} notify={setNotice} />;
      case "usage": return capabilities.system ? <UsageSettings call={call} busy={busy} setNotice={setNotice} /> : null;
      case "experimental": return capabilities.system ? (
        <ExperimentalSection enabled={experimentalShown(data)} busy={busy} onChange={(enabled) => act("experimental.set", { enabled })}>
          <JevSettings busy={busy} call={call} setNotice={setNotice} />
        </ExperimentalSection>
      ) : null;
      default: return null;
    }
  };
  const selected = available.some((item) => item.id === category) ? category : available[0]?.id;
  return (
    <section className="page settings-page">
      <h1>{ui("工作区设置")}</h1>
      <p className="muted">{ui("资料、题库、调度与模型，由你掌控。")}</p>
      {tourActive ? (
        /* The tour points at sections anywhere on the page: show every category, one after another. */
        <div className="settings-all">{available.map((item) => <React.Fragment key={item.id}>{pane(item.id)}</React.Fragment>)}</div>
      ) : (
        <div className="settings-layout">
          <SettingsNav available={available} active={selected} missing={missing} onSelect={select} />
          <div className="settings-pane" role="region" aria-label={ui(available.find((item) => item.id === selected)?.title || "")}>{pane(selected)}</div>
        </div>
      )}
    </section>
  );
}
