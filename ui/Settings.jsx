import { getUiLanguage, ui, uiFormat, uiLocale } from "./i18n.js";
import React, { useEffect, useId, useRef, useState } from "react";
import AudioSettings from "./AudioSettings.jsx";
import ExtensionsSettings from './ExtensionsSettings.jsx';
import { hasContext } from './capabilities.js';
import { UpdateSettingsPanel } from './UpdateCenter.jsx';
import { Button, Dialog, Icon, InlineMessage, formatBytes } from './components/index.js';
import { useInjectCss } from './shared.js';
import { previewSchedule } from '../lib/sm2.js';
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
export function ScheduleSection({ settings = {}, saved = {}, setSettings, act, busy, setNotice }) {
  const dirty = SM2_FIELDS.some(([key]) => Number(settings[key]) !== Number(saved?.[key]));
  const current = numbers(settings);
  const good = previewSchedule(current, { grade: 4, reviews: 6 }), hard = good && previewSchedule(current, { grade: 3, reviews: 6 });
  return (
    <form className="settings-form" onSubmit={(e) => {
      e.preventDefault();
      act("settings", settings, () => setNotice?.({ text: ui("复习调度已保存"), tone: "success" }));
    }}>
      <fieldset className="settings-section sm2-settings">
        <legend className="settings-section__title">{ui("间隔复习 · SM-2")}</legend>
        <p className="settings-section__lead">{ui("答对时，下一次复习的间隔逐次拉长；答错时回到 1 天。")}</p>
        <div className="sm2-fields">
          {SM2_FIELDS.map(([key, label, unit, min, step]) => <label key={key} className="sm2-field">
            <span>{ui(label)}</span>
            <span className="sm2-input">
              <input type="number" required min={min} max="365" step={step} value={settings[key] ?? ""} disabled={busy}
                onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })} />
              {unit && <span className="sm2-unit">{ui(unit)}</span>}
            </span>
          </label>)}
        </div>
        <p className="settings-section__note">{ui("熟练系数越大，间隔增长越快；答得吃力时会下降，但不低于最低系数。")}</p>
        <SchedulePreview good={good} hard={hard} />
        <div className="settings-actions">
          <Button type="submit" variant="primary" disabled={busy || !dirty}>{ui("保存复习设置")}</Button>
          <Button variant="quiet" disabled={busy || !dirty} onClick={() => setSettings({ ...saved })}>{ui("撤销未保存修改")}</Button>
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
  const input = useRef(null);
  const exportId = useId(), restoreId = useId();
  const folder = backupsFolder(root);
  async function read(chosen) {
    setFile(null); setError("");
    if (!chosen) return;
    try {
      const state = JSON.parse(await chosen.text());
      if (!isFullBackup(state)) throw new Error(ui("这不是完整学习库备份"));
      setFile({ name: chosen.name, size: chosen.size, state });
    } catch (e) {
      setError(uiFormat("无法读取备份：{0}", [e.message || String(e)]));
    } finally { if (input.current) input.current.value = ""; }
  }
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
          <p className="settings-section__note">{uiFormat("文件名形如 {0}，保存到浏览器的下载文件夹。", [backupFileName()])}</p>
          <div className="settings-actions"><Button variant="primary" icon="download" disabled={busy} onClick={exportData}>{ui("导出学习库")}</Button></div>
        </section>
        <section className="backup-block" aria-labelledby={restoreId}>
          <h3 id={restoreId} className="settings-subtitle">{ui("恢复")}</h3>
          <p>{ui("用一份完整备份替换当前学习库。替换前，当前数据会自动另存一份到：")}</p>
          <code className="backup-path" title={folder}>{folder || ui("当前学习库的 backups 文件夹")}</code>
          <input ref={input} type="file" hidden accept=".json,application/json" onChange={(e) => read(e.target.files?.[0])} />
          {!file && <div className="settings-actions"><Button icon="upload" disabled={busy} onClick={() => input.current?.click()}>{ui("选择备份文件…")}</Button></div>}
          {error && <InlineMessage>{error}</InlineMessage>}
          {file && <RestorePreview file={file} busy={busy || working} onConfirm={() => setConfirm(true)} onCancel={() => { setFile(null); input.current?.click(); }} />}
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
}) {
  useInjectCss(css, "study-settings");
  const [profile, setProfile] = useState(initialProfile);
  useEffect(() => {
    act("coach.profile", {}, setProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="page settings-page">
      <h1>{ui("工作区设置")}</h1>
      <p className="muted">{ui("资料、题库、调度与模型，由你掌控。")}</p>
      <fieldset className="settings-section" data-tour="settings-model">
        <legend className="settings-section__title">{ui("学习库与模型")}</legend>
        {workspacePanel}
      </fieldset>
      {coursePanel}
      {hasContext(data, 'audio') && <AudioSettings busy={busy} act={act} call={call} setNotice={setNotice} />}
      {hasContext(data, 'generation') && <ExtensionsSettings call={call} setNotice={setNotice} />}
      {onboardingPanel}
      {profile && <CoachSection profile={profile} busy={busy} act={act} call={call} setProfile={setProfile} setNotice={setNotice} />}
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
      <ScheduleSection settings={settings} saved={data.settings} setSettings={setSettings} act={act} busy={busy} setNotice={setNotice} />
      <BackupSection root={data.root} busy={busy} exportData={exportData} act={act} onRestored={onRestored} />
      <UpdateSettingsPanel call={call} host={host} notify={setNotice} />
    </section>
  );
}
