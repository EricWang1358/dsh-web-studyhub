import React from "react";

/* 设置视图：学习库绑定与模型（workspacePanel JSX 由 App 传入）、旧库导入、
   SM-2 调度参数与 JSON 导出。 */
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
}) {
  return (
    <section className="page">
      <h1>工作区设置</h1>
      <p className="muted">资料、题库、调度与模型，由你掌控。</p>
      <fieldset>
        <legend>学习库与模型</legend>
        {workspacePanel}
      </fieldset>
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
        <legend>数据导出</legend>
        <p className="muted">
          下载完整 JSON 备份，包含资料、题组和学习记录。
        </p>
        <button onClick={exportData}>导出学习库 ↓</button>
      </fieldset>
    </section>
  );
}
