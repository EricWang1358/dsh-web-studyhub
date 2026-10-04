import React from "react";
import { ui, uiFormat } from "../i18n.js";
import { Button, ConfirmDialog } from "../components/index.js";
import { useInjectCss } from "../shared.js";
import css from "./onboarding.css";

/**
 * Settings › 学习画像与导览 › 上手与示例: start or resume the feature tour, and load or remove
 * the sample course. `progress` is the paused tour position ({ index, total }).
 */
export function OnboardingPanel({ sample, progress, busy = false, onTour, onRestart, onLoad, onRemove }) {
  useInjectCss(css, "study-onboarding");
  const loaded = !!sample?.loaded;
  return (
    <fieldset className="onboarding-settings settings-section" data-tour="settings-sample">
      <legend className="settings-section__title">{ui("上手与示例")}</legend>
      <p className="settings-section__lead">{loaded
        ? uiFormat("示例课程「{0}」已载入。移除时只删除示例，不影响你自己的资料和记录。", [sample.course || ""])
        : ui("示例课程可以演示全部功能：一份讲义、一个题组和三周的练习记录。载入后随时可以一键移除。")}</p>
      <div className="onboarding-settings__actions">
        <Button icon="sparkle" disabled={busy} onClick={onTour}>{progress
          ? uiFormat("继续功能导览（{0}/{1}）", [progress.index + 1, progress.total]) : ui("开始功能导览")}</Button>
        {progress && onRestart && <Button variant="quiet" disabled={busy} onClick={onRestart}>{ui("从头开始")}</Button>}
        {loaded
          ? <Button variant="danger" disabled={busy} onClick={onRemove}>{ui("移除示例数据")}</Button>
          : onLoad && <Button disabled={busy} onClick={onLoad}>{ui("载入示例数据")}</Button>}
      </div>
    </fieldset>
  );
}

/** Confirms removing the sample: it says exactly what goes and what stays. */
export function RemoveSampleDialog({ busy = false, onConfirm, onClose }) {
  return (
    <ConfirmDialog title={ui("移除示例数据？")} onClose={onClose} busy={busy} confirmLabel={ui("移除示例数据")} onConfirm={onConfirm}
      description={ui("将删除示例课程的讲义、题组、练习记录、笔记、知识骨架和学习流。你自己创建的资料、题组和记录不受影响。")}>
      <p className="muted">{ui("示例课程以后还可以在「设置 › 学习画像与导览」的「上手与示例」里重新载入。")}</p>
    </ConfirmDialog>
  );
}
