import React from "react";
import { ui, uiFormat } from "../i18n.js";
import { Button } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { describeModelError, plainAssistFailure } from "../generation-status.js";
import ModelErrorNote from "../ModelErrorNote.jsx";

/* A failed background-assistant task. A model failure goes through the one model note: a key or model problem points to the settings
   (sending the same request again cannot work, so there is no 重新提交), a busy or slow service keeps 重新提交. Anything else is about the
   content: the plain line, 重新提交, and 改一改再提交 when there is a question to edit. */
export default function AssistFailure({ task, modelReady = false, onSettings, onResubmit, onEdit }) {
  const { busy } = useStudy();
  const text = plainAssistFailure(task.message) || ui("没有拿到具体原因");
  const info = describeModelError(text);
  const resubmit = <Button className="assist-actions__btn" variant="primary" size="sm" lock={busy} onClick={onResubmit}>{ui("重新提交")}</Button>;
  const edit = onEdit && <Button className="assist-actions__btn" size="sm" onClick={onEdit}>{ui("改一改再提交")}</Button>;
  if (info.kind !== "unknown") {
    const canRetry = info.action === "retry" || modelReady;
    return (
      <div className="assist-note assist-failed" data-kind={info.kind}>
        <ModelErrorNote error={text} context="assist" onSettings={onSettings} />
        {(canRetry || edit) && <div className="assist-actions">{canRetry && resubmit}{edit}</div>}
      </div>
    );
  }
  return (
    <div className="assist-status failed assist-failed" role="status">
      <p>{uiFormat("后台助教没能完成：{0}", [text])}</p>
      <div className="assist-actions">{resubmit}{edit}</div>
    </div>
  );
}
