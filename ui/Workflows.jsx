import { ui, useUiLanguage } from "./i18n.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import WorkflowPortal from "./WorkflowPortal.jsx";
import { Banner, Button, ErrorState, LoadingState, PageHeader } from "./components/index.js";
import { useInjectCss } from "./shared.js";
import { usePolling } from "./use-polling.js";
import css from "./workflows.css";
import { useStudy } from "./study-context.jsx";
import { formatDateTime } from "./format.js";

const when = (value) => formatDateTime(value, "stamp");
const STATUS = { active: "学习中", paused: "已暂停", completed: "已结束" };

/* Read-only historical archive of learning-flow sessions (#779).
   Creating, editing, deleting or advancing workflows is retired; per-course 学法 (course.method) and main-session AI 带学 replace it. */
export default function Workflows({ data, openSession, openRun, onOpenSettings, initialListing = null, renderRelated }) {
  const { call } = useStudy();
  const language = useUiLanguage();
  useInjectCss(css, "study-workflows");
  const [listing, setListing] = useState(initialListing);
  const [screen, setScreen] = useState(() => (openSession ? { kind: "portal", id: openSession } : { kind: "list" }));
  const [error, setError] = useState("");
  const request = useRef(0), reading = useRef(null), live = useRef(true);
  const root = data?.root || "local";
  const invalidateReads = useCallback(() => { ++request.current; reading.current = null; }, []);
  const refresh = useCallback(async ({ automatic = false } = {}) => {
    if (automatic && reading.current !== null) return;
    const token = ++request.current;
    reading.current = token;
    try {
      const result = await call("workflow.list");
      if (live.current && token === request.current) { setListing(result); setError(""); }
    } catch (err) {
      if (live.current && token === request.current) setError(err.message);
    } finally {
      if (reading.current === token) reading.current = null;
    }
  }, [call]);
  useEffect(() => { live.current = true; return () => { live.current = false; invalidateReads(); }; }, [invalidateReads]);
  useEffect(() => {
    if (screen.kind !== "portal") void refresh();
    return invalidateReads;
  }, [refresh, data?.revision, screen.kind, invalidateReads, language]);
  usePolling(() => refresh({ automatic: true }), { intervalMs: 15000, enabled: false });
  const back = () => { setScreen({ kind: "list" }); void refresh(); };
  if (screen.kind === "portal") {
    return (
      <>
        {renderRelated?.(screen.id)}
        <WorkflowPortal key={screen.id} id={screen.id} libraryKey={root} onOpenSettings={onOpenSettings}
          onOpenRun={openRun} onBack={back} revision={data?.revision} />
      </>
    );
  }
  if (!listing) {
    return (
      <section className="page workflow-page">
        <PageHeader title={ui("历史学习流记录")} />
        {error ? <ErrorState error={error} onRetry={refresh} retryLabel={ui("重新读取")} /> : <LoadingState label={ui("正在读取历史记录…")} />}
      </section>
    );
  }
  const sessions = listing.sessions || [];
  return (
    <section className="page workflow-page">
      <PageHeader title={ui("历史学习流记录")} description={ui("此前的学习流过程、讲解材料与复述笔记保存在这里，仅供只读查阅。")} />
      <Banner tone="info" role="status" className="wf-banner" title={ui("学习流已退役，历史记录只读保留")}>
        <p>{ui("学习流（含自定义流程）已由每门课的「学法」与主会话「AI 带学」替代；新的学习安排可在课程设置里调整学法，或在主会话直接开始带学。")}</p>
      </Banner>
      {error && <ErrorState error={error} />}
      <div className="wf-section-head"><h2>{ui("学习记录")}</h2></div>
      {!sessions.length ? (
        <p className="muted wf-empty">{ui("当前学习库没有历史学习流记录。")}</p>
      ) : (
        <ul className="wf-session-list">
          {[...sessions].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).map((s) => (
            <li key={s.id} data-session={s.id}>
              <div>
                <strong>{s.topic}</strong>
                <p>{s.title}{s.stepTitle ? ` · ${s.stepTitle}` : ""}</p>
                <small className="muted">{`${ui(STATUS[s.status] || STATUS.completed)} · ${when(s.updatedAt)}`}</small>
              </div>
              <div className="wf-actions">
                <Button className="wf-action-btn" onClick={() => setScreen({ kind: "portal", id: s.id })}>{ui("查看记录")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
