import React from "react";
import { ui, uiFormat } from "./i18n.js";
import { Banner } from "./components/index.js";
import { useInjectCss } from "./shared.js";
import css from "./welcome.css";

/* The welcome page of an empty library is the first-run line now (ui/first-run/FirstRunLine.jsx, 3.6 D2): its own steps, with the sample tour as a quiet
   link at the bottom. What stays here is the sample banner: while the sample course is in the library it rides at the top of the home, with the way to
   take the tour again and to remove the sample. */

/** A slim line on the home page while the sample course is in the library. */
export function SampleBanner({ sample, busy = false, onTour, onRemove }) {
  useInjectCss(css, "study-welcome");
  if (!sample?.loaded) return null;
  return (
    <Banner className="sample-banner" icon="sparkle" title={uiFormat("正在使用示例数据：{0}", [sample.course || ""])}
      action={onTour && { label: ui("重新开始导览"), onClick: onTour, disabled: busy }}
      secondary={onRemove && { label: ui("移除示例数据"), onClick: onRemove, disabled: busy }} />
  );
}
