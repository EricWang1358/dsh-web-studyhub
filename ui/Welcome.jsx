import React from "react";
import { ui, uiFormat } from "./i18n.js";
import { Banner, Button, Icon, SetupRequired } from "./components/index.js";
import { useInjectCss } from "./shared.js";
import css from "./welcome.css";

/**
 * The first screen of an empty library (and of a freshly loaded sample, until
 * dismissed). An empty library leads with the learner's own first material (the one
 * primary action); the sample course with its tour is a quiet link under it, and,
 * while no AI model is ready, the model setup follows, plus a quiet "later". A loaded
 * sample leads with its tour, the import beside it. It lives in the main area, never
 * the sidebar.
 */
export default function Welcome({ model, sample, busy = false, onStartSample, onStartTour, onImport, onSetupModel, onRemoveSample, onLater }) {
  useInjectCss(css, "study-welcome");
  const loaded = !!sample?.loaded;
  const modelReady = model?.ready !== false;
  return (
    <section className="page welcome" aria-labelledby="study-welcome-title">
      <header className="welcome__intro">
        <p className="welcome__eyebrow">{loaded ? ui("示例课程") : ui("开始使用")}</p>
        <h1 className="welcome__title" id="study-welcome-title">{loaded ? ui("示例课程已就绪") : ui("欢迎使用 StudyHub")}</h1>
        <p className="welcome__lead">{loaded
          ? uiFormat("「{0}」已经载入：一份讲义、一个题组、三周的练习记录和一份待发布的草稿。", [sample.course || ""])
          : ui("把讲义和课件变成标明出处的练习题，按记忆曲线复习，真正学会。")}</p>
      </header>
      {loaded ? (
        <div className="welcome__choices">
          <article className="welcome-card welcome-card--lead">
            <span className="welcome-card__icon" aria-hidden="true"><Icon name="sparkle" size={22} /></span>
            <h2 className="welcome-card__title">{ui("跟着导览走一遍")}</h2>
            <p className="welcome-card__text">{ui("两三分钟，依次切到资料、出题、练习、错题和统计等页面，看看每一步怎么用。")}</p>
            <div className="welcome-card__action">
              <Button variant="primary" iconEnd="arrow-right" disabled={busy} onClick={onStartTour}>{ui("开始导览")}</Button>
            </div>
          </article>
          <article className="welcome-card">
            <span className="welcome-card__icon" aria-hidden="true"><Icon name="upload" size={22} /></span>
            <h2 className="welcome-card__title">{ui("从自己的资料开始")}</h2>
            <p className="welcome-card__text">{ui("PDF、Markdown、网页或文本都可以，原文件会保留。导入后就能用它出题。")}</p>
            <div className="welcome-card__action">
              <Button icon="upload" disabled={busy} onClick={onImport}>{ui("导入我的第一份资料")}</Button>
            </div>
          </article>
        </div>
      ) : (
        <div className="welcome__choices welcome__choices--first">
          <article className="welcome-card welcome-card--lead">
            <span className="welcome-card__icon" aria-hidden="true"><Icon name="upload" size={22} /></span>
            <h2 className="welcome-card__title">{ui("从自己的资料开始")}</h2>
            <p className="welcome-card__text">{ui("PDF、Markdown、网页或文本都可以，原文件会保留。导入后就能用它出题。")}</p>
            <div className="welcome-card__action">
              <Button variant="primary" icon="upload" disabled={busy} onClick={onImport}>{ui("导入我的第一份资料")}</Button>
            </div>
          </article>
          {/* The sample is for looking around first: a quiet link, never the lead. */}
          <p className="welcome__sample">
            <span>{ui("想先看看效果？")}</span>
            <Button variant="link" size="sm" busy={busy} onClick={onStartSample}>{ui("载入示例并开始导览")}</Button>
            <small>{ui("一门示例课程（设计模式）：一份讲义、九道带出处的题和三周练习记录，导览约三分钟；示例数据随时一键移除。")}</small>
          </p>
        </div>
      )}
      {!modelReady && <SetupRequired className="welcome__model" icon="model" title={ui("连接一个 AI 模型")}
        why={ui("出题、讲解和提问需要 AI 模型；复习练习和示例导览不需要，可以先体验。")}
        steps={[{ text: ui("打开模型设置，选择一个服务商和模型") }, { text: ui("填入服务商提供的 API Key 并保存，回到这里即可出题") }]}>
        <div className="welcome__model-action">
          <Button icon="model" disabled={busy} onClick={onSetupModel}>{ui("打开模型设置")}</Button>
        </div>
      </SetupRequired>}
      <footer className="welcome__footer">
        {loaded && onRemoveSample && <Button variant="quiet" size="sm" disabled={busy} onClick={onRemoveSample}>{ui("移除示例数据")}</Button>}
        <Button variant="link" size="sm" onClick={onLater}>{ui("以后再说")}</Button>
      </footer>
    </section>
  );
}

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
