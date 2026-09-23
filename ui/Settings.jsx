import React, { useEffect, useState } from "react";

const GOALS = [["", "未设定"], ["exam", "应付考试"], ["interview", "面试求职"], ["work", "工作中落地"], ["explore", "兴趣拓展"]];

/* 设置视图：学习库绑定与模型、旧库导入、调度参数与完整备份。 */
export default function Settings({
  data,
  busy,
  act,
  setNotice,
  settings,
  setSettings,
  legacy,
  setLegacy,
  workspacePanel,
  exportData,
  onRestored,
}) {
  const [profile, setProfile] = useState(null);
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreError, setRestoreError] = useState("");
  async function readBackup(file) {
    setRestoreFile(null);
    setRestoreError("");
    if (!file) return;
    try {
      const state = JSON.parse(await file.text());
      if (!state || !Number.isInteger(state.version) || !Array.isArray(state.sources) ||
          !Array.isArray(state.decks) || !Array.isArray(state.drafts) ||
          !Array.isArray(state.runs) || !Array.isArray(state.attempts))
        throw new Error("这不是完整学习库备份");
      setRestoreFile({ name: file.name, state });
    } catch (e) {
      setRestoreError(`无法读取备份：${e.message || String(e)}`);
    }
  }
  useEffect(() => {
    act("coach.profile", {}, setProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="page">
      <h1>工作区设置</h1>
      <p className="muted">资料、题库、调度与模型，由你掌控。</p>
      <fieldset>
        <legend>学习库与模型</legend>
        {workspacePanel}
      </fieldset>
      {profile && (
        <fieldset>
          <legend>陪学</legend>
          <p className="muted">
            陪学记住的学习目标和画像只保存在这个学习库文件里，用来让变式题和建议更贴近你。模型调用使用最低思考档位。
          </p>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={profile.consent === true}
              onChange={(e) => act("coach.consent", { prep: e.target.checked }, () => act("coach.profile", {}, setProfile))}
            />
            做题时在后台准备变式题和应用场景题
          </label>
          <label>
            学习目标
            <select value={profile.goal} onChange={(e) => act("coach.goal", { goal: e.target.value }, () => act("coach.profile", {}, setProfile))}>
              {GOALS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <p className="muted">
            {profile.summary ? `画像：${profile.summary}` : "还没有画像：做完一轮后，陪学会根据表现写一段简短摘要。"}
            {` · 懂了 ${profile.signals.got} · 还是不懂 ${profile.signals.confused} · 👍 ${profile.signals.up} · 👎 ${profile.signals.down}`}
            {profile.ready ? ` · 已备 ${profile.ready} 道定制题` : ""}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => act("coach.forget", {}, (p) => { setProfile(p); setNotice("已清空陪学画像和未使用的定制题；练习记录不受影响。"); })}
          >
            清空画像
          </button>
        </fieldset>
      )}
      <fieldset>
        <legend>导入 study-lib-spar</legend>
        <p className="muted">
          从已有本地学习库导入，保留可迁移的复习记录。
        </p>
        <label>
          原学习库路径
          <input
            value={legacy}
            onChange={(e) => setLegacy(e.target.value)}
          />
        </label>
        <button
          disabled={busy || !legacy}
          onClick={() =>
            act("legacy.import", { path: legacy }, (r) =>
              setNotice(
                r.reused
                  ? "该学习库已导入"
                  : `已导入 ${r.count} 道题。${(r.warnings || []).join("；")}`,
              ),
            )
          }
        >
          导入学习库
        </button>
      </fieldset>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act("settings", settings, () =>
            setNotice("复习调度已保存"),
          );
        }}
      >
        <fieldset>
          <legend>间隔复习 · SM-2</legend>
          <div className="two-col">
            {Object.entries({
              first_interval_days: "首次复习间隔（天）",
              second_interval_days: "第二次间隔（天）",
              initial_ease_factor: "初始熟练系数",
              minimum_ease_factor: "最低熟练系数",
            }).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  required
                  min={key.includes("days") ? 1 : 0.1}
                  max="365"
                  step={key.includes("days") ? 1 : 0.1}
                  value={settings[key] ?? ""}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      [key]: Number(e.target.value),
                    })
                  }
                />
              </label>
            ))}
          </div>
          <button disabled={busy}>保存复习设置</button>
          <button
            type="button"
            onClick={() => setSettings(data.settings)}
          >
            撤销未保存修改
          </button>
        </fieldset>
      </form>
      <fieldset>
        <legend>数据备份与恢复</legend>
        <p className="muted">
          下载完整 JSON 备份，包含资料、题组和学习记录。
        </p>
        <button onClick={exportData}>导出学习库 ↓</button>
        <p className="muted">恢复会替换当前学习库。替换前会在当前学习库的 backups 目录保存一份原数据。</p>
        <label>选择完整备份 JSON
          <input type="file" accept=".json,application/json" disabled={busy}
            onChange={(e) => readBackup(e.target.files?.[0])} />
        </label>
        {restoreError && <p role="alert">{restoreError}</p>}
        {restoreFile && <div role="status">
          <p>已读取「{restoreFile.name}」：{restoreFile.state.sources.length} 份资料、{restoreFile.state.decks.length} 个题组、{restoreFile.state.attempts.length} 条作答记录。</p>
          <button type="button" disabled={busy} onClick={async () => {
            const result = await act("restore", { state: restoreFile.state }, onRestored);
            if (result) setRestoreFile(null);
          }}>确认恢复并替换当前学习库</button>
        </div>}
      </fieldset>
    </section>
  );
}
